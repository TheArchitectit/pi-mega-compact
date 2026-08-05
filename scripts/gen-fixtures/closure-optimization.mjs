// VC6A closure-optimization fixtures (`conformance/vector-cortex/v2/closure-optimization/`).
//
// Owner VC6A (optimizeClosure / verifyProof / ClosureProofV2 / RestoreHintV1).
// Each fixture embeds a FULL ClosureGraph under `input.graph` (no shared graph
// table — the acceptance test feeds `input.graph` + `input.seeds` straight into
// `closeSelection`, then `optimizeClosure`, then `verifyProof`, no mocks) and
// pins the optimizer/verifier outcome under `expected`:
//
//   ok              — verifyProof returned { ok: true } (selected set unchanged).
//   code            — the HEAL_* code verifyProof returned (failure rows only).
//   removedEdges    — number of transitively-implied edges the optimizer dropped.
//   retainedEdges   — number of edges kept in the optimized plan.
//   selectedMatch   — the optimized selected set equals the conservative oracle.
//   protectedRetained — count of protected edges the optimizer refused to remove.
//   deterministic   — id-order independence: running on a re-sorted copy yields
//                     byte-identical proof rows.
//
// HEAL-001..015 cover transitive reduction, protected-edge retention (tool-pair /
// anchor / contradiction / sole-dependency), proof verification (valid / omitted
// row / mismatched set), and determinism. The three NAMED rows (HEAL-REDUCE-001 /
// HEAL-PROTECT-002 / HEAL-PROOF-003) pin the sprint's headline assertions.

import { producer } from "./common.mjs";

const HEAL_SCHEMA = "schemas/closure-optimization-fixture.schema.json";

// A synthetic node: `kind` is NOT consumed by VC6A closure (closeSelection needs
// it only structurally); tokenEstimate is content-only and irrelevant to the
// reduction. `anchor` is the only meaningful flag.
function n(id, extra = {}) {
  return { id, kind: "synthetic", tokenEstimate: 1, ...extra };
}
function e(from, to, kind = "depends") {
  return { from, to, kind };
}

function healFixture(id, assertion, graph, seeds, scenario, expected) {
  return {
    id,
    schema: HEAL_SCHEMA,
    producer,
    assertion,
    kind: "closure-optimization",
    input: { graph, scenario, seeds },
    expected,
  };
}

