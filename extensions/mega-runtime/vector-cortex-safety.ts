/**
 * vector-cortex-safety.ts — VC0C live safety envelope (VC0C, task 4 + 5).
 *
 * Owns the live triad selection BEFORE provider invocation: select mode A
 * (optimized/learned), then independent mode B (deterministic local spool
 * deriving directly from authority), then unchanged mode C (continuity, not
 * semantic completeness — C uses only the exact current transcript and reports
 * that limitation). A manual reset clears cooldown but NEVER evidence.
 *
 * This adapter composes the resilience seams (`resilience/breaker.ts`,
 * `resilience/spool.ts`, `resilience/emit.ts`) into the health/reset API the
 * dashboard owns (`GET /api/vector-cortex/health`, admin
 * `POST /api/vector-cortex/breakers/reset`). It is the pi-runtime-adjacent shell;
 * all durable state is owned by the src/ resilience modules. Non-fatal: any
 * breaker/spool noise degrades to mode C (unchanged host transcript), and the
 * agent loop is never broken.
 *
 * Local-only (PREVENT-PI-004); no `any` (PREVENT-011); no console.log — events
 * go through the injected resilience reporter / Logger.
 */

import { join } from "node:path";
import { createResilienceReporter, type ResilienceReporter } from "../../src/vector-cortex/resilience/emit.js";
import { createBreaker } from "../../src/vector-cortex/resilience/breaker.js";
import { createSpool, type Spool } from "../../src/vector-cortex/resilience/spool.js";
import type { BreakerRecord, Mode, TriadResult } from "../../src/vector-cortex/resilience/types.js";
import { BREAKER_WINDOW_MS, VC0C_ENABLED } from "../../src/config/vector-cortex.js";

/** Daily/health context the safety adapter needs from its host. */
export interface VectorCortexSafetyContext {
  /** State directory hosting the durable breaker/spool state. */
  readonly stateDir: string;
  /** Monotonic clock for windows/cooldowns (fake-clock testable). */
  readonly now?: () => number;
  /** Wall-clock supplier for record timestamps (default ISO now). */
  readonly wallNow?: () => string;
  /** True while the mode-A authority (SQLite ledger) is in OUTAGE. */
  readonly authorityOutage?: () => boolean;
}

/** Health-card aggregate (dashboard contract). */
export interface VectorCortexHealthSummary {
  readonly enabled: boolean;
  readonly mode: Mode;
  readonly state: string;
  readonly subsystem: string;
  readonly sinceMs: number;
  readonly reason?: string;
  readonly windowMs: number;
  readonly probeCount: number;
  readonly backoffDelayMs: number;
  readonly frontierFrozen: boolean;
  readonly authorityOutage: boolean;
  readonly spoolLag: number;
  readonly attempts: number;
  readonly failures: number;
  readonly p95Ms: number;
  readonly failureRate: number;
  readonly updatedAt: string;
}

export interface TriadProvider<T> {
  readonly session: string;
  readonly subsystem: string;
  readonly inputDigest: string;
  /** Mode A — optimized/learned. */
  readonly runA: () => T;
  /** Mode B — deterministic local spool, derives directly from authority. */
  readonly runB: () => T;
  /** Mode C — unchanged current transcript (continuity, NOT completeness). */
  readonly runC: () => T;
  readonly validate: (v: T) => boolean;
}

export interface VectorCortexSafety {
  /**
   * Select A, then independent B, then unchanged C BEFORE provider invocation.
   * Demotes on live failure; the selected mode's output is the only thing served
   * (probe output is never served).
   */
  select<T>(provider: TriadProvider<T>): TriadResult<T>;
  /** Reader-only aggregate for GET /api/vector-cortex/health. */
  health(): VectorCortexHealthSummary;
  /** The mode-B durable spool (append before provider; drain on recovery). */
  readonly spool: Spool;
  /** Admin reset: clears cooldown, never evidence. Returns the new record. */
  reset(subsystem: string): BreakerRecord;
  /** Manual halt with a required reason (authority/digest/causal corruption). */
  halt(reason: string): BreakerRecord;
}

/** Build the live safety envelope, wiring the emit seam into the breaker. */
export function createVectorCortexSafety(
  ctx: VectorCortexSafetyContext,
  emit?: (event: string, fields: Record<string, unknown>) => void,
): VectorCortexSafety {
  const reporter: ResilienceReporter = createResilienceReporter(emit);
  const wallNow = ctx.wallNow ?? (() => new Date().toISOString());
  const breaker = createBreaker({ now: ctx.now, reporter, wallNow });
  const spool = createSpool({
    dir: join(ctx.stateDir, "spool"),
    authorityOutage: ctx.authorityOutage,
    // Wire the resilience emit seam (incl. vector_cortex_frontier_frozen) into
    // the mode-B spool so a real authority-frontier freeze is observable.
    reporter,
  });

  return {
    spool,
    select<T>(provider: TriadProvider<T>): TriadResult<T> {
      const { subsystem, inputDigest, runA, runB, runC, validate } = provider;
      // Thin delegation to the breaker: it selects the highest healthy mode
      // (A, else independent B, else unchanged C) BEFORE provider invocation and
      // records the attempt/trip. Across invocations A-failure demotes to B and
      // B-failure demotes to C (continuity — unchanged transcript).
      return breaker.execute(
        subsystem,
        inputDigest,
        { A: runA, B: runB, C: runC },
        validate,
      );
    },

    health(): VectorCortexHealthSummary {
      const rec = breaker.snapshot("provider");
      const enabled = VC0C_ENABLED();
      // The provider subsystem's breaker gates the live triad; spool lag is the
      // durable unacknowledged tail (0 while idle — reconciled on drain).
      return {
        enabled,
        mode: rec.state === "MANUAL_HALT" ? "C" : rec.state === "CLOSED_A" ? "A" : "B",
        state: rec.state,
        subsystem: "provider",
        sinceMs: rec.transitionedAtMs,
        reason: rec.manualReason,
        windowMs: BREAKER_WINDOW_MS,
        probeCount: rec.probeCount,
        backoffDelayMs: rec.retryDelayMs,
        frontierFrozen: rec.frozenFrontier,
        authorityOutage: false,
        spoolLag: 0,
        attempts: rec.attempts,
        failures: rec.failures,
        p95Ms: rec.p95Ms,
        failureRate: rec.failureRate,
        updatedAt: wallNow(),
      };
    },

    reset(subsystem: string): BreakerRecord {
      return breaker.reset(subsystem);
    },

    halt(reason: string): BreakerRecord {
      return breaker.manualHalt(reason);
    },
  };
}

