/**
 * dashboard-server/routes-cosine-fp.ts — COS-FP-A cosine-FP report route.
 *
 * GET /api/cosine-fp-report — reader-only aggregate answering "what did the last
 * synthetic bench recommend for the L2 cosine threshold?". Reads the last
 * written bench-run aggregate (scripts/cosine-fp/bench-run/cosine-fp-report.json,
 * located by walking up to the repo root) + its mtime, memoized by
 * {mtime,size} (mirrors routes-vector-cortex-health.ts memoized-facts), and
 * serves the report digest + recommendation + grid summary. Reader-only: emits
 * counts + fractions + digests, never template text (EVAL-REDACT-002).
 *
 * Flag-off (MEGACOMPACT_COSINE_FP_BENCH=0) returns 404 — byte-identical
 * predecessor. Missing report file is reported as `awaiting_data` with
 * benchStatus awaiting_data — never a fabricated zero row (COS-FP-A-003).
 *
 * Guardrails: PREVENT-PI-004 (local filesystem read only), PREVENT-001
 * (JSON.parse guarded), PREVENT-011 (no `any`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RouteContext } from "./routes-core.js";
import { sendJson } from "./routes-vector-cortex-shared.js";
import { COSINE_FP_BENCH_ENABLED } from "../../src/config.js";
import { deriveVcStatus } from "./vc-status.js";
import type {
  CosineFpReportV1,
  CosineFpBenchStatus,
  CosineFpPerTypeCounts,
} from "./api-contracts/cosine-fp.js";

const MEMO_TTL_MS = 5000; // ≤5s per file state

interface MemoEntry {
  key: string;
  at: number;
  body: CosineFpReportV1;
}

let memo: MemoEntry | null = null;

/**
 * Resolve the bench-run dir (scripts/cosine-fp/bench-run/) by walking up to the
 * repo root. The test seam MEGACOMPACT_COSINE_FP_BENCH_RUN_DIR (read lazily so a
 * test can set it post-import) overrides the location so route tests can point
 * at a temp dir without touching the repo.
 */
export function benchRunDir(): string | null {
  const testRunDir = process.env.MEGACOMPACT_COSINE_FP_BENCH_RUN_DIR;
  if (testRunDir) return testRunDir;
  let dir = dirname(fileURLToPath(import.meta.url));
  const rel = join("scripts", "cosine-fp", "bench-run");
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, rel);
    try {
      // guardrails-allow PREVENT-PI-004: local bench-run dir stat (loopback)
      statSync(candidate);
      return candidate;
    } catch {
      /* keep walking */
    }
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return null;
}

/** Read + minimally validate the aggregate JSON (PREVENT-001). Returns null on
 *  any parse/shape failure — the caller treats that as awaiting_data, never as
 *  a fabricated zero row. */
