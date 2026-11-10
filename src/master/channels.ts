/**
 * Keeps this session's inbox reachable from each worker.
 *
 * A channel is one SSH connection holding a reverse forward: a socket path on
 * the worker that leads to the master session's inbox. Worker sessions are
 * started knowing that path, so the path is stable per master machine and user,
 * and whichever master session opened the channel last receives the messages.
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

export class Channels {
  private readonly channels = new Map<string, Channel>();
  private readonly opening = new Map<string, Promise<PrepResult>>();
  private readonly masterId = createHash("sha256")
    .update(`${os.userInfo().username}@${os.hostname()}`)
    .digest("hex")
    .slice(0, 12);
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
      // Another master session may have re-bound the path since we opened it.
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
