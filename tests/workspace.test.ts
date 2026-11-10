import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { inspectProject, syncProblems } from "../src/master/project.ts";
import { taskBrief } from "../src/shared/protocol.ts";
import { formatQuestions } from "../src/worker/cli.ts";
import { prepareWorkspace, projectName, removeWorkspace, workspacePaths } from "../src/worker/workspace.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();

let tmp: string;
let remote: string; // the shared remote
let master: string; // the master's checkout
let root: string; // the worker's work root

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rw-ws-"));
  remote = path.join(tmp, "remote.git");
  master = path.join(tmp, "master");
  root = path.join(tmp, "work");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
  execFileSync("git", ["clone", "--quiet", remote, master], { stdio: "ignore" });
  fs.writeFileSync(path.join(master, "a.txt"), "one\n");
  git(master, "add", ".");
  git(master, "commit", "--quiet", "-m", "first");
  git(master, "push", "--quiet", "origin", "HEAD:main");
  git(master, "branch", "--quiet", "-M", "main");
  git(master, "fetch", "--quiet", "origin");
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("projectName reads the last path segment of any remote form", () => {
  assert.equal(projectName("git@github.com:team/app.git"), "app");
  assert.equal(projectName("https://example.com/team/My App/"), "My-App");
  assert.equal(projectName("/srv/git/remote.git"), "remote");
});

test("workspacePaths keeps one clone per remote and one worktree per session", () => {
  const a = workspacePaths("/w", "git@h:t/app.git", "cw-1");
  const b = workspacePaths("/w", "git@h:t/app.git", "cw-2");
  const other = workspacePaths("/w", "git@h:other/app.git", "cw-1");
  assert.equal(a.repo, b.repo);
  assert.notEqual(a.worktree, b.worktree);
  assert.notEqual(a.repo, other.repo);
  assert.ok(a.worktree.startsWith(a.sessionDir + "/"));
  assert.ok(a.sessionDir.startsWith("/w/sessions/"));
});

test("inspectProject reports what a worker could not see", async () => {
  const clean = await inspectProject(master);
  assert.ok(clean);
  assert.equal(clean.branch, "main");
  assert.equal(clean.url, remote);
  assert.deepEqual(syncProblems(clean), []);

  fs.writeFileSync(path.join(master, "b.txt"), "local\n");
  const dirty = await inspectProject(master);
  assert.match(syncProblems(dirty!).join(), /1 个文件的改动还没有提交/);
  git(master, "add", ".");
  git(master, "commit", "--quiet", "-m", "local only");
  const ahead = await inspectProject(master);
  assert.match(syncProblems(ahead!).join(), /1 个提交还没有推送/);
  git(master, "reset", "--quiet", "--hard", "origin/main");

  assert.equal(await inspectProject(os.tmpdir()), undefined);
});

test("a session gets its own worktree at the master's commit, and cleanup protects unpushed work", () => {
  const commit = git(master, "rev-parse", "HEAD");
  const first = prepareWorkspace({ root, url: remote, commit, session: "cw-1" });
  assert.equal(first.cloned, true);
  assert.equal(first.localBranch, "rw/cw-1");
  assert.equal(git(first.codeDir, "rev-parse", "HEAD"), commit);
  assert.equal(fs.readFileSync(path.join(first.codeDir, "a.txt"), "utf8"), "one\n");
  // the session starts in a plain folder around the worktree, which is not itself a checkout
  assert.equal(path.dirname(first.codeDir), first.path);
  assert.equal(fs.existsSync(path.join(first.path, ".git")), false);

  const second = prepareWorkspace({ root, url: remote, commit, session: "cw-2" });
  assert.equal(second.cloned, false);
  assert.notEqual(second.path, first.path);
  assert.throws(() => prepareWorkspace({ root, url: remote, commit, session: "cw-1" }), /已有工作目录/);
  assert.throws(
    () => prepareWorkspace({ root, url: remote, commit: "0".repeat(40), session: "cw-3" }),
    /不在远端仓库里/,
  );

  // work that exists only in the worktree blocks removal
  fs.writeFileSync(path.join(first.codeDir, "new.txt"), "wip\n");
  assert.match(removeWorkspace({ root, path: first.path }).reason ?? "", /1 个未提交的改动/);
  git(first.codeDir, "add", ".");
  git(first.codeDir, "commit", "--quiet", "-m", "work");
  assert.match(removeWorkspace({ root, path: first.path }).reason ?? "", /1 个未推送的提交/);

  // delivered the way the brief says: push the worktree's HEAD to the master's branch
  git(first.codeDir, "push", "--quiet", "origin", "HEAD:main");
  git(first.codeDir, "fetch", "--quiet", "origin");
  assert.deepEqual(removeWorkspace({ root, path: first.path }), { removed: true });
  assert.equal(fs.existsSync(first.path), false);

  assert.deepEqual(removeWorkspace({ root, path: second.path, force: true }), { removed: true });
  assert.match(removeWorkspace({ root, path: master }).reason ?? "", /不是本插件创建/);
});

test("the brief states the sync rules only when code was prepared", () => {
  const withCode = taskBrief("fix it", { url: "git@h:t/app.git", branch: "dev", commit: "abcdef1234567890", localBranch: "rw/cw-1", dir: "/w/sessions/app/cw-1/app" });
  assert.match(withCode, /git push origin HEAD:dev/);
  assert.match(withCode, /密钥已经配置好/);
  assert.match(withCode, /abcdef123456（/);
  assert.doesNotMatch(taskBrief("look around"), /git push/);
  assert.doesNotMatch(withCode, /独立分支上提交/);
});

test("formatQuestions keeps the question and its options", () => {
  const text = formatQuestions({
    questions: [{ question: "A 还是 B？", options: [{ label: "A", description: "快" }, { label: "B" }] }],
  });
  assert.equal(text, "A 还是 B？\n  - A：快\n  - B");
});
