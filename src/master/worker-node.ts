/** Everything the master can do to one worker machine. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REMOTE_DIR,
  REMOTE_SCRIPT,
  WORKER_ALLOWED_TOOLS,
  WORKER_SERVER,
  type PendingRequest,
  type PermissionMode,
  type RequestAnswer,
  type WorkerEnv,
} from "../shared/protocol.ts";
import { ToolError } from "../shared/tooling.ts";
import type { PrepResult } from "../worker/cli.ts";
import type { RemoveRequest, Workspace, WorkspaceRequest } from "../worker/workspace.ts";
import { HOOK_TIMEOUT_MAX, type WorkerConfig } from "./config.ts";
import { SshHost, shPath, shq } from "./exec.ts";
import { USAGE_ARGS, parseUsage, type Usage } from "./usage.ts";

/** A background session as `claude agents --json` reports it. */
export interface RemoteSession {
  id: string;
  name?: string;
  cwd?: string;
  /** Present while the session's process is alive. */
  pid?: number;
  state?: "working" | "blocked" | "done" | "failed" | "stopped";
  status?: "busy" | "waiting" | "idle";
  waitingFor?: string;
  sessionId?: string;
}

export interface LaunchOptions {
  cwd: string;
  name: string;
  prompt: string;
  permissionMode: PermissionMode;
  model?: string;
  /** Continue this conversation instead of starting a new one. */
  resumeSessionId?: string;
  /** Where the master's inbox is reachable on the worker. */
  channel: PrepResult;
}

const STATE_LABEL: Record<string, string> = {
  working: "工作中",
  blocked: "等待输入",
  done: "已完成",
  failed: "失败",
  stopped: "已停止",
};

/** Whether the session's process is gone. A session that just started may briefly report no pid. */
export function hasExited(session: RemoteSession): boolean {
  return !session.pid && session.state !== "working";
}

export function describeSession(session: RemoteSession): string {
  const notes: string[] = [];
  if (session.waitingFor) notes.push(`卡在：${session.waitingFor}`);
  if (hasExited(session)) notes.push("进程已退出，可用 worker_resume 续跑");
  else if (session.status === "idle") notes.push("空闲，等待下一条消息");
  const state = STATE_LABEL[session.state ?? ""] ?? session.state ?? "?";
  const suffix = notes.length ? `  [${notes.join("；")}]` : "";
  return `${session.id}  ${session.name ?? "(未命名)"}  ${state}  ${session.cwd ?? ""}${suffix}`;
}

export class WorkerNode {
  readonly name: string;
  readonly config: WorkerConfig;
  readonly ssh: SshHost;
  private scriptCurrent = false;
  private workRootTrusted = false;

  constructor(name: string, config: WorkerConfig) {
    this.name = name;
    this.config = config;
    const binDir = path.dirname(config.claudePath);
    this.ssh = new SshHost(config.ssh, binDir === "." ? undefined : binDir);
  }

  private get claude(): string {
    return shq(this.config.claudePath);
  }

  // ---- the worker bundle

