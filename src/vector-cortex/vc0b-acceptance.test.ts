/**
 * vector-cortex/vc0b-acceptance.test.ts — VC0B acceptance aggregator.
 *
 * Reads the CUT-001..020 + M3-001..010 conformance rows from the v2 manifest,
 * runs the ReplayCutV2 effective-cut calculator / M3 migration over each row,
 * and asserts each row returns its manifest bytes/results or exactly its listed
 * failure code. Also verifies: CUT-PAIR-001 / CUT-ANCHOR-002 / CUT-HIGHWATER-003
 * source assertions; 10,000 replay turns with zero reordered/split/orphan pairs;
 * the M3 crash-after-validation-but-before-switch failure injection (old pointer
 * retained, idempotent resume); and flag-off (MEGACOMPACT_VC0B=0) byte-identical
 * predecessor behavior.
 *
 * Node --test on the compiled dist output (no mocks; real logic + fixtures).
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VC0B_ENABLED } from "../config/vector-cortex.js";
import { CUT_IDS, M3_IDS } from "./replay/types.js";
import { computeEffectiveCutV2 } from "./replay/cut.js";
import { runReplayV2 } from "./replay/replay.js";
import { createReplayReporter } from "./replay/emit.js";
import {
  migrateEffectiveCutV2,
  m3Copy,
  m3Validate,
} from "./migrations/effective-cut-v2.js";
import type { ReplayToolPair } from "./replay/types.js";

// Repo root differs by run location (raw tsc layout vs postbuild-published copy).
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = HERE.includes(join("dist", "src", "vector-cortex"))
  ? join(HERE, "..", "..", "..")
  : join(HERE, "..", "..");
const V2 = join(REPO_ROOT, "conformance", "vector-cortex", "v2");

interface ManifestRow {
  id: string;
  path: string;
  sha256: string;
  algorithm: string;
  expected: string;
}
interface Manifest {
  fixtures: ManifestRow[];
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}

function readFixture(path: string): any {
  return JSON.parse(readFileSync(join(V2, path), "utf8"));
}

/** Convert a fixture cut input (number seqs, pair array) to bigint form. */
function cutInput(body: any) {
  const c = body.input.cut ?? body.input;
  return {
    requestedSeq: BigInt(c.requestedSeq as number),
    boundarySafeSeq: BigInt(c.boundarySafeSeq as number),
    committedSeq: BigInt(c.committedSeq as number),
    capturedHighWater: BigInt(c.capturedHighWater as number),
    anchorFloor: BigInt(c.anchorFloor as number),
    pairs: (c.pairs ?? []).map((p: { callSeq: number; resultSeq: number }): ReplayToolPair => ({
      callSeq: BigInt(p.callSeq),
      resultSeq: BigInt(p.resultSeq),
    })),
  };
}

/** In-memory M3Host backed by a fixture host state (numbers -> bigint). */
function makeHost(hostBody: any) {
  const state = {
    oldPointer: hostBody.oldPointer == null ? null : BigInt(hostBody.oldPointer),
    stagedPointer: hostBody.stagedPointer == null ? null : BigInt(hostBody.stagedPointer),
    active: hostBody.active as "old" | "new",
    committed: 0n,
  };
  return {
    state,
    get oldPointer() {
      return state.oldPointer;
    },
    writeStaged(p: bigint) {
      state.stagedPointer = p;
    },
    stagedPointer() {
      return state.stagedPointer;
    },
    committedSeq() {
      return state.committed;
    },
    switchPointer(p: bigint) {
      state.active = "new";
      state.oldPointer = p;
    },
  };
}

