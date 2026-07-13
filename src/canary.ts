/**
 * canary.ts — safe sequential tier rollout (Sprint 14, Phase 7).
 *
 * Enables tiers one at a time (L0 → L1 → L2 → RAPTOR), watching each tier's p95
 * latency (from monitoring metrics) and AUTO-DISABLING a tier whose p95 breaches
 * the budget. No human-in-the-loop: degradation is automatic and local (QA #19).
 *
 * The controller owns a MUTABLE working copy of the dedup config; callers read
 * `controller.config` after each step. Tiers disabled via MARK_ONLY degrade
 * gracefully rather than fully off.
 */

import type { DedupConfigShape, DedupTier } from "./config/dedup.js";
import { loadDedupConfig } from "./config/dedup.js";
import type { DedupMetrics } from "./monitoring.js";
import { p95 } from "./monitoring.js";

/** Canonical enablement order. */
export const CANARY_ORDER: DedupTier[] = ["L0", "L1", "L2", "RAPTOR"];

export interface CanaryState {
  /** Tiers currently enabled (and not auto-disabled). */
  enabled: Set<DedupTier>;
  /** Tiers auto-disabled by a p95 breach. */
  disabled: Set<DedupTier>;
  /** Steps taken so far. */
  step: number;
}

export class CanaryController {
  readonly config: DedupConfigShape;
  private readonly state: CanaryState;

  constructor(base: DedupConfigShape = loadDedupConfig()) {
    // Start from the base config but begin with L0 only (sequential rollout).
    this.config = { ...base };
    this.config.L1_ENABLED = false;
    this.config.L2_ENABLED = false;
    this.config.RAPTOR_ENABLED = false;
    this.state = {
      enabled: new Set<DedupTier>(["L0"]),
      disabled: new Set<DedupTier>(),
      step: 1,
    };
  }

  /** Enable the next tier in CANARY_ORDER (no-op if all enabled). */
  stepForward(): DedupTier | null {
    for (const tier of CANARY_ORDER) {
      if (!this.state.enabled.has(tier) && !this.state.disabled.has(tier)) {
        this.setEnabled(tier, true);
        this.state.step++;
        return tier;
      }
    }
    return null;
  }

  private setEnabled(tier: DedupTier, on: boolean): void {
    switch (tier) {
      case "L0": this.config.L0_ENABLED = on; break;
      case "L1": this.config.L1_ENABLED = on; break;
      case "L2": this.config.L2_ENABLED = on; break;
      case "RAPTOR": this.config.RAPTOR_ENABLED = on; break;
    }
    if (on) { this.state.enabled.add(tier); this.state.disabled.delete(tier); }
    else { this.state.enabled.delete(tier); }
  }

  private disableReason(tier: DedupTier): void {
    this.setEnabled(tier, false);
    this.state.disabled.add(tier);
  }

  /**
   * Evaluate p95 latency for every enabled tier against the budget. Any tier
   * whose p95 exceeds `config.P95_BUDGET_MS` is auto-disabled. Returns the tiers
   * it disabled this pass (so the caller can log/alert).
   */
  evaluate(metrics: DedupMetrics): DedupTier[] {
    const disabledNow: DedupTier[] = [];
    for (const tier of CANARY_ORDER) {
      if (!this.state.enabled.has(tier)) continue;
      const lat = p95(metrics.latency[tier] ?? []);
      if (lat > this.config.P95_BUDGET_MS) {
        this.disableReason(tier);
        disabledNow.push(tier);
      }
    }
    return disabledNow;
  }

  getState(): CanaryState {
    return {
      enabled: new Set(this.state.enabled),
      disabled: new Set(this.state.disabled),
      step: this.state.step,
    };
  }
}

/**
 * Run the full canary rollout against a metrics feed. `feed` is sampled at each
 * step (after enabling a tier) to drive auto-disable. Deterministic + offline.
 */
export function runCanary(
  metricsFeed: (step: number, config: DedupConfigShape) => DedupMetrics,
  base: DedupConfigShape = loadDedupConfig(),
): { controller: CanaryController; disabled: DedupTier[] } {
  const controller = new CanaryController(base);
  const allDisabled: DedupTier[] = [];
  let step = 0;
  // Up to one step per tier + a final eval.
  while (true) {
    const tier = controller.stepForward();
    if (tier === null) break;
    const metrics = metricsFeed(controller.getState().step, controller.config);
    const disabled = controller.evaluate(metrics);
    allDisabled.push(...disabled);
    if (++step > CANARY_ORDER.length + 1) break;
  }
  // Final eval pass on the last enabled set.
  const finalMetrics = metricsFeed(controller.getState().step, controller.config);
  allDisabled.push(...controller.evaluate(finalMetrics));
  return { controller, disabled: [...new Set(allDisabled)] };
}
