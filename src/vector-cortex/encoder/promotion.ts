/**
 * vector-cortex/encoder/promotion.ts — ML5-E PromotionV1 ledger row type +
 * append-only manifest helper + atomic digest-swap rollback.
 *
 * Pure-function discipline: zero I/O, no clock, no storage, no network
 * (PREVENT-PI-004 / PREVENT-011). Every function is total over its inputs.
 * The cron orchestrator (scripts/ml5/retrain-nightly.mjs) and the promotion
 * gate (scripts/ml5/promotion-gate.mjs) consume these helpers; the acceptance
 * aggregator (ml5e-acceptance.test.ts) validates them synthetically without a
 * real training run.
 *
 * The promotion manifest is an APPEND-ONLY ledger: every new asset is a new
 * entry, never an overwrite. Rollback restores a prior entry by SHA-256 via
 * an atomic digest swap (flip the committed pointer to the prior entry's
 * digest in one step) — no partial state is possible because the swap is a
 * single value assignment.
 *
 * ENC-0d extends the ledger to the real-asset promotion path: `PromotionV1`
 * carries `{color, assetDigestStack}` — a promotion color from gate
 * qualification ("green" atomically swaps to the trained asset, "red" keeps
 * the prior asset live) and a LIFO of prior shipped digest for O(1)-by-sha256
 * rollback. The on-disk manifest byte-swap itself (write-temp-then-rename,
 * never in-place partial) is the promotion gate script's job; these helpers
 * stay pure and return the restorable digest + the updated manifest/stack so
 * the script can perform the swap in one atomic step.
 */

// ---------------------------------------------------------------------------
// PromotionV1 — the ledger row recording one nightly training + promotion run.
// ---------------------------------------------------------------------------

/** Schema tag for the promotion ledger row. */
export const PROMOTION_SCHEMA = "promotion-v1" as const;

/** Per-head calibration verdict: pass or fail. */
export interface HeadVerdict {
  readonly head: string;
  readonly pass: boolean;
}

/** PromotionV1 — a single ledger row recording one training + gate run.
 *  Digest-only: carries SHA-256 identifiers, never payload content. */
export interface PromotionV1 {
  readonly schema: typeof PROMOTION_SCHEMA;
  /** ISO-8601 timestamp of the run. */
  readonly ts: string;
  /** SHA-256 of the corpus digest used for this training run. */
  readonly corpusDigest: string;
  /** SHA-256 of the newly trained asset manifest (null when no-op). */
  readonly assetDigest: string | null;
  /** SHA-256 of the previously committed asset (the incumbent). */
  readonly priorAssetDigest: string | null;
  /** Per-head calibration verdicts (all five heads). */
  readonly headVerdicts: readonly HeadVerdict[];
  /** True when all five heads pass their per-head thresholds. */
  readonly fiveHeadsOk: boolean;
  /** True when the new asset beats the incumbent on held-out dev set. */
  readonly heldOutBeat: boolean;
  /** The gate decision: promoted (eligible) or demoted (new asset rejected).
   *  `noop` is defined by the spec but unused — the corpus-digest check in
   *  retrain-nightly.mjs exits before any ledger append when there is nothing
   *  to train on. */
  readonly verdict: "promoted" | "demoted" | "noop";
  /** Present only when verdict is "demoted": the demotion event name. */
  readonly demotedEvent: "demoted_new_asset" | null;
  /** ENC-0d promotion color from gate qualification. "green" atomically swaps
   *  the shipped manifest to the trained asset; "red" keeps the prior asset
   *  live and emits a demotion. */
  readonly color: "green" | "red";
  /** ENC-0d LIFO of prior shipped asset digests for O(1)-by-sha256 rollback.
   *  The most recent prior digest (top of the stack) is the rollback target. */
  readonly assetDigestStack: readonly string[];
}

// ---------------------------------------------------------------------------
// Append-only manifest — every new asset is a NEW entry, never an overwrite.
// ---------------------------------------------------------------------------

/** A single entry in the append-only asset manifest. */
export interface AssetManifestEntry {
  readonly assetDigest: string;
  readonly ts: string;
  readonly source: string;
  readonly verdict: string;
}

/** The append-only manifest: an ordered list of asset entries plus the
 *  committed pointer (the digest of the currently active asset). */
export interface AssetManifest {
  readonly entries: readonly AssetManifestEntry[];
  /** SHA-256 of the currently committed (active) asset. */
  committed: string | null;
}

/** Append a new asset entry to the manifest. Never mutates `entries`;
 *  returns a new manifest with the entry appended and `committed` updated. */
export function appendAsset(
  manifest: AssetManifest,
  entry: AssetManifestEntry,
): AssetManifest {
  return {
    entries: [...manifest.entries, entry],
    committed: entry.assetDigest,
  };
}

