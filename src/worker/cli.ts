/** Small jobs the master runs on a worker over SSH. Each prints its answer to stdout. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { postToInbox, sessionInbox } from "../shared/inbox.ts";
import {
  PERMISSION_NOT_FORWARDED,
  PERMISSION_TIMED_OUT,
  autoDeniedMessage,
  QUESTION_NOT_FORWARDED,
  QUESTION_TIMED_OUT,
  permissionDenied,
  questionTexts,
  rememberable,
  requestMessage,
  type PendingRequest,
  type RequestAnswer,
} from "../shared/protocol.ts";
import {
  RequestError,
  answerRequest,
  listPending,
  newRequestId,
  removeRequest,
  requestsDir,
  savePending,
  waitForAnswer,
} from "./requests.ts";
import { currentMaster, readRoute, removeRoute, routesDir, writeRoute } from "./routes.ts";
import { TrustError, isTrusted, trustWorkRoot } from "./trust.ts";
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
  if (!base || !fs.existsSync(base)) base = `/tmp/agent-remote-worker-${os.userInfo().uid}`;
  const dir = path.join(base, "agent-remote-worker");
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
  console.log(isTrusted(dirArg ?? ".") ? "true" : "false");
  return 0;
}

/** trust-root <dir>: trust the work root without the interactive prompt; prints whether it changed. */
function trustRoot(dirArg: string | undefined): number {
  if (!dirArg) {
    console.error("usage: trust-root <dir>");
    return 2;
  }
  try {
    console.log(trustWorkRoot(dirArg) ? "trusted" : "already");
    return 0;
  } catch (error) {
    console.error(error instanceof TrustError ? error.message : String(error));
    return 5;
  }
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

/** What a PermissionRequest hook prints for the master's answer, or for none. */
export function permissionOutput(request: PendingRequest, answer: RequestAnswer | undefined, fallback: string) {
  let decision: Record<string, unknown>;
  if (answer?.kind === "permission" && answer.decision === "allow") {
    const rules = answer.remember ? rememberable(request.suggestions) : [];
    decision = {
      behavior: "allow",
      // "Don't ask again" for the rest of this session only, never written to settings files.
      ...(rules.length ? { updatedPermissions: rules.map((entry) => ({ ...entry, destination: "session" })) } : {}),
    };
  } else if (answer?.kind === "permission") {
    decision = { behavior: "deny", message: permissionDenied(answer.message) };
  } else {
    decision = { behavior: "deny", message: fallback };
  }
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
}

/** What the AskUserQuestion PreToolUse hook prints: the tool runs with the master's answers, or is refused. */
export function questionOutput(request: PendingRequest, answer: RequestAnswer | undefined, fallback: string) {
  if (answer?.kind === "question") {
    const answers = Object.fromEntries(questionTexts(request.toolInput).map((text, i) => [text, answer.answers[i] ?? ""]));
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { ...request.toolInput, answers },
      },
    };
  }
  return {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: fallback },
  };
}

/**
 * hook-permission / hook-ask <socket> <worker> <session> <timeout-seconds> <approval>
 *
 * Nobody sits at a worker session, so its permission prompts and questions go
 * to the master: the hook files the request, tells the master, and holds the
 * session until the master answers or the time runs out.
 */
async function hookRequest(kind: "permission" | "question", args: string[]): Promise<number> {
  const [launchSocket = "", worker = "worker", session = "?", timeoutArg, approvalArg] = args;
  const input = JSON.parse(await readStdin());
  const { socket, master } = currentMaster(session, launchSocket);
  const timeoutMs = Math.max(0, Number(timeoutArg) || 0) * 1000; // 0: wait until answered
  const dir = requestsDir();
  const request: PendingRequest = {
    id: newRequestId(),
    kind,
    worker,
    session,
    pid: process.pid,
    createdAt: Date.now(),
    deadline: timeoutMs ? Date.now() + timeoutMs : 0,
    approval: approvalArg === "user" ? "user" : "master",
    toolName: String(input.tool_name ?? (kind === "question" ? "AskUserQuestion" : "?")),
    toolInput: (input.tool_input ?? {}) as Record<string, unknown>,
    ...(Array.isArray(input.permission_suggestions) ? { suggestions: input.permission_suggestions } : {}),
    ...(master ? { master } : {}),
  };
  const output = kind === "permission" ? permissionOutput : questionOutput;
  const cleanUp = () => removeRequest(dir, request.id);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.once(signal, () => {
      cleanUp();
      process.exit(1);
    });
  }

  try {
    savePending(dir, request);
    await postToInbox(socket, requestMessage(request));
  } catch {
    cleanUp();
    console.log(JSON.stringify(output(request, undefined, kind === "permission" ? PERMISSION_NOT_FORWARDED : QUESTION_NOT_FORWARDED)));
    return 0;
  }
  const answer = await waitForAnswer(dir, request);
  cleanUp();
  console.log(JSON.stringify(output(request, answer, kind === "permission" ? PERMISSION_TIMED_OUT : QUESTION_TIMED_OUT)));
  return 0;
}

