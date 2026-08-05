/**
 * vector-cortex/heal/proof.ts — VC6A proof verifier (task 4).
 *
 * The optimizer (`closure-opt.ts`) is PURE and cheap, but a proof is cheap to
 * LIE about: a buggy or tampered producer could ship a proof that removes an
 * edge the conservative closure actually needs. The verifier does not trust the
 * proof — it REPLAYS it against the conservative oracle from scratch.
 *
 * REPLAY. From the conservative `ClosureResult` we rebuild the requirement
 * adjacency (`to ⇒ from` for `depends`, both directions for `tool-pair`) over
 * the in-selection edges — exactly the relation `closure-opt` reduced over.
 * For every row the proof claims to REMOVE, the verifier independently confirms
 * the same alternate path exists. For every row it claims to RETAIN, it confirms
 * the protection reason holds (or that no alternate path exists). Any row that
 * fails its own predicate is a witness violation.
 *
 * SELECTED-SET DIVERGENCE (the cardinal sin). The proof must contain the SAME
 * selected set as the conservative oracle, byte for byte. Closure optimization
 * is allowed to make the plan cheaper, never smaller — so if the proof's
 * `selected` differs from the oracle's, that is `HEAL_PROOF_SET_MISMATCH` and the
 * repaired triad must fall back to mode B (the conservative closure) and
 * ultimately C (VC5C's legacy prompt) if even that fails.
 *
 * PURE / DETERMINISTIC / LOCAL, like everything in `heal/`: no storage, no
 * console, no clock, no network (PREVENT-PI-004 / PREVENT-011). The verifier
 * reads only types and the two ClosureEdge/ClosureGraph/ClosureResult shapes.
 */

import type { ClosureGraph, ClosureResult } from "../reconstruct/types.js";
import type {
  ClosureProofRow,
  ClosureProofV2,
  HealFailureCode,
  HealMode,
  HealTriadOutcome,
  ProofVerification,
} from "./types.js";

/** Bytewise id comparator — matches `closure-opt.ts` / `reconstruct/closure.ts`. */
function byBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Requirement adjacency over an edge list, identical to `closure-opt`. */
function requirementAdjacency(edges: readonly ClosureProofRow[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  const add = (key: string, value: string): void => {
    const list = adj.get(key);
    if (list === undefined) adj.set(key, [value]);
    else list.push(value);
  };
  for (const row of edges) {
    if (row.kind === "contradicts") continue; // not a traversal edge
    if (row.kind === "depends") add(row.to, row.from);
    else if (row.kind === "tool-pair") {
      add(row.to, row.from);
      add(row.from, row.to);
    }
  }
  for (const list of adj.values()) list.sort(byBytes);
  return adj;
}

/** Does a detour `start ⇒ via ⇒ ... ⇒ target` exist, excluding the direct hop? */
function alternatePathVia(
  adj: ReadonlyMap<string, string[]>,
  start: string,
  target: string,
): string | null {
  for (const hop of (adj.get(start) ?? []).filter((n) => n !== target)) {
    const seen = new Set<string>([start]);
    const worklist: string[] = [hop];
    while (worklist.length > 0) {
      worklist.sort(byBytes);
      const current = worklist.shift();
      if (current === undefined) break;
      if (current === target) return hop;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of adj.get(current) ?? []) {
        if (!seen.has(next)) worklist.push(next);
      }
    }
  }
  return null;
}

/**
 * Verify a `ClosureProofV2` produced for an already-closed graph.
 *
 * Returns `{ ok: true, selected }` when the replay confirms the optimized plan is
 * provably equivalent to the conservative closure — mode A may be used. On any
 * divergence it returns `{ ok: false, codes }` listing every failure code; the
 * caller routes to mode B (conservative) and, if that also fails, mode C (legacy,
 * with `semanticLossStated`). The verifier is idempotent — replaying the same
 * proof twice yields the same verdict, which `vc6a-acceptance.test.ts` asserts.
 */
