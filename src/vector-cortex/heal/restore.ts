/**
 * vector-cortex/heal/restore.ts — VC6B exact source restoration orchestrator.
 *
 * Turns a `RestoreRequestV1` into a `RestoreResultV1` by consulting, per span,
 * the two EXACT sources in `restore-readers.ts` — an indexed exact shard first,
 * then a ledger range scan — and inserting bytes only after they hash to the
 * digest the request pinned.
 *
 * ORDER OF OPERATIONS IS THE CONTRACT.
 *
 *   1. BOUNDS, BEFORE ANY READER TOUCH. The span count and the aggregate
 *      requested byte span are computed PURELY FROM THE REQUEST (`byteEnd -
 *      byteStart`, which needs no source at all) and checked first. On breach we
 *      return immediately, having never read `reader.exactShards` or
 *      `reader.ledgerEvents`. This is HEAL-LIMIT-002: an oversized request must
 *      not be able to make the restorer walk the ledger even once, so the check
 *      cannot be "inside the loop, before the read" — it must be before the loop
 *      exists. The acceptance corpus proves it by passing EMPTY readers with an
 *      over-limit request: a reader-touching implementation would still return
 *      "missing" rather than "limit".
 *
 *   2. EXACT SHARD, then LEDGER, then MISSING. Sources are tried strongest-first.
 *      A digest mismatch anywhere is recorded and the span is NOT restored — the
 *      restorer never downgrades to "closest available bytes".
 *
 *   3. MODE from what actually happened, not from what was attempted. A = every
 *      span came from a shard; B = all restored, at least one via ledger scan;
 *      C = something is missing, and mode C STATES its semantic loss rather than
 *      hiding an incomplete restoration behind a successful-looking result.
 *
 * PURE. No storage, no console, no clock, no network — `node:crypto` (a Node
 * built-in) is the only dependency beyond types (PREVENT-PI-004 / PREVENT-011).
 * The reporter seam in `restore-emit.ts` is flag-gated; THIS arithmetic is not,
 * so flag-off is byte-identical.
 */

import type {
  RestoreFailureCode,
  RestoreReader,
  RestoreRequestV1,
  RestoreResultV1,
  RestoreSpanRequest,
  RestoreSpanResult,
} from "./restore-types.js";
import { RESTORE_LIMIT_BYTES, RESTORE_LIMIT_SPANS } from "./restore-types.js";
import { readExactShard, readLedgerSpan } from "./restore-readers.js";

/**
 * Fixed code ordering so a result's `codes` array is deterministic regardless of
 * which span failed first. Deterministic output is what lets the conformance
 * corpus pin an exact expected value.
 */
const CODE_ORDER: readonly RestoreFailureCode[] = [
  "HEAL_RESTORE_LIMIT",
  "HEAL_RESTORE_DIGEST_MISMATCH",
  "HEAL_RESTORE_SOURCE_MISSING",
  "HEAL_RESTORE_RANGE_MISMATCH",
] as const;

/** Deduplicate + sort codes into the fixed priority order. */
export function orderCodes(
  codes: readonly RestoreFailureCode[],
): readonly RestoreFailureCode[] {
  const seen = new Set(codes);
  return CODE_ORDER.filter((c) => seen.has(c));
}

/**
 * Total bytes the request ASKS for, derived from the ranges alone. Negative or
 * inverted ranges contribute 0 rather than reducing the total — an inverted span
 * must never be usable to smuggle a large request under the bound.
 */
function requestedBytes(spans: readonly RestoreSpanRequest[]): number {
  let total = 0;
  for (const s of spans) {
    const len = s.range.byteEnd - s.range.byteStart;
    total += len > 0 ? len : 0;
  }
  return total;
}

/** The immediate over-limit result: nothing read, everything missing. */
function limitExceeded(request: RestoreRequestV1): RestoreResultV1 {
  return {
    schema: "restore-result-v1",
    sessionId: request.sessionId,
    mode: "C",
    restored: [],
    missing: request.spans.map((s) => s.nodeId),
    semanticLossStated: true,
    codes: ["HEAL_RESTORE_LIMIT"],
  };
}

/**
 * Restore the exact original bytes for every requested span.
 *
 * Never throws: a request naming spans no source covers yields a mode-C result
 * that discloses the loss, not an exception (PRACTICES: non-fatal — a failed
 * restoration must degrade the prompt, never break the agent loop).
 */
export function restoreSources(
  request: RestoreRequestV1,
  reader: RestoreReader,
): RestoreResultV1 {
  // (1) Bounds first — computed from the request only. `reader` is not touched
  // on this path, which is exactly what HEAL-LIMIT-002 asserts.
  if (
    request.spans.length > RESTORE_LIMIT_SPANS ||
    requestedBytes(request.spans) > RESTORE_LIMIT_BYTES
  ) {
    return limitExceeded(request);
  }

  const restored: RestoreSpanResult[] = [];
  const missing: string[] = [];
  const codes: RestoreFailureCode[] = [];
  let usedLedger = false;

  // (2) Per span, strongest source first, in request order.
  for (const span of request.spans) {
    const exact = readExactShard(reader.exactShards, span.range, span.digest);
    if (exact.kind === "bytes") {
      restored.push({
        nodeId: span.nodeId,
        source: "exact-shard",
        bytes: exact.bytes,
        digest: span.digest,
      });
      continue;
    }
    if (exact.kind === "digest-mismatch") codes.push("HEAL_RESTORE_DIGEST_MISMATCH");

    const ledger = readLedgerSpan(reader.ledgerEvents, span.range, span.digest);
    if (ledger.kind === "bytes") {
      usedLedger = true;
      restored.push({
        nodeId: span.nodeId,
        source: "ledger-scan",
        bytes: ledger.bytes,
        digest: span.digest,
      });
      continue;
    }
    if (ledger.kind === "digest-mismatch") codes.push("HEAL_RESTORE_DIGEST_MISMATCH");

    // (3) Neither exact source answered. Identity only — never bytes.
    missing.push(span.nodeId);
    codes.push("HEAL_RESTORE_SOURCE_MISSING");
  }

  const complete = missing.length === 0 && restored.length === request.spans.length;
  const mode: RestoreResultV1["mode"] = !complete ? "C" : usedLedger ? "B" : "A";

  return {
    schema: "restore-result-v1",
    sessionId: request.sessionId,
    mode,
    restored,
    missing,
    // Mode C omits spans, so it MUST disclose that the old context is gone.
    semanticLossStated: mode === "C",
    codes: orderCodes(codes),
  };
}
