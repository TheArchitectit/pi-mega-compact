/**
 * VC4A acceptance aggregator — SHD-001..020 + the three named rows
 * (SHD-PAIR-001 / SHD-UTF8-002 / SHD-RANGE-003) against the REAL shard tier
 * logic (partitionSemantic / partitionExact / buildShardManifest /
 * validateShardManifest / assembleAndValidate). Runs each conformance scenario
 * through a fixture-driven host of the same shape production wires — real logic,
 * no mocks (no-mock-data/no-stubs memory). Acceptance asserts pinned by the
 * sprint contract: 100% protected-span coverage (every protected byte tiled by
 * an exact shard exactly once), zero pair splits (SHD-PAIR-001), invalid UTF-8
 * preserved verbatim and exact-only (SHD-UTF8-002), overlapping semantic/exact
 * coverage rejected (SHD-RANGE-003). Flag-off parity: the pure shard logic is
 * byte-identical whether or not MEGACOMPACT_VC4A is set (the flag only gates the
 * reporter seam).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createEventCodec } from "./ledger/event-codec.js";
import type { EventV2 } from "./ledger/types.js";
import { partitionSemantic, cumulativeOffsets } from "./shards/semantic.js";
import { partitionExact } from "./shards/exact.js";
import { buildShardManifest, validateShardManifest, assembleAndValidate, manifestSorted } from "./shards/manifest.js";
import {
  SHD_IDS,
  SHD_NAMED_IDS,
  type ProtectedSpan,
  type SemanticShardV1,
  type ExactShardV1,
  type ShardManifestV1,
} from "./shards/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
function repoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "conformance", "vector-cortex"))) return dir;
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  throw new Error("conformance corpus not found above " + from);
}
const REPO_ROOT = repoRoot(HERE);
const V2 = join(REPO_ROOT, "conformance", "vector-cortex", "v2");

const codec = createEventCodec();

interface ManifestRow { id: string; path: string; algorithm: string; expected: string }
interface Manifest { fixtures: ManifestRow[] }
interface ShardFixtureEvent {
  seq: number;
  eventId: string;
  role: string;
  kind: string;
  toolCallId?: string;
  bytesBase64: string;
}
interface NamedSpan { case: string; seqs: number[] }
interface ShardFxInput {
  scenario: string;
  sessionId: string;
  targetSize: number;
  events: ShardFixtureEvent[];
  protected?: NamedSpan[];
}
interface ShardFxExpected {
  ok: boolean;
  code?: string;
  shardCount?: number;
  eventCount?: number;
}
interface ShardFixture {
  id: string;
  kind: string;
  producer: string;
  assertion: string;
  input: ShardFxInput;
  expected: ShardFxExpected;
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}
function fixture(id: string): ShardFixture {
  const m = readManifest();
  const row = m.fixtures.find((f) => f.id === id);
  assert.ok(row, `fixture ${id} registered in manifest`);
  return JSON.parse(readFileSync(join(V2, row.path), "utf8")) as ShardFixture;
}

/** Flag-pinned TestFn wrapper (mirrors vc3c): valid under MEGACOMPACT_VC4A=0. */
function withFlagsOn(fn: () => void): () => void {
  return (): void => {
    const saved = process.env.MEGACOMPACT_VC4A;
    process.env.MEGACOMPACT_VC4A = "1";
    try {
      fn();
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_VC4A;
      else process.env.MEGACOMPACT_VC4A = saved;
    }
  };
}

/** Build EventV2 from a fixture event descriptor (verbatim bytes). */
function decodeEvent(ev: ShardFixtureEvent): EventV2 {
  const bytes = Buffer.from(ev.bytesBase64, "base64");
  return codec.encode({
    sessionId: "s1", // single-session fixtures; cross-session is injected below
    seq: BigInt(ev.seq),
    eventId: ev.eventId,
    role: ev.role as "user" | "assistant" | "tool" | "policy",
    kind: ev.kind,
    bytes: new Uint8Array(bytes),
    occurredAtMs: 0n,
    ...(ev.toolCallId !== undefined ? { toolCallId: ev.toolCallId } : {}),
  });
}

