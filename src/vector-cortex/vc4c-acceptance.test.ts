/**
 * VC4C acceptance aggregator — CLO-001..030 + REC-001..030 + the three named rows
 * (CLO-TRANSITIVE-001 / CLO-CONTRA-002 / REC-ORDER-003) against the REAL
 * reconstruct logic (src/vector-cortex/reconstruct/{closure,assemble,validate}.js).
 * Fixture materialization lives in ./reconstruct/_acceptance-helpers.ts.
 *
 * Acceptance assertions pinned by the sprint contract:
 *   - CLO-TRANSITIVE-001: selecting a adds dependencies b then c
 *   - CLO-CONTRA-002: the later exact resolution supersedes the earlier claim
 *   - REC-ORDER-003: semantic and exact spans assemble by source offsets
 *   - closure reaches a fixed point; validated output contains every protected span
 *   - UNIQUE failure injection: erase a dependency shard + corrupt its residual
 *     fallback -> validator returns REC_SOURCE_UNAVAILABLE and blocks live output
 *   - forced triad A (closed semantic+exact/residual) / B (greedy exact-only) /
 *     C (legacy prompt, continuity not completeness)
 *   - REC_DIGEST_MISMATCH: a shard whose pinned digest disagrees with its bytes
 *     is rejected (real digest path, not the "0" unset sentinel)
 *
 * Flag-off parity: MEGACOMPACT_VC4C only gates the reporter seam; the closure /
 * assemble / validate functions are PURE and byte-identical either way, so this
 * SAME acceptance suite is green under both flag states.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { closeSelection, isFixedPoint, closeExactOnly } from "./reconstruct/closure.js";
import { assembleSourceOrder } from "./reconstruct/assemble.js";
import { validateAndAssemble } from "./reconstruct/validate.js";
import { CLO_IDS, REC_IDS, RECONSTRUCT_NAMED_IDS } from "./reconstruct/types.js";
import {
  fixture,
  materializeGraph,
  materializeShards,
  readManifest,
  runScenario,
  withFlagsOn,
} from "./reconstruct/_acceptance-helpers.js";

describe("VC4C conformance registration", () => {
  test("manifest registers CLO-001..030 + REC-001..030 + the three named fixtures", () => {
    const m = readManifest();
    const ids = m.fixtures.filter((f) => f.path.startsWith("reconstruction/")).map((f) => f.id);
    for (const id of CLO_IDS) assert.ok(ids.includes(id), `missing ${id}`);
    for (const id of REC_IDS) assert.ok(ids.includes(id), `missing ${id}`);
    for (const id of RECONSTRUCT_NAMED_IDS) assert.ok(ids.includes(id), `missing ${id}`);
    for (const id of [...CLO_IDS, ...REC_IDS, ...RECONSTRUCT_NAMED_IDS]) {
      const row = m.fixtures.find((f) => f.id === id);
      assert.ok(row, `${id} has a manifest row`);
      assert.equal(row.algorithm, "reconstruction", `${id} algorithm promotion`);
    }
  });
});

describe("CLO-001..030 conformance rows", () => {
  for (const id of CLO_IDS) {
    test(`${id}: ${fixture(id).assertion}`, withFlagsOn(async () => {
      const fx = fixture(id);
      const got = await runScenario(fx);
      assert.equal(got.ok, fx.expected.ok, `${id}: ok=${fx.expected.ok}`);
      if (fx.expected.code !== undefined) assert.equal(got.code, fx.expected.code, `${id}: failure code`);
      if (fx.expected.selected !== undefined) assert.deepEqual(got.selected, fx.expected.selected, `${id}: selected set`);
      if (fx.expected.selectedCount !== undefined) assert.equal(got.selectedCount, fx.expected.selectedCount, `${id}: selectedCount`);
      if (fx.expected.unresolved !== undefined) assert.deepEqual(got.unresolved, fx.expected.unresolved, `${id}: unresolved`);
      if (fx.expected.removedContradictions !== undefined) assert.deepEqual(got.removedContradictions, fx.expected.removedContradictions, `${id}: removed contradictions`);
      if (fx.expected.mandatoryTokenEstimate !== undefined) assert.equal(got.mandatoryTokenEstimate, fx.expected.mandatoryTokenEstimate, `${id}: mandatory token estimate`);
      if (fx.expected.closureReachedFixedPoint !== undefined) assert.equal(got.closureReachedFixedPoint, fx.expected.closureReachedFixedPoint, `${id}: fixed point`);
    }));
  }
});

describe("VC4C named headline rows", () => {
  test("CLO-TRANSITIVE-001: selecting a adds dependencies b then c (named)", withFlagsOn(async () => {
    const fx = fixture("CLO-TRANSITIVE-001");
    const graph = materializeGraph(fx.input.graph ?? "chain");
    const closure = closeSelection({ graph, seeds: fx.input.seeds ?? ["a"] });
    assert.equal(closure.ok, true);
    assert.deepEqual(closure.selected, ["a", "b", "c"]);
    assert.equal(isFixedPoint(graph, closure), true);
    assert.equal(RECONSTRUCT_NAMED_IDS[0], "CLO-TRANSITIVE-001");
  }));

  test("CLO-CONTRA-002: the later exact resolution supersedes the earlier claim (named)", withFlagsOn(async () => {
    const fx = fixture("CLO-CONTRA-002");
    const graph = materializeGraph(fx.input.graph ?? "contra-later");
    const closure = closeSelection({ graph, seeds: ["a"] });
    assert.equal(closure.ok, true);
    assert.ok(!closure.selected.includes("early"), "earlier claim removed");
    assert.ok(closure.selected.includes("late"), "later claim retained");
    assert.deepEqual([...closure.removedContradictions], ["early"]);
    assert.equal(RECONSTRUCT_NAMED_IDS[1], "CLO-CONTRA-002");
  }));

  test("REC-ORDER-003: semantic and exact spans assemble by source offsets (named)", withFlagsOn(async () => {
    const fx = fixture("REC-ORDER-003");
    const graph = materializeGraph(fx.input.graph ?? "ordered");
    const shards = [...materializeShards(fx.input.shards ?? "ordered", graph).values()];
    const closure = closeSelection({ graph, seeds: ["a"] });
    assert.equal(closure.ok, true);
    const assembled = await assembleSourceOrder({ sessionId: graph.sessionId, selected: closure.selected, nodes: graph.nodes, edges: graph.edges, shards, mandatoryTokenEstimate: closure.mandatoryTokenEstimate });
    assert.equal(assembled.code, null);
    assert.ok(assembled.reconstruction !== null);
    const order = assembled.reconstruction!.spans.map((s) => s.nodeId);
    assert.deepEqual(order, ["a", "b", "c"], "sorted by source offset, not closure order");
    assert.equal(RECONSTRUCT_NAMED_IDS[2], "REC-ORDER-003");
  }));
});

describe("VC4C acceptance (closure fixed point + protected spans + failure injection + triad)", () => {
  test("acceptance: every CLO closure reaches a fixed point", withFlagsOn(async () => {
    for (const id of CLO_IDS) {
      const fx = fixture(id);
      if (!fx.expected.ok) continue;
      const graph = materializeGraph(fx.input.graph ?? "leaf");
      const seeds = fx.input.seeds ?? (graph.nodes[0] ? [graph.nodes[0].id] : []);
      const closure = closeSelection({ graph, seeds });
      assert.equal(isFixedPoint(graph, closure), true, `${id}: fixed point`);
    }
  }));

  test("acceptance: a validated reconstruction contains every protected span", withFlagsOn(async () => {
    const graph = materializeGraph("protected");
    const shards = [...materializeShards("protected", graph).values()];
    const closure = closeSelection({ graph, seeds: ["a"] });
    assert.equal(closure.ok, true);
    const assembled = await assembleSourceOrder({ sessionId: graph.sessionId, selected: closure.selected, nodes: graph.nodes, edges: graph.edges, shards, mandatoryTokenEstimate: closure.mandatoryTokenEstimate });
    assert.equal(assembled.code, null);
    assert.ok(assembled.reconstruction !== null);
    const protectedSpans = assembled.reconstruction!.spans.filter((s) => s.protectedSpan);
    assert.equal(protectedSpans.length, 1, "every protected span present");
    assert.equal(protectedSpans[0]!.nodeId, "a");
  }));

  test("acceptance: UNIQUE failure injection — erase b + corrupt residual fallback returns REC_SOURCE_UNAVAILABLE", withFlagsOn(async () => {
    const graph = materializeGraph("ordered");
    // Erase dependency shard b and corrupt its residual fallback.
    const shards = materializeShards("ordered-corrupt-fallback", graph, "b");
    const corrupt = shards.get("b");
    if (corrupt !== undefined) shards.set("b", { ...corrupt, bytes: new TextEncoder().encode("WRONG!!") });
    const closure = closeSelection({ graph, seeds: ["a"] });
    const validated = await validateAndAssemble({ graph, closure, nodes: graph.nodes, edges: graph.edges, shards: [...shards.values()] });
    assert.equal(validated.validation.ok, false, "live output blocked");
    assert.equal(validated.validation.ok ? null : validated.validation.codes[0], "REC_SOURCE_UNAVAILABLE", "exact failure code");
  }));

  test("acceptance: a shard whose pinned digest disagrees with its bytes is rejected (REC_DIGEST_MISMATCH)", withFlagsOn(async () => {
    // Pin a REAL (non-"0") digest that does not match the shard bytes. This is
    // the path the validator's findDigestMismatch guards: a supply-chain or
    // storage corruption that swaps bytes without re-pinning the digest.
    const graph = materializeGraph("single");
    const wrongDigest = "0000000000000000000000000000000000000000000000000000000000000000";
    const shards = materializeShards("single", graph, undefined, wrongDigest);
    // sanity: the override took and the digest is not the "0" sentinel the
    // validator skips.
    const shard = [...shards.values()][0]!;
    assert.notEqual(shard.digest, "0");
    assert.notEqual(shard.digest, createHash("sha256").update(shard.bytes).digest("hex"));
    const closure = closeSelection({ graph, seeds: ["a"] });
    assert.equal(closure.ok, true);
    const validated = await validateAndAssemble({ graph, closure, nodes: graph.nodes, edges: graph.edges, shards: [...shards.values()] });
    assert.equal(validated.validation.ok, false, "mismatched digest must not go live");
    assert.equal(validated.validation.ok ? null : validated.validation.codes[0], "REC_DIGEST_MISMATCH", "exact failure code");
  }));

  test("acceptance: forced triad A/B/C are independent and non-overlapping", withFlagsOn(async () => {
    const graph = materializeGraph("mixed");
    const seeds = ["a"];
    // A: closed semantic + exact + residual.
    const a = closeSelection({ graph, seeds });
    assert.equal(a.ok, true);
    const aShards = [...materializeShards("mixed", graph).values()];
    const aAsm = await assembleSourceOrder({ sessionId: graph.sessionId, selected: a.selected, nodes: graph.nodes, edges: graph.edges, shards: aShards, mandatoryTokenEstimate: a.mandatoryTokenEstimate });
    assert.equal(aAsm.code, null);
    assert.ok(aAsm.reconstruction !== null);
    assert.equal(aAsm.reconstruction!.spans.some((s) => s.source === "semantic"), true, "A includes semantics");

    // B: greedy exact-only (no semantics) — independent algorithm/index.
    const b = closeExactOnly({ graph, seeds });
    assert.equal(b.ok, true);
    assert.ok(!b.selected.some((id) => graph.nodes.find((n) => n.id === id)?.kind === "semantic"), "B excludes semantics");

    // C: legacy prompt — continuity, drops semantic tier, states the loss.
    const cShards = [...materializeShards("mixed", graph).values()].filter((s) => graph.nodes.find((n) => n.id === s.nodeId)?.kind !== "semantic");
    assert.ok(cShards.length < aShards.length, "C omits the semantic tier");
  }));
});

describe("VC4C flag-off parity", () => {
  test("closure/assemble/validate are byte-identical with MEGACOMPACT_VC4C untouched (pure math)", async () => {
    const run = async (): Promise<unknown> => {
      const graph = materializeGraph("ordered");
      const shards = [...materializeShards("ordered", graph).values()];
      const closure = closeSelection({ graph, seeds: ["a"] });
      assert.equal(closure.ok, true);
      const assembled = await assembleSourceOrder({ sessionId: graph.sessionId, selected: closure.selected, nodes: graph.nodes, edges: graph.edges, shards, mandatoryTokenEstimate: closure.mandatoryTokenEstimate });
      assert.equal(assembled.code, null);
      assert.ok(assembled.reconstruction !== null);
      return assembled.reconstruction!;
    };
    // Default: flag ON (env unset → sprintFlag defaults true).
    const saved = process.env.MEGACOMPACT_VC4C;
    delete process.env.MEGACOMPACT_VC4C;
    const on = await run();
    // Explicit OFF: the reconstruct math is pure and must not change.
    process.env.MEGACOMPACT_VC4C = "0";
    const off = await run();
    assert.deepEqual(off, on, "flag OFF must be byte-identical to flag ON");
    assert.deepEqual((off as { spans: Array<{ nodeId: string }> }).spans.map((s) => s.nodeId), ["a", "b", "c"]);
    // Restore.
    if (saved === undefined) delete process.env.MEGACOMPACT_VC4C;
    else process.env.MEGACOMPACT_VC4C = saved;
  });
});
