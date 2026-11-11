/**
 * Which master session a worker session reports to.
 *
 * Every master session has its own forwarded inbox on the worker. A session's
 * route names the one it belongs to, plus how it was launched, so that a resume
 * keeps the same permission mode and model. The master rewrites the route
 * whenever it dispatches, messages or resumes the session, and the session's
 * tools and hooks read it before every message: the master that last talked to
 * a session is the one that hears from it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PermissionMode } from "../shared/protocol.ts";

export interface Route {
  /** The master's forwarded inbox on this machine. */
  socket: string;
  /** The master session's id. */
  master: string;
  permissionMode?: PermissionMode;
  model?: string;
}

export function routesDir(): string {
  return process.env.CW_ROUTES_DIR ?? path.join(os.homedir(), ".agent-remote-worker", "routes");
}

const NAME = /^[0-9A-Za-z._-]{1,128}$/;

function routeFile(dir: string, session: string): string {
  if (!NAME.test(session) || session.startsWith(".")) throw new Error(`bad session name: ${session}`);
  return path.join(dir, `${session}.json`);
}

export function readRoute(dir: string, session: string): Route | undefined {
  try {
    const route = JSON.parse(fs.readFileSync(routeFile(dir, session), "utf8")) as Route;
    return typeof route.socket === "string" && typeof route.master === "string" ? route : undefined;
  } catch {
    return undefined;
  }
}

/** Merges `update` into the session's route: fields it leaves out keep their value, null clears one. */
export function writeRoute(dir: string, session: string, update: { [K in keyof Route]?: Route[K] | null }): Route {
  const merged = Object.fromEntries(
    Object.entries({ ...readRoute(dir, session), ...update }).filter(([, value]) => value !== undefined && value !== null),
  ) as unknown as Route;
  if (!merged.socket || !merged.master) throw new Error("a route needs socket and master");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = routeFile(dir, session);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return merged;
}

export function removeRoute(dir: string, session: string): void {
  try {
    fs.rmSync(routeFile(dir, session), { force: true });
  } catch {
    // a name we never wrote a route for
  }
}

/**
 * Where a session's messages go now: its route, or else the inbox it was
 * launched with (a session started before routes existed, which belongs to no
 * master in particular).
 */
export function currentMaster(session: string, launchSocket: string): { socket: string; master?: string } {
  const route = readRoute(routesDir(), session);
  return route ? { socket: route.socket, master: route.master } : { socket: launchSocket };
}
