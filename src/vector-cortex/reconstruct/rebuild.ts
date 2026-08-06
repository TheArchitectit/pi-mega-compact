/**
 * vector-cortex/reconstruct/rebuild.ts — VC6C-IMPL production atomic rebuild.
 *
 * The thin *production executor* over the pure `heal/rebuild.ts` copy-verify-
 * switch primitives. It materializes a NEW derived generation for the planned
 * range, verifies the root manifest digest is a STRICT SUCCESSOR (the planned
 * `generation` is `current + 1` and the switch refuses any non-monotonic move),
 * and swaps the pointer in a single atomic commit. A failed verification keeps
 * the old pointer and DELETES NO EVIDENCE: the orphaned generation is retained
 * for inspection (heal/rebuild.ts crash-safety contract).
 *
 * REUSES, DOES NOT FORK. `rebuildGeneration` + `switchPointer` are the same
 * functions VC6C shipped and tested (74 tests). This file only binds them to
 * the production `RepairPlanV1` shape and the atomic-commit framing the
 * post-compact handler calls — the whole point of VC6C-IMPL is that the pure
 * primitives already exist and only the production seam was missing.
 *
 * STRICT SUCCESSOR. The pointer moves only when (a) verification passed and
 * (b) the new generation is STRICTLY greater than the current one. Replaying a
 * stale plan after a restart cannot roll the pointer backwards — the same
 * monotonic guard `heal/rebuild.ts#switchPointer` enforces.
 *
 * THE AUTHORITY IS NEVER MUTATED. This rebuild only swaps the DERIVED generation
 * pointer; the durable authority is untouched. `currentGeneration` is read to
 * enforce monotonicity, never written.
 *
 * PURE. No storage, no console, no network (PREVENT-PI-004 / PREVENT-011);
 * `node:crypto` comes via the heal digest helper.
 */

import {
  rebuildAndSwitch,
  type PointerSwitch,
  type RebuildInput,
  type RebuildResult,
} from "../heal/rebuild.js";
import type { Mode } from "../heal/repair-types.js";
import type { RepairPlanV1 } from "./repair-plan.js";

export type { PointerSwitch, RebuildInput, RebuildResult };

/**
 * The outcome of one atomic rebuild attempt. `result` is the verification
 * verdict; `pointer` is the atomic commit — `switched:true` only when the root
 * digest verified AND the generation advanced strictly. On `switched:false`
 * the live generation is unchanged and the orphaned generation is retained.
 */
export interface AtomicRebuild {
  readonly plan: RepairPlanV1;
  readonly result: RebuildResult;
  readonly pointer: PointerSwitch;
}

/**
 * Materialize + atomically switch a planned repair range.
 *
 * `rebuildInput` carries the materialized new-generation bytes and the root
 * digest the plan pinned. The helper reuses `heal/rebuild.ts#rebuildAndSwitch`,
 * which verifies the digest FIRST and refuses to switch under any combination of
 * failed verification or non-strict generation — "switch without verifying" is
 * not expressible.
 */
export function rebuildRepairRange(
  plan: RepairPlanV1,
  rebuildInput: RebuildInput,
  currentGeneration: number,
  mode: Mode = "A",
): AtomicRebuild {
  const { result, pointer } = rebuildAndSwitch(
    rebuildInput,
    currentGeneration,
    mode,
  );
  return { plan, result, pointer };
}
