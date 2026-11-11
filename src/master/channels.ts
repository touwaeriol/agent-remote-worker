/**
 * Keeps this session's inbox reachable from each worker.
 *
 * A channel is one SSH connection holding a reverse forward: a socket path on
 * the worker that leads to the master session's inbox. Each master session has
 * its own path, named after the session, so several master sessions on one
 * machine never take each other's messages. A worker session reports to the
 * path its route names (see src/worker/routes.ts).
 */
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import { ownSessionInbox } from "../shared/inbox.ts";
import { ToolError } from "../shared/tooling.ts";
import type { PrepResult } from "../worker/cli.ts";
import type { WorkerNode } from "./worker-node.ts";

interface Channel {
  node: WorkerNode;
  tunnel: ChildProcess;
  prep: PrepResult;
  /** Identity of the forwarded socket on the worker, to notice another master taking the path. */
  socketId: string | undefined;
}

const OPEN_TIMEOUT_MS = 12_000;
const WATCH_INTERVAL_MS = 10_000;

/** A child that exited or was killed by a signal; `exitCode` alone misses the latter. */
const hasEnded = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/**
 * Names this master session. Claude Code's session id when it is passed on,
 * else the session's inbox (one per running session), else our parent process.
 */
function masterSessionId(): string {
  const session =
    process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || ownSessionInbox() || `ppid:${process.ppid}`;
  return createHash("sha256")
    .update(`${os.userInfo().username}@${os.hostname()}\n${session}`)
    .digest("hex")
    .slice(0, 16);
}

export class Channels {
  private readonly channels = new Map<string, Channel>();
  private readonly opening = new Map<string, Promise<PrepResult>>();
  /** This master session's id: one forwarded inbox per master session on each worker. */
  readonly masterId = masterSessionId();
  private readonly onReopen: (node: WorkerNode) => Promise<void>;

  /** `onReopen` runs after a lost channel comes back, to let sessions re-report. */
  constructor(onReopen: (node: WorkerNode) => Promise<void>) {
    this.onReopen = onReopen;
    setInterval(() => void this.reopenDropped(), WATCH_INTERVAL_MS).unref();
  }

  isOpen(workerName: string): boolean {
    const channel = this.channels.get(workerName);
    return channel !== undefined && !hasEnded(channel.tunnel);
  }

  /** Makes sure the channel to a worker is open and ours, and says where it lands there. */
  ensure(node: WorkerNode): Promise<PrepResult> {
    let pending = this.opening.get(node.name);
    if (!pending) {
      pending = this.ensureNow(node).finally(() => this.opening.delete(node.name));
      this.opening.set(node.name, pending);
    }
    return pending;
  }

  private async ensureNow(node: WorkerNode): Promise<PrepResult> {
    const current = this.channels.get(node.name);
    if (current && !hasEnded(current.tunnel)) {
      // The forwarded socket may be gone (worker rebooted, path cleaned up) though our ssh lives on.
      const stillOurs = current.socketId !== undefined && (await node.socketId(current.prep.socket)) === current.socketId;
      if (stillOurs) return current.prep;
      current.tunnel.kill();
    }
    const prep = await this.open(node);
    if (current) void this.onReopen(node).catch(() => {});
    return prep;
  }

  private async open(node: WorkerNode): Promise<PrepResult> {
    const inbox = ownSessionInbox();
    if (!inbox) {
      throw new ToolError("找不到主会话的收件箱（跨会话消息功能不可用？），无法接收 worker 的消息。");
    }
    const prep = await node.prepareChannel(this.masterId);
    const tunnel = node.ssh.reverseForward(prep.socket, inbox);
    let stderr = "";
    tunnel.stderr!.on("data", (chunk) => (stderr += chunk));

    try {
      const deadline = Date.now() + OPEN_TIMEOUT_MS;
      let socketId: string | undefined;
      while ((socketId = await node.socketId(prep.socket)) === undefined) {
        if (hasEnded(tunnel)) throw new ToolError(`建立反向通道失败：${stderr.trim().slice(-400)}`);
        if (Date.now() > deadline) throw new ToolError("建立反向通道超时。");
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      this.channels.set(node.name, { node, tunnel, prep, socketId });
      return prep;
    } catch (error) {
      tunnel.kill();
      throw error;
    }
  }

  private async reopenDropped(): Promise<void> {
    for (const [name, channel] of [...this.channels]) {
      if (!hasEnded(channel.tunnel) || this.opening.has(name)) continue;
      await this.ensure(channel.node).catch(() => {}); // still down: the entry stays, retried next tick
    }
  }

  close(): void {
    for (const channel of this.channels.values()) channel.tunnel.kill();
    this.channels.clear();
  }
}
