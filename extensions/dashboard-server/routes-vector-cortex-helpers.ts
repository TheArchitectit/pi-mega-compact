/**
 * routes-vector-cortex-helpers.ts — shared spawn-and-fetch harness for the
 * /api/vector-cortex/* route test files.
 *
 * The dashboard-server.js main block fires when the entry argv includes
 * "dashboard-server", so tests under dist/extensions/dashboard-server/ MUST
 * spawn the server as a child process rather than import launchDashboardServer.
 * Extracted from routes-vector-cortex.test.ts so per-sprint route test files
 * can share the harness without each re-implementing it.
 *
 * Reader-only: no payload bytes are ever returned by the routes under test.
 */
import { createHash } from "node:crypto";
import { rmSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

/** Locate the repo root (the directory holding `conformance/vector-cortex`). */
const HERE = dirname(fileURLToPath(import.meta.url));
export function repoRoot(from: string = HERE): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "conformance", "vector-cortex"))) return dir;
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  throw new Error("conformance corpus not found above " + from);
}

const REPO_ROOT = repoRoot();

/** SHA-256 of the REAL committed ModelManifestV1 — the health card's digest. */
export function realManifestDigest(): string {
  // guardrails-allow PREVENT-PI-004: local committed asset filesystem read (loopback)
  return createHash("sha256")
    .update(readFileSync(join(REPO_ROOT, "assets", "vector-cortex", "encoder-v1", "manifest.json")))
    .digest("hex");
}

export const SERVER_ENTRY = new URL("./server.js", import.meta.url).pathname;

export function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 6000,
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timeout"));
      setTimeout(tick, 50);
    };
    tick();
  });
}

export async function withServer<T>(
  port: string,
  dir: string,
  fn: (port: number) => Promise<T>,
): Promise<T> {
  process.env.MEGACOMPACT_DASHBOARD_PORT = port;
  // Pin loopback so the spawn-and-fetch harness stays hermetic even on a
  // machine with tailscale0 (the production auto-bind would otherwise grab the
  // tailnet IP and the localhost probe would connection-refuse). Tests that
  // need a different host can set MEGACOMPACT_DASHBOARD_HOST before calling.
  process.env.MEGACOMPACT_DASHBOARD_HOST = "127.0.0.1";
  const child = spawn(process.execPath, [SERVER_ENTRY, dir], {
    stdio: "ignore",
    env: {
      ...process.env,
      MEGACOMPACT_INDEX_DIR: dir,
    },
  });
  try {
    await waitFor(async () => {
      try {
        const raw = JSON.parse(readFileSync(join(dir, "port.pid"), "utf-8"));
        const res = await fetch(`http://localhost:${raw.port}/api/version`);
        return res.ok;
      } catch {
        return false;
      }
    });
    const raw = JSON.parse(readFileSync(join(dir, "port.pid"), "utf-8"));
    return await fn(raw.port);
  } finally {
    child.kill("SIGTERM");
    delete process.env.MEGACOMPACT_DASHBOARD_PORT;
    delete process.env.MEGACOMPACT_DASHBOARD_HOST;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Seed redacted metric rows directly on disk so the server's reader sees them. */
export async function seedEval(dir: string): Promise<void> {
  const { appendEvalRow } = await import(
    "../../src/vector-cortex/eval/persist.js"
  );
  // Buckets (inclusive): 1,5,10,25,50,100,250. 1ms→cell0, 12ms→cell3
  // (<=25), 250ms→cell6, 300ms→overflow.
  appendEvalRow(dir, [
    { session: "s1", seq: 1, event: "encode", value: 1, unit: "ms", mode: "A" },
    { session: "s1", seq: 2, event: "encode", value: 250, unit: "ms", mode: "A" },
    { session: "s1", seq: 3, event: "encode", value: 300, unit: "ms", mode: "A" },
    { session: "s1", seq: 4, event: "encode", value: 12, unit: "ms", mode: "A" },
  ]);
}
