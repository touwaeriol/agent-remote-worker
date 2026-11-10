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
