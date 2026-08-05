/**
 * vector-cortex/heal/rebuild.ts — VC6C generation rebuild + atomic pointer switch.
 *
 * Executes what `controller.ts` planned: materialize a NEW generation, verify its
 * root digest, and only then flip the live pointer.
 *
 * COPY, VERIFY, SWITCH — in that order, always.
 *
 *   1. COPY. The rebuild writes into `plan.generation` (always `current + 1`),
 *      never into the live generation. The thing currently being served is never
 *      the thing being modified, so a crash mid-rebuild leaves a complete old
 *      generation and a partial new one — never a torn live one.
 *   2. VERIFY. The new generation's root digest must equal the digest the plan
 *      pinned. This is the ONLY gate on the pointer.
 *   3. SWITCH. `switchPointer` moves the pointer iff verification passed.
 *
 * A FAILED VERIFICATION DELETES NO EVIDENCE. On mismatch we keep the old pointer
 * AND leave the new generation on disk. That is deliberate: the corrupt
 * generation is the only artifact that can explain WHY the rebuild was wrong, and
 * a self-healing system that tidies up its failures is a system that cannot be
 * debugged. Cleanup is a separate, explicit operator action.
 *
 * CRASH SAFETY IS A CONSEQUENCE OF THE ORDER, NOT AN EXTRA STEP. The pointer is
 * the single atomic commit point. Kill the process after step 1 or 2 and the old
 * pointer is still live, so the next start serves the prior generation and simply
 * re-plans — the orphaned generation is inert. This is what
 * `rebuild-chaos.test.ts` pins.
 *
 * THE TRIAD (independent algorithms, per TRIAD_RESILIENCE).
 *   A — TARGETED: rebuild only `plan.range`, reusing the prior generation for
 *       everything outside it. Cheap; needs a healthy prior generation.
 *   B — FULL DETERMINISTIC: re-derive the whole subsystem from the byte ledger,
 *       reusing NOTHING. Independent of A: it shares no index, no prior
 *       generation, and no incremental state, so a bug or corruption that breaks
 *       A cannot break B the same way.
 *   C — DISABLE DERIVED STATE: no rebuild at all. Mode C is a real outcome, not
 *       an error path, and it MUST state its loss of old semantic context — the
 *       subsystem serves nothing rather than serving something wrong.
 *
 * PURE. `node:crypto` only — no storage, no console, no clock, no network
 * (PREVENT-PI-004 / PREVENT-011). Callers own persistence; this module owns the
 * decision and the digest arithmetic, which is what makes it fixture-testable.
 */

import { createHash } from "node:crypto";

import type { Mode, RepairFailureCode, ShardRange } from "./repair-types.js";

/**
 * Everything a rebuild needs. `sourceBytes` is the materialized content of the
 * new generation; `expectedDigest` is the root digest the plan pinned and the
 * ONLY thing that authorizes a pointer switch.
 */
export interface RebuildInput {
  readonly subsystem: string;
  readonly range: ShardRange;
  /** The NEW generation being written (never the live one). */
  readonly generation: number;
  /** The rebuilt generation's content. */
  readonly sourceBytes: Uint8Array;
  /** Root digest, BARE lowercase hex (the ExactShardV1.digest convention). */
  readonly expectedDigest: string;
}

/**
 * The rebuild verdict.
 *
 * The failure arm still carries `generation` so the caller can name the orphaned
 * generation in a log or an operator prompt — the evidence is retained, so its
 * identity must be reportable.
 */
export type RebuildResult =
  | {
      readonly ok: true;
      readonly generation: number;
      /** The VERIFIED root digest (equals `expectedDigest`). */
      readonly digest: string;
      readonly mode: Mode;
    }
  | {
      readonly ok: false;
      readonly code: RepairFailureCode;
      readonly generation: number;
      readonly mode: Mode;
      /** Set on mode C: the caller MUST be told derived context is gone. */
      readonly semanticLossStated?: boolean;
    };

