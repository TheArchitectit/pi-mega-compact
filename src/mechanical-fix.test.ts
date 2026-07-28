/**
 * mechanical-fix.test.ts — focused unit tests for non-SQLite mechanical fixes:
 * appendCheckpoint session-id normalization (store.ts JSON file path) +
 * preserveRecentForPressure floor of 1 (config.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { appendCheckpoint, listCheckpoints } from "./store.js";
import type { StoredCheckpoint } from "./store.js";
import { preserveRecentForPressure } from "./config.js";

// ---------------------------------------------------------------------------
// appendCheckpoint (store.ts) — normalizeSessionId on the write path
// ---------------------------------------------------------------------------

describe("mechanical-fix: appendCheckpoint (store.ts)", () => {
  it("write→read roundtrips with an UNprefixed sessionId", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-mech-cp-"));
    try {
      const cp: StoredCheckpoint = {
        checkpointId: "chkpt_001",
        sessionId: "abc", // UNprefixed → normalizes to sess_abc
        summary: "test summary",
        keyDecisions: ["decide"],
        nextSteps: ["step"],
        filesModified: ["file.ts"],
        tokenEstimate: 50,
        regionHash: "r1",
        embedding: [],
        timestamp: 1000,
      };
      appendCheckpoint(cp, dir);
      // listCheckpoints normalizes 'abc' → 'sess_abc' on read; appendCheckpoint
      // now normalizes on write → both use the same file path.
      const read = listCheckpoints("abc", dir);
      assert.equal(read.length, 1);
      assert.equal(read[0].checkpointId, "chkpt_001");
      assert.equal(read[0].sessionId, "abc"); // original preserved in the object
      assert.equal(read[0].summary, "test summary");
      // Reading via the already-normalized form also works.
      const read2 = listCheckpoints("sess_abc", dir);
      assert.equal(read2.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// preserveRecentForPressure (config.ts) — floor of 1
// ---------------------------------------------------------------------------

describe("mechanical-fix: preserveRecentForPressure (config.ts)", () => {
  it("floors at 1 (never compact ALL messages)", () => {
    // preserveRecentMin=0 at full pressure → 0 would compact everything; floor=1.
    assert.equal(preserveRecentForPressure(1.0, 10, 0), 1);
    // preserveRecentMin=0, preserveRecent=0 at any pressure → still 1.
    assert.equal(preserveRecentForPressure(1.0, 0, 0), 1);
  });

  it("respects preserveRecentMin when above the floor", () => {
    // preserveRecentMin=5 at full pressure → 5 (above the floor, no effect).
    assert.equal(preserveRecentForPressure(1.0, 10, 5), 5);
    // Normal case: pressure=0.5, preserveRecent=10, min=2 → round(10 - 8*0.5) = 6.
    assert.equal(preserveRecentForPressure(0.5, 10, 2), 6);
  });
});
