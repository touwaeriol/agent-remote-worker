/** Running commands, locally and on a worker over SSH. */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolError } from "../shared/tooling.ts";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  input?: string;
  timeoutMs?: number;
  cwd?: string;
  /** Called with stderr as it arrives, for commands that report progress there. */
  onStderr?: (chunk: string) => void;
}

/** Quotes a string for a POSIX shell. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Like `shq`, but keeps a leading `~` for the remote shell to expand. */
export function shPath(value: string): string {
  if (value === "~") return "~";
  // The tilde only expands when it and the slash after it are unquoted.
  return value.startsWith("~/") ? `~/${shq(value.slice(2))}` : shq(value);
}

export function run(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  const { input, timeoutMs = 60_000, cwd, onStderr } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new ToolError(`超时（${Math.round(timeoutMs / 1000)} 秒）：${command} ${args.at(-1) ?? ""}`.slice(0, 200)));
    }, timeoutMs);
    child.stdout!.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr!.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
      onStderr?.(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new ToolError(`无法运行 ${command}：${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (input !== undefined) {
      // The child may exit before reading it all; its exit code tells that story.
      child.stdin!.on("error", () => {});
      child.stdin!.end(input);
    }
  });
}

/** One worker machine as seen through SSH. Commands share a multiplexed connection. */
export class SshHost {
  private readonly controlDir = path.join(os.homedir(), ".claude", "workers-run");
  private readonly alias: string;
  private readonly pathPrefix: string;

  /** `extraPath` is put in front of PATH for every command (where `claude` and `node` live). */
  constructor(alias: string, extraPath?: string) {
    this.alias = alias;
    this.pathPrefix = extraPath ? `export PATH=${shq(extraPath)}:"$PATH"; ` : "";
    fs.mkdirSync(this.controlDir, { recursive: true, mode: 0o700 });
  }

  private baseArgs(): string[] {
    return [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-o", "ControlMaster=auto",
      "-o", "ControlPersist=120",
      "-o", `ControlPath=${this.controlDir}/cm-%C`,
      this.alias,
    ];
  }

  /** Runs a shell command line on the worker. */
  exec(commandLine: string, options: ExecOptions = {}): Promise<ExecResult> {
    return run("ssh", [...this.baseArgs(), this.pathPrefix + commandLine], options);
  }

  /** Like `exec`, but a non-zero exit becomes a ToolError naming what failed. */
  async execOk(commandLine: string, what: string, options: ExecOptions = {}): Promise<string> {
    const result = await this.exec(commandLine, options);
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().slice(-600);
      throw new ToolError(`${what}失败（退出码 ${result.code}）：${detail}`);
    }
    return result.stdout;
  }

  /**
   * Opens a dedicated connection that makes `localSocket` reachable on the worker
   * as `remoteSocket`. The forward lives exactly as long as the returned process.
   */
  reverseForward(remoteSocket: string, localSocket: string): ChildProcess {
    return spawn(
      "ssh",
      [
        "-N",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=3",
        "-o", "ControlPath=none",
        "-R", `${remoteSocket}:${localSocket}`,
        this.alias,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  }
}
