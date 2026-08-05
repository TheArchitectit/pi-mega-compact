/**
 * dashboard-server/vc-event-counts.ts — lightweight events.log tail reader for
 * the Vector Cortex dashboard routes.
 *
 * The VC event reporters in `src/vector-cortex/*` emit structured JSON events
 * (one per line) into the per-repo `events.log`. Instead of the dashboard
 * hardcoding zero for aggregate counters, this module reads the event tail and
 * counts real occurrences of named events. It is the single shared seam so every
 * route stays a small, thin consumer and the counting logic lives in one place
 * (extensions/ 400-line soft-as-hard split trigger).
 *
 * NEVER throws: a missing/unreadable file degrades to an empty Map, malformed
 * lines are skipped silently, and only the `.event` string field is inspected —
 * no payload, bytes, span ids, digests, or ledger text ever leaves this module
 * (SECURITY_PRIVACY, reader-only aggregate).
 *
 * Guardrails: PREVENT-PI-004 (local in-process file read only), PREVENT-011
 * (no `any`).
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";

/**
 * Count occurrences of the given named events within the last `maxLines` of the
 * per-repo events.log adjacent to `stateDir`. Returns a Map keyed by event name;
 * a missing/unreadable log or zero matching lines yields an empty Map. Best-effort
 * and non-fatal by construction (matches the non-fatal-stores invariant).
 */
export function countVcEvents(
  stateDir: string,
  eventNames: readonly string[],
  maxLines = 10000,
): Map<string, number> {
  const counts = new Map<string, number>();
  let raw: string;
  try {
    raw = readFileSync(join(stateDir, "events.log"), "utf-8");
  } catch {
    // Missing or unreadable log → nothing to count, never throw.
    return counts;
  }
  // Walk only the tail: split into lines and keep the last `maxLines`.
  const lines = raw.split("\n");
  const start = Math.max(0, lines.length - maxLines);
  const wanted = new Set(eventNames);
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.length === 0) continue;
    let ev: { event?: unknown } | null = null;
    try {
      ev = JSON.parse(line) as { event?: unknown };
    } catch {
      // Malformed line — skip silently, never break the reader.
      continue;
    }
    if (typeof ev?.event === "string" && wanted.has(ev.event)) {
      counts.set(ev.event, (counts.get(ev.event) ?? 0) + 1);
    }
  }
  return counts;
}

/** Read a value from an event-count map, defaulting to 0 when absent. */
export function vcCount(counts: Map<string, number>, name: string): number {
  return counts.get(name) ?? 0;
}
