/**
 * cache/store.test.ts — VC7A content-addressed write-once store semantics,
 * the interrupted-write chaos case, and the forced failure triad.
 *
 * Everything runs against the REAL `CrystalStore` and the REAL `encodeCrystalKey`
 * over the committed corpus. The invariants under test:
 *   - a key is written once and NEVER overwritten;
 *   - identical bytes re-written is idempotent, different bytes is a collision;
 *   - a write interrupted before commit is invisible to reads and is DISCARDED
 *     on restart, after which a fresh write produces exactly one valid crystal;
 *   - A = store hit, B = miss/collision forcing a fresh render, C = store
 *     unavailable serving nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  CRYSTAL_IDS,
  CRYSTAL_PROVIDER_IDS,
  type CrystalKeyV1,
  type CrystalV1,
  type DagSpan,
} from "./types.js";
import { computeCoveredDigest, encodeCrystalKey } from "./crystal.js";
import { CrystalStore, contentAddress } from "./store.js";
import { crystalFixture, decodeKey } from "./_crystal-fixture.js";

const bytesOf = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "utf8"));

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

/** Encode a key and freeze `text` under it, using only real modules. */
function freeze(k: CrystalKeyV1, text: string): CrystalV1 {
  const enc = encodeCrystalKey(k);
  assert.ok(enc.ok, "test key must encode");
  if (!enc.ok) throw new Error("unreachable");
  return CrystalStore.freeze(enc.keyDigest, bytesOf(text), enc.key);
}

// ── Content addressing ───────────────────────────────────────────────────────

test("VC7A store: contentDigest is SHA-256 of the bytes, bare lowercase hex", () => {
  const c = CrystalStore.freeze("kd", bytesOf("frozen"), key());
  assert.equal(c.contentDigest, createHash("sha256").update("frozen").digest("hex"));
  assert.match(c.contentDigest, /^[0-9a-f]{64}$/);
  assert.equal(c.byteCount, 6);
});

test("VC7A store: freeze copies the bytes — later caller mutation cannot alter it", () => {
  const src = bytesOf("frozen");
  const c = CrystalStore.freeze("kd", src, key());
  src[0] = 0x00;
  assert.equal(c.contentDigest, contentAddress(bytesOf("frozen")));
});

test("VC7A store: identical bytes always content-address identically", () => {
  assert.equal(contentAddress(bytesOf("same")), contentAddress(bytesOf("same")));
  assert.notEqual(contentAddress(bytesOf("same")), contentAddress(bytesOf("diff")));
});

// ── Write-once ───────────────────────────────────────────────────────────────

test("VC7A store: a first write publishes exactly one crystal", () => {
  const s = new CrystalStore();
  const r = s.write(freeze(key(), "render-a"));
  assert.deepEqual({ ok: r.ok, written: r.ok && r.written }, { ok: true, written: true });
  assert.equal(s.stats().crystalCount, 1);
  assert.equal(s.stats().writes, 1);
});

test("VC7A store: re-writing identical bytes is idempotent and stores nothing new", () => {
  const s = new CrystalStore();
  s.write(freeze(key(), "render-a"));
  const r = s.write(freeze(key(), "render-a"));
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.written, false);
  assert.equal(s.stats().crystalCount, 1);
  assert.equal(s.stats().duplicateWrites, 1);
});

test("VC7A store: same key + different bytes is CRY_KEY_COLLISION and never overwrites", () => {
  const s = new CrystalStore();
  const first = freeze(key(), "render-a");
  s.write(first);
  const r = s.write(freeze(key(), "render-b"));
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, "CRY_KEY_COLLISION");
  const held = s.read(first.keyDigest);
  assert.equal(held?.contentDigest, first.contentDigest, "stored bytes are unchanged");
  assert.equal(s.stats().crystalCount, 1);
  assert.equal(s.stats().collisions, 1);
});

test("VC7A store: a collision is reported repeatedly and never wears down", () => {
  const s = new CrystalStore();
  const first = freeze(key(), "render-a");
  s.write(first);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(s.write(freeze(key(), "render-b")).ok, false);
  }
  assert.equal(s.stats().collisions, 3);
  assert.equal(s.read(first.keyDigest)?.contentDigest, first.contentDigest);
});

test("VC7A store: distinct keys over the same ranges are distinct crystals", () => {
  const s = new CrystalStore();
  s.write(freeze(key(), "render-opus"));
  s.write(freeze(key({ profileId: "openai-gpt" }), "render-gpt"));
  assert.equal(s.stats().crystalCount, 2);
  assert.equal(s.stats().collisions, 0);
});

// ── Interrupted write (chaos) ────────────────────────────────────────────────

test("VC7A chaos: a write interrupted before commit is invisible to reads", () => {
  const s = new CrystalStore();
  const c = freeze(key(), "render-a");
  s.stage(c);
  assert.equal(s.read(c.keyDigest), undefined, "staged bytes are never readable");
  assert.equal(s.stats().crystalCount, 0);
  assert.equal(s.pendingCount(), 1);
});

