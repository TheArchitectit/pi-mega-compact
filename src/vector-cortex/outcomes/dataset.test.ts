/**
 * outcomes/dataset.test.ts — VC8A dataset manifest tests.
 *
 * Tests split integrity (no group crosses splits), revocation exclusion,
 * and digest reproducibility. Uses the real production modules — no mocks.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildManifest, manifestDigest, hasNonconsentedRecords } from "./dataset.js";
import { appendGrant, appendRevoke } from "./consent.js";
import { validateOutcome } from "./ledger.js";
import type { OutcomeV1, ConsentV1, DatasetManifestRow } from "./types.js";

function makeOutcome(id: string, repo: string, session: string): OutcomeV1 {
  return validateOutcome({
    outcomeId: id,
    sessionId: session,
    repoId: repo,
    assignment: "experimental",
    metrics: [{ code: "x", value: 1, unit: "count" }],
    ts: "2026-01-01T00:00:00Z",
  });
}

describe("VC8A dataset manifest", () => {
  test("consented outcomes are included in the manifest", () => {
    const outcomes = [
      makeOutcome("out-1", "repo-a", "sess-1"),
      makeOutcome("out-2", "repo-a", "sess-2"),
    ];
    const consent: ConsentV1[] = [
      appendGrant("sess-1", 1, "2026-01-01T00:00:00Z"),
      appendGrant("sess-2", 1, "2026-01-01T00:00:00Z"),
    ];
    const manifest = buildManifest(outcomes, consent, 1);
    assert.equal(manifest.rows.length, 2);
  });

  test("revoked sessions are excluded from the manifest", () => {
    const outcomes = [
      makeOutcome("out-1", "repo-a", "sess-1"),
      makeOutcome("out-2", "repo-a", "sess-2"),
    ];
    const consent: ConsentV1[] = [
      appendGrant("sess-1", 1, "2026-01-01T00:00:00Z"),
      appendGrant("sess-2", 1, "2026-01-01T00:00:00Z"),
      appendRevoke("sess-2", 2, "2026-01-02T00:00:00Z"),
    ];
    const manifest = buildManifest(outcomes, consent, 2);
    assert.equal(manifest.rows.length, 1);
    assert.equal(manifest.rows[0].sessionId, "sess-1");
  });

  test("no consent means no inclusion", () => {
    const outcomes = [makeOutcome("out-1", "repo-a", "sess-1")];
    const manifest = buildManifest(outcomes, [], 1);
    assert.equal(manifest.rows.length, 0);
  });

  test("all rows for a repo/session remain in one split", () => {
    const outcomes: OutcomeV1[] = [];
    for (let i = 0; i < 10; i++) {
      outcomes.push(makeOutcome(`out-${i}`, "repo-a", "sess-1"));
    }
    const consent: ConsentV1[] = [
      appendGrant("sess-1", 1, "2026-01-01T00:00:00Z"),
    ];
    const manifest = buildManifest(outcomes, consent, 1);
    const splits = new Set(manifest.rows.map((r) => r.split));
    assert.equal(splits.size, 1, "all rows for one session must be in the same split");
  });

  test("different sessions can be in different splits", () => {
    const outcomes: OutcomeV1[] = [];
    for (let s = 0; s < 10; s++) {
      for (let i = 0; i < 3; i++) {
        outcomes.push(makeOutcome(`out-${s}-${i}`, `repo-${s % 3}`, `sess-${s}`));
      }
    }
    const consent: ConsentV1[] = outcomes.map((_, i) =>
      appendGrant(`sess-${Math.floor(i / 3)}`, 1, "2026-01-01T00:00:00Z"),
    );
    const manifest = buildManifest(outcomes, consent, 1);
    const splits = new Set(manifest.rows.map((r) => r.split));
    assert.ok(splits.size >= 2, "multiple sessions should span multiple splits");
  });

  test("manifest digest is reproducible regardless of input order", () => {
    const rows1: DatasetManifestRow[] = [
      { outcomeId: "a", repoId: "r1", sessionId: "s1", split: "train" },
      { outcomeId: "b", repoId: "r1", sessionId: "s2", split: "train" },
    ];
    const rows2: DatasetManifestRow[] = [
      { outcomeId: "b", repoId: "r1", sessionId: "s2", split: "train" },
      { outcomeId: "a", repoId: "r1", sessionId: "s1", split: "train" },
    ];
    assert.equal(manifestDigest(rows1), manifestDigest(rows2));
  });

  test("manifest digest changes when rows differ", () => {
    const rows1: DatasetManifestRow[] = [
      { outcomeId: "a", repoId: "r1", sessionId: "s1", split: "train" },
    ];
    const rows2: DatasetManifestRow[] = [
      { outcomeId: "b", repoId: "r1", sessionId: "s1", split: "train" },
    ];
    assert.notEqual(manifestDigest(rows1), manifestDigest(rows2));
  });

  test("hasNonconsentedRecords is false when all rows have consent", () => {
    const outcomes = [
      makeOutcome("out-1", "repo-a", "sess-1"),
    ];
    const consent: ConsentV1[] = [
      appendGrant("sess-1", 1, "2026-01-01T00:00:00Z"),
    ];
    const manifest = buildManifest(outcomes, consent, 1);
    assert.equal(hasNonconsentedRecords(manifest, consent, 1), false);
  });

  test("split digests are present and are hex strings", () => {
    const outcomes = [
      makeOutcome("out-1", "repo-a", "sess-1"),
      makeOutcome("out-2", "repo-a", "sess-2"),
      makeOutcome("out-3", "repo-a", "sess-3"),
    ];
    const consent: ConsentV1[] = [
      appendGrant("sess-1", 1, "2026-01-01T00:00:00Z"),
      appendGrant("sess-2", 1, "2026-01-01T00:00:00Z"),
      appendGrant("sess-3", 1, "2026-01-01T00:00:00Z"),
    ];
    const manifest = buildManifest(outcomes, consent, 1);
    assert.ok(manifest.splitDigests["train"]);
    assert.ok(manifest.splitDigests["calibration"] || manifest.splitDigests["held-out"]);
    assert.match(manifest.splitDigests["train"], /^[0-9a-f]{64}$/);
  });
});
