/**
 * dashboard-server/routes-dedup-attribution.ts — DEDUP-ATTR tier attribution route.
 *
 * GET /api/dedup-tier-attribution?windowMs=<n> — reader-only aggregate answering
 * "L0/L1/L2/new percent of dedup decisions in window W". Reads the repo's local
 * events.log (per-repo stateDir, bounded 8 MiB tail), parses `dedup_audit` lines
 * (PREVENT-001 guarded), and sends the pure rollup with a shared-derived status.
 *
 * Flag-off (MEGACOMPACT_DEDUP_ATTR=0) returns 404 and writes NO durable cache
 * file — byte-identical predecessor. Reader-only: emits tier counts + shares,
 * never matched checkpoint paths/text, never raw user query (EVAL-REDACT-002).
 *
 * Memoization mirrors routes-vector-cortex-health.ts: an in-memory facts cache
 * keyed on {events.log mtime+size, windowMs} is served when ≤5s old, so repeated
 * dashboard polls stay cheap while any on-disk log mutation still invalidates.
 *
 * Guardrails: PREVENT-PI-004 (local filesystem read + loopback response only),
 * PREVENT-001 (JSON.parse guarded), PREVENT-011 (no `any`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

import type { RouteContext } from "./routes-core.js";
import { sendJson } from "./routes-vector-cortex-shared.js";
import { DEDUP_ATTR_ENABLED } from "../../src/config.js";
import { computeDedupTierRollup } from "../../src/vector-cortex/dedup-attr/rollup.js";
import type { DedupTierAttributionResponse } from "./api-contracts/dedup-attribution.js";
import type { DedupAuditEvent } from "../../src/vectorStore/dedup-audit.js";
import { deriveVcStatus } from "./vc-status.js";

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_TAIL_BYTES = 8 * 1024 * 1024; // 8 MiB
const MEMO_TTL_MS = 5000; // ≤5s per stateDir

interface MemoEntry {
  key: string;
  at: number;
  body: DedupTierAttributionResponse;
}

let memo: MemoEntry | null = null;

/** Parse one events.log line into a DedupAuditEvent, or null (PREVENT-001). */
function parseAuditLine(line: string): DedupAuditEvent | null {
  if (!line.includes('"dedup_audit"')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== "dedup_audit") return null;
  if (typeof obj.ts !== "string") return null;
  const tier = obj.tier;
  const status = obj.status;
  if (tier !== "L0" && tier !== "L1" && tier !== "L2" && tier !== "new") return null;
  // "skipped" = a tier matched but the degenerate-match guard declined to
  // collapse. Accepted so the line is not silently dropped from the tail; the
  // rollup below counts only deduped/passed, so tier catch-share math is
  // unchanged by its presence.
  if (
    status !== "deduped" &&
    status !== "passed" &&
    status !== "stored" &&
    status !== "skipped"
  )
    return null;
  // sessionId is never read by the rollup; a parsed line may omit richer fields.
  return { type: "dedup_audit", ts: obj.ts, tier, status, sessionId: "" };
}

/** Read the bounded tail of events.log into parsed dedup_audit events. */
function readAuditEvents(eventsPath: string): DedupAuditEvent[] {
  let buf: Buffer;
  try {
    buf = readFileSync(eventsPath); // guardrails-allow PREVENT-PI-004: local events.log read (loopback dashboard)
  } catch {
    return [];
  }
  const tail = buf.length > MAX_TAIL_BYTES ? buf.subarray(buf.length - MAX_TAIL_BYTES) : buf;
  const text = tail.toString("utf-8");
  const lines = text.split("\n");
  // Drop a leading fragment when we truncated mid-line (first line may be partial).
  const start = buf.length > MAX_TAIL_BYTES ? 1 : 0;
  const out: DedupAuditEvent[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const ev = parseAuditLine(line);
    if (ev) out.push(ev);
  }
  return out;
}

/** Resolve windowMs from the ?windowMs= query param (default 24h, capped 30d). */
function resolveWindowMs(url: string): number {
  if (!url.includes("?")) return DEFAULT_WINDOW_MS;
  const params = new URLSearchParams(url.slice(url.indexOf("?")));
  const raw = params.get("windowMs");
  if (raw == null) return DEFAULT_WINDOW_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WINDOW_MS;
  return Math.min(n, MAX_WINDOW_MS);
}

/** Best-effort durable snapshot write (never breaks the response). */
function writeDurableSnapshot(stateDir: string, rollup: DedupTierAttributionResponse): void {
  try {
    mkdirSync(dirname(join(stateDir, "dedup-tier-attribution.json")), { recursive: true });
    writeFileSync(
      join(stateDir, "dedup-tier-attribution.json"),
      `${JSON.stringify(rollup)}\n`,
      "utf-8",
    );
  } catch {
    /* best-effort — instrumentation must never break the read path */
  }
}

export function handleDedupTierAttribution(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): boolean {
  const url = req.url ?? "";
  const path = url.split("?", 1)[0] ?? url;
  if (path !== "/api/dedup-tier-attribution") return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }
  if (!DEDUP_ATTR_ENABLED()) {
    // Flag-off: 404 + no durable cache write — byte-identical predecessor.
    sendJson(res, 404, { error: "not_found" });
    return true;
  }

  const eventsPath = ctx.eventsPath;
  const windowMs = resolveWindowMs(url);
  const now = new Date();

  // Memoized-facts pattern (mirrors routes-vector-cortex-health.ts): serve a
  // still-fresh entry keyed on {events.log mtime+size, windowMs}.
  let keyBase: { mtimeMs: number; size: number } | null = null;
  try {
    const s = statSync(eventsPath); // guardrails-allow PREVENT-PI-004: local events.log stat (loopback)
    keyBase = { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    keyBase = { mtimeMs: 0, size: 0 };
  }
  const key = `${keyBase.mtimeMs}:${keyBase.size}:${windowMs}`;
  if (memo !== null && memo.key === key && now.getTime() - memo.at <= MEMO_TTL_MS) {
    sendJson(res, 200, memo.body);
    return true;
  }

  const auditEvents = readAuditEvents(eventsPath);
  const rollup = computeDedupTierRollup(auditEvents, windowMs, now);
  const status = deriveVcStatus({
    enabled: true,
    hasData: auditEvents.length > 0,
    structuralOnly: false,
  });
  const body: DedupTierAttributionResponse = { ...rollup, status };

  memo = { key, at: now.getTime(), body };
  writeDurableSnapshot(ctx.stateDir, body);

  sendJson(res, 200, body);
  return true;
}
