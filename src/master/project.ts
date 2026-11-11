/** What the master knows about the code it is about to hand to a worker. */
import path from "node:path";
import { ToolError } from "../shared/tooling.ts";
import { run } from "./exec.ts";

export interface Project {
  /** Top of the working tree on this machine. */
  dir: string;
  url: string;
  branch: string;
  commit: string;
  /** Files changed here but not committed; a worker cannot see them. */
  uncommitted: number;
  /** Commits that no remote branch has yet; a worker cannot fetch them. */
  unpushed: number;
}

async function git(dir: string, ...args: string[]): Promise<string | undefined> {
  const result = await run("git", ["-C", dir, ...args], { timeoutMs: 30_000 });
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/** Reads the git state of `dir`; undefined when it is not inside a repository. */
export async function inspectProject(dir: string): Promise<Project | undefined> {
  const top = await git(dir, "rev-parse", "--show-toplevel");
  if (!top) return undefined;

  const url = await git(top, "remote", "get-url", "origin");
  if (!url) throw new ToolError(`${top} 没有名为 origin 的远端，worker 无法拉取这个项目。`);
  const branch = await git(top, "rev-parse", "--abbrev-ref", "HEAD");
  const commit = await git(top, "rev-parse", "HEAD");
  if (!commit) throw new ToolError(`${top} 还没有任何提交。`);
  if (!branch || branch === "HEAD") {
    throw new ToolError(`${top} 当前不在任何分支上（分离 HEAD），worker 不知道该把结果推到哪里。请先切到一个分支。`);
  }
  const status = (await git(top, "status", "--porcelain")) ?? "";
  const unpushed = Number((await git(top, "rev-list", "--count", "HEAD", "--not", "--remotes")) ?? 0);
  return {
    dir: path.resolve(top),
    url,
    branch,
    commit,
    uncommitted: status.split("\n").filter(Boolean).length,
    unpushed,
  };
}

/** Why a worker would not see the same code as the master, if anything. */
export function syncProblems(project: Project): string[] {
  return [
    project.unpushed ? `有 ${project.unpushed} 个提交还没有推送到远端` : "",
    project.uncommitted ? `有 ${project.uncommitted} 个文件的改动还没有提交` : "",
  ].filter(Boolean);
}

/** Where a session starts: a commit, and the remote branch it came from when there is one. */
export interface StartPoint {
  commit: string;
  /** The branch on origin that `ref` named, if it named one. */
  branch?: string;
}

/**
 * Resolves `ref` to a commit a worker can fetch from origin: a branch or tag on
 * origin (an `origin/` prefix is fine), or a commit id.
 */
export async function resolveStart(project: Project, ref: string): Promise<StartPoint> {
  const name = ref.trim().replace(/^origin\//, "").replace(/^refs\/heads\//, "");
  if (!name) throw new ToolError("base_ref 不能为空。");
  const lsRemote = async (pattern: string) => {
    const result = await run("git", ["-C", project.dir, "ls-remote", "origin", pattern], { timeoutMs: 60_000 });
    if (result.code !== 0) throw new ToolError(`无法查询远端 origin：${result.stderr.trim().slice(-300)}`);
    return result.stdout.trim().split("\n").filter(Boolean).map((line) => line.split(/\s+/));
  };
  const heads = await lsRemote(`refs/heads/${name}`);
  if (heads[0]) return { commit: heads[0][0]!, branch: name };
  const tags = await lsRemote(`refs/tags/${name}*`);
  const tag = tags.find(([, refName]) => refName === `refs/tags/${name}^{}`) ?? tags.find(([, refName]) => refName === `refs/tags/${name}`);
  if (tag) return { commit: tag[0]! };
  if (/^[0-9a-f]{7,40}$/i.test(name)) {
    const full = await git(project.dir, "rev-parse", "--verify", "--quiet", `${name}^{commit}`);
    if (full) return { commit: full };
    if (name.length === 40) return { commit: name.toLowerCase() };
    throw new ToolError(`本机找不到提交 ${name}，无法确认完整的提交号。请给完整的 40 位提交号，或给远端分支名。`);
  }
  throw new ToolError(`base_ref「${ref}」在 origin 上既不是分支也不是标签，也不像提交号。`);
}

/** Refuses a name git would not take as a branch. */
export async function checkBranchName(dir: string, name: string): Promise<string> {
  const branch = name.trim().replace(/^origin\//, "").replace(/^refs\/heads\//, "");
  const result = await run("git", ["-C", dir, "check-ref-format", "--branch", branch], { timeoutMs: 10_000 });
  if (!branch || result.code !== 0) throw new ToolError(`deliver_branch「${name}」不是合法的分支名。`);
  return branch;
}