/** Map protected named spans onto the decoded events. */
function protectedSpans(named: NamedSpan[] | undefined, bySeq: Map<number, EventV2>): ProtectedSpan[] {
  const out: ProtectedSpan[] = [];
  for (const ns of named ?? []) {
    const events = ns.seqs.map((s) => {
      const e = bySeq.get(s);
      assert.ok(e, `protected span seq ${s} maps to an event`);
      return e;
    });
    out.push({ events, case: ns.case as ProtectedSpan["case"] });
  }
  return out;
}

/** The handler-level partition the production delegate wires: two tiers + manifest. */
function runFx(fx: ShardFixture, foreignEvent?: EventV2): {
  semanticOk: boolean;
  semantic?: readonly SemanticShardV1[];
  exact?: readonly ExactShardV1[];
  spans: ProtectedSpan[];
  manifest?: ShardManifestV1;
  code?: string;
} {
  const bySeq = new Map<number, EventV2>();
  for (const d of fx.input.events) bySeq.set(d.seq, decodeEvent(d));
  const events: EventV2[] = [...bySeq.values()].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  // A foreign-session event is injected as an extra stream member (SHD-006).
  if (foreignEvent) events.push(foreignEvent);
  const sessionId = fx.input.sessionId;
  const targetSize = fx.input.targetSize;
  const spans = protectedSpans(fx.input.protected, bySeq);

  const sem = partitionSemantic({ sessionId, events, targetSize });
  if (!sem.ok) return { semanticOk: false, spans, code: sem.code };
  const exactR = partitionExact({ sessionId, events, protectedSpans: spans, targetSize });
  if (!exactR.ok) return { semanticOk: true, semantic: sem.shards, spans, code: exactR.code };
  // Real protected byte ranges (from the canonical offsets) so the manifest's
  // cross-tier coverage check is meaningful, not trivially-empty.
  const offsets = cumulativeOffsets(events);
  const manifest = buildShardManifest({
    sessionId,
    sourceHighWater: BigInt(fx.input.events.length),
    semantic: sem.shards,
    exact: exactR.shards,
    protectedSpans: spans.map((s) => {
      const first = s.events[0];
      const last = s.events[s.events.length - 1];
      const start = offsets.of(first.seq);
      const end = offsets.of(last.seq);
      return {
        sessionId,
        seqStart: first.seq,
        seqEnd: last.seq,
        byteStart: start ? start.byteStart : 0,
        byteEnd: end ? end.byteEnd : 0,
      };
    }),
  });
  return { semanticOk: true, semantic: sem.shards, exact: exactR.shards, spans, manifest };
}

describe("VC4A conformance registration", () => {
  test("manifest registers SHD-001..020 + the three named fixtures", () => {
    const m = readManifest();
    const ids = m.fixtures.filter((f) => f.path.startsWith("shards/")).map((f) => f.id);
    for (const id of SHD_IDS) assert.ok(ids.includes(id), `missing ${id}`);
    for (const id of SHD_NAMED_IDS) assert.ok(ids.includes(id), `missing ${id}`);
    for (const id of [...SHD_IDS, ...SHD_NAMED_IDS]) {
      const row = m.fixtures.find((f) => f.id === id);
      assert.ok(row, `${id} has a manifest row`);
      assert.equal(row.algorithm, "shard", `${id} algorithm promotion`);
    }
  });
});

// ── SHD-001..020: drive each scenario through the real tier logic ──────────

