/**
 * cache/flag-parity.test.ts — VC7A flag-off byte-identity.
 *
 * The sprint contract: `MEGACOMPACT_VC7A=0` must be byte-identical to the
 * predecessor (VC6C). That does NOT mean the crystal code stops running — it
 * means the OBSERVABLE arithmetic is unchanged and only the reporter + dashboard
 * seam goes quiet. So this file asserts both halves:
 *
 *   1. ARITHMETIC IS FLAG-INDEPENDENT. Every key digest, every content address,
 *      every write-once/collision verdict is byte-identical with the flag on and
 *      off. If the flag ever leaked into `crystal.ts` or `store.ts`, these rows
 *      would diverge.
 *   2. THE SEAM IS FLAG-GATED. With the flag off, neither VC7A event is emitted,
 *      even though the same writes and the same collision occurred.
 *
 * The emit functions are driven with a REAL collecting emitter (not a mock
 * framework) so the suppression is observed rather than asserted about.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { CRYSTAL_IDS, CRYSTAL_NAMED_IDS, CRYSTAL_PROVIDER_IDS, type CrystalKeyV1, type DagSpan } from "./types.js";
import { computeCoveredDigest, encodeCrystalKey } from "./crystal.js";
import { CrystalStore } from "./store.js";
import { reportCrystalCollision, reportCrystalWritten } from "./crystal-emit.js";
import { crystalFixture, decodeKey, withVc7aFlag } from "./_crystal-fixture.js";

const span = (sessionId: string, seq: number, startByte: number, text: string): DagSpan => ({
  sessionId,
  startSeq: BigInt(seq),
  endSeq: BigInt(seq),
  startByte,
  endByte: startByte + 32,
  digest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
});

const RANGES: readonly DagSpan[] = [span("s-a", 1, 0, "one"), span("s-a", 2, 32, "two")];

const key = (extra: Partial<CrystalKeyV1> = {}): CrystalKeyV1 => ({
  profileId: "anthropic-claude-opus",
  profileVersion: "v1",
  requestDigest: createHash("sha256").update("req").digest("hex"),
  rendererVersion: "render-v1",
  dependencyHighWater: 100n,
  sourceRanges: RANGES,
  coveredDigest: computeCoveredDigest(RANGES),
  ...extra,
});

/**
 * Run the full crystal pipeline and return an observable summary: every key
 * digest from the corpus plus the store's verdicts for a write / duplicate /
 * collision sequence. This is the "golden bytes" the two flag states compare.
 */
function pipelineSummary(): string {
  const parts: string[] = [];
  for (const id of [...CRYSTAL_IDS, ...CRYSTAL_PROVIDER_IDS, ...CRYSTAL_NAMED_IDS]) {
    const fx = crystalFixture(id);
    const r = encodeCrystalKey(decodeKey(fx.input.key));
    parts.push(`${id}=${r.ok ? r.keyDigest : r.codes.join(",")}`);
    if (fx.input.other !== undefined) {
      const o = encodeCrystalKey(decodeKey(fx.input.other));
      parts.push(`${id}#other=${o.ok ? o.keyDigest : o.codes.join(",")}`);
    }
  }
  const s = new CrystalStore();
  const enc = encodeCrystalKey(key());
  assert.ok(enc.ok);
  if (enc.ok) {
    const a = CrystalStore.freeze(enc.keyDigest, new Uint8Array(Buffer.from("render-a")), enc.key);
    const b = CrystalStore.freeze(enc.keyDigest, new Uint8Array(Buffer.from("render-b")), enc.key);
    const w1 = s.write(a);
    const w2 = s.write(a);
    const w3 = s.write(b);
    parts.push(`w1=${JSON.stringify(w1)}`, `w2=${JSON.stringify(w2)}`, `w3=${JSON.stringify(w3)}`);
    parts.push(`read=${s.read(enc.keyDigest)?.contentDigest ?? "none"}`);
    parts.push(`stats=${JSON.stringify(s.stats())}`);
  }
  return parts.join("\n");
}

test("VC7A flag parity: the crystal/store arithmetic is byte-identical ON vs OFF", () => {
  let on = "";
  let off = "";
  withVc7aFlag("1", () => {
    on = pipelineSummary();
  })();
  withVc7aFlag("0", () => {
    off = pipelineSummary();
  })();
  assert.ok(on.length > 0);
  assert.equal(off, on, "flag-off must not change a single key digest or verdict");
});

test("VC7A flag parity: flag-ON emits both crystal events", () => {
  const seen: string[] = [];
  withVc7aFlag("1", () => {
    reportCrystalWritten((n) => seen.push(n), { keyDigest: "kd", byteCount: 8, mode: "A" });
    reportCrystalCollision((n) => seen.push(n), {
      keyDigest: "kd",
      code: "CRY_KEY_COLLISION",
      mode: "B",
    });
  })();
  assert.deepEqual(seen, ["vector_cortex_crystal_written", "vector_cortex_crystal_collision"]);
});

test("VC7A flag parity: flag-OFF emits nothing even though the writes happened", () => {
  const seen: string[] = [];
  withVc7aFlag("0", () => {
    const s = new CrystalStore();
    const enc = encodeCrystalKey(key());
    assert.ok(enc.ok);
    if (!enc.ok) return;
    const a = CrystalStore.freeze(enc.keyDigest, new Uint8Array(Buffer.from("x")), enc.key);
    const b = CrystalStore.freeze(enc.keyDigest, new Uint8Array(Buffer.from("y")), enc.key);
    // The arithmetic still runs and still refuses the collision with the flag off.
    assert.equal(s.write(a).ok, true);
    assert.equal(s.write(b).ok, false);
    reportCrystalWritten((n) => seen.push(n), { keyDigest: enc.keyDigest, byteCount: 1, mode: "A" });
    reportCrystalCollision((n) => seen.push(n), {
      keyDigest: enc.keyDigest,
      code: "CRY_KEY_COLLISION",
      mode: "B",
    });
  })();
  assert.deepEqual(seen, [], "no VC7A event may be emitted with the flag off");
});

test("VC7A: a throwing emitter is non-fatal and never breaks the agent loop", () => {
  withVc7aFlag("1", () => {
    assert.doesNotThrow(() => {
      reportCrystalWritten(
        () => {
          throw new Error("reporter down");
        },
        { keyDigest: "kd", byteCount: 1, mode: "A" },
      );
    });
  })();
});

test("VC7A: an absent emitter is a no-op in both flag states", () => {
  for (const v of ["1", "0"]) {
    withVc7aFlag(v, () => {
      assert.doesNotThrow(() => {
        reportCrystalWritten(undefined, { keyDigest: "kd", byteCount: 1, mode: "A" });
        reportCrystalCollision(undefined, { keyDigest: "kd", code: "CRY_KEY_COLLISION", mode: "C" });
      });
    })();
  }
});
