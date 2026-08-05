/**
 * vector-cortex/reconstruct/validate.ts — reconstruction validation (VC4C).
 *
 * Task 5: a validator that rejects a closed selection that would corrupt a live
 * prompt and emits exactly two events:
 *   - `vector_cortex_reconstruction_validated`  (the good outcome)
 *   - `vector_cortex_closure_rejected`          (a rejected/cancelled closure)
 *
 * Rejection reasons (the failure codes are the ONLY externally-visible detail):
 *   - REC_ANCHOR_MISSING          an anchor-floor node is absent from the closure
 *   - REC_TOOL_PAIR_SPLIT         a tool-pair is not contiguous (PREVENT-PI-002)
 *   - REC_DIGEST_MISMATCH         a decoded shard's bytes disagree with its digest
 *   - REC_CONTRADICTION_UNRESOLVED an unresolved tie (closure already failed)
 *   - REC_SOURCE_UNAVAILABLE      a required shard is missing/erased (failure inj.)
 *   - REC_SPAN_OVERLAP            two spans intersect in source byte space
 *
 * The validator NEVER emits content; it exposes only a `ReconstructionSummary`
 * (counts + digest + token estimate) or the failure `codes`. Assembly/closure
 * errors are surfaced but the validator is the authoritative last gate.
 *
 * OWNERSHIP: this is a PURE function over its inputs — no storage, no network,
 * no console. The dashboard/seams that consume it live in extensions/, which may
 * emit observability; this module stays silent (structured logging contract).
 */

import { createHash } from "node:crypto";
import { assembleSourceOrder, type DecodedShard } from "./assemble.js";
import type {
  ClosureEdge,
  ClosureGraph,
  ClosureNode,
  ClosureResult,
  ReconstructEmitter,
  ReconstructReporter,
  ReconstructionFailureCode,
  ReconstructionSummary,
  ReconstructionV1,
  ReconstructionValidation,
} from "./types.js";

/** Flag-gated reporter — mirrors the VC4B residual reporter pattern. */
export function createReconstructReporter(emit?: ReconstructEmitter): ReconstructReporter {
  const fire = (event: Parameters<ReconstructEmitter>[0], fields: Record<string, unknown>): void => {
    if (!emit) return;
    try {
      emit(event, fields);
    } catch {
      /* non-fatal observability — never break the agent loop */
    }
  };
  return {
    reconstructionValidated: (fields): void => fire("vector_cortex_reconstruction_validated", fields),
    closureRejected: (fields): void => fire("vector_cortex_closure_rejected", fields),
  };
}

