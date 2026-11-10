import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pickWorker, type Config } from "../src/master/config.ts";
import { shPath, shq } from "../src/master/exec.ts";
import { parseUsage, remainingPercent } from "../src/master/usage.ts";
import { describeSession } from "../src/master/worker-node.ts";
import { inboxFrame, postToInbox } from "../src/shared/inbox.ts";
import { taskBrief, workerMessage } from "../src/shared/protocol.ts";

test("shq survives quotes and shell metacharacters", () => {
  assert.equal(shq("it's $HOME; rm -rf /"), `'it'\\''s $HOME; rm -rf /'`);
});

test("shPath keeps a leading tilde expandable and quotes the rest", () => {
  assert.equal(shPath("~"), "~");
  assert.equal(shPath("~/my repo"), "~/'my repo'");
  assert.equal(shPath("/srv/app"), "'/srv/app'");
  assert.equal(shPath("~user/x"), "'~user/x'");
});

test("parseUsage reads the quota lines and the weekly figure", () => {
  const result = [
    "You are currently using your subscription",
    "",
    "Current session: 19% used · resets Nov 10, 12:10pm",
    "Current week (all models): 93% used · resets Nov 11, 7am",
    "Current week (Fable): 81% used · resets Nov 11, 7am",
    "",
    "Last 24h · 691 requests",
  ].join("\n");
  const usage = parseUsage(JSON.stringify({ type: "result", result }));
  assert.equal(usage.lines.length, 3);
  assert.equal(usage.weekUsedPercent, 93);
  assert.equal(remainingPercent(usage), 7);
});

test("parseUsage rejects output without quota lines", () => {
  assert.throws(() => parseUsage(JSON.stringify({ result: "Not logged in" })), /没有用量信息/);
  assert.throws(() => parseUsage("garbage"), /无法解析/);
});

test("pickWorker defaults to the only worker and names the choices otherwise", () => {
  const one = { workers: { a: { ssh: "a" } } } as unknown as Config;
  assert.equal(pickWorker(one)[0], "a");
  const two = { workers: { a: { ssh: "a" }, b: { ssh: "b" } } } as unknown as Config;
  assert.throws(() => pickWorker(two), /a、b/);
  assert.throws(() => pickWorker(two, "c"), /没有名为「c」/);
  assert.equal(pickWorker(two, "b")[0], "b");
});

test("describeSession flags an exited process", () => {
  const line = describeSession({ id: "abc123", name: "cw-1", state: "stopped", cwd: "/w" });
  assert.match(line, /abc123 {2}cw-1 {2}已停止/);
  assert.match(line, /worker_resume/);
  // a session that just started has no pid yet but is not dead
  assert.doesNotMatch(describeSession({ id: "abc123", state: "working" }), /worker_resume/);
});

test("messages carry who sent them and how to answer", () => {
  const message = workerMessage("box", "cw-1", "question", " A or B? ");
  assert.match(message, /^\[agent-remote-worker\] worker「box」会话「cw-1」的提问：\nA or B\?/);
  assert.match(message, /worker_send\(worker="box", session="cw-1"/);
  assert.match(taskBrief("do it"), /任务：\ndo it$/);
});

test("postToInbox writes one frame and rejects when nobody listens", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cw-test-"));
  const socketPath = path.join(dir, "inbox.sock");
  const received = new Promise<string>((resolve) => {
    // like a session: reads the line and keeps the connection open
    const server = net.createServer((connection) => {
      connection.on("data", (chunk) => {
        server.close();
        resolve(String(chunk));
      });
      connection.on("error", () => {});
    });
    server.listen(socketPath);
  });
  await postToInbox(socketPath, "hello");
  assert.equal(await received, inboxFrame("hello"));
  assert.deepEqual(JSON.parse(await received), {
    type: "user",
    message: { role: "user", content: "hello" },
  });
  await assert.rejects(postToInbox(path.join(dir, "missing.sock"), "x"));

  // like a forward whose far end is gone: accepts, then hangs up
  const deadPath = path.join(dir, "dead.sock");
  const dead = net.createServer((connection) => connection.destroy());
  await new Promise<void>((resolve) => dead.listen(deadPath, resolve));
  try {
    await assert.rejects(postToInbox(deadPath, "x"));
  } finally {
    dead.close();
  }
  fs.rmSync(dir, { recursive: true });
});
