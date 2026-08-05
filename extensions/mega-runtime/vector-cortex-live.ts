/**
 * vector-cortex-live.ts — VC5C live graduated-rollout integration seam.
 *
 * This adapter composes the rollout assign + gate + emit seams into the host
 * provider-invocation path. It runs BEFORE provider invocation and decides, for
 * the current session, which live path is active:
 *
 *   - on a hard causal/tool/anchor/exact failure → select mode C (pre-VC prompt
 *     path) and FREEZE promotion (promotionBlocked=true) for the remainder of the
 *     cooldown/spool/restart/clock period satisfying TRIAD_RESILIENCE;
 *   - otherwise → the active gate decides whether the VC path is exposed to this
 *     session's bucket.
 *
 * PREVENT-PI-003: the rollout NEVER emits a `role:"system"` message. The VC
 * prompt context is composed into the host `before_agent_start` systemPrompt
 * prepend seam only. PREVENT-PI-004: zero network calls (local in-process state
 * + injected clock only). PREVENT-011: no `any`. Non-fatal: any rollout noise
 * degrades to mode C (pre-VC continuity), never breaking the agent loop.
 *
 * LIVENESS HONESTY (mirrors VC0C-Q01/Q06): the rollout decision state here is
 * PER-PROCESS / IN-MEMORY and EPHEMERAL — there is NO persistent rollout runtime
 * and NO live producer wiring. The gate decision is recomputed from injected
 * evidence each epoch. The assigned/blocked events are emitted for observability
 * only.
 */

import { assignSession, bucketInGate, gatePctForIndex } from "../../src/vector-cortex/rollout/assign.js";
import {
  decideGate,
  selectsPreVcPath,
  type RolloutClock,
  type RolloutEvidence,
} from "../../src/vector-cortex/rollout/gate.js";
import { createRolloutReporter, type RolloutReporter } from "../../src/vector-cortex/rollout/emit.js";
import type { GateIndex, RolloutHardFault } from "../../src/vector-cortex/rollout/types.js";
import { VC5C_ENABLED } from "../../src/config/vector-cortex.js";

/** Host context the live seam needs. */
export interface VectorCortexLiveContext {
  /** Monotonic clock for windows/cooldowns + gate eligibility (fake-clock testable). */
  readonly clock?: RolloutClock;
  /** Current gate index BEFORE this epoch (0..4). */
  readonly currentGate?: GateIndex;
  /** Injected rollout evidence for the current window. */
  readonly evidence?: RolloutEvidence;
  /** Hard faults observed this epoch (any entry forces C + freezes promotion). */
  readonly hardFaults?: readonly RolloutHardFault[];
  /** Optional emit callback for observability events. */
  readonly emit?: (event: string, fields: Record<string, unknown>) => void;
}

/** The decision the live seam returns for one session epoch. */
export interface VectorCortexLiveDecision {
  /** Whether the VC path is exposed to this session (true under current gate). */
  readonly vcActive: boolean;
  /** True when a hard failure forced mode C (pre-VC continuity). */
  readonly forcedPreVc: boolean;
  /**
   * The selected triad mode for this epoch. The VC5C rollout seam only ever
   * selects "A" (VC path exposed at the active gate) or "C" (pre-VC fallback:
   * flag off, no evidence/clock, or a hard causal/tool/anchor/exact fault that
   * freezes promotion). The deterministic-greedy triad "B" mode is NOT produced
   * here — this seam is a pure gating/eligibility layer with no live renderer
   * driver; a real mode-B greedy-render fallback belongs to the layer that
   * actually runs renderers (a future sprint), not to this observability seam.
   * Declaring "B" in this union while never producing it would be an overclaim.
   */
  readonly mode: "A" | "C";
  /** The session's stable bucket (0..9999). */
  readonly bucket: number;
  /** The effective gate index after this epoch. */
  readonly gateIndex: GateIndex;
  /** True when promotion is frozen by a hard fault. */
  readonly promotionBlocked: boolean;
  /** The systemPrompt prepend the host `before_agent_start` seam should use. */
  readonly systemPromptPrepend: string;
}

const NO_PREPEND = "";

/**
 * Decide the live path for a session epoch. Pure over injected context; no
 * I/O, no network. Flag OFF (or absent evidence/clock) degrades to mode C with
 * the VC path inactive (pre-VC predecessor parity).
 */
export function decideLivePath(
  sessionId: string,
  ctx: VectorCortexLiveContext,
): VectorCortexLiveDecision {
  const reporter: RolloutReporter = createRolloutReporter(ctx.emit);
  const assignment = assignSession(sessionId);

  if (!VC5C_ENABLED()) {
    // Pre-VC predecessor: no rollout, no VC path. Never emit role:system.
    return {
      vcActive: false,
      forcedPreVc: false,
      mode: "C",
      bucket: assignment.bucket,
      gateIndex: 0,
      promotionBlocked: false,
      systemPromptPrepend: NO_PREPEND,
    };
  }

  reporter.assigned({
    sessionId,
    bucket: assignment.bucket,
    gateIndex: assignment.gateIndex,
    gatePct: gatePctForIndex(assignment.gateIndex),
  });

  const hardFaults = ctx.hardFaults ?? [];
  const hardFault = hardFaults.length > 0 ? hardFaults[0]! : undefined;
  const forcedPreVc = selectsPreVcPath(hardFault);

  if (forcedPreVc && hardFault) {
    reporter.promotionBlocked({
      gateIndex: ctx.currentGate ?? assignment.gateIndex,
      kind: hardFault.kind,
      detail: hardFault.detail,
    });
    // Hard failure → select C (pre-VC path) and freeze promotion.
    return {
      vcActive: false,
      forcedPreVc: true,
      mode: "C",
      bucket: assignment.bucket,
      gateIndex: ctx.currentGate ?? assignment.gateIndex,
      promotionBlocked: true,
      systemPromptPrepend: NO_PREPEND,
    };
  }

  const clock = ctx.clock;
  const evidence = ctx.evidence;
  if (clock === undefined || evidence === undefined) {
    // No live evidence/clock → pre-VC parity (no promotion, no VC exposure).
    return {
      vcActive: false,
      forcedPreVc: false,
      mode: "C",
      bucket: assignment.bucket,
      gateIndex: assignment.gateIndex,
      promotionBlocked: false,
      systemPromptPrepend: NO_PREPEND,
    };
  }

  const outcome = decideGate(ctx.currentGate ?? assignment.gateIndex, evidence, clock);
  const vcActive = bucketInGate(assignment.bucket, outcome.gatePct);

  // PREVENT-PI-003: VC prompt context is composed into the host prepend seam,
  // never as a role:system message. Empty prepend here (the actual prompt text
  // is owned by the renderer seam); this seam only signals eligibility.
  return {
    vcActive,
    forcedPreVc: false,
    mode: vcActive ? "A" : "C",
    bucket: assignment.bucket,
    gateIndex: outcome.gateIndex,
    promotionBlocked: outcome.promotionBlocked,
    systemPromptPrepend: NO_PREPEND,
  };
}
