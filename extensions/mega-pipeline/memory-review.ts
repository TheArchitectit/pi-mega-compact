/**
 * memory-review.ts — review live conversation & persist durable memories.
 *
 * `runMemoryReview` is shared by the pressure-scaled turn-end cadence
 * (mega-events.ts) AND review-on-compact (compact.ts) so both paths run the
 * identical review body. Best-effort + non-fatal: a review failure is swallowed
 * and never breaks the caller.
 */

import {
  type MegaRuntime,
  C,
} from "../mega-runtime.js";

/**
 * Review the live conversation and persist durable memories (S20+S24). Shared by
 * the pressure-scaled turn-end cadence (mega-events.ts) AND review-on-compact
 * (below) so both paths run the identical review body. Best-effort + non-fatal:
 * a review failure is swallowed and never breaks the caller. On success, the
 * number of applied ops is returned so callers can feed the consolidation gate.
 *
 * @param view the engine message view to review (caller builds it)
 * @param label a short source tag for the ticker line (e.g. "pressure" / "turn")
 */
export async function runMemoryReview(
  runtime: MegaRuntime,
  view: ReturnType<MegaRuntime["engineView"]>,
  label: string,
): Promise<number> {
  try {
    const { reviewConversation } = await import("../../src/memory.js");
    const { applyMemoryOps } = await import("../../src/memoryOps.js");
    const ops = reviewConversation(view, []);
    if (ops.length) {
      await applyMemoryOps(ops, runtime.currentStateDir);
      // S21.2: ops landed — the compaction path reads this counter and fires
      // `consolidateMemories` only when > 0.
      runtime.memoriesTouchedThisCompaction += ops.length;
      runtime.pushTicker(`${C.green}🧠${C.reset} reviewed ${ops.length} memory op${ops.length === 1 ? "" : "s"} (${label})`);
    }
    return ops.length;
  } catch {
    /* non-fatal — auto-review must never break the turn loop / compaction */
    return 0;
  }
}