/** Restore a prior asset by SHA-256: atomically swap the committed pointer
 *  to the prior entry. The prior entry MUST exist in the manifest (append-only
 *  guarantees it was never overwritten). Returns null when the digest is not
 *  found (defensive: append-only means it should always be findable). */
export function rollbackTo(
  manifest: AssetManifest,
  digest: string,
): AssetManifest | null {
  const found = manifest.entries.find((e) => e.assetDigest === digest);
  if (!found) return null;
  return {
    entries: manifest.entries,
    committed: found.assetDigest,
  };
}

// ---------------------------------------------------------------------------
// ENC-0d LIFO rollback stack + atomic swap. Pure pointer arithmetic; the
// on-disk write-temp-then-rename of the swapped manifest bytes is the gate
// script's job so no partial state can ever be observed (PREVENT-PI-004).
// ---------------------------------------------------------------------------

/** Push a freshly-shipped digest onto the LIFO rollback stack (top = latest
 *  prior shipped digest). Non-mutating: returns a new array. */
export function pushAssetDigest(
  stack: readonly string[],
  digest: string,
): readonly string[] {
  return [...stack, digest];
}

/** Pop the top (most recent prior) digest off the LIFO rollback stack without
 *  mutating it. Returns the prior digest (null when the stack is empty) plus
 *  the remaining stack for the caller to commit (atomic card-swap fallback:
 *  a green swap pushes the incumbent digest; a rollback pops it). */
export function popAssetDigest(
  stack: readonly string[],
): { prior: string | null; rest: readonly string[] } {
  if (stack.length === 0) return { prior: null, rest: stack };
  const rest = stack.slice(0, -1);
  return { prior: stack[stack.length - 1]!, rest };
}

/** Outcome of an atomic promotion swap (pure): the (possibly restored)
 *  manifest, the updated rollback stack, and whether a digest swap occurred. */
export interface AtomicSwapOutcome {
  readonly manifest: AssetManifest;
  readonly stack: readonly string[];
  /** True when the committed pointer changed (green swap or rollback). */
  readonly swapped: boolean;
}

/** Atomically swap the committed manifest to a real trained asset's digest.
 *  Green: append the new entry (append-only — the incumbent stays in the
 *  ledger, never overwritten), commit to it, and record the INCUMBENT digest
 *  onto the LIFO stack for O(1) rollback (rollback restores the incumbent, so
 *  the stack must hold the pre-swap committed digest — pushing the swapped-in
 *  digest would point rollback back at the very asset being rolled back). Red
 *  (or no candidate digest): return the manifest and stack untouched — no
 *  swap, prior asset stays live. */
export function atomicSwap(
  manifest: AssetManifest,
  entry: AssetManifestEntry,
  color: "green" | "red",
  stack: readonly string[],
): AtomicSwapOutcome {
  if (color !== "green" || !entry.assetDigest) {
    return { manifest, stack, swapped: false };
  }
  const incumbent = manifest.committed;
  const next = appendAsset(manifest, entry);
  return {
    manifest: next,
    stack: incumbent === null ? stack : pushAssetDigest(stack, incumbent),
    swapped: true,
  };
}

/** Roll back to the previous shipped asset by SHA-256 (O(1) via the LIFO
 *  stack): restores the most recent prior digest in the manifest and pops that
 *  entry off the stack. Returns null when no prior digest exists or the prior
 *  digest is no longer in the append-only manifest (defensive: append-only
 *  means it should always be findable). Never leaves a partial state — the
 *  committed pointer flip and the stack pop happen together or not at all. */
export function assetRollback(
  manifest: AssetManifest,
  stack: readonly string[],
): AtomicSwapOutcome | null {
  const { prior, rest } = popAssetDigest(stack);
  if (prior === null) return null;
  const restored = rollbackTo(manifest, prior);
  if (!restored) return null;
  return { manifest: restored, stack: rest, swapped: true };
}

// ---------------------------------------------------------------------------
// Pure decision rules.
// ---------------------------------------------------------------------------

/** Evaluate the promotion gate: promote only when all five heads pass AND the
 *  new asset beats the committed asset on the held-out dev set. Otherwise
 *  demote. No training data is ever the held-out set. */
export function promoteDecision(
  fiveHeadsOk: boolean,
  heldOutBeat: boolean,
): "promoted" | "demoted" {
  return fiveHeadsOk && heldOutBeat ? "promoted" : "demoted";
}

/** Whether a rollback is needed: the current asset at position N regressed
 *  relative to the asset at position N-1. True only when regression is
 *  confirmed and a prior asset digest exists to restore. */
export function rollbackNeeded(
  regressionConfirmed: boolean,
  priorAssetDigest: string | null,
): boolean {
  return regressionConfirmed && priorAssetDigest !== null;
}
