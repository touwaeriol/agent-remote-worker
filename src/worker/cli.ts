/** Small jobs the master runs on a worker over SSH. Each prints its answer to stdout. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { postToInbox, sessionInbox } from "../shared/inbox.ts";
import { QUESTION_FORWARDED, QUESTION_NOT_FORWARDED, workerMessage } from "../shared/protocol.ts";
import { WorkspaceError, prepareWorkspace, removeWorkspace } from "./workspace.ts";

/** What `prep` prints: where the master's inbox will appear, and how to start us. */
export interface PrepResult {
  socket: string;
  script: string;
  node: string;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

/** post <pid>: deliver stdin to that session's inbox. */
async function post(pidArg: string | undefined): Promise<number> {
  const inbox = sessionInbox(Number(pidArg));
  if (!inbox) {
    console.error(`no inbox socket for pid ${pidArg}`);
    return 3;
  }
  await postToInbox(inbox, await readStdin());
  console.log("ok");
  return 0;
}

/** prep <master-id>: make room for the master's forwarded inbox and say where it goes. */
function prep(masterId: string | undefined): number {
  const id = (masterId ?? "").replace(/[^0-9a-zA-Z_-]/g, "");
  if (!id) {
    console.error("usage: prep <master-id>");
    return 2;
  }
  let base = process.env.XDG_RUNTIME_DIR;
  if (!base || !fs.existsSync(base)) base = `/tmp/remote-workers-${os.userInfo().uid}`;
  const dir = path.join(base, "remote-workers");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // /tmp is shared: refuse a directory someone else prepared for us.
  const owner = fs.lstatSync(dir);
  if (!owner.isDirectory() || owner.uid !== os.userInfo().uid || (owner.mode & 0o077) !== 0) {
    console.error(`refusing to use ${dir}: not a private directory of this user`);
    return 4;
  }
  const socket = path.join(dir, `master-${id}.sock`);
  fs.rmSync(socket, { force: true }); // sshd refuses to forward onto an existing path
  const result: PrepResult = {
    socket,
    script: fileURLToPath(import.meta.url),
    node: process.execPath,
  };
  console.log(JSON.stringify(result));
  return 0;
}

/** trust <dir>: whether Claude Code already trusts that folder (or a parent of it). */
function trust(dirArg: string | undefined): number {
  let dir = path.resolve((dirArg ?? ".").replace(/^~(?=$|\/)/, os.homedir()));
  let projects: Record<string, { hasTrustDialogAccepted?: boolean }> = {};
  try {
    projects = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8")).projects ?? {};
  } catch {
    // no config yet means nothing is trusted
  }
  for (;;) {
    if (projects[dir]?.hasTrustDialogAccepted) {
      console.log("true");
      return 0;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  console.log("false");
  return 0;
}

/** workspace-add / workspace-remove: the request is JSON on stdin, the answer JSON on stdout. */
async function workspace(action: "add" | "remove"): Promise<number> {
  try {
    const request = JSON.parse(await readStdin());
    console.log(JSON.stringify(action === "add" ? prepareWorkspace(request) : removeWorkspace(request)));
    return 0;
  } catch (error) {
    console.error(error instanceof WorkspaceError ? error.message : String(error));
    return 5;
  }
}

interface AskUserQuestionInput {
  questions?: Array<{ question?: string; options?: Array<{ label?: string; description?: string }> }>;
}

/** Renders the built-in question tool's input as text the master can answer. */
export function formatQuestions(input: AskUserQuestionInput): string {
  const questions = input.questions ?? [];
  return questions
    .map((q, index) => {
      const options = (q.options ?? [])
        .map((option) => `  - ${option.label ?? ""}${option.description ? `：${option.description}` : ""}`)
        .join("\n");
      const title = questions.length > 1 ? `问题 ${index + 1}：${q.question ?? ""}` : (q.question ?? "");
      return options ? `${title}\n${options}` : title;
    })
    .join("\n\n");
}

/**
 * hook-ask <socket> <worker> <session>: a PreToolUse hook for AskUserQuestion.
 * Nobody sits at a worker session, so the question goes to the master instead
 * and the tool call is refused with what to do next.
 */
async function hookAsk([socket, worker, session]: string[]): Promise<number> {
  let reason = QUESTION_FORWARDED;
  try {
    const input = JSON.parse(await readStdin()).tool_input as AskUserQuestionInput;
    await postToInbox(socket ?? "", workerMessage(worker ?? "worker", session ?? "?", "question", formatQuestions(input)));
  } catch {
    reason = QUESTION_NOT_FORWARDED;
  }
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  return 0;
}

export async function runCli(command: string | undefined, args: string[]): Promise<number> {
  switch (command) {
    case "workspace-add":
      return workspace("add");
    case "workspace-remove":
      return workspace("remove");
    case "hook-ask":
      return hookAsk(args);
    case "post":
      return post(args[0]);
    case "prep":
      return prep(args[0]);
    case "trust":
      return trust(args[0]);
    default:
      console.error("usage: worker.js serve | post <pid> | prep <master-id> | trust <dir>");
      return 2;
  }
}