/** Sync SHA-256 hex (validator is sync except for assembly's concat digest). */
function sha256HexSync(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Verify each decoded shard's bytes hash to its declared digest (REC_DIGEST_MISMATCH). */
function findDigestMismatch(shards: readonly DecodedShard[]): ReconstructionFailureCode | null {
  for (const s of shards) {
    // A pinned digest of "0" is a placeholder: the source tier did not compute a
    // per-shard digest, so the only guarantee is the post-assembly concatenation
    // digest. Any other digest is a real pin that must match exactly.
    if (s.digest === "0") continue;
    const computed = sha256HexSync(s.bytes);
    if (computed !== s.digest) return "REC_DIGEST_MISMATCH";
  }
  return null;
}

export interface ValidateInput {
  readonly graph: ClosureGraph;
  readonly closure: ClosureResult;
  readonly nodes: readonly ClosureNode[];
  readonly edges: readonly ClosureEdge[];
  readonly shards: readonly DecodedShard[];
  readonly emit?: ReconstructEmitter;
}

/**
 * Validate a closed selection and, on success, assemble it into source order.
 * Returns the discriminated `ReconstructionValidation`: ok -> summary only;
 * fail -> failure codes only. Emits exactly one of the two events.
 */
export async function validateAndAssemble(input: ValidateInput): Promise<{
  readonly validation: ReconstructionValidation;
  readonly reconstruction: ReconstructionV1 | null;
}> {
  const { graph, closure, nodes, edges, shards, emit } = input;
  const reporter = createReconstructReporter(emit);

  // 1. A closure that failed its own contradiction resolution cannot go live.
  if (!closure.ok) {
    const codes: ReconstructionFailureCode[] = ["REC_CONTRADICTION_UNRESOLVED"];
    reporter.closureRejected({ sessionId: graph.sessionId, codes, reason: "closure-not-ok" });
    return {
      validation: { ok: false, codes },
      reconstruction: null,
    };
  }

  // 2. Anchor-floor discipline (PREVENT-PI-001 restated): every anchor node must
  //    be present in the closed set, or the closure silently dropped a floor
  //    item and must be rejected.
  const anchorMissing = nodes.some((n) => n.anchor === true && !closure.selected.includes(n.id));
  if (anchorMissing) {
    reporter.closureRejected({ sessionId: graph.sessionId, codes: ["REC_ANCHOR_MISSING"], reason: "anchor-missing" });
    return {
      validation: { ok: false, codes: ["REC_ANCHOR_MISSING"] },
      reconstruction: null,
    };
  }

  // 3. Unresolved contradiction present in the closed set.
  if (closure.unresolved.length > 0) {
    const codes = ["REC_CONTRADICTION_UNRESOLVED"] as ReconstructionFailureCode[];
    reporter.closureRejected({ sessionId: graph.sessionId, codes, reason: "unresolved-contradiction" });
    return {
      validation: { ok: false, codes },
      reconstruction: null,
    };
  }

  // 4. Per-shard digest pre-check hook (REC_DIGEST_MISMATCH path preserved).
  const digestCode = findDigestMismatch(shards);
  if (digestCode !== null) {
    reporter.closureRejected({ sessionId: graph.sessionId, codes: [digestCode], reason: "digest-mismatch" });
    return {
      validation: { ok: false, codes: [digestCode] },
      reconstruction: null,
    };
  }

  // 5. Assembly: missing source (REC_SOURCE_UNAVAILABLE) / split pair
  //    (REC_TOOL_PAIR_SPLIT) / overlap (REC_SPAN_OVERLAP) all surface here.
  const assembled = await assembleSourceOrder({
    sessionId: graph.sessionId,
    selected: closure.selected,
    nodes,
    edges,
    shards,
    mandatoryTokenEstimate: closure.mandatoryTokenEstimate,
  });
  if (assembled.code !== null || assembled.reconstruction === null) {
    const code = assembled.code ?? "REC_DIGEST_MISMATCH";
    reporter.closureRejected({ sessionId: graph.sessionId, codes: [code], reason: "assembly-failed" });
    return {
      validation: { ok: false, codes: [code] },
      reconstruction: null,
    };
  }

  const rec = assembled.reconstruction;
  const summary: ReconstructionSummary = buildSummary(rec);
  reporter.reconstructionValidated({
    sessionId: rec.sessionId,
    spanCount: summary.spanCount,
    protectedSpanCount: summary.protectedSpanCount,
    byteTotal: summary.byteTotal,
    mandatoryTokenEstimate: summary.mandatoryTokenEstimate,
    digest: summary.digest,
    bySource: summary.bySource,
  });
  return { validation: { ok: true, summary }, reconstruction: rec };
}

function buildSummary(rec: ReconstructionV1): ReconstructionSummary {
  const exact = rec.spans.filter((s) => s.source === "exact").length;
  const residual = rec.spans.filter((s) => s.source === "residual").length;
  const semantic = rec.spans.filter((s) => s.source === "semantic").length;
  return {
    sessionId: rec.sessionId,
    spanCount: rec.spans.length,
    protectedSpanCount: rec.spans.filter((s) => s.protectedSpan).length,
    byteTotal: rec.byteTotal,
    mandatoryTokenEstimate: rec.mandatoryTokenEstimate,
    digest: rec.digest,
    bySource: { exact, residual, semantic },
  };
}