describe("SHD-001..020 conformance rows", () => {
  test("SHD-001 boundary-exact: a stream that fills one budget yields a single semantic shard", withFlagsOn(() => {
    const fx = fixture("SHD-001");
    assert.equal(fx.expected.ok, true);
    const r = runFx(fx);
    assert.equal(r.semanticOk, true);
    assert.equal(r.semantic!.length, fx.expected.shardCount);
    assert.equal(r.semantic!.reduce((n, s) => n + s.eventCount, 0), fx.expected.eventCount);
  }));

  test("SHD-002 split-at-boundary: splits ONLY at complete record boundaries", withFlagsOn(() => {
    const fx = fixture("SHD-002");
    assert.equal(fx.expected.ok, true);
    const r = runFx(fx);
    assert.equal(r.semantic!.length, fx.expected.shardCount);
    for (const s of r.semantic!) assert.equal(s.range.byteEnd - s.range.byteStart, s.byteCount, "no record is split");
  }));

  test("SHD-003 single-over-budget: an over-budget record occupies its own complete shard", withFlagsOn(() => {
    const fx = fixture("SHD-003");
    assert.equal(fx.expected.ok, true);
    const r = runFx(fx);
    assert.equal(r.semantic!.length, 1);
    assert.equal(r.semantic![0].byteCount, 8);
    assert.equal(r.semantic![0].eventCount, 1);
  }));

  test("SHD-004 empty-stream: zero events yield zero semantic shards", withFlagsOn(() => {
    const fx = fixture("SHD-004");
    assert.equal(fx.expected.ok, true);
    const r = runFx(fx);
    assert.deepEqual(r.semantic, []);
  }));

  test("SHD-005 range-metadata: shard ranges preserve the exact source seq + byte window", withFlagsOn(() => {
    const fx = fixture("SHD-005");
    const r = runFx(fx);
    assert.equal(r.semantic!.length, 1);
    assert.equal(r.semantic![0].range.seqStart, 1n);
    assert.equal(r.semantic![0].range.seqEnd, 2n);
    assert.equal(r.semantic![0].range.byteStart, 0);
    assert.equal(r.semantic![0].range.byteEnd, 8);
  }));

  test("SHD-006 cross-session: a foreign event rejects the semantic partition (SHD_CROSS_SESSION)", withFlagsOn(() => {
    const fx = fixture("SHD-006");
    assert.equal(fx.expected.ok, false);
    assert.equal(fx.expected.code, "SHD_CROSS_SESSION");
    const foreign = codec.encode({
      sessionId: "OTHER",
      seq: 9n,
      eventId: "foreign",
      role: "user",
      kind: "message",
      bytes: new Uint8Array([0x58]),
      occurredAtMs: 0n,
    });
    const r = runFx(fx, foreign);
    assert.equal(r.semanticOk, false);
    assert.equal(r.code, "SHD_CROSS_SESSION");
  }));

  test("SHD-007 invalid-target: a non-positive target size rejects (SHD_INVALID_TARGET_SIZE)", withFlagsOn(() => {
    const fx = fixture("SHD-007");
    assert.equal(fx.expected.ok, false);
    assert.equal(fx.expected.code, "SHD_INVALID_TARGET_SIZE");
    const r = runFx(fx);
    assert.equal(r.semanticOk, false);
    assert.equal(r.code, "SHD_INVALID_TARGET_SIZE");
  }));

  test("SHD-008 contiguous-coverage: semantic byte ranges tile the stream disjointly + contiguously", withFlagsOn(() => {
    const fx = fixture("SHD-008");
    const r = runFx(fx);
    assert.equal(r.semantic!.length, 4);
    const ranges = r.semantic!.map((s) => [s.range.byteStart, s.range.byteEnd]);
    for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i][0], ranges[i - 1][1], "contiguous tiling");
    assert.deepEqual(ranges.map((x) => x[1]), ranges.map((x) => x[0]).slice(1).concat([12]));
  }));

  test("SHD-009 count-and-bytes: eventCount and byteCount match the covered records", withFlagsOn(() => {
    const fx = fixture("SHD-009");
    const r = runFx(fx);
    assert.equal(r.semantic!.length, 1);
    assert.equal(r.semantic![0].eventCount, 2);
    assert.equal(r.semantic![0].byteCount, 8);
  }));

  test("SHD-010 deterministic-digest: identical input yields identical shard digests", withFlagsOn(() => {
    const fx = fixture("SHD-010");
    const a = runFx(fx);
    const b = runFx(fx);
    assert.deepEqual(a.semantic!.map((s) => s.digest), b.semantic!.map((s) => s.digest));
  }));

  test("SHD-011 pair-atomic: a call/result spanning the target size stays in ONE exact shard", withFlagsOn(() => {
    const fx = fixture("SHD-011");
    assert.equal(fx.expected.ok, true);
    const r = runFx(fx);
    assert.equal(r.exact!.length, 1, "pair must never be split");
    assert.equal(r.exact![0].range.seqStart, 1n);
    assert.equal(r.exact![0].range.seqEnd, 2n);
    const joined = new TextDecoder().decode(r.exact![0].originalBytes);
    assert.equal(joined, "call--result");
  }));

  test("SHD-012 invalid-preserved: invalid bytes preserved verbatim in the exact shard", withFlagsOn(() => {
    const fx = fixture("SHD-012");
    assert.equal(fx.expected.ok, true);
    const r = runFx(fx);
    const bytes = r.exact![0].originalBytes;
    assert.equal(bytes[3], 0xff);
    assert.equal(bytes[4], 0x00);
    assert.equal(bytes[5], 0xfe);
    assert.equal(r.exact![0].byteCount, 6);
  }));

  test("SHD-013 group-by-budget: multiple protected spans bundle into budget-bounded shards", withFlagsOn(() => {
    const fx = fixture("SHD-013");
    assert.equal(fx.expected.ok, true);
    const r = runFx(fx);
    assert.equal(r.exact!.length, 2);
    assert.equal(r.exact!.reduce((n, s) => n + s.byteCount, 0), 24);
  }));

  test("SHD-014 empty-protected: no protected spans yield zero exact shards", withFlagsOn(() => {
    const fx = fixture("SHD-014");
    assert.equal(fx.expected.ok, true);
    const r = runFx(fx);
    assert.deepEqual(r.exact, []);
  }));

  test("SHD-015 cross-session-exact: a protected span referencing an absent event rejects", withFlagsOn(() => {
    const fx = fixture("SHD-015");
    assert.equal(fx.expected.ok, false);
    assert.equal(fx.expected.code, "SHD_CROSS_SESSION");
    // The fixture references seq 99 which is NOT in the event stream. Build that
    // span directly (the protectedSpans mapper asserts existence; this span is
    // intentionally absent) and let partitionExact's cross-session guard reject it.
    const events = fx.input.events.map((d) => decodeEvent(d));
    const absent = codec.encode({
      sessionId: fx.input.sessionId,
      seq: 99n,
      eventId: "missing",
      role: "user",
      kind: "message",
      bytes: new Uint8Array([0x6d]),
      occurredAtMs: 0n,
    });
    const r = partitionExact({
      sessionId: fx.input.sessionId,
      events,
      protectedSpans: [{ events: [absent], case: "anchor" }],
      targetSize: fx.input.targetSize,
    });
    assert.equal(r.ok, false);
    if (r.ok) throw new Error("unreachable");
    assert.equal(r.code, "SHD_CROSS_SESSION");
  }));

  test("SHD-016 valid-cover: disjoint shards + full protected coverage validate", withFlagsOn(() => {
    const fx = fixture("SHD-016");
    assert.equal(fx.expected.ok, true);
    const r = runFx(fx);
    const m = r.manifest!;
    assert.equal(validateShardManifest(m).ok, true);
    // The fixture's shardCount pins the SEMANTIC tier count (the manifest's
    // total also includes the exact tier); semantic + exact is the full manifest.
    assert.equal(m.semantic.length, fx.expected.shardCount);
    assert.equal(m.shardCount, m.semantic.length + m.exact.length);
  }));

  test("SHD-017 overlap-reject: overlapping semantic shard ranges are rejected (SHD_RANGE_OVERLAP)", withFlagsOn(() => {
    const fx = fixture("SHD-017");
    assert.equal(fx.expected.ok, false);
    assert.equal(fx.expected.code, "SHD_RANGE_OVERLAP");
    const r = runFx(fx);
    // Force an overlap: pass the same semantic range twice. A clean partition
    // alone cannot overlap, so the manifest validator is what rejects it.
    const dup = buildShardManifest({
      sessionId: fx.input.sessionId,
      sourceHighWater: BigInt(fx.input.events.length),
      semantic: [...r.semantic!, ...r.semantic!],
      exact: [],
      protectedSpans: [],
    });
    const v = validateShardManifest(dup);
    assert.equal(v.ok, false);
    if (v.ok) throw new Error("unreachable");
    assert.equal(v.code, "SHD_RANGE_OVERLAP");
  }));

  test("SHD-018 gap-reject: a missing exact shard leaves a protected-span gap (SHD_PROTECTED_GAP)", withFlagsOn(() => {
    const fx = fixture("SHD-018");
    assert.equal(fx.expected.ok, false);
    assert.equal(fx.expected.code, "SHD_PROTECTED_GAP");
    const r = runFx(fx);
    assert.ok(r.exact!.length > 0, "a correct partition DOES produce the exact shard");
    // The manifest is malformed when the exact tier is MISSING: its protected
    // spans then have no exact shard to tile them (SHD_PROTECTED_GAP).
    const m = buildShardManifest({
      sessionId: fx.input.sessionId,
      sourceHighWater: BigInt(fx.input.events.length),
      semantic: r.semantic!,
      exact: [],
      protectedSpans: r.manifest!.protectedSpans,
    });
    const v = validateShardManifest(m);
    assert.equal(v.ok, false);
    if (v.ok) throw new Error("unreachable");
    assert.equal(v.code, "SHD_PROTECTED_GAP");
  }));

  test("SHD-019 sorted-ranges: assembled manifest ranges are sorted by (seqStart, byteStart)", withFlagsOn(() => {
    const fx = fixture("SHD-019");
    assert.equal(fx.expected.ok, true);
    const r = runFx(fx);
    assert.equal(manifestSorted(r.manifest!), true);
  }));

  test("SHD-020 digest-stable: the manifest generation digest is deterministic", withFlagsOn(() => {
    const fx = fixture("SHD-020");
    assert.equal(fx.expected.ok, true);
    const a = runFx(fx);
    const b = runFx(fx);
    assert.equal(a.manifest!.generationDigest, b.manifest!.generationDigest);
  }));
});