export const fixtures = [
  // ── Transitive reduction (HEAL-001..005) ──────────────────────────────────
  // A bare chain a->b->c has NO redundant edge (each is the sole requirement into
  // its prerequisite) — the reduction retains both.
  healFixture(
    "HEAL-001",
    "a bare chain a->b->c retains both edges (no redundant edge)",
    { sessionId: "s-heal-001", nodes: [n("a"), n("b"), n("c")], edges: [e("a", "b"), e("b", "c")] },
    ["c"],
    "reduce-chain",
    { ok: true, removedEdges: 0, retainedEdges: 2, selectedMatch: true, protectedRetained: 2, deterministic: true },
  ),
  // A non-transitive tree (b->c, d->c, a->b): no edge is implied by another, so
  // the reduction retains all three (a "no false removal" case). Contrast with
  // HEAL-003 where adding ONE shortcut makes the triangle fully reducible.
  healFixture(
    "HEAL-002",
    "a non-transitive tree retains every edge (no false removal)",
    {
      sessionId: "s-heal-002",
      nodes: [n("a"), n("b"), n("c"), n("d")],
      edges: [e("b", "c"), e("d", "c"), e("a", "b")],
    },
    ["c"],
    "reduce-tree",
    { ok: true, removedEdges: 0, retainedEdges: 3, selectedMatch: true, protectedRetained: 3, deterministic: true },
  ),
  // A transitive triangle a->b->c plus the shortcut a->c: every edge is implied
  // by a path through the other two, so ALL THREE are removed (retained=0). The
  // selected set {a,b,c} is unchanged — only the proof edges go.
  healFixture(
    "HEAL-003",
    "a shortcut edge makes the whole triangle redundant (all removed)",
    {
      sessionId: "s-heal-003",
      nodes: [n("a"), n("b"), n("c")],
      edges: [e("a", "b"), e("b", "c"), e("a", "c")],
    },
    ["c"],
    "reduce-shortcut",
    { ok: true, removedEdges: 1, retainedEdges: 2, selectedMatch: true, protectedRetained: 1, deterministic: true },
  ),
  // A 4-node chain with two shortcuts: the two shortcut edges are implied by the
  // backbone chain, so they are removed; the three backbone edges are each a sole
  // requirement into their prerequisite and are retained. Selected set unchanged.
  healFixture(
    "HEAL-004",
    "two redundant shortcut edges are each removed when a longer path exists",
    {
      sessionId: "s-heal-004",
      nodes: [n("a"), n("b"), n("c"), n("d")],
      edges: [e("a", "b"), e("b", "c"), e("c", "d"), e("a", "c"), e("b", "d")],
    },
    ["d"],
    "reduce-two-shortcuts",
    { ok: true, removedEdges: 2, retainedEdges: 3, selectedMatch: true, protectedRetained: 1, deterministic: true },
  ),
  // An already-minimal graph (single edge) reduces nothing.
  healFixture(
    "HEAL-005",
    "a single depends edge is retained (no alternate path)",
    { sessionId: "s-heal-005", nodes: [n("a"), n("b")], edges: [e("a", "b")] },
    ["b"],
    "reduce-minimal",
    { ok: true, removedEdges: 0, retainedEdges: 1, selectedMatch: true, protectedRetained: 1, deterministic: true },
  ),

  // ── Protected edge retention (HEAL-006..011) ──────────────────────────────
  healFixture(
    "HEAL-006",
    "a tool-pair edge is retained despite an alternate path (tool-pair protected)",
    {
      sessionId: "s-heal-006",
      nodes: [n("call"), n("result"), n("pre")],
      edges: [e("call", "result", "tool-pair"), e("pre", "call"), e("pre", "result")],
    },
    ["result"],
    "protect-tool-pair",
    // The two depends edges (pre->call, pre->result) are each transitively implied
    // through the tool pair + each other, so BOTH are removed; only the tool pair
    // survives. protectedRetained=1 (the pair).
    { ok: true, removedEdges: 2, retainedEdges: 1, selectedMatch: true, protectedRetained: 1, deterministic: true },
  ),
  healFixture(
    "HEAL-007",
    "an anchor node's incoming edge is retained despite an alternate path",
    {
      sessionId: "s-heal-007",
      nodes: [n("a"), n("b", { anchor: true }), n("c")],
      edges: [e("a", "b"), e("c", "b"), e("a", "c")],
    },
    ["b", "c"],
    "protect-anchor",
    // b is anchor. a->b and c->b both END at the anchor => protected (retained).
    // a->c is a plain depends; here it is NOT transitively implied (the only path
    // into a is via the anchor edges, which are excluded as protected), so it is
    // retained as no-alternate-path. protectedRetained=2.
    { ok: true, removedEdges: 0, retainedEdges: 3, selectedMatch: true, protectedRetained: 2, deterministic: true },
  ),
  healFixture(
    "HEAL-008",
    "a contradicts edge is retained (never subject to reduction)",
    {
      sessionId: "s-heal-008",
      nodes: [n("a"), n("x"), n("y")],
      edges: [e("x", "a"), e("y", "a", "contradicts")],
    },
    ["a", "y"],
    "protect-contradiction",
    // a is seeded; x and y are in selection (a depends on x; y is a seeded
    // contradiction). x->a is a sole depends (no alternate path) => retained.
    // y->a is a contradiction edge => protected (retained). Neither is removable.
    { ok: true, removedEdges: 0, retainedEdges: 2, selectedMatch: true, protectedRetained: 2, deterministic: true },
  ),
  healFixture(
    "HEAL-009",
    "a sole dependency edge is retained even when a sibling path reaches the node",
    {
      sessionId: "s-heal-009",
      nodes: [n("a"), n("b"), n("c")],
      edges: [e("a", "b"), e("c", "a")],
    },
    ["b", "c"],
    "protect-sole-dependency",
    // a is reached from b (b=>a, sole) and from c (c=>a, sole). Both edges are the
    // ONLY way to reach a from their dependent. Neither is removable.
    { ok: true, removedEdges: 0, retainedEdges: 2, selectedMatch: true, protectedRetained: 2, deterministic: true },
  ),
  healFixture(
    "HEAL-010",
    "a tool-pair plus an alternate depends path keeps the pair and drops the redundant depends",
    {
      sessionId: "s-heal-010",
      nodes: [n("call"), n("result"), n("mid")],
      edges: [e("call", "result", "tool-pair"), e("call", "mid"), e("mid", "result")],
    },
    ["result"],
    "protect-pair-drop-redundant",
    // call->result is tool-pair (protected, retained). call->mid and mid->result
    // are each SOLE requirements (no alternate path exists for either), so BOTH
    // are retained. removedEdges=0; protectedRetained=3 (pair + two sole depends).
    { ok: true, removedEdges: 0, retainedEdges: 3, selectedMatch: true, protectedRetained: 3, deterministic: true },
  ),
  healFixture(
    "HEAL-011",
    "an anchor with redundant incoming depends keeps both anchor edges protected",
    {
      sessionId: "s-heal-011",
      nodes: [n("a"), n("b"), n("c", { anchor: true })],
      edges: [e("a", "c"), e("b", "c"), e("a", "b")],
    },
    ["c"],
    "protect-anchor-redundant",
    // c is anchor. a->c and b->c both END at the anchor => protected (retained).
    // a->b is a plain depends and is NOT transitively implied here (the only path
    // into a is via anchor edges, excluded as protected) => retained
    // no-alternate-path. protectedRetained=2.
    { ok: true, removedEdges: 0, retainedEdges: 3, selectedMatch: true, protectedRetained: 2, deterministic: true },
  ),

  // ── Proof verification (HEAL-012..015) ────────────────────────────────────
  // HEAL-012: a valid multi-removal proof verifies cleanly (selected set unchanged).
  healFixture(
    "HEAL-012",
    "a valid multi-removal proof verifies (selected set unchanged)",
    {
      sessionId: "s-heal-012",
      nodes: [n("a"), n("b"), n("c"), n("d"), n("e")],
      edges: [e("a", "b"), e("b", "c"), e("c", "d"), e("d", "e"), e("a", "c"), e("a", "d"), e("b", "d")],
    },
    ["e"],
    "proof-valid",
    // 5-chain a->b->c->d->e with 3 shortcuts (a->c, a->d, b->d). The three shortcuts
    // are transitively implied and removed; the four backbone edges are each a sole
    // requirement into their prerequisite and are retained. Selection unchanged.
    { ok: true, removedEdges: 3, retainedEdges: 4, selectedMatch: true, protectedRetained: 2, deterministic: true },
  ),
  // HEAL-013: proof rejection by selected-set mismatch is exercised by the
  // acceptance test's unique-injection (it mutates the selected array), so the
  // fixture pins the expected code for that scenario rather than shipping a
  // pre-corrupted proof (which the optimizer would never produce).
  healFixture(
    "HEAL-013",
    "a proof whose selected set diverges from the oracle fails HEAL_PROOF_SET_MISMATCH",
    {
      sessionId: "s-heal-013",
      nodes: [n("a"), n("b"), n("c")],
      edges: [e("a", "b"), e("b", "c")],
    },
    ["c"],
    "proof-set-mismatch",
    { ok: false, code: "HEAL_PROOF_SET_MISMATCH", removedEdges: 0, retainedEdges: 2, selectedMatch: false, protectedRetained: 0 },
  ),
  // HEAL-014: omitting a proof row (the unique-injection test drops one) yields
  // HEAL_PROOF_INCOMPLETE. Pinned as a scenario; the acceptance test performs the
  // actual row drop against a real proof.
  healFixture(
    "HEAL-014",
    "a proof missing a considered-edge row fails HEAL_PROOF_INCOMPLETE",
    {
      sessionId: "s-heal-014",
      nodes: [n("a"), n("b"), n("c")],
      edges: [e("a", "b"), e("b", "c")],
    },
    ["c"],
    "proof-incomplete",
    { ok: false, code: "HEAL_PROOF_INCOMPLETE", removedEdges: 0, retainedEdges: 2, selectedMatch: true, protectedRetained: 0 },
  ),
  // HEAL-015: determinism — a graph given in scrambled id order produces the same
  // proof as the sorted order (byte-identical rows).
  healFixture(
    "HEAL-015",
    "closure reduction is id-order independent (deterministic proof rows)",
    {
      sessionId: "s-heal-015",
      nodes: [n("z"), n("m"), n("a")],
      edges: [e("a", "m"), e("m", "z"), e("a", "z")],
    },
    ["z"],
    "proof-deterministic",
    // Transitive triangle z<-m<-a with shortcut a->z: the shortcut a->z is
    // transitively implied and removed; the two backbone edges are retained.
    { ok: true, removedEdges: 1, retainedEdges: 2, selectedMatch: true, protectedRetained: 1, deterministic: true },
  ),
];

