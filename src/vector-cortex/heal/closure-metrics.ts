/**
 * vector-cortex/heal/closure-metrics.ts — VC6A closure proof metrics + handoff.
 *
 * Pure read-only derivations over a `ClosureProofV2`: traversal savings (the
 * sprint's >=20% median acceptance bar) and the `RestoreHintV1` list VC6B
 * consumes. Extracted from `closure-opt.ts` (delegate-shell) to keep the core
 * reduction algorithm under the 300-line soft limit.
 *
 * PURE / DETERMINISTIC / LOCAL: no storage, no clock, no network (PREVENT-PI-004
 * / PREVENT-011). Identity only — never source bytes or prompt text
 * (SECURITY_PRIVACY).
 */

import type { ClosureGraph } from "../reconstruct/types.js";
import type { ClosureProofV2, RestoreHintV1, RetainReason } from "./types.js";

/** Bytewise id comparator — matches `closure-opt.ts` / `reconstruct/closure.ts`. */
function byBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Anchor id set from a graph (matches `closure-opt.ts`). */
function anchorIds(graph: ClosureGraph): Set<string> {
  return new Set(graph.nodes.filter((n) => n.anchor === true).map((n) => n.id));
}

/**
 * Traversal savings as a fraction in [0,1]: how much of the conservative edge
 * walk the optimized plan avoids. A plan with nothing to remove scores 0 (not a
 * failure — a chain graph is already minimal). The sprint's acceptance bar is a
 * >=20% MEDIAN over the corpus, never a per-graph floor.
 */
export function traversalSavings(proof: ClosureProofV2): number {
  if (proof.conservativeTraversals === 0) return 0;
  const saved = proof.conservativeTraversals - proof.optimizedTraversals;
  return saved / proof.conservativeTraversals;
}

/**
 * Derive the `RestoreHintV1` list VC6B consumes (the sprint's declared handoff:
 * "VC6B receives missing-source hints and proof").
 *
 * One hint per selected node that a RETAINED edge reaches, naming the cheapest
 * (bytewise-first) retained prerequisite and whether the node is protected.
 * Identity only — never source bytes or prompt text (SECURITY_PRIVACY).
 */
export function restoreHints(proof: ClosureProofV2, graph: ClosureGraph): readonly RestoreHintV1[] {
  const anchors = anchorIds(graph);
  const best = new Map<string, { from: string; reason: RetainReason }>();
  for (const row of proof.rows) {
    if (row.decision !== "retained") continue;
    const reason = row.reason as RetainReason;
    const existing = best.get(row.to);
    if (existing === undefined || byBytes(row.from, existing.from) < 0) {
      best.set(row.to, { from: row.from, reason });
    }
  }
  const hints: RestoreHintV1[] = [];
  for (const nodeId of [...proof.selected].sort(byBytes)) {
    const hit = best.get(nodeId);
    const isToolPair = proof.retainedEdges.some(
      (e) => e.kind === "tool-pair" && (e.from === nodeId || e.to === nodeId),
    );
    hints.push({
      schema: "restore-hint-v1",
      nodeId,
      viaEdgeFrom: hit?.from,
      protectedNode: anchors.has(nodeId) || isToolPair,
      reason: hit?.reason ?? (anchors.has(nodeId) ? "anchor" : "no-alternate-path"),
    });
  }
  return hints;
}
