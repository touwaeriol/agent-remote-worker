/**
 * Claude Code gives every session an inbox socket: write a line to it and the
 * text arrives in that session as a message from another session. An idle
 * session wakes up; a busy one reads it between tool calls.
 *
 * The socket is documented. The line format is not, so it may change with a
 * Claude Code upgrade: `inboxFrame` is the only place that knows it.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export function inboxFrame(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}

const CONFIRM_WINDOW_MS = 500;

/**
 * Delivers `text` into the session that owns `socketPath`. Rejects if nobody is listening.
 *
 * A session reads the line and keeps the connection open. A forwarded socket
 * whose far end is gone accepts the connection and then drops it, so a peer
 * that hangs up right after the write means the message went nowhere.
 */
export function postToInbox(socketPath: string, text: string, timeoutMs = 6000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(timeoutMs, () => settle(new Error("timed out")));
    socket.once("error", settle);
    socket.once("close", () => settle(new Error("connection dropped by the other end")));
    socket.once("connect", () => {
      socket.write(inboxFrame(text), () => setTimeout(settle, CONFIRM_WINDOW_MS));
    });
  });
}

function runtimeDir(): string {
  return process.env.XDG_RUNTIME_DIR ?? `/run/user/${os.userInfo().uid}`;
}

/** The inbox socket of the session whose process id is `pid`, if it has one. */
export function sessionInbox(pid: number): string | undefined {
  const candidates = [
    path.join(runtimeDir(), "cc-socks", `${pid}.sock`),
    `/tmp/cc-socks-${os.userInfo().uid}/${pid}.sock`,
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function parentPid(pid: number): number {
  try {
    // /proc/<pid>/stat is "pid (comm) state ppid ..."; comm may contain spaces.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    try {
      return Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }));
    } catch {
      return 0;
    }
  }
}

/** The inbox of the session this process was started by (it is one of our ancestors). */
export function ownSessionInbox(): string | undefined {
  const fromEnv = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const pids: number[] = [];
  const claudePid = Number(process.env.CLAUDE_PID);
  if (claudePid > 1) pids.push(claudePid);
  for (let pid = process.ppid, depth = 0; pid > 1 && depth < 6; pid = parentPid(pid), depth++) {
    pids.push(pid);
  }
  for (const pid of pids) {
    const inbox = sessionInbox(pid);
    if (inbox) return inbox;
  }
  return undefined;
}
