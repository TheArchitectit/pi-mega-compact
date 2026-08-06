/**
 * context-handler/controller.ts — VC6C-IMPL production post-compact gap
 * detection + repair drive.
 *
 * The production seam that makes the VC6C self-healing controller REAL: after a
 * compact, compare each derived subsystem's POST-compact chunk count against the
 * durable authority high-water. A subsystem whose derived high-water fell behind
 * authority has a REAL gap; only then does the drive route through the plan →
 * rebuild → emit pipeline. When there is no real gap, NOTHING is emitted (no
 * rebuild without a real gap — VC6C-IMPL-006).
 *
 * PURE POLICY DEFERS TO heal/. Gap-ness, the four refusal rules (frozen
 * authority / no gap / mode C / rate limit), and the deterministic backoff are
 * the VC6C heal primitives' job (`detectGaps`, `isPlannable`, `computeBackoff`
 * — 74 tested lines). This file owns ONLY the production mapping: `PostCompactView`
 * → `RepairState` (so heal policy can judge it) → `RepairPlanV1` (production
 * shape) → `AtomicRebuild` (atomic pointer switch) → the three repair events.
 * Flag OFF = the placeholder continues firing exactly as today and rebuild is a
 * no-op; see `drivePostCompactRepair`'s caller in afterCompact.ts.
 *
 * THE AUTHORITY IS NEVER WRITTEN. `PostCompactView.authorityHighWater` is read to
 * decide gap-ness; no code here has a write path to the durable authority.
 *
 * PURE-ish + CONSTANT-FREE. `nowMs` is always injected (fake-clock fixtures).
 * Backoff/gap come from the plan, never a literal. No console, no network
 * (PREVENT-PI-004). Emit is an injected callback so the drive is unit-testable
 * without a runtime.
 */

import { isPlannable } from "../../../src/vector-cortex/heal/controller.js";
import type { RepairState } from "../../../src/vector-cortex/heal/repair-types.js";
import {
  reportRepairBackoff,
  reportRepairPlanned,
  reportRepairPointerSwitched,
  type RepairEmit,
} from "../../../src/vector-cortex/heal/repair-emit.js";
import {
  buildRepairPlan,
  gapSizeOf,
  type PostCompactGap,
  type RepairPlanV1,
} from "../../../src/vector-cortex/reconstruct/repair-plan.js";
import {
  rebuildRepairRange,
  type AtomicRebuild,
  type RebuildInput,
} from "../../../src/vector-cortex/reconstruct/rebuild.js";
import type { Mode } from "../../../src/vector-cortex/heal/repair-types.js";

/** One derived subsystem's pre/post compact counts against durable authority. */
export interface PostCompactView {
  readonly subsystem: string;
  /** Derived chunk count BEFORE compaction. */
  readonly preCount: number;
  /** Derived chunk count AFTER compaction (the derived high-water, inclusive). */
  readonly postCount: number;
  /** Durable CONTIGUOUS authority high-water (inclusive). Read, never written. */
  readonly authorityHighWater: number;
  /** CURRENT live derived generation. A plan targets `generation + 1`. */
  readonly generation: number;
  readonly failedAttempts?: number;
  readonly mode: Mode;
  /** True while the durable authority frontier is frozen (outage). */
  readonly authorityFrozen?: boolean;
  /** Monotonic ms of the last rebuild, or null if never rebuilt. */
  readonly lastRebuildAtMs: bigint | null;
}

/**
 * Detect the subsystems whose POST-compact derived high-water fell behind the
 * durable authority. `left` is the pre-compact view, `right` the post-compact
 * view (aligned by subsystem name); a subsystem qualifies when its POST count
 * is strictly below its durable authority high-water. Pure — no clock, no
 * writes.
 */
export function detectPostCompactGaps(
  left: readonly PostCompactView[],
  right: readonly PostCompactView[],
): readonly PostCompactView[] {
  const byName = new Map(right.map((v) => [v.subsystem, v]));
  const gapped: PostCompactView[] = [];
  for (const l of left) {
    const r = byName.get(l.subsystem);
    if (r === undefined) continue;
    if (r.postCount < r.authorityHighWater) gapped.push(r);
  }
  return gapped;
}

/** Map a production post-compact view into the heal `RepairState` judge shape. */
export function toRepairState(view: PostCompactView): RepairState {
  return {
    subsystem: view.subsystem,
    derivedHighWater: BigInt(view.postCount),
    authorityHighWater: BigInt(view.authorityHighWater),
    lastRebuildAt: view.lastRebuildAtMs,
    generation: view.generation,
    mode: view.mode,
    ...(view.failedAttempts !== undefined ? { failedAttempts: view.failedAttempts } : {}),
    ...(view.authorityFrozen !== undefined ? { authorityFrozen: view.authorityFrozen } : {}),
  };
}