function readAggregate(runDir: string): Record<string, unknown> | null {
  const p = join(runDir, "cosine-fp-report.json");
  let raw: string;
  try {
    raw = readFileSync(p, "utf8"); // guardrails-allow PREVENT-PI-004: local bench-run report read (loopback)
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function toNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Project per-content-type count entries into the contract shape (PREVENT-011). */
function projectPerType(
  raw: unknown,
): Readonly<Record<string, CosineFpPerTypeCounts>> {
  const out: Record<string, CosineFpPerTypeCounts> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const o = v as Record<string, unknown>;
    out[key] = {
      items: toNum(o.items) ?? 0,
      dup: toNum(o.dup) ?? 0,
      near: toNum(o.near) ?? 0,
      clean: toNum(o.clean) ?? 0,
    };
  }
  return out;
}

/** Project the raw aggregate into the full CosineFpReportV1 (reader-only). */
function buildBody(runDir: string, aggregate: Record<string, unknown>): CosineFpReportV1 {
  let mtime: number | null = null;
  try {
    const s = statSync(join(runDir, "cosine-fp-report.json")); // guardrails-allow PREVENT-PI-004: local stat (loopback)
    mtime = s.mtimeMs;
  } catch {
    mtime = null;
  }
  const benchStatus: CosineFpBenchStatus = aggregate.status === "ok" ? "ok" : "no_data";
  const hasData = benchStatus === "ok";
  const status = deriveVcStatus({ enabled: true, hasData, structuralOnly: false });

  const grid = aggregate.grid;
  const overrides = aggregate.overrides;
  const corpus = aggregate.corpusSummary;
  const rows = aggregate.rows;

  return {
    status,
    benchStatus,
    seed: toNum(aggregate.seed),
    grid:
      grid && typeof grid === "object"
        ? {
            lo: toNum((grid as Record<string, unknown>).lo) ?? 0,
            hi: toNum((grid as Record<string, unknown>).hi) ?? 0,
            step: toNum((grid as Record<string, unknown>).step) ?? 0,
            points: toNum((grid as Record<string, unknown>).points) ?? 0,
          }
        : null,
    corpusSummary:
      corpus && typeof corpus === "object"
        ? {
            items: toNum((corpus as Record<string, unknown>).items) ?? 0,
            pairs: toNum((corpus as Record<string, unknown>).pairs) ?? 0,
            types: Array.isArray((corpus as Record<string, unknown>).types)
              ? ((corpus as Record<string, unknown>).types as string[])
              : [],
            perType: projectPerType((corpus as Record<string, unknown>).perType),
            digest:
              typeof (corpus as Record<string, unknown>).digest === "string"
                ? ((corpus as Record<string, unknown>).digest as string)
                : null,
          }
        : null,
    rows: Array.isArray(rows) ? (rows as CosineFpReportV1["rows"]) : null,
    recommendedDefault: toNum(aggregate.recommendedDefault),
    shippedDefault: toNum(aggregate.shippedDefault) ?? 0.85,
    overrides:
      overrides && typeof overrides === "object"
        ? {
            code: toNum((overrides as Record<string, unknown>).code),
            prose: toNum((overrides as Record<string, unknown>).prose),
            mixed: toNum((overrides as Record<string, unknown>).mixed),
          }
        : null,
    fpBudget: toNum(aggregate.fpBudget),
    digest: typeof aggregate.digest === "string" ? (aggregate.digest as string) : null,
    reportFileMtime: mtime,
  };
}

function awaitingDataBody(reason: "flag" | "missing"): CosineFpReportV1 {
  const status = deriveVcStatus({
    enabled: reason !== "flag",
    hasData: false,
    structuralOnly: false,
  });
  return {
    status,
    benchStatus: reason === "flag" ? "off" : "awaiting_data",
    seed: null,
    grid: null,
    corpusSummary: null,
    rows: null,
    recommendedDefault: null,
    shippedDefault: 0.85,
    overrides: null,
    fpBudget: null,
    digest: null,
    reportFileMtime: null,
  };
}

export function handleCosineFpReport(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  if (url !== "/api/cosine-fp-report") return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }
  if (!COSINE_FP_BENCH_ENABLED()) {
    // Flag-off: 404 — byte-identical predecessor.
    sendJson(res, 404, { error: "not_found" });
    return true;
  }

  const runDir = benchRunDir();
  if (runDir === null) {
    sendJson(res, 200, awaitingDataBody("missing"));
    return true;
  }

  // Memoized-facts pattern: serve a still-fresh entry keyed on {mtime,size}.
  let size = 0;
  let mtime = 0;
  try {
    const s = statSync(join(runDir, "cosine-fp-report.json")); // guardrails-allow PREVENT-PI-004: local stat (loopback)
    size = s.size;
    mtime = s.mtimeMs;
  } catch {
    // no report on disk yet
  }
  if (size === 0 && mtime === 0) {
    sendJson(res, 200, awaitingDataBody("missing"));
    return true;
  }

  const key = `${mtime}:${size}`;
  const now = Date.now();
  if (memo !== null && memo.key === key && now - memo.at <= MEMO_TTL_MS) {
    sendJson(res, 200, memo.body);
    return true;
  }

  const aggregate = readAggregate(runDir);
  const body = aggregate === null ? awaitingDataBody("missing") : buildBody(runDir, aggregate);
  memo = { key, at: now, body };
  sendJson(res, 200, body);
  return true;
}
