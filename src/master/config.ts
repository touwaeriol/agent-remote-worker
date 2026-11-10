/** The one file a user writes: which machines are workers and how to reach them. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { PERMISSION_MODES } from "../shared/protocol.ts";
import { ToolError } from "../shared/tooling.ts";

const workerSchema = z.object({
  /** Host alias from ~/.ssh/config. Keys and ports stay in the SSH config. */
  ssh: z.string().min(1),
  /** Absolute path of `claude` on the worker; a non-interactive SSH shell often lacks it on PATH. */
  claudePath: z.string().min(1).default("claude"),
  /** `node` on the worker, when it is not next to `claude` or on PATH. */
  nodePath: z.string().min(1).default("node"),
  permissionMode: z.enum(PERMISSION_MODES).default("auto"),
  /**
   * Where projects are cloned on the worker. Trust this folder in Claude Code
   * once; the worktrees created inside it are then trusted too.
   */
  workRoot: z.string().min(1).default("~/agent-remote-worker"),
});

const configSchema = z.object({
  workers: z.record(workerSchema).refine((workers) => Object.keys(workers).length > 0, {
    message: "workers 不能为空",
  }),
  /** Refuse to dispatch when a worker has less than this share of its weekly quota left. */
  minRemainingPercent: z.number().min(0).max(100).default(10),
  /** `claude` on this machine, when it is not on PATH. */
  localClaudePath: z.string().optional(),
});

export type WorkerConfig = z.infer<typeof workerSchema>;
export type Config = z.infer<typeof configSchema>;

export function configPath(): string {
  return process.env.AGENT_REMOTE_WORKER_CONFIG ?? path.join(os.homedir(), ".claude", "workers.json");
}

const EXAMPLE = `{
  "workers": {
    "worker": {
      "ssh": "worker",
      "claudePath": "/home/USER/.local/bin/claude",
      "workRoot": "~/agent-remote-worker",
      "permissionMode": "auto"
    }
  },
  "minRemainingPercent": 10
}`;

/** Read on every call, so edits apply without restarting the session. */
export function loadConfig(): Config {
  const file = configPath();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new ToolError(
      `还没有节点配置。请创建 ${file}，例如：\n${EXAMPLE}\n` +
        "ssh 填 ~/.ssh/config 里的主机别名；claudePath 是 worker 上 claude 的绝对路径。",
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new ToolError(`节点配置 ${file} 不是合法 JSON：${(error as Error).message}`);
  }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new ToolError(`节点配置 ${file} 有问题：\n${issues.join("\n")}`);
  }
  return parsed.data;
}

/** Picks a worker by name; the name may be omitted when there is only one. */
export function pickWorker(config: Config, name?: string): [string, WorkerConfig] {
  const names = Object.keys(config.workers);
  const key = name || (names.length === 1 ? names[0] : undefined);
  if (!key) throw new ToolError(`有多个节点，请用 worker 参数指定：${names.join("、")}`);
  const worker = config.workers[key];
  if (!worker) throw new ToolError(`没有名为「${key}」的节点。可用：${names.join("、")}`);
  return [key, worker];
}