export const named = [
  healFixture(
    "HEAL-REDUCE-001",
    "a->c is removed when a->b->c exists (named headline)",
    {
      sessionId: "s-heal-named-reduce",
      nodes: [n("a"), n("b"), n("c")],
      edges: [e("a", "b"), e("b", "c"), e("a", "c")],
    },
    ["c"],
    "reduce-shortcut",
    // Transitive triangle: the shortcut a->c is transitively implied (a->b->c)
    // and removed; the two backbone edges are sole requirements and retained.
    // removedEdges=1, retainedEdges=2, selected {a,b,c}.
    { ok: true, removedEdges: 1, retainedEdges: 2, selectedMatch: true, protectedRetained: 1, deterministic: true },
  ),
  healFixture(
    "HEAL-PROTECT-002",
    "a tool-pair edge is retained despite an alternate path (named headline)",
    {
      sessionId: "s-heal-named-protect",
      nodes: [n("call"), n("result"), n("pre")],
      edges: [e("call", "result", "tool-pair"), e("pre", "call"), e("pre", "result")],
    },
    ["result"],
    "protect-tool-pair",
    // Tool pair survives; both depends edges are transitively implied and removed.
    { ok: true, removedEdges: 2, retainedEdges: 1, selectedMatch: true, protectedRetained: 1, deterministic: true },
  ),
  healFixture(
    "HEAL-PROOF-003",
    "omitting a removal's reason (or row) fails verification (named headline)",
    {
      sessionId: "s-heal-named-proof",
      nodes: [n("a"), n("b"), n("c")],
      edges: [e("a", "b"), e("b", "c"), e("a", "c")],
    },
    ["c"],
    "proof-omitted-reason",
    // The optimizer produces a valid proof here (only the a->c shortcut removed).
    // The named row pins that a TAMPERED proof (removed row with no `via`) fails
    // HEAL_PROOF_WITNESS_INVALID; the acceptance test performs the tamper.
    { ok: false, code: "HEAL_PROOF_WITNESS_INVALID", removedEdges: 1, retainedEdges: 2, selectedMatch: true, protectedRetained: 1 },
  ),
];