/** Build the production plan for one gapped view. */
export function planFor(view: PostCompactView): RepairPlanV1 {
  return buildRepairPlan(view as PostCompactGap);
}

/** Turn a production plan + view into the heal `RebuildInput` builder surface. */
export interface RebuildSource {
  /** Materialized bytes of the new derived generation. */
  readonly sourceBytes: Uint8Array;
  /** Root digest (BARE lowercase hex) the plan pins for the new generation. */
  readonly expectedDigest: string;
}

function rebuildInputFor(plan: RepairPlanV1, src: RebuildSource): RebuildInput {
  return {
    subsystem: plan.subsystem,
    range: {
      sessionId: plan.subsystem,
      seqStart: BigInt(plan.range[0]),
      seqEnd: BigInt(plan.range[1]),
      byteStart: 0,
      byteEnd: 0,
    },
    generation: plan.generation,
    sourceBytes: src.sourceBytes,
    expectedDigest: src.expectedDigest,
  };
}

/**
 * Drive one repair for a gapped subsystem: plan → rebuild → emit.
 *
 * Emits `reportRepairPlanned` first (the plan with its deterministic backoff),
 * then executes the atomic rebuild; a verified strict-successor switch emits
 * `reportRepairPointerSwitched`, a failed rebuild emits `reportRepairBackoff`.
 * `currentGeneration` (the live generation) is read for the monotonic switch.
 */
export function driveOneRepair(
  view: PostCompactView,
  emit: RepairEmit | undefined,
  rebuildSource: RebuildSource,
): { plan: RepairPlanV1; rebuilt: AtomicRebuild } {
  const plan = planFor(view);
  reportRepairPlanned(emit, {
    subsystem: plan.subsystem,
    generation: plan.generation,
    backoffMs: plan.backoffMs,
    gapSize: gapSizeOf(view as PostCompactGap),
  });
  const rebuilt = rebuildRepairRange(
    plan,
    rebuildInputFor(plan, rebuildSource),
    view.generation,
    view.mode,
  );
  if (rebuilt.pointer.switched) {
    reportRepairPointerSwitched(emit, {
      subsystem: plan.subsystem,
      fromGeneration: view.generation,
      toGeneration: plan.generation,
      mode: view.mode,
    });
  } else {
    reportRepairBackoff(emit, {
      subsystem: plan.subsystem,
      code: rebuilt.result.ok ? "HEAL_REPAIR_RATE_LIMITED" : (rebuilt.result.code ?? "HEAL_REBUILD_FAILED"),
      backoffMs: plan.backoffMs,
      attempt: view.failedAttempts ?? 0,
    });
  }
  return { plan, rebuilt };
}

/**
 * The full post-compact repair drive. Applies heal's eligibility policy
 * (`isPlannable` — rate limit, no gap, frozen authority, mode C) per subsystem,
 * and only runs `driveOneRepair` for subsystems with a REAL, actionable gap. A
 * subsystem with no real gap, or inside its rate-limit window, emits NOTHING.
 *
 * `rebuildSourceFor` is an injected executor that materializes a new generation
 * for a plannable subsystem (the handler supplies the real one; fixtures supply
 * a deterministic one), keeping the drive testable without a runtime.
 */
export function drivePostCompactRepair(
  views: readonly PostCompactView[],
  nowMs: bigint,
  emit: RepairEmit | undefined,
  rebuildSourceFor: (view: PostCompactView) => RebuildSource,
): void {
  for (const view of views) {
    const state = toRepairState(view);
    if (!isPlannable(state, nowMs)) continue;
    driveOneRepair(view, emit, rebuildSourceFor(view));
  }
}

/**
 * Build the production post-compact subsystem views from a compact result.
 *
 * `compactedFrom` is the committed seq frontier after compaction. In a NORMAL
 * compact the derived post-count equals the durable authority high-water (they
 * advance together), so the resulting view has NO real gap — the drive emits
 * nothing (VC6C-IMPL-006). A caller that derives per-subsystem counts where a
 * derived tier fell behind authority supplies those lower counts here, and the
 * drive will detect the gap and repair it. `currentGeneration` seeds the derived
 * generation counter.
 */
export function buildPostCompactViews(
  compactedFrom: number,
  currentGeneration: number,
  authorityHighWater: number = compactedFrom,
  postCount: number = compactedFrom,
): readonly PostCompactView[] {
  return [
    {
      subsystem: "post_compact",
      preCount: compactedFrom,
      postCount,
      authorityHighWater,
      generation: currentGeneration,
      failedAttempts: 0,
      mode: "A",
      lastRebuildAtMs: null,
    },
  ];
}