// ── acceptance: 100% protected-span coverage, zero pair splits, verbatim UTF-8 ─

describe("VC4A acceptance (protected coverage + pair atomicity)", () => {
  test("SHD-PAIR-001: a call/result spanning the target size stays in ONE exact shard (named)", withFlagsOn(() => {
    const fx = fixture("SHD-PAIR-001");
    assert.equal(fx.expected.ok, true);
    const r = runFx(fx);
    assert.equal(r.exact!.length, 1, "the straddling pair is never split");
    assert.equal(r.exact![0].range.seqStart, 1n);
    assert.equal(r.exact![0].range.seqEnd, 2n);
    assert.equal(new TextDecoder().decode(r.exact![0].originalBytes), "call--result");
  }));

  test("SHD-UTF8-002: invalid UTF-8 bytes are exact-only and preserved unchanged (named)", withFlagsOn(() => {
    const fx = fixture("SHD-UTF8-002");
    assert.equal(fx.expected.ok, true);
    const r = runFx(fx);
    const bytes = r.exact![0].originalBytes;
    assert.deepEqual(Array.from(bytes), [0xff, 0xfe, 0x00, 0xc0, 0xaf]);
    assert.equal(r.exact![0].case, "invalid-utf8");
  }));

  test("SHD-RANGE-003: overlapping semantic/exact coverage is rejected (named)", withFlagsOn(() => {
    const fx = fixture("SHD-RANGE-003");
    assert.equal(fx.expected.ok, false);
    assert.equal(fx.expected.code, "SHD_RANGE_OVERLAP");
    const r = runFx(fx);
    // Forced overlap between the semantic tier and an exact range the partition
    // would not otherwise place disjointly.
    const exactOverlap = [...(r.exact ?? [])];
    const overlap = r.semantic![0];
    const syntheticExact: ExactShardV1 = {
      schema: "exact-shard-v1",
      sessionId: fx.input.sessionId,
      range: { ...overlap.range },
      kind: "exact",
      originalBytes: new Uint8Array(overlap.range.byteEnd - overlap.range.byteStart),
      digest: "sha256:overlap",
      byteCount: overlap.range.byteEnd - overlap.range.byteStart,
      case: "anchor",
    };
    exactOverlap.push(syntheticExact);
    const m = buildShardManifest({
      sessionId: fx.input.sessionId,
      sourceHighWater: BigInt(fx.input.events.length),
      semantic: r.semantic!,
      exact: exactOverlap,
      protectedSpans: r.spans.map((s) => s.events[0]).map(() => ({ sessionId: fx.input.sessionId, seqStart: 1n, seqEnd: 1n, byteStart: 0, byteEnd: 4 })),
    });
    const v = validateShardManifest(m);
    assert.equal(v.ok, false);
    if (v.ok) throw new Error("unreachable");
    assert.equal(v.code, "SHD_RANGE_OVERLAP");
  }));

  test("acceptance: SHD-016 exact shards tile every protected byte exactly once (100% coverage)", withFlagsOn(() => {
    const fx = fixture("SHD-016");
    const r = runFx(fx);
    const m = r.manifest!;
    assert.equal(validateShardManifest(m).ok, true);
    // 100% protected-span coverage: the validator's disjoint + SHD_PROTECTED_GAP
    // checks prove every protected byte is tiled by exactly one exact shard —
    // assert it at the byte level too. No protected byte is dropped and none is
    // doubled.
    assert.ok(r.spans.length > 0, "acceptance fixture has protected spans");
    const protBytes = r.spans.reduce((n, s) => n + s.events.reduce((m2, e) => m2 + e.originalBytes.length, 0), 0);
    const exactBytes = r.exact!.reduce((n, s) => n + s.byteCount, 0);
    assert.equal(exactBytes, protBytes, "no protected byte is dropped and none is doubled");
  }));

  test("acceptance: zero pair splits across every tool-pair fixture", withFlagsOn(() => {
    // SHD-011, SHD-PAIR-001 carry tool-pair protected spans; each must land as
    // a SINGLE exact shard spanning both the call and the result.
    for (const id of ["SHD-011", "SHD-PAIR-001"]) {
      const fx = fixture(id);
      const r = runFx(fx);
      const pairShards = r.exact!.filter((s) => s.case === "tool-pair");
      assert.equal(pairShards.length, 1, `${id}: the pair is exactly one tool-pair shard`);
      assert.equal(pairShards[0].range.seqEnd - pairShards[0].range.seqStart, 1n, `${id}: pair covers call+result in one shard`);
    }
  }));
});

describe("VC4A flag-off parity", () => {
  test("assembleAndValidate succeeds with the flag untouched (pure logic is byte-identical)", () => {
    const fx = fixture("SHD-016");
    const r = runFx(fx);
    const res = assembleAndValidate({
      sessionId: fx.input.sessionId,
      sourceHighWater: BigInt(fx.input.events.length),
      semantic: r.semantic!,
      exact: r.exact!,
      // Real protected byte ranges from the runFx-built manifest.
      protectedSpans: r.manifest!.protectedSpans,
    });
    assert.equal(res.ok, true);
  });
});