/**
 * hook-denied <socket> <worker> <session>: a PermissionDenied hook. Auto mode
 * refused a call without asking anyone; tell the master. The refusal stands.
 */
async function hookDenied([launchSocket = "", worker = "worker", session = "?"]: string[]): Promise<number> {
  try {
    const input = JSON.parse(await readStdin());
    await postToInbox(
      currentMaster(session, launchSocket).socket,
      autoDeniedMessage(worker, session, String(input.tool_name ?? "?"), (input.tool_input ?? {}) as Record<string, unknown>, String(input.reason ?? "")),
    );
  } catch {
    // The master is out of reach: the worker still sees the refusal and can report it later.
  }
  return 0;
}

/**
 * pending: the requests on this machine still waiting for an answer, as JSON,
 * each with the master its session reports to now.
 */
function pending(): number {
  const dir = routesDir();
  const requests = listPending(requestsDir()).map((request) => {
    const { master: _recorded, ...rest } = request;
    const master = readRoute(dir, request.session)?.master;
    return master ? { ...rest, master } : rest;
  });
  console.log(JSON.stringify(requests));
  return 0;
}

/**
 * answer <id> [master-id]: hand the master's answer (JSON on stdin) to the hook
 * waiting on that request. With a master id, only a request of a session that
 * reports to that master is answered.
 */
async function answer(id: string | undefined, masterId: string | undefined): Promise<number> {
  try {
    const request = answerRequest(requestsDir(), id ?? "", JSON.parse(await readStdin()) as RequestAnswer, (found) => {
      const owner = readRoute(routesDir(), found.session)?.master;
      if (masterId && owner && owner !== masterId) {
        throw new RequestError(
          `请求 #${found.id} 属于另一个主会话派发的会话「${found.session}」，没有答复。` +
            `那个主会话会收到并处理它。确实要由你接管这个会话，先用 worker_send 给它发一条消息（之后它的汇报和请求都会交给你），再答复。`,
        );
      }
    });
    console.log(JSON.stringify(request));
    return 0;
  } catch (error) {
    console.error(error instanceof RequestError ? error.message : String(error));
    return 5;
  }
}

/** route <session>: merge the route (JSON on stdin) into the session's route and print it. */
async function route(session: string | undefined): Promise<number> {
  try {
    console.log(JSON.stringify(writeRoute(routesDir(), session ?? "", JSON.parse(await readStdin()) as Parameters<typeof writeRoute>[2])));
    return 0;
  } catch (error) {
    console.error(String(error));
    return 5;
  }
}

/** route-show <session>: the session's route as JSON, or null. */
function routeShow(session: string | undefined): number {
  console.log(JSON.stringify(readRoute(routesDir(), session ?? "") ?? null));
  return 0;
}

/** unroute <session>: forget the session's route. */
function unroute(session: string | undefined): number {
  removeRoute(routesDir(), session ?? "");
  return 0;
}

export async function runCli(command: string | undefined, args: string[]): Promise<number> {
  switch (command) {
    case "workspace-add":
      return workspace("add");
    case "workspace-remove":
      return workspace("remove");
    case "hook-ask":
      return hookRequest("question", args);
    case "hook-denied":
      return hookDenied(args);
    case "hook-permission":
      return hookRequest("permission", args);
    case "pending":
      return pending();
    case "answer":
      return answer(args[0], args[1]);
    case "route":
      return route(args[0]);
    case "route-show":
      return routeShow(args[0]);
    case "unroute":
      return unroute(args[0]);
    case "post":
      return post(args[0]);
    case "prep":
      return prep(args[0]);
    case "trust":
      return trust(args[0]);
    case "trust-root":
      return trustRoot(args[0]);
    default:
      console.error("usage: worker.js serve | post <pid> | prep <master-id> | trust <dir> | pending | answer <id> [master-id] | route <session> | route-show <session> | unroute <session>");
      return 2;
  }
}