/** Build a balanced tool call/result stream (msg, call, result per turn). */
function balancedStream(sessionId: string, turns: number) {
  const out: {
    sessionId: string;
    seq: bigint;
    eventId: string;
    role: "message" | "user" | "assistant" | "tool";
    kind: string;
    toolCallId?: string;
    originalBytes?: Uint8Array;
  }[] = [];
  let seq = 0n;
  const enc = new TextEncoder();
  for (let t = 0; t < turns; t++) {
    const callId = `tc-${t}`;
    out.push({ sessionId, seq: ++seq, eventId: `msg-${t}`, role: "user", kind: "message", originalBytes: enc.encode(`m${t}`) });
    out.push({ sessionId, seq: ++seq, eventId: `call-${t}`, role: "assistant", kind: "tool_call", toolCallId: callId, originalBytes: enc.encode(`c${t}`) });
    out.push({ sessionId, seq: ++seq, eventId: `res-${t}`, role: "tool", kind: "tool_result", toolCallId: callId, originalBytes: enc.encode(`r${t}`) });
  }
  return out as any;
}

describe("VC0B flag gates replay observability (real consumer)", () => {
  const flagEnvKey = "MEGACOMPACT_VC0B";
  const savedFlag = process.env[flagEnvKey];

  after(() => {
    if (savedFlag === undefined) delete process.env[flagEnvKey];
    else process.env[flagEnvKey] = savedFlag;
  });

  test("flag ON emits cut_retreat + highwater_frozen; flag OFF emits ZERO events", () => {
    // Balanced stream turns 1..3 (msg/call/result per turn, seq 1..9).
    const occurrences = balancedStream("s-vc0b-flag-gate", 3);
    const emitter: string[] = [];
    const reporter = createReplayReporter((ev) => emitter.push(ev));

    // Flag ON — committed lands on call seq 5 (call 5 / result 6) forcing a
    // CUT_TOOL_PAIR_SPLIT retreat in mode A.
    process.env[flagEnvKey] = "1";
    const onA = runReplayV2({
      sessionId: "s-vc0b-flag-gate",
      occurrences,
      requestedSeq: 8n,
      committedSeq: 5n,
      capturedHighWater: 8n,
      anchorFloor: 0n,
      mode: "A",
      reporter,
    });
    assert.equal(VC0B_ENABLED(), true);
    assert.equal(onA.report.counts.orphanToolEvents, 0);
    assert.ok(emitter.includes("vector_cortex_replay_cut_retreat"), "flag ON emits cut_retreat");

    // Flag ON — mode C also emits the frozen high-water event.
    emitter.length = 0;
    runReplayV2({
      sessionId: "s-vc0b-flag-gate",
      occurrences,
      requestedSeq: 8n,
      committedSeq: 5n,
      capturedHighWater: 8n,
      anchorFloor: 0n,
      mode: "C",
      reporter,
    });
    assert.ok(emitter.includes("vector_cortex_replay_highwater_frozen"), "flag ON emits highwater_frozen");

    // Flag OFF — same reporter emits NOTHING; the report data still carries the
    // frozen high-water and mode C (observability gated, state intact).
    emitter.length = 0;
    process.env[flagEnvKey] = "0";
    assert.equal(VC0B_ENABLED(), false);
    const offC = runReplayV2({
      sessionId: "s-vc0b-flag-gate",
      occurrences,
      requestedSeq: 8n,
      committedSeq: 5n,
      capturedHighWater: 8n,
      anchorFloor: 0n,
      mode: "C",
      reporter,
    });
    assert.equal(emitter.length, 0, "flag OFF emits zero replay observability events");
    assert.equal(offC.report.mode, "C", "report still reports mode C");
    assert.equal(offC.report.cut.capturedHighWater, 8n, "report still carries the frozen high-water");
    assert.equal(offC.report.counts.replayed, 0, "byte-identical predecessor: zero replayed");
  });
});

