#!/usr/bin/env node
// Drives the built master server over stdio, the way Claude Code would.
//
//   node tests/drive.mjs [--hold SECONDS] TOOL '{"json":"args"}' [TOOL ARGS ...]
//
// Calls each tool in order and prints its result. With no tools, lists them.
// --hold keeps the server (and so the reverse channel) open afterwards, so a
// worker's reports can still reach the session that ran this script.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const hold = argv[0] === "--hold" ? Number(argv.splice(0, 2)[1]) : 0;

const server = spawn(process.execPath, [fileURLToPath(new URL("../dist/master.js", import.meta.url))], {
  stdio: ["pipe", "pipe", "inherit"],
});
const lines = createInterface({ input: server.stdout })[Symbol.asyncIterator]();
let nextId = 0;

async function rpc(method, params) {
  const id = nextId++;
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  for (;;) {
    const { value, done } = await lines.next();
    if (done) throw new Error("server exited");
    const message = JSON.parse(value);
    if (message.id === id) return message.result ?? Promise.reject(new Error(JSON.stringify(message.error)));
  }
}

const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "drive", version: "0" },
});
server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
console.log("server:", JSON.stringify(init.serverInfo));

let failed = false;
if (argv.length === 0) {
  for (const tool of (await rpc("tools/list", {})).tools) console.log(" -", tool.name);
}
for (let i = 0; i < argv.length; i += 2) {
  const result = await rpc("tools/call", { name: argv[i], arguments: JSON.parse(argv[i + 1]) });
  failed ||= Boolean(result.isError);
  console.log(`\n== ${argv[i]}${result.isError ? " (ERROR)" : ""}\n${result.content[0].text}`);
}
if (hold) {
  console.log(`\nholding the server open for ${hold}s ...`);
  await new Promise((resolve) => setTimeout(resolve, hold * 1000));
}
server.stdin.end();
process.exitCode = failed ? 1 : 0;
