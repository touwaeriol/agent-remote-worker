/**
 * Permission prompts and questions a worker session is waiting on.
 *
 * The hook that raises a request writes it to a file and waits; the master
 * answers by writing a second file next to it over SSH. Files rather than a
 * socket, so a request survives the master losing its connection for a while.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PendingRequest, RequestAnswer } from "../shared/protocol.ts";

/** A refusal the master should read: the request is gone, or the answer does not fit it. */
export class RequestError extends Error {}

export function requestsDir(): string {
  return process.env.CW_REQUESTS_DIR ?? path.join(os.homedir(), ".agent-remote-worker", "requests");
}

const ID = /^[0-9a-f]{4,16}$/;
const pendingFile = (dir: string, id: string) => path.join(dir, `${id}.json`);
const answerFile = (dir: string, id: string) => path.join(dir, `${id}.answer.json`);

export function newRequestId(): string {
  return randomBytes(4).toString("hex");
}

function writeAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function savePending(dir: string, request: PendingRequest): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomic(pendingFile(dir, request.id), request);
}

export function removeRequest(dir: string, id: string): void {
  fs.rmSync(pendingFile(dir, id), { force: true });
  fs.rmSync(answerFile(dir, id), { force: true });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readPending(dir: string, id: string): PendingRequest | undefined {
  let request: PendingRequest;
  try {
    request = JSON.parse(fs.readFileSync(pendingFile(dir, id), "utf8"));
  } catch {
    return undefined;
  }
  // The hook gave up or was killed: nobody is waiting for an answer any more.
  if (!isAlive(request.pid) || (request.deadline && request.deadline < Date.now())) {
    removeRequest(dir, id);
    return undefined;
  }
  return request;
}

/** Requests still being waited on, oldest first. Clears out those whose hook is gone. */
export function listPending(dir: string): PendingRequest[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => /^([0-9a-f]+)\.json$/.exec(name)?.[1])
    .filter((id): id is string => id !== undefined)
    .map((id) => readPending(dir, id))
    .filter((request): request is PendingRequest => request !== undefined)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Hands an answer to the hook waiting on `id`. */
export function answerRequest(
  dir: string,
  id: string,
  answer: RequestAnswer,
  /** Throws a RequestError when this caller may not answer the request. */
  check?: (request: PendingRequest) => void,
): PendingRequest {
  if (!ID.test(id)) throw new RequestError(`请求编号「${id}」格式不对。`);
  const request = readPending(dir, id);
  if (!request) throw new RequestError(`没有待答复的请求 #${id}：它可能已经超时、已被答复，或会话已经停止。`);
  if (request.kind !== answer.kind) {
    throw new RequestError(
      request.kind === "permission"
        ? `#${id} 是权限请求，请用 decision="allow" 或 "deny" 答复。`
        : `#${id} 是提问，请用 answers 答复。`,
    );
  }
  check?.(request);
  if (fs.existsSync(answerFile(dir, id))) throw new RequestError(`请求 #${id} 已经答复过了。`);
  writeAtomic(answerFile(dir, id), answer);
  return request;
}

/** Waits for the master's answer until the request's deadline (forever when it has none); undefined when none came. */
export async function waitForAnswer(dir: string, request: PendingRequest, intervalMs = 500): Promise<RequestAnswer | undefined> {
  const file = answerFile(dir, request.id);
  for (;;) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as RequestAnswer;
    } catch {
      // not answered yet (or caught mid-rename: try again)
    }
    if (request.deadline && Date.now() >= request.deadline) return undefined;
    const left = request.deadline ? Math.max(0, request.deadline - Date.now()) : intervalMs;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, left)));
  }
}