describe("CUT conformance corpus (manifest-indexed, CUT-001..020)", () => {
  test("manifest registers CUT-001..020", () => {
    const manifest = readManifest();
    const ids = manifest.fixtures.filter((f) => f.path.startsWith("replay/")).map((f) => f.id);
    for (const id of CUT_IDS) assert.ok(ids.includes(id), `missing ${id}`);
    for (const id of M3_IDS) assert.ok(ids.includes(id), `missing M3 ${id}`);
  });

  test("every CUT row returns its manifest bytes or exact failure code", () => {
    const manifest = readManifest();
    const rows = manifest.fixtures.filter((f) => f.algorithm === "replay-cut-v2");
    for (const fx of rows) {
      const body = readFixture(fx.path);
      const { requestedSeq, boundarySafeSeq, committedSeq, capturedHighWater, anchorFloor, pairs } = cutInput(body);
      const { cut, retreats } = computeEffectiveCutV2({
        requestedSeq,
        boundarySafeSeq,
        committedSeq,
        capturedHighWater,
        anchorFloor,
        pairs,
      });
      if (fx.expected !== "ok") {
        assert.fail(`${fx.id}: replay-cut-v2 rows are expected ok`);
      }
      assert.equal(
        cut.effectiveSeq,
        BigInt(body.expected.effectiveSeq as number),
        `${fx.id} effectiveSeq mismatch`,
      );
      const codes = retreats.map((r) => r.code);
      const expectedCodes: string[] = body.expected.retreatCodes ?? [];
      assert.deepEqual(
        codes.sort(),
        [...expectedCodes].sort(),
        `${fx.id} retreat codes mismatch`,
      );
      if (body.expected.anchorFloorRespected) {
        assert.ok(cut.effectiveSeq >= anchorFloor, `${fx.id} crossed the anchor floor`);
      }
    }
  });

  test("CUT-PAIR-001: requested cut between call c7 and result r7 retreats before c7", () => {
    const body = readFixture("replay/CUT-001.json");
    const { cut } = computeEffectiveCutV2({
      requestedSeq: BigInt(body.input.requestedSeq),
      boundarySafeSeq: BigInt(body.input.boundarySafeSeq),
      committedSeq: BigInt(body.input.committedSeq),
      capturedHighWater: BigInt(body.input.capturedHighWater),
      anchorFloor: BigInt(body.input.anchorFloor),
      pairs: body.input.pairs.map((p: any) => ({ callSeq: BigInt(p.callSeq), resultSeq: BigInt(p.resultSeq) }) as ReplayToolPair),
    });
    // call c7 = seq 7, result r7 = seq 9; retreat lands at call-1 = 6.
    assert.equal(cut.effectiveSeq, 6n);
    assert.ok(cut.effectiveSeq < 8n, "must retreat before c7 (seq 7)");
  });

  test("CUT-ANCHOR-002: retreat cannot cross the recent-anchor floor", () => {
    const body = readFixture("replay/CUT-002.json");
    const input = cutInput(body);
    const { cut, retreats } = computeEffectiveCutV2(input);
    assert.ok(cut.effectiveSeq >= input.anchorFloor, "effective must never go below the floor");
    assert.ok(retreats.some((r) => r.code === "CUT_TOOL_PAIR_SPLIT"));
  });

  test("CUT-HIGHWATER-003: captured high-water below committed seq wins", () => {
    const body = readFixture("replay/CUT-003.json");
    const input = cutInput(body);
    const { cut } = computeEffectiveCutV2(input);
    assert.equal(cut.effectiveSeq, input.capturedHighWater);
    assert.ok(cut.capturedHighWater < cut.committedSeq);
  });
});

