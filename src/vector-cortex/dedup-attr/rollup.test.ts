/**
 * vector-cortex/dedup-attr/rollup.test.ts — pure-fn unit tests (DEDUP-ATTR).
 *
 * Exercises computeDedupTierRollup directly with synthetic DedupAuditEvent
 * arrays. Flag-agnostic: the rollup is pure and runs identically under both
 * MEGACOMPACT_DEDUP_ATTR states (the flag only gates the dashboard route).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { DedupAuditEvent } from "../../vectorStore/dedup-audit.js";
import { computeDedupTierRollup } from "./rollup.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Build a dedup_audit event at a given offset from `now`. */
function ev(
  now: Date,
  offsetMs: number,
  tier: DedupAuditEvent["tier"],
  status: DedupAuditEvent["status"] = "deduped",
  extra: Partial<DedupAuditEvent> = {},
): DedupAuditEvent {
  return {
    type: "dedup_audit",
    ts: new Date(now.getTime() + offsetMs).toISOString(),
    sessionId: "sess-1",
    tier,
    status,
    ...extra,
  };
}

describe("computeDedupTierRollup", () => {
  test("windows the events and sums per-tier counts (L0/L1/L2/new)", () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const events = [
      ev(now, -1 * HOUR, "L0", "deduped"), // in window
      ev(now, -2 * HOUR, "L1", "passed"), // in window
      ev(now, -5 * HOUR, "L2", "deduped"), // in window
      ev(now, -25 * HOUR, "L0", "deduped"), // OUTSIDE 24h window
      ev(now, -3 * HOUR, "new", "stored"), // in window
    ];
    const rollup = computeDedupTierRollup(events, DAY, now);
    assert.equal(rollup.schema, "dedup-tier-rollup-v1");
    assert.equal(rollup.totalDecisions, 4);
    assert.deepEqual(rollup.byTier.l0, { deduped: 1, passed: 0 });
    assert.deepEqual(rollup.byTier.l1, { deduped: 0, passed: 1 });
    assert.deepEqual(rollup.byTier.l2, { deduped: 1, passed: 0 });
    assert.equal(rollup.byTier.new, 1);
    assert.equal(rollup.status, "live");
    // 4 in-window decisions: l0=1/4, l1=1/4, l2=1/4.
    assert.equal(rollup.l0Share, 0.25);
    assert.equal(rollup.l1Share, 0.25);
    assert.equal(rollup.l2Share, 0.25);
  });

  test("'skipped' guard declines are excluded from the share denominator", () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    // A degenerate-match-guard decline is a real decision but belongs to no tier
    // catch, so counting it in `total` would break the share identity below.
    const events = [
      ev(now, -1 * HOUR, "L0", "deduped"),
      ev(now, -2 * HOUR, "L1", "passed"),
      ev(now, -3 * HOUR, "L2", "skipped", { dedupReason: "degenerateGuard" }),
      ev(now, -4 * HOUR, "L1", "skipped", { dedupReason: "degenerateGuard" }),
    ];
    const rollup = computeDedupTierRollup(events, DAY, now);
    // Only the two attributable decisions count.
    assert.equal(rollup.totalDecisions, 2);
    assert.deepEqual(rollup.byTier.l0, { deduped: 1, passed: 0 });
    assert.deepEqual(rollup.byTier.l1, { deduped: 0, passed: 1 });
    assert.deepEqual(rollup.byTier.l2, { deduped: 0, passed: 0 });
    // The invariant: attributed shares still sum to 1 over the window.
    assert.equal(rollup.l0Share + rollup.l1Share + rollup.l2Share, 1);
  });

  test("empty window returns zeros + awaiting_data (never fabricated)", () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const rollup = computeDedupTierRollup([], DAY, now);
    assert.equal(rollup.totalDecisions, 0);
    assert.deepEqual(rollup.byTier.l0, { deduped: 0, passed: 0 });
    assert.deepEqual(rollup.byTier.l1, { deduped: 0, passed: 0 });
    assert.deepEqual(rollup.byTier.l2, { deduped: 0, passed: 0 });
    assert.equal(rollup.byTier.new, 0);
    assert.equal(rollup.l0Share, 0);
    assert.equal(rollup.l1Share, 0);
    assert.equal(rollup.l2Share, 0);
    assert.equal(rollup.status, "awaiting_data");
  });

  test("skips non-dedup_audit lines and malformed ts silently (never crashes)", () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const badTs = { ...ev(now, -1 * HOUR, "L0", "deduped"), ts: "not-a-date" };
    const nonAudit = {
      type: "decision",
      ts: now.toISOString(),
    } as unknown as DedupAuditEvent;
    const events = [ev(now, -1 * HOUR, "L1", "deduped"), badTs, nonAudit];
    const rollup = computeDedupTierRollup(events, DAY, now);
    assert.equal(rollup.totalDecisions, 1);
    assert.equal(rollup.byTier.l1.deduped, 1);
    assert.equal(rollup.status, "live");
  });

  test("missing similarity on L0/L1 is carried through honestly (hash tiers)", () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    // L0/L1 dedup events MUST NOT carry a similarity field; the rollup ignores it.
    const l0 = ev(now, -1 * HOUR, "L0", "deduped");
    const l1 = ev(now, -2 * HOUR, "L1", "deduped");
    assert.equal("similarity" in l0, false);
    assert.equal("similarity" in l1, false);
    const rollup = computeDedupTierRollup([l0, l1], DAY, now);
    assert.equal(rollup.byTier.l0.deduped, 1);
    assert.equal(rollup.byTier.l1.deduped, 1);
    assert.ok(rollup.byTier.l0.passed === 0 && rollup.byTier.l1.passed === 0);
  });

  test("L2 similarity, when present, does not affect the rollup counts", () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const l2 = ev(now, -1 * HOUR, "L2", "deduped", { similarity: 0.94 });
    const rollup = computeDedupTierRollup([l2], DAY, now);
    assert.equal(rollup.byTier.l2.deduped, 1);
    assert.equal(rollup.totalDecisions, 1);
  });

  test("all dedup tiers with no new sum to exactly 1.0 (DEDUP-ATTR-001)", () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const events = [
      ev(now, -1 * HOUR, "L0", "deduped"),
      ev(now, -2 * HOUR, "L1", "passed"),
      ev(now, -3 * HOUR, "L2", "deduped"),
      ev(now, -4 * HOUR, "L2", "passed"),
    ];
    const rollup = computeDedupTierRollup(events, DAY, now);
    assert.equal(rollup.totalDecisions, 4);
    const sum = rollup.l0Share + rollup.l1Share + rollup.l2Share;
    assert.ok(Math.abs(sum - 1.0) < 1e-9, `shares sum to 1.0, got ${sum}`);
  });

  test("pure determinism: same events+window+now is deep-equal (DEDUP-ATTR-004)", () => {
    const now = new Date("2026-08-05T12:00:00.000Z");
    const events = [
      ev(now, -1 * HOUR, "L0", "deduped"),
      ev(now, -2 * HOUR, "L1", "passed"),
      ev(now, -3 * HOUR, "new", "stored"),
    ];
    const a = computeDedupTierRollup(events, DAY, now);
    const b = computeDedupTierRollup(events, DAY, now);
    assert.deepEqual(a, b);
    assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  });
});