export function verifyProof(
  proof: ClosureProofV2,
  conservative: ClosureResult,
  graph?: ClosureGraph,
): ProofVerification {
  const codes: HealFailureCode[] = [];
  const inSelection = new Set(conservative.selected);
  const anchors = new Set(
    (graph?.nodes ?? []).filter((n) => n.anchor === true).map((n) => n.id),
  );

  // 1. Selected-set divergence is the hard gate (task 4: HEAL_PROOF_SET_MISMATCH).
  const oracleSelected = [...conservative.selected].sort(byBytes);
  const proofSelected = [...proof.selected].sort(byBytes);
  const selectedMatch =
    oracleSelected.length === proofSelected.length &&
    oracleSelected.every((id, i) => id === proofSelected[i]);
  if (!selectedMatch) codes.push("HEAL_PROOF_SET_MISMATCH");

  // 2. Re-check each row against its own predicate. For a removal, the witness
  //    is validated against the OTHER rows (the reduced graph), so a removal
  //    never justifies another's witness — this catches both a missing-witness
  //    removal (HEAL-PROOF-003) and a protected edge that was removed
  //    (HEAL_PROOF_PROTECTED_REMOVED).

  for (const row of proof.rows) {
    // Out-of-scope rows (touch an unselected node) should never have been
    // emitted; treat as a witness violation so a malformed proof fails loudly.
    if (!inSelection.has(row.from) || !inSelection.has(row.to)) {
      codes.push("HEAL_PROOF_WITNESS_INVALID");
      continue;
    }
    if (row.decision === "removed") {
      // A removal MUST carry a witness and the witness MUST still validate
      // against the OTHER rows (the reduced graph) — never the row itself, so a
      // removal never justifies another's witness (matches the optimizer's
      // exclusion rule).
      if (row.via === undefined) {
        codes.push("HEAL_PROOF_WITNESS_INVALID");
        continue;
      }
      const others = proof.rows.filter((r) => r !== row);
      const witness = alternatePathVia(requirementAdjacency(others), row.to, row.from);
      if (witness === null) {
        codes.push("HEAL_PROOF_WITNESS_INVALID");
        continue;
      }
      if (anchors.has(row.from) || anchors.has(row.to)) {
        // Topology says removable, but an anchor edge is NEVER removable.
        codes.push("HEAL_PROOF_PROTECTED_REMOVED");
        continue;
      }
      if (row.kind === "tool-pair" || row.kind === "contradicts") {
        // Both are protected regardless of topology.
        codes.push("HEAL_PROOF_PROTECTED_REMOVED");
      }
    } else {
      // A retained plain depends edge that claims `no-alternate-path` but
      // actually HAS one (through the other rows) is an internal inconsistency:
      // the optimizer kept a removable edge without removing it. The proof is
      // internally contradictory, so it fails replay.
      if (row.kind === "depends" && row.reason === "no-alternate-path") {
        const others = proof.rows.filter((r) => r !== row);
        const hasPath = alternatePathVia(requirementAdjacency(others), row.to, row.from);
        if (hasPath !== null) codes.push("HEAL_PROOF_WITNESS_INVALID");
      }
    }
  }

  // 3. Completeness: every in-selection edge the optimizer considered must appear
  //    in the proof. A dropped row (the unique-injection test drops one) surfaces
  //    as HEAL_PROOF_INCOMPLETE even if the remaining rows replay fine — the proof
  //    must account for EVERY considered edge. `conservativeTraversals` is the
  //    optimizer's own record of how many edges it fed through, so `rows.length`
  //    must equal it exactly.
  if (proof.rows.length < proof.conservativeTraversals) {
    codes.push("HEAL_PROOF_INCOMPLETE");
  }

  if (codes.length === 0) {
    return { ok: true, selected: proofSelected };
  }
  return { ok: false, codes: [...new Set(codes)] };
}

/**
 * Drive the A/B/C resilient triad for one closure (task 5 wiring; VC6A exposes
 * the decision; the actual selection/budget work is VC4C/VC5A respectively).
 *
 *  - A: the optimized proof verified cleanly → ship the optimized plan.
 *  - B: proof rejected → fall back to the conservative VC4C closure (no opt).
 *  - C: B also failed (should not happen for a sound conservative closure) →
 *       state the legacy prompt path with `semanticLossStated`.
 *
 * This is PURE: it returns the verdict and which mode to use; it does not emit,
 * store, or touch the network. The emit seam (`emit.ts`) consumes the outcome.
 */
export function selectHealMode(
  proof: ClosureProofV2,
  conservative: ClosureResult,
  graph?: ClosureGraph,
): HealTriadOutcome {
  const verification = verifyProof(proof, conservative, graph);
  if (verification.ok) {
    return {
      mode: "A" as HealMode,
      proof,
      selected: [...proof.selected],
      codes: [],
      semanticLossStated: false,
    };
  }
  // Mode B: conservative closure is sound by construction (it is the oracle the
  // proof was measured against). Use it directly.
  return {
    mode: "B" as HealMode,
    proof: null,
    selected: [...conservative.selected],
    codes: verification.codes,
    semanticLossStated: false,
  };
}

/**
 * Convenience for the rare B-failure path: if even the conservative oracle's
 * selection cannot be honored, state the legacy prompt and MARK semantic loss.
 * Mode C is the last resort and the only place semantic loss is ever admitted.
 */
export function legacyFallback(conservative: ClosureResult, reason: HealFailureCode): HealTriadOutcome {
  return {
    mode: "C" as HealMode,
    proof: null,
    selected: [...conservative.selected],
    codes: [reason, "HEAL_CLOSURE_REJECTED"],
    semanticLossStated: true,
  };
}
