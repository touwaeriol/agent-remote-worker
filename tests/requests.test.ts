import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { describeToolCall, requestMessage, type PendingRequest } from "../src/shared/protocol.ts";
import { permissionOutput, questionOutput } from "../src/worker/cli.ts";
import { RequestError, answerRequest, listPending, savePending, waitForAnswer } from "../src/worker/requests.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cw-requests-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const MAIN = fileURLToPath(new URL("../src/worker/main.ts", import.meta.url));

function request(overrides: Partial<PendingRequest> = {}): PendingRequest {
  return {
    id: "abcd1234",
    kind: "permission",
    worker: "box",
    session: "cw-1",
    pid: process.pid,
    createdAt: Date.now(),
    deadline: Date.now() + 60_000,
    approval: "master",
    toolName: "Bash",
    toolInput: { command: "rm -rf dist", description: "清理构建产物" },
    ...overrides,
  };
}

test("a permission request tells the master what is asked and how to answer", () => {
  const text = requestMessage(request());
  assert.match(text, /^\[agent-remote-worker\] worker「box」会话「cw-1」的权限请求 #abcd1234/);
  assert.match(text, /命令：rm -rf dist\n说明：清理构建产物/);
  assert.match(text, /worker_answer\(worker="box", request_id="abcd1234", decision=/);
  assert.match(requestMessage(request({ approval: "user" })), /先问用户/);
  assert.match(text, /约 1 分钟内没有答复会按拒绝处理/);
  assert.match(requestMessage(request({ deadline: 0 })), /它会一直等到你答复/);
  assert.match(describeToolCall("Edit", { file_path: "/a" }), /工具：Edit\n参数：.*file_path/s);
});

test("a question request lists the questions and asks for answers in order", () => {
  const text = requestMessage(
    request({
      kind: "question",
      toolName: "AskUserQuestion",
      toolInput: { questions: [{ question: "用哪个？", multiSelect: true, options: [{ label: "A" }, { label: "B" }] }] },
    }),
  );
  assert.match(text, /的提问 #abcd1234/);
  assert.match(text, /用哪个？（可多选）\n {2}- A\n {2}- B/);
  assert.match(text, /answers=\[/);
});

test("permission answers become the hook's decision", () => {
  const suggestion = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm -rf dist" }], behavior: "allow", destination: "localSettings" };
  const req = request({ suggestions: [suggestion, { type: "setMode", mode: "acceptEdits", destination: "session" }] });

  const allow = permissionOutput(req, { kind: "permission", decision: "allow" }, "x").hookSpecificOutput;
  assert.deepEqual(allow, { hookEventName: "PermissionRequest", decision: { behavior: "allow" } });

  // remembered only for this session, never written to a settings file
  const remembered = permissionOutput(req, { kind: "permission", decision: "allow", remember: true }, "x");
  assert.deepEqual(remembered.hookSpecificOutput.decision, {
    behavior: "allow",
    updatedPermissions: [{ ...suggestion, destination: "session" }],
  });

  const deny = permissionOutput(req, { kind: "permission", decision: "deny", message: "用 npm run clean" }, "x");
  assert.equal(deny.hookSpecificOutput.decision.behavior, "deny");
  assert.match(String(deny.hookSpecificOutput.decision.message), /主节点拒绝了这个操作：用 npm run clean/);

  const none = permissionOutput(req, undefined, "超时");
  assert.deepEqual(none.hookSpecificOutput.decision, { behavior: "deny", message: "超时" });
});

test("question answers are keyed by question text, alongside the original questions", () => {
  const questions = [{ question: "Q1" }, { question: "Q2" }];
  const req = request({ kind: "question", toolName: "AskUserQuestion", toolInput: { questions } });
  const out = questionOutput(req, { kind: "question", answers: ["A"] }, "x").hookSpecificOutput;
  assert.equal(out.permissionDecision, "allow");
  assert.deepEqual((out as { updatedInput: unknown }).updatedInput, { questions, answers: { Q1: "A", Q2: "" } });
  const refused = questionOutput(req, undefined, "等 master").hookSpecificOutput;
  assert.deepEqual(refused, { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "等 master" });
});

test("requests can be listed and answered once, and vanish with their hook", async () => {
  const dir = path.join(tmp, "store");
  savePending(dir, request());
  savePending(dir, request({ id: "dead0001", pid: 999_999_999 })); // its hook is gone
  savePending(dir, request({ id: "late0001", deadline: Date.now() - 1 })); // timed out
  assert.deepEqual(listPending(dir).map((r) => r.id), ["abcd1234"]);
  assert.equal(fs.existsSync(path.join(dir, "dead0001.json")), false);

  assert.throws(() => answerRequest(dir, "abcd1234", { kind: "question", answers: ["x"] }), /是权限请求/);
  assert.throws(() => answerRequest(dir, "ffff0000", { kind: "permission", decision: "allow" }), RequestError);
  assert.throws(() => answerRequest(dir, "../etc", { kind: "permission", decision: "allow" }), /格式不对/);
  answerRequest(dir, "abcd1234", { kind: "permission", decision: "allow" });
  assert.throws(() => answerRequest(dir, "abcd1234", { kind: "permission", decision: "deny" }), /已经答复过/);
  assert.deepEqual(await waitForAnswer(dir, request()), { kind: "permission", decision: "allow" });
  assert.equal(await waitForAnswer(dir, request({ id: "beef0000", deadline: Date.now() + 50 }), 10), undefined);

  // no deadline: stays pending and keeps waiting until answered
  savePending(dir, request({ id: "f0f0f0f0", deadline: 0 }));
  assert.ok(listPending(dir).some((r) => r.id === "f0f0f0f0"));
  const waiting = waitForAnswer(dir, request({ id: "f0f0f0f0", deadline: 0 }), 10);
  setTimeout(() => answerRequest(dir, "f0f0f0f0", { kind: "permission", decision: "deny" }), 100);
  assert.deepEqual(await waiting, { kind: "permission", decision: "deny" });
});

/** A stand-in for the master session's inbox that collects what arrives. */
async function fakeInbox(file: string): Promise<{ next: () => Promise<string>; close: () => void }> {
  const queue: string[] = [];
  const waiters: Array<(text: string) => void> = [];
  const server = net.createServer((connection) => {
    connection.on("data", (chunk) => {
      const text = JSON.parse(String(chunk)).message.content as string;
      const waiter = waiters.shift();
      if (waiter) waiter(text);
      else queue.push(text);
    });
    connection.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(file, resolve));
  return {
    next: () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise((resolve) => waiters.push(resolve))),
    close: () => server.close(),
  };
}

function runWorker(args: string[], input: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN, ...args], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test("the hooks hold the session until the master answers through the CLI", { timeout: 30_000 }, async () => {
  const env = { CW_REQUESTS_DIR: path.join(tmp, "e2e") as string };
  const socket = path.join(tmp, "inbox.sock");
  const inbox = await fakeInbox(socket);
  try {
    const hookArgs = [socket, "box", "cw-1", "60", "master"];
    const permission = runWorker(
      ["hook-permission", ...hookArgs],
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "make deploy" }, permission_suggestions: [] }),
      env,
    );
    const permissionText = await inbox.next();
    const permissionId = /#([0-9a-f]+)/.exec(permissionText)![1]!;

    const listed = await runWorker(["pending"], "", env);
    assert.deepEqual(JSON.parse(listed.stdout).map((r: PendingRequest) => r.id), [permissionId]);

    const answered = await runWorker(["answer", permissionId], JSON.stringify({ kind: "permission", decision: "deny", message: "不要部署" }), env);
    assert.equal(answered.code, 0, answered.stderr);
    const decided = JSON.parse((await permission).stdout);
    assert.equal(decided.hookSpecificOutput.decision.behavior, "deny");
    assert.match(decided.hookSpecificOutput.decision.message, /不要部署/);

    const toolInput = { questions: [{ question: "分支名？", options: [{ label: "dev" }, { label: "main" }] }] };
    const question = runWorker(["hook-ask", ...hookArgs], JSON.stringify({ tool_name: "AskUserQuestion", tool_input: toolInput }), env);
    const questionId = /#([0-9a-f]+)/.exec(await inbox.next())![1]!;
    await runWorker(["answer", questionId], JSON.stringify({ kind: "question", answers: ["dev"] }), env);
    const out = JSON.parse((await question).stdout).hookSpecificOutput;
    assert.deepEqual(out.updatedInput, { ...toolInput, answers: { "分支名？": "dev" } });

    // answered requests are cleaned up
    assert.deepEqual(JSON.parse((await runWorker(["pending"], "", env)).stdout), []);
    const gone = await runWorker(["answer", questionId], JSON.stringify({ kind: "question", answers: ["x"] }), env);
    assert.equal(gone.code, 5);
  } finally {
    inbox.close();
  }
});

test("an auto-mode refusal is reported to the master and left standing", async () => {
  const socket = path.join(tmp, "denied.sock");
  const inbox = await fakeInbox(socket);
  try {
    const result = await runWorker(
      ["hook-denied", socket, "box", "cw-1"],
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /tmp/build" }, reason: "[Irreversible Local Destruction]" }),
      {},
    );
    assert.equal(result.stdout.trim(), ""); // no retry, no decision
    const text = await inbox.next();
    assert.match(text, /被 auto 模式直接拒绝了/);
    assert.match(text, /命令：rm -rf \/tmp\/build\n原因：\[Irreversible Local Destruction\]/);
  } finally {
    inbox.close();
  }
  const offline = await runWorker(["hook-denied", path.join(tmp, "nobody.sock"), "box", "cw-1"], "{}", {});
  assert.equal(offline.code, 0);
});

test("with the master unreachable the hooks refuse at once", async () => {
  const env = { CW_REQUESTS_DIR: path.join(tmp, "offline") as string };
  const args = [path.join(tmp, "nobody.sock"), "box", "cw-1", "60", "master"];
  const permission = await runWorker(["hook-permission", ...args], JSON.stringify({ tool_name: "Bash", tool_input: {} }), env);
  assert.match(JSON.parse(permission.stdout).hookSpecificOutput.decision.message, /联系不上/);
  const question = await runWorker(["hook-ask", ...args], JSON.stringify({ tool_input: { questions: [] } }), env);
  assert.equal(JSON.parse(question.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(listPending(env.CW_REQUESTS_DIR), []);
});

test("a session reports to the master its route names, and only that master may answer it", { timeout: 30_000 }, async () => {
  const env = { CW_REQUESTS_DIR: path.join(tmp, "routed"), CW_ROUTES_DIR: path.join(tmp, "routes") };
  const launchSocket = path.join(tmp, "launch.sock"); // the inbox it was started with: nobody listens there any more
  const socketA = path.join(tmp, "a.sock");
  const socketB = path.join(tmp, "b.sock");
  const [inboxA, inboxB] = await Promise.all([fakeInbox(socketA), fakeInbox(socketB)]);
  try {
    // Master A dispatched it, in default mode with a chosen model.
    const set = await runWorker(["route", "cw-9"], JSON.stringify({ socket: socketA, master: "aaaa", permissionMode: "default", model: "m1" }), env);
    assert.equal(set.code, 0, set.stderr);

    const hookArgs = [launchSocket, "box", "cw-9", "60", "master"];
    const permission = runWorker(["hook-permission", ...hookArgs], JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }), env);
    const id = /#([0-9a-f]+)/.exec(await inboxA.next())![1]!;

    const listed = JSON.parse((await runWorker(["pending"], "", env)).stdout) as PendingRequest[];
    assert.deepEqual(listed.map((r) => [r.id, r.master]), [[id, "aaaa"]]);

    const allow = JSON.stringify({ kind: "permission", decision: "allow" });
    const refused = await runWorker(["answer", id, "bbbb"], allow, env);
    assert.equal(refused.code, 5);
    assert.match(refused.stderr, /属于另一个主会话/);

    // Master B messages the session and so takes it over; the launch settings stay.
    await runWorker(["route", "cw-9"], JSON.stringify({ socket: socketB, master: "bbbb" }), env);
    const shown = JSON.parse((await runWorker(["route-show", "cw-9"], "", env)).stdout);
    assert.deepEqual(shown, { socket: socketB, master: "bbbb", permissionMode: "default", model: "m1" });
    assert.equal((await runWorker(["answer", id, "bbbb"], allow, env)).code, 0);
    assert.equal(JSON.parse((await permission).stdout).hookSpecificOutput.decision.behavior, "allow");

    const denied = await runWorker(["hook-denied", ...hookArgs.slice(0, 3)], JSON.stringify({ tool_name: "Bash", tool_input: {} }), env);
    assert.equal(denied.code, 0);
    assert.match(await inboxB.next(), /被 auto 模式直接拒绝了/);

    await runWorker(["unroute", "cw-9"], "", env);
    assert.equal((await runWorker(["route-show", "cw-9"], "", env)).stdout.trim(), "null");
    assert.equal((await runWorker(["route", "../x"], JSON.stringify({ socket: socketA, master: "aaaa" }), env)).code, 5);
  } finally {
    inboxA.close();
    inboxB.close();
  }
});

test("a fresh launch clears settings an earlier session of the same name left behind", async () => {
  const env = { CW_ROUTES_DIR: path.join(tmp, "routes-fresh") };
  await runWorker(["route", "cw-5"], JSON.stringify({ socket: "/s/a", master: "aaaa", permissionMode: "default", model: "m1" }), env);
  await runWorker(["route", "cw-5"], JSON.stringify({ socket: "/s/b", master: "bbbb", permissionMode: "auto", model: null }), env);
  assert.deepEqual(JSON.parse((await runWorker(["route-show", "cw-5"], "", env)).stdout), { socket: "/s/b", master: "bbbb", permissionMode: "auto" });
});