test("VC7A chaos: restart discards the temp write; a fresh write yields ONE crystal", () => {
  const s = new CrystalStore();
  const c = freeze(key(), "render-a");
  s.stage(c);
  // Simulated process restart: staged entries are dropped, never promoted.
  assert.equal(s.recover(), 1);
  assert.equal(s.pendingCount(), 0);
  assert.equal(s.stats().crystalCount, 0);

  const r = s.write(freeze(key(), "render-a"));
  assert.equal(r.ok && r.written, true);
  assert.equal(s.stats().crystalCount, 1, "exactly one valid crystal after recovery");
  assert.equal(s.read(c.keyDigest)?.contentDigest, c.contentDigest);
});

test("VC7A chaos: an interrupted DIFFERENT-bytes write cannot collide after restart", () => {
  const s = new CrystalStore();
  s.write(freeze(key(), "render-a"));
  s.stage(freeze(key(), "render-b"));
  s.recover();
  assert.equal(s.stats().collisions, 0, "a discarded temp write never reaches the ratchet");
  assert.equal(s.stats().crystalCount, 1);
});

test("VC7A chaos: committing an unstaged key is refused, not invented", () => {
  const s = new CrystalStore();
  const r = s.commit("never-staged");
  assert.equal(r.ok, false);
  assert.equal(s.stats().crystalCount, 0);
});

// ── Forced triad: A / B / C ──────────────────────────────────────────────────

test("VC7A triad A: a store hit serves the frozen bytes and counts hit bytes", () => {
  const s = new CrystalStore();
  const c = freeze(key(), "render-a");
  s.write(c);
  const got = s.read(c.keyDigest);
  assert.equal(got?.contentDigest, c.contentDigest);
  assert.equal(s.mode(), "A");
  assert.equal(s.stats().hits, 1);
  assert.equal(s.stats().hitBytes, c.byteCount);
});

test("VC7A triad B: a miss forces a fresh render — no crystal is served", () => {
  const s = new CrystalStore();
  const c = freeze(key(), "render-a");
  assert.equal(s.read(c.keyDigest), undefined);
  assert.equal(s.mode(), "B");
  assert.equal(s.stats().misses, 1);
  assert.equal(s.stats().hitBytes, 0);
});

test("VC7A triad B: a collision leaves the caller with no cached answer to reuse", () => {
  const s = new CrystalStore();
  s.write(freeze(key(), "render-a"));
  const rejected = freeze(key(), "render-b");
  const r = s.write(rejected);
  assert.equal(!r.ok && r.code, "CRY_KEY_COLLISION");
  assert.notEqual(s.read(rejected.keyDigest)?.contentDigest, rejected.contentDigest);
});

test("VC7A triad C: an unavailable store serves nothing and refuses writes", () => {
  const s = new CrystalStore();
  const c = freeze(key(), "render-a");
  s.write(c);
  s.setAvailable(false);
  assert.equal(s.mode(), "C");
  assert.equal(s.read(c.keyDigest), undefined, "mode C serves nothing from cache");
  const w = s.write(freeze(key({ dependencyHighWater: 101n }), "render-c"));
  assert.equal(!w.ok && w.code, "CRY_STORE_UNAVAILABLE");
  assert.equal(s.has(c.keyDigest), false);
});

test("VC7A triad C: restoring availability re-exposes the untouched crystal", () => {
  const s = new CrystalStore();
  const c = freeze(key(), "render-a");
  s.write(c);
  s.setAvailable(false);
  s.read(c.keyDigest);
  s.setAvailable(true);
  assert.equal(s.read(c.keyDigest)?.contentDigest, c.contentDigest);
  assert.equal(s.mode(), "A");
});

// ── Corpus store rows ────────────────────────────────────────────────────────

/** Drive one corpus store row through the real store. */
function runStoreRow(id: string): void {
  const fx = crystalFixture(id);
  if (fx.input.scenario !== "store") return;
  const s = new CrystalStore();
  if (fx.input.mode === "unavailable") s.setAvailable(false);

  const k = decodeKey(fx.input.key);
  const first = freeze(k, fx.input.bytes ?? "");
  let last = s.write(first);

  if (fx.input.secondBytes !== undefined) {
    // "write-two-profiles" varies the IDENTITY (a different profile), which must
    // produce a second crystal; every other rewrite row reuses the SAME key.
    const secondKey =
      fx.input.mode === "write-two-profiles" ? { ...k, profileId: "openai-gpt" } : k;
    last = s.write(freeze(secondKey, fx.input.secondBytes));
  }

  assert.equal(last.ok, fx.expected.ok, `${id}: ${fx.assertion}`);
  if (!last.ok) assert.equal(last.code, fx.expected.code, `${id}: expected ${fx.expected.code}`);
  else assert.equal(last.written, fx.expected.written, `${id}: written flag`);
  assert.equal(s.stats().crystalCount, fx.expected.crystalCount, `${id}: crystal count`);
  if (fx.expected.mode !== undefined) assert.equal(s.mode(), fx.expected.mode, `${id}: mode`);
}

for (const id of [...CRYSTAL_IDS, ...CRYSTAL_PROVIDER_IDS]) {
  test(`VC7A store corpus ${id}`, () => {
    runStoreRow(id);
  });
}
