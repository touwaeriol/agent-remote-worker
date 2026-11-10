/**
 * Workspace trust on a worker.
 *
 * Claude Code starts a background session only in a folder its user has
 * trusted. Trust lives in `~/.claude.json` as
 * `projects["<folder>"].hasTrustDialogAccepted`, and the documentation names
 * setting that key as the way to trust a folder by hand. Trusting a plain
 * folder covers the plain folders inside it, but not git checkouts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface ClaudeConfig {
  projects?: Record<string, { hasTrustDialogAccepted?: boolean } | undefined>;
  [key: string]: unknown;
}

export class TrustError extends Error {}

const defaultConfigFile = () => path.join(os.homedir(), ".claude.json");
const expandHome = (p: string) => p.replace(/^~(?=$|\/)/, os.homedir());

function readConfig(configFile: string): ClaudeConfig {
  try {
    return JSON.parse(fs.readFileSync(configFile, "utf8")) as ClaudeConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new TrustError(`无法读取 ${configFile}：${(error as Error).message}`);
  }
}

/** Whether Claude Code already trusts `dir`, directly or through a folder above it. */
export function isTrusted(dir: string, configFile = defaultConfigFile()): boolean {
  const projects = readConfig(configFile).projects ?? {};
  for (let current = path.resolve(expandHome(dir)); ; current = path.dirname(current)) {
    if (projects[current]?.hasTrustDialogAccepted) return true;
    if (path.dirname(current) === current) return false;
  }
}

/** The nearest folder at or above `dir` that is a git checkout, if any. */
function enclosingCheckout(dir: string): string | undefined {
  for (let current = dir; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    if (path.dirname(current) === current) return undefined;
  }
}

/**
 * Marks the work root as trusted, creating it if needed. Returns whether
 * anything had to change.
 *
 * Only a folder this plugin fully controls qualifies: a trust prompt exists so
 * a person can review what a folder's own settings would switch on, and an
 * empty plain folder has nothing to review.
 */
export function trustWorkRoot(root: string, configFile = defaultConfigFile()): boolean {
  const requested = path.resolve(expandHome(root));
  fs.mkdirSync(requested, { recursive: true });
  const dir = fs.realpathSync(requested);

  if (dir === fs.realpathSync(os.homedir())) {
    throw new TrustError("workRoot 不能是主目录：Claude Code 不会长期信任主目录。");
  }
  const checkout = enclosingCheckout(dir);
  if (checkout) {
    throw new TrustError(`workRoot 在 git 仓库 ${checkout} 里面：信任会记在整个仓库上，请换一个仓库之外的目录。`);
  }
  if (fs.existsSync(path.join(dir, ".claude")) || fs.existsSync(path.join(dir, ".mcp.json"))) {
    throw new TrustError(`${dir} 里已有 Claude Code 的配置（.claude 或 .mcp.json），需要你亲自确认：请在该目录运行一次 claude。`);
  }
  if (isTrusted(dir, configFile)) return false;

  // Claude Code rewrites this file while sessions run, so another writer may
  // slip in between our read and our rename. Read late, write fast, then look.
  for (let attempt = 0; attempt < 4; attempt++) {
    const config = readConfig(configFile);
    const projects = (config.projects ??= {});
    projects[dir] = { ...projects[dir], hasTrustDialogAccepted: true };

    const temporary = `${configFile}.agent-remote-worker.${process.pid}`;
    const mode = fs.existsSync(configFile) ? fs.statSync(configFile).mode & 0o777 : 0o600;
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode });
    fs.renameSync(temporary, configFile);

    if (isTrusted(dir, configFile)) return true;
  }
  throw new TrustError(`写入 ${configFile} 后信任记录仍然不在，可能有会话在同时改写这个文件。请重试。`);
}