  /** Copies dist/worker.js to the worker unless the same build is already there. Returns whether it copied. */
  async ensureScript(): Promise<boolean> {
    if (this.scriptCurrent) return false;
    const bundle = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "worker.js"));
    const localHash = createHash("sha256").update(bundle).digest("hex");
    // `|| true` keeps "no file yet" apart from "cannot reach the worker" (ssh exits 255).
    const remoteHash = await this.ssh.execOk(
      `{ sha256sum ${REMOTE_SCRIPT} 2>/dev/null || true; } | cut -d' ' -f1`,
      "连接 worker",
    );
    const upToDate = remoteHash.trim() === localHash;
    if (!upToDate) {
      await this.ssh.execOk(
        `mkdir -p ${REMOTE_DIR} && chmod 700 ${REMOTE_DIR} && cat > ${REMOTE_SCRIPT}.tmp && mv -f ${REMOTE_SCRIPT}.tmp ${REMOTE_SCRIPT}`,
        "复制脚本到 worker",
        { input: bundle.toString("utf8") },
      );
    }
    this.scriptCurrent = true;
    return !upToDate;
  }

  private helper(args: string): string {
    return `${shq(this.config.nodePath)} ${REMOTE_SCRIPT} ${args}`;
  }

  /** Clears the way for the master's inbox to be forwarded here. */
  async prepareChannel(masterId: string): Promise<PrepResult> {
    await this.ensureScript();
    const out = await this.ssh.execOk(this.helper(`prep ${shq(masterId)}`), "准备 worker 端通道");
    try {
      return JSON.parse(out.slice(out.indexOf("{"))) as PrepResult;
    } catch {
      throw new ToolError(`worker 端通道准备结果无法解析：${out.slice(0, 200)}`);
    }
  }

  /** The inode of a socket on the worker, or undefined when it is not there. */
  async socketId(socketPath: string): Promise<string | undefined> {
    const path = shq(socketPath);
    const result = await this.ssh.exec(`test -S ${path} && ls -i ${path}`, { timeoutMs: 20_000 });
    return result.code === 0 ? /^\s*(\d+)/.exec(result.stdout)?.[1] : undefined;
  }

  /**
   * Makes sure sessions can start under the work root. When the folder is not
   * trusted yet, trusts it if the config allows; returns what it found or did.
   */
  async ensureWorkRootTrusted(): Promise<"trusted" | "just-trusted" | "untrusted"> {
    if (this.workRootTrusted) return "trusted";
    const root = this.config.workRoot;
    if (await this.isTrusted(root)) {
      this.workRootTrusted = true;
      return "trusted";
    }
    if (!this.config.trustWorkRoot) return "untrusted";
    await this.ssh.execOk(this.helper(`trust-root ${shPath(root)}`), "信任 worker 上的 workRoot");
    this.workRootTrusted = true;
    return "just-trusted";
  }

  async isTrusted(dir: string): Promise<boolean> {
    await this.ensureScript();
    const out = await this.ssh.execOk(this.helper(`trust ${shPath(dir)}`), "检查目录信任");
    return out.trim() === "true";
  }

  // ---- sessions

  /** Background sessions on the worker; `includeFinished` adds those that already ended. */
  async sessions(includeFinished = true): Promise<RemoteSession[]> {
    const out = await this.ssh.execOk(
      `${this.claude} agents --json${includeFinished ? " --all" : ""}`,
      "查询 worker 会话",
      { timeoutMs: 45_000 },
    );
    let items: Array<RemoteSession & { kind?: string }>;
    try {
      items = JSON.parse(out.slice(out.indexOf("[")));
    } catch {
      throw new ToolError(`无法解析 worker 的会话列表：${out.slice(0, 300)}`);
    }
    return items.filter((item) => item.kind === "background" && item.id);
  }

  /** Finds a session by id, name or conversation id, preferring one that is still running. */
  async findSession(ref: string): Promise<RemoteSession> {
    const all = await this.sessions();
    let hits = all.filter((s) => s.id === ref || s.name === ref || s.sessionId === ref);
    if (hits.length === 0) hits = all.filter((s) => s.sessionId?.startsWith(ref));
    const hit = hits.find((s) => s.pid) ?? hits.find((s) => !hasExited(s)) ?? hits[0];
    if (!hit) throw new ToolError(`worker「${this.name}」上没有会话「${ref}」。用 worker_list 查看现有会话。`);
    return hit;
  }

  /** Delivers text into a running session's inbox. */
  async post(session: RemoteSession, text: string): Promise<void> {
    for (let attempt = 0; !session.pid && attempt < 5; attempt++) {
      // Just launched: the process id shows up a moment later.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      session = (await this.sessions()).find((s) => s.id === session.id) ?? session;
    }
    if (!Number.isInteger(session.pid)) {
      throw new ToolError(`会话 ${session.id} 没有在运行的进程，无法投递消息。`);
    }
    await this.ensureScript();
    await this.ssh.execOk(this.helper(`post ${session.pid}`), "投递消息", { input: text, timeoutMs: 30_000 });
  }

  /** Starts (or resumes) a background session and returns its short id. */
  async launch(options: LaunchOptions): Promise<string> {
    const env: WorkerEnv = {
      CW_MASTER_SOCK: options.channel.socket,
      CW_WORKER: this.name,
      CW_SESSION: options.name,
    };
    const mcpConfig = {
      mcpServers: {
        [WORKER_SERVER]: { command: options.channel.node, args: [options.channel.script, "serve"], env },
      },
    };
    const { approval, approvalTimeout } = this.config;
    const hook = (command: string) => ({
      type: "command",
      command: [options.channel.node, options.channel.script, command, env.CW_MASTER_SOCK, env.CW_WORKER, env.CW_SESSION, String(approvalTimeout), approval]
        .map(shq)
        .join(" "),
      // The hook waits for the master's answer; Claude Code must not give up on it first.
      // With no limit set, give it the longest timeout a timer can hold.
      timeout: approvalTimeout ? approvalTimeout + 60 : HOOK_TIMEOUT_MAX,
    });
    const settings = {
      // Nobody sits at a worker session: its permission prompts and questions go to the master instead.
      hooks: {
        PreToolUse: [{ matcher: "AskUserQuestion", hooks: [hook("hook-ask")] }],
        PermissionRequest: [{ matcher: "*", hooks: [hook("hook-permission")] }],
        // Auto mode refuses some calls without a prompt; at least let the master know.
        PermissionDenied: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: [options.channel.node, options.channel.script, "hook-denied", env.CW_MASTER_SOCK, env.CW_WORKER, env.CW_SESSION]
                  .map(shq)
                  .join(" "),
                timeout: 30,
              },
            ],
          },
        ],
      },
      // A session that bypasses permission prompts holds peer messages unless told to accept them.
      ...(options.permissionMode === "bypassPermissions" ? { crossSessionInbound: "accept" } : {}),
    };
    const flags = [
      "--bg",
      ...(options.resumeSessionId ? ["--resume", shq(options.resumeSessionId)] : []),
      "--name", shq(options.name),
      "--permission-mode", options.permissionMode,
      "--mcp-config", shq(JSON.stringify(mcpConfig)),
      "--allowedTools", shq(WORKER_ALLOWED_TOOLS),
      "--settings", shq(JSON.stringify(settings)),
      ...(options.model ? ["--model", shq(options.model)] : []),
    ];
    // `--` keeps the prompt from being swallowed by a variadic flag such as --allowedTools.
    const commandLine = `cd ${shPath(options.cwd)} && ${this.claude} ${flags.join(" ")} -- ${shq(options.prompt)}`;
    const result = await this.ssh.exec(commandLine, { timeoutMs: 90_000 });
    const output = `${result.stdout}\n${result.stderr}`.trim();

    if (output.includes("not trusted")) {
      throw new ToolError(
        `worker 上的目录 ${options.cwd} 还没有被信任，后台会话无法在里面启动。` +
          `请在 worker 上进入 ${this.config.workRoot}（或该目录）运行一次 claude 并接受信任提示，` +
          "或者在节点配置里把 trustWorkRoot 设为 true 让插件自动信任 workRoot，然后重试。",
      );
    }
    const id = /backgrounded\s*\S\s*([0-9a-f]{6,})/.exec(output)?.[1];
    if (result.code !== 0 || !id) {
      throw new ToolError(`启动后台会话失败（退出码 ${result.code}）：${output.slice(-600)}`);
    }
    if (output.includes("send a prompt to start")) {
      throw new ToolError(`会话 ${id} 已创建但没有收到任务说明：${output.slice(-300)}`);
    }
    return id;
  }

  async stop(session: RemoteSession): Promise<void> {
    await this.ssh.execOk(`${this.claude} stop ${shq(session.id)}`, "停止会话");
  }

  /** Deletes a stopped session's record on the worker. */
  async forget(session: RemoteSession): Promise<void> {
    await this.ssh.execOk(`${this.claude} rm ${shq(session.id)}`, "删除会话");
  }

  // ---- permission prompts and questions

  /** Requests the worker's sessions are holding for an answer. */
  async pendingRequests(): Promise<PendingRequest[]> {
    await this.ensureScript();
    const out = await this.ssh.execOk(this.helper("pending"), "查询待答复的请求");
    try {
      return JSON.parse(out.slice(out.indexOf("["))) as PendingRequest[];
    } catch {
      throw new ToolError(`无法解析待答复的请求：${out.slice(0, 200)}`);
    }
  }

  /** Hands an answer to the session waiting on request `id`; returns that request. */
  async answerRequest(id: string, answer: RequestAnswer): Promise<PendingRequest> {
    await this.ensureScript();
    const result = await this.ssh.exec(this.helper(`answer ${shq(id)}`), { input: JSON.stringify(answer) });
    if (result.code === 5) throw new ToolError(result.stderr.trim());
    if (result.code !== 0) {
      throw new ToolError(`答复请求失败（退出码 ${result.code}）：${(result.stderr || result.stdout).trim().slice(-400)}`);
    }
    return JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as PendingRequest;
  }

  // ---- code

  /** Clones or updates the project on the worker and gives the session its own worktree. */
  async addWorkspace(
    request: Omit<WorkspaceRequest, "root">,
    onProgress?: (line: string) => void,
  ): Promise<Workspace> {
    await this.ensureScript();
    const out = await this.ssh.execOk(this.helper("workspace-add"), "在 worker 上准备代码", {
      input: JSON.stringify({ ...request, root: this.config.workRoot } satisfies WorkspaceRequest),
      timeoutMs: 11 * 60_000,
      // git rewrites its progress line with carriage returns; keep the latest state of it
      onStderr: (chunk) => {
        const line = chunk.split(/[\r\n]/).filter((part) => part.trim()).pop();
        if (line) onProgress?.(line.trim());
      },
    });
    return JSON.parse(out.slice(out.indexOf("{"))) as Workspace;
  }

  /** Removes a session's worktree; reports why not when that would lose work. */
  async removeWorkspace(dir: string, force: boolean): Promise<{ removed: boolean; reason?: string }> {
    await this.ensureScript();
    const out = await this.ssh.execOk(this.helper("workspace-remove"), "清理 worker 上的工作目录", {
      input: JSON.stringify({ root: this.config.workRoot, path: dir, force } satisfies RemoveRequest),
    });
    return JSON.parse(out.slice(out.indexOf("{")));
  }

  // ---- account

  async usage(): Promise<Usage> {
    const out = await this.ssh.execOk(`cd ~ && ${this.claude} ${USAGE_ARGS.join(" ")}`, "查询 worker 额度", {
      timeoutMs: 90_000,
    });
    return parseUsage(out);
  }

  async version(command: "claude" | "node"): Promise<string> {
    const bin = command === "claude" ? this.claude : shq(this.config.nodePath);
    return (await this.ssh.execOk(`${bin} --version`, `运行 ${command}`)).trim();
  }

  async hostname(): Promise<string> {
    return (await this.ssh.execOk("hostname", "SSH 连接")).trim();
  }
}
