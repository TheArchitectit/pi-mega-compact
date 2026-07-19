/**
 * dashboard-server/state.ts — local runtime log + version state.
 *
 * The dashboard server is spawned as a DETACHED child. When it is launched with
 * `stdio: "ignore"` (the old default) any crash before the first console.log is
 * invisible — there is no log to "check". We therefore mirror every lifecycle
 * line to a file in the state dir so a failed start is always diagnosable. The
 * launcher also captures stderr, so this doubles as defense-in-depth.
 */

import { appendFileSync } from "node:fs";

let LOG_PATH: string | null = null;

export function setLogPath(path: string | null): void {
  LOG_PATH = path;
}

export function log(...parts: unknown[]): void {
  const line = `[mega-compact][dashboard] ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}`;
  // eslint-disable-next-line no-console
  console.error(line); // stderr — captured by the launcher pipe
  if (LOG_PATH) {
    try { appendFileSync(LOG_PATH, new Date().toISOString() + " " + line + "\n"); } catch { /* non-fatal */ }
  }
}

/** Package version of this extension, surfaced in the dashboard header. */
export let dashboardServerVersion = "0.0.0";

export function setDashboardServerVersion(v: string): void {
  dashboardServerVersion = v;
}