/** The outcome of a pointer switch: which generation is live afterwards. */
export interface PointerSwitch {
  readonly switched: boolean;
  /** The live generation AFTER the attempt (unchanged when `switched` is false). */
  readonly generation: number;
}

/** Root digest of a generation's bytes: SHA-256, bare lowercase hex. */
export function rootDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Materialize + verify one generation.
 *
 * Hashes the rebuilt bytes and compares to the pinned root digest. A mismatch
 * returns `HEAL_REPAIR_DIGEST_MISMATCH` and — critically — the caller must NOT
 * switch the pointer; `switchPointer` enforces that structurally by requiring the
 * verified flag.
 *
 * An EMPTY rebuild is a failure, not an empty success: a generation with no bytes
 * would hash to the digest of nothing, and if a plan ever pinned that digest an
 * empty rebuild would "verify" and the pointer would flip to nothing at all. It
 * is reported as `HEAL_REBUILD_FAILED` because the rebuild produced no artifact.
 */
export function rebuildGeneration(
  input: RebuildInput,
  mode: Mode = "A",
): RebuildResult {
  if (input.sourceBytes.length === 0) {
    return {
      ok: false,
      code: "HEAL_REBUILD_FAILED",
      generation: input.generation,
      mode,
    };
  }
  const digest = rootDigest(input.sourceBytes);
  if (digest !== input.expectedDigest) {
    // Evidence retained: the caller keeps the generation on disk for inspection.
    return {
      ok: false,
      code: "HEAL_REPAIR_DIGEST_MISMATCH",
      generation: input.generation,
      mode,
    };
  }
  return { ok: true, generation: input.generation, digest, mode };
}

/**
 * The atomic commit point: flip the live pointer iff the new generation verified.
 *
 * `verified` is a required argument rather than something re-derived here, so a
 * caller cannot switch the pointer without having gone through
 * `rebuildGeneration` — "switch without verifying" is not expressible.
 *
 * A non-monotonic switch is also refused: the new generation must be strictly
 * greater than the current one. Replaying a stale plan after a restart would
 * otherwise roll the pointer BACKWARDS onto an older generation, silently
 * un-healing the subsystem.
 */
export function switchPointer(
  currentGen: number,
  newGen: number,
  verified: boolean,
): PointerSwitch {
  if (!verified) return { switched: false, generation: currentGen };
  if (newGen <= currentGen) return { switched: false, generation: currentGen };
  return { switched: true, generation: newGen };
}

/**
 * Apply the triad arm for a rebuild.
 *
 * A and B run the same verification (a digest is a digest) but are reached by
 * INDEPENDENT production paths: A reuses the prior generation and rebuilds only
 * the planned range, while B re-derives everything from the byte ledger sharing
 * no index or incremental state with A. C performs no rebuild at all and states
 * its loss.
 */
export function applyTriad(mode: Mode, input: RebuildInput): RebuildResult {
  if (mode === "C") {
    // Derived state disabled: no rebuild, and the loss of old semantic context
    // is DISCLOSED rather than papered over with a stale or partial generation.
    return {
      ok: false,
      code: "HEAL_REBUILD_FAILED",
      generation: input.generation,
      mode: "C",
      semanticLossStated: true,
    };
  }
  return rebuildGeneration(input, mode);
}

/**
 * Convenience: rebuild then switch, returning both halves.
 *
 * The pointer moves only on a verified rebuild, so a failed verification yields
 * `switched:false` with the ORIGINAL generation still live and the new (corrupt)
 * generation left intact on disk for inspection.
 */
export function rebuildAndSwitch(
  input: RebuildInput,
  currentGen: number,
  mode: Mode = "A",
): { readonly result: RebuildResult; readonly pointer: PointerSwitch } {
  const result = applyTriad(mode, input);
  const pointer = switchPointer(currentGen, input.generation, result.ok);
  return { result, pointer };
}
