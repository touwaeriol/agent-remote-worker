/**
 * Preparing code on a worker before a session starts.
 *
 * Each project is cloned once under the work root. Every dispatched task gets
 * its own git worktree of that clone, so tasks on one project never share files.
 *
 *   <root>/repos/<project>-<id>/                      the one clone
 *   <root>/sessions/<project>-<id>/<session>/          where the session starts
 *   <root>/sessions/<project>-<id>/<session>/<project> its worktree
 *
 * The session starts in a plain folder around the worktree, not in the worktree:
 * Claude Code lets a plain folder inherit trust from the work root, but asks
 * again for every git checkout, and nobody is there to answer.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface WorkspaceRequest {
  /** The worker's work root; may start with `~`. */
  root: string;
  url: string;
  /** The commit the task starts from; it must be reachable from the remote. */
  commit: string;
  session: string;
}

export interface Workspace {
  /** The folder the session starts in. */
  path: string;
  /** The worktree inside it, where the code is. */
  codeDir: string;
  /** The local branch checked out there. */
  localBranch: string;
  /** Whether this call cloned the project for the first time. */
  cloned: boolean;
}

export class WorkspaceError extends Error {}

const SESSIONS = "sessions";
const CLONE_TIMEOUT_MS = 10 * 60_000;

const expandHome = (p: string) => p.replace(/^~(?=$|\/)/, os.homedir());
const safeName = (value: string) => value.replace(/[^0-9A-Za-z._-]/g, "-").replace(/^[.-]+/, "") || "x";

/** "git@host:team/app.git" → "app" */
export function projectName(url: string): string {
  const last = url.replace(/[/\\]+$/, "").split(/[/:\\]/).pop() ?? "";
  return safeName(last.replace(/\.git$/, "")) || "project";
}

/** Where a project and one session's worktree live under the work root. */
export function workspacePaths(root: string, url: string, session: string) {
  const base = `${projectName(url)}-${createHash("sha256").update(url).digest("hex").slice(0, 8)}`;
  const absoluteRoot = path.resolve(expandHome(root));
  const sessionDir = path.join(absoluteRoot, SESSIONS, base, safeName(session));
  return {
    root: absoluteRoot,
    repo: path.join(absoluteRoot, "repos", base),
    sessionDir,
    worktree: path.join(sessionDir, projectName(url)),
    localBranch: `rw/${safeName(session)}`,
  };
}

/** `showProgress` lets git write its progress to our stderr, which the master is reading. */
function git(cwd: string | undefined, args: string[], timeoutMs = 120_000, showProgress = false): string {
  try {
    return execFileSync("git", cwd ? ["-C", cwd, ...args] : args, {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", showProgress ? "inherit" : "pipe"],
      // Nobody is there to answer a credential or host-key prompt.
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
      },
    }).trim();
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    throw new WorkspaceError(`git ${args[0]} 失败${stderr ? `：${stderr.slice(-500)}` : ""}`);
  }
}

export function prepareWorkspace(request: WorkspaceRequest): Workspace {
  const paths = workspacePaths(request.root, request.url, request.session);
  fs.mkdirSync(paths.root, { recursive: true });

  const cloned = !fs.existsSync(path.join(paths.repo, ".git"));
  if (cloned) {
    fs.mkdirSync(path.dirname(paths.repo), { recursive: true });
    git(undefined, ["clone", "--progress", request.url, paths.repo], CLONE_TIMEOUT_MS, true);
  } else {
    git(paths.repo, ["fetch", "--progress", "--prune", "origin"], CLONE_TIMEOUT_MS, true);
  }

  try {
    git(paths.repo, ["cat-file", "-e", `${request.commit}^{commit}`]);
  } catch {
    throw new WorkspaceError(`提交 ${request.commit.slice(0, 12)} 不在远端仓库里，主节点需要先推送。`);
  }
  if (fs.existsSync(paths.sessionDir)) {
    throw new WorkspaceError(`会话名「${request.session}」在这个项目上已有工作目录 ${paths.sessionDir}，请换一个名字。`);
  }
  git(paths.repo, ["worktree", "prune"]);
  fs.mkdirSync(paths.sessionDir, { recursive: true });
  git(paths.repo, ["worktree", "add", "--quiet", "-B", paths.localBranch, paths.worktree, request.commit]);
  return { path: paths.sessionDir, codeDir: paths.worktree, localBranch: paths.localBranch, cloned };
}

export interface RemoveRequest {
  root: string;
  /** A session folder previously returned by `prepareWorkspace` as `path`. */
  path: string;
  /** Remove even when it holds work that exists nowhere else. */
  force?: boolean;
}

/** Removes a session's worktree. Returns a reason instead when that would lose work. */
export function removeWorkspace(request: RemoveRequest): { removed: boolean; reason?: string } {
  const sessionDir = path.resolve(request.path);
  const managed = path.join(path.resolve(expandHome(request.root)), SESSIONS) + path.sep;
  if (!sessionDir.startsWith(managed)) return { removed: false, reason: "不是本插件创建的工作目录，未删除" };
  if (!fs.existsSync(sessionDir)) return { removed: false, reason: "工作目录已不存在" };
  const inside = fs.readdirSync(sessionDir).map((entry) => path.join(sessionDir, entry));
  const worktree = inside.find((entry) => fs.existsSync(path.join(entry, ".git")));
  if (!worktree) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    return { removed: true };
  }

  if (!request.force) {
    const uncommitted = git(worktree, ["status", "--porcelain"]).split("\n").filter(Boolean).length;
    const unpushed = Number(git(worktree, ["rev-list", "--count", "HEAD", "--not", "--remotes"]));
    if (uncommitted || unpushed) {
      const parts = [
        uncommitted ? `${uncommitted} 个未提交的改动` : "",
        unpushed ? `${unpushed} 个未推送的提交` : "",
      ].filter(Boolean);
      return { removed: false, reason: `工作目录里还有${parts.join("和")}` };
    }
  }
  const repo = path.dirname(git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const branch = git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]);
  git(repo, ["worktree", "remove", "--force", worktree]);
  fs.rmSync(sessionDir, { recursive: true, force: true });
  if (branch.startsWith("rw/")) {
    try {
      git(repo, ["branch", "-D", branch]);
    } catch {
      // the branch may be checked out elsewhere; leaving it is harmless
    }
  }
  return { removed: true };
}