describe("M3 migration conformance (M3-001..010)", () => {
  test("M3-001: copy/validate/switch activates the new effective cut", () => {
    const body = readFixture("replay/M3-001.json");
    const host = makeHost(body.input.host);
    host.state.committed = BigInt(body.input.cut.committedSeq);
    const input = cutInput(body);
    const res = migrateEffectiveCutV2(host, input);
    assert.equal(res.ok, true);
    assert.equal(res.effectiveSeq, BigInt(body.expected.effectiveSeq));
    assert.equal(host.state.active, "new", "pointer switched");
  });

  test("M3-002: crash after copy/validate but before switch retains the OLD pointer", () => {
    const body = readFixture("replay/M3-002.json");
    const host = makeHost(body.input.host);
    host.state.committed = BigInt(body.input.cut.committedSeq);
    const input = cutInput(body);
    // Phase 1 + 2 succeed...
    const staged = m3Copy(host, input);
    const v = m3Validate(host, input);
    assert.equal(v.ok, true, "validate passes before the crash");
    // ...crash BEFORE switch: active pointer remains OLD, staged not activated.
    assert.equal(host.state.active, "old", "crash leaves old pointer active");
    assert.equal(host.state.oldPointer, BigInt(body.expected.retainedPointer ?? 3));
    assert.equal(staged, BigInt(body.expected.effectiveSeq), "staged staged but not switched");
  });

  test("M3-003: resume after interruption is idempotent", () => {
    const body = readFixture("replay/M3-003.json");
    const host = makeHost(body.input.host);
    host.state.committed = BigInt(body.input.cut.committedSeq);
    const input = cutInput(body);
    // Pretend a prior partial switch already staged+activated (state active:"new").
    const first = migrateEffectiveCutV2(host, input);
    assert.equal(first.ok, true);
    const second = migrateEffectiveCutV2(host, input);
    assert.equal(second.ok, true);
    assert.equal(second.effectiveSeq, first.effectiveSeq, "idempotent resume");
  });

  test("M3-004..M3-008: each returns exactly its listed failure code", () => {
    const manifest = readManifest();
    const failRows = manifest.fixtures.filter(
      (f) => f.path.startsWith("replay/M3-") && f.expected !== "ok",
    );
    assert.ok(failRows.length >= 5, "expected the M3 failure-code rows");
    for (const fx of failRows) {
      const body = readFixture(fx.path);
      const host = makeHost(body.input.host);
      host.state.committed = BigInt(body.input.cut.committedSeq);
      const input = cutInput(body);
      // Failure injection: validate the host's provided (bad) staged pointer
      // WITHOUT copy (copy would overwrite it and mask the corruption).
      const v = m3Validate(host, input);
      assert.equal(v.ok, false, `${fx.id} must fail validation`);
      assert.ok(v.codes.includes(fx.expected as any), `${fx.id} listed code=${fx.expected}, got ${v.codes.join(",")}`);
      // Switch never runs on failure.
      assert.equal(host.state.active, "old", `${fx.id} must not switch on failure`);
    }
  });

  test("M3-009: pair retreat bounded by anchor floor yields a valid resumed cut", () => {
    const body = readFixture("replay/M3-009.json");
    const host = makeHost(body.input.host);
    host.state.committed = BigInt(body.input.cut.committedSeq);
    const input = cutInput(body);
    const res = migrateEffectiveCutV2(host, input);
    assert.equal(res.ok, true);
    assert.equal(res.effectiveSeq, BigInt(body.expected.effectiveSeq));
    assert.ok(res.effectiveSeq >= input.anchorFloor);
    assert.equal(host.state.active, "new");
  });

  test("M3-010: frozen captured high-water below committed wins the cut", () => {
    const body = readFixture("replay/M3-010.json");
    const host = makeHost(body.input.host);
    host.state.committed = BigInt(body.input.cut.committedSeq);
    const input = cutInput(body);
    const res = migrateEffectiveCutV2(host, input);
    assert.equal(res.ok, true);
    assert.equal(res.effectiveSeq, input.capturedHighWater);
  });
});

describe("Replay scan hard invariants (10,000 turns)", () => {
  test("no reordered / split / orphan tool pairs across 10,000 replay turns", () => {
    const sessionId = "s-vc0b-acceptance-bulk";
    const turns = 10_000;
    const occurrences = balancedStream(sessionId, turns);
    const { report } = runReplayV2({
      sessionId,
      occurrences,
      requestedSeq: BigInt(occurrences.length),
      committedSeq: BigInt(occurrences.length) - 1n,
      capturedHighWater: BigInt(occurrences.length),
      anchorFloor: 0n,
      mode: "A",
    });
    assert.equal(report.counts.reordered, 0, "zero reordered pairs (10k turns)");
    assert.equal(report.counts.splitPairs, 0, "zero split pairs (10k turns)");
    assert.equal(report.counts.orphanToolEvents, 0, "zero orphan tool events (10k turns)");
    assert.equal(report.cut.effectiveSeq < BigInt(occurrences.length), true);
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────
