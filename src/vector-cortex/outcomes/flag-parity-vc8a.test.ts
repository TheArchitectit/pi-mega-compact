/**
 * outcomes/flag-parity-vc8a.test.ts — VC8A feature-flag parity contract.
 *
 * The flag `MEGACOMPACT_VC8A` gates ONLY the reporter/dashboard seam. The
 * ledger validation, consent evaluation, and dataset manifest builder are PURE
 * and flag-independent: flag-off is byte-identical to the predecessor (VC7C).
 *
 * This suite pins that contract:
 *   - flag ON  -> the emitter receives BOTH events (appended + excluded).
 *   - flag OFF -> the emitter receives NEITHER.
 *   - the payload is payload-free: no prompt, response, or free-text.
 *   - a throwing emitter is non-fatal; an absent emitter is a silent no-op.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { appendOutcome } from "./ledger.js";
import { buildManifest } from "./dataset.js";
import { appendGrant, appendRevoke } from "./consent.js";
import {
  reportOutcomeAppended,
  reportDatasetRecordExcluded,
} from "./emit.js";

function withVc8aFlag(value: "0" | "1", fn: () => void): void {
  const prev = process.env["MEGACOMPACT_VC8A"];
  process.env["MEGACOMPACT_VC8A"] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env["MEGACOMPACT_VC8A"];
    else process.env["MEGACOMPACT_VC8A"] = prev;
  }
}

type Emitted = { name: string; payload: unknown };
function recorder(): { emit: (name: string, payload: unknown) => void; seen: Emitted[] } {
  const seen: Emitted[] = [];
  return { emit: (name, payload) => seen.push({ name, payload }), seen };
}

describe("VC8A flag parity", () => {
  test("the ledger/consent/dataset arithmetic is identical with flag ON or OFF", () => {
    const outcomes = [
      appendOutcome({
        outcomeId: "out-1",
        sessionId: "sess-a",
        repoId: "repo-x",
        assignment: "experimental",
        metrics: [{ code: "x", value: 1, unit: "count" }],
        ts: "2026-01-01T00:00:00Z",
      }),
    ];
    const consent = [
      appendGrant("sess-a", 1, "2026-01-01T00:00:00Z"),
      appendRevoke("sess-a", 2, "2026-01-02T00:00:00Z"),
    ];

    let onManifest, offManifest;
    withVc8aFlag("1", () => {
      onManifest = buildManifest(outcomes, consent, 1);
    });
    withVc8aFlag("0", () => {
      offManifest = buildManifest(outcomes, consent, 1);
    });

    assert.deepEqual(
      JSON.stringify(onManifest),
      JSON.stringify(offManifest),
      "the manifest must not depend on the reporter flag",
    );
  });

  test("flag ON emits the outcome_appended event", () => {
    withVc8aFlag("1", () => {
      const { emit, seen } = recorder();
      reportOutcomeAppended(emit, {
        outcomeId: "out-1",
        sessionId: "sess-a",
        repoId: "repo-x",
      });
      assert.equal(seen.length, 1);
      assert.equal(seen[0].name, "vector_cortex_outcome_appended");
    });
  });

  test("flag OFF emits neither event", () => {
    withVc8aFlag("0", () => {
      const { emit, seen } = recorder();
      reportOutcomeAppended(emit, {
        outcomeId: "out-1",
        sessionId: "sess-a",
        repoId: "repo-x",
      });
      reportDatasetRecordExcluded(emit, {
        outcomeId: "out-2",
        reason: "consent_revoked",
      });
      assert.equal(seen.length, 0);
    });
  });

  test("flag ON emits the dataset_record_excluded event", () => {
    withVc8aFlag("1", () => {
      const { emit, seen } = recorder();
      reportDatasetRecordExcluded(emit, {
        outcomeId: "out-2",
        reason: "consent_revoked",
      });
      assert.equal(seen.length, 1);
      assert.equal(seen[0].name, "vector_cortex_dataset_record_excluded");
    });
  });

  test("the emitted payload never carries prompt/response/free-text", () => {
    withVc8aFlag("1", () => {
      const { emit, seen } = recorder();
      reportOutcomeAppended(emit, {
        outcomeId: "out-1",
        sessionId: "sess-a",
        repoId: "repo-x",
      });
      const json = JSON.stringify(seen[0].payload);
      for (const leak of ["prompt", "response", "freeText", "exactBytes", "content", "payload", "text", "body"]) {
        assert.ok(!json.includes(leak), `never exposes ${leak}`);
      }
    });
  });

  test("a throwing emitter is non-fatal", () => {
    withVc8aFlag("1", () => {
      const throwingEmit = () => { throw new Error("boom"); };
      // Must not throw
      reportOutcomeAppended(throwingEmit, {
        outcomeId: "out-1",
        sessionId: "sess-a",
        repoId: "repo-x",
      });
    });
  });

  test("an absent emitter is a silent no-op", () => {
    withVc8aFlag("1", () => {
      // Must not throw
      reportOutcomeAppended(undefined, {
        outcomeId: "out-1",
        sessionId: "sess-a",
        repoId: "repo-x",
      });
    });
  });
});
