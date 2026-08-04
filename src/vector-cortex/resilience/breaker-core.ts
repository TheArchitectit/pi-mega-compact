/**
 * vector-cortex/resilience/breaker-core.ts — VC0C breaker state machine (VC0C).
 *
 * Implementation file behind the `breaker.ts` factory shell. See breaker.ts for
 * the public surface; this file owns the TRIAD_RESILIENCE §breaker state machine.
 *
 * Implements TRIAD_RESILIENCE.md §breaker state machine over the shared
 * constants in src/config/vector-cortex.ts (consumed, NOT redefined — resolves
 * the standing "dead BREAKER_* constants" issue):
 *
 *   States: CLOSED_A, OPEN_B, OPEN_C, PROBE_B, PROBE_A, MANUAL_HALT.
 *   Rolling window BREAKER_WINDOW_MS; min BREAKER_MIN_ATTEMPTS attempts.
 *   Performance trip at BREAKER_PERF_FAILURES failures or failure-rate >=
 *   BREAKER_PERF_FAILURE_RATE; correctness trip on the FIRST correctness failure.
 *   Cooldown BREAKER_COOLDOWN_MS; BREAKER_PROBE_COUNT consecutive probes succeed
 *   to advance; exponential retry BREAKER_RETRY_BASE_MS * 2^attempt capped at
 *   BREAKER_RETRY_CAP_MS with deterministic +-10% jitter derived from the
 *   subsystem digest; promotion hysteresis needs failure rate <
 *   BREAKER_HYSTERESIS_FAILURE_RATE and p95 <= BREAKER_HYSTERESIS_BUDGET_P95_MS;
 *   BREAKER_MIN_HEALTHY_RESIDENCE_MS healthy residence before another promotion.
 *
 * Clock: windows/cooldowns use MONOTONIC time (`now()`, injectable and
 * defaulting to performance.now()); wall time appears only in `updatedAt`
 * (records). Backward/forward wall jumps never alter eligibility. Restart
 * reconstructs state from appended breaker events (`onEvent`). Expired cooldown
 * may PROBE, never directly promote. Probe output is never served. Manual halt
 * requires a reason + explicit admin `reset` that clears cooldown but never
 * evidence.
 *
 * Pure in-memory + event-serializable state; no storage, no network
 * (PREVENT-PI-004), no `any` (PREVENT-011).
 */

import {
  BREAKER_WINDOW_MS,
  BREAKER_MIN_ATTEMPTS,
  BREAKER_PERF_FAILURES,
  BREAKER_PERF_FAILURE_RATE,
  BREAKER_CORRECTNESS_FAILURES,
  BREAKER_COOLDOWN_MS,
  BREAKER_PROBE_COUNT,
  BREAKER_RETRY_BASE_MS,
  BREAKER_RETRY_CAP_MS,
  BREAKER_RETRY_JITTER,
  BREAKER_HYSTERESIS_FAILURE_RATE,
  BREAKER_HYSTERESIS_BUDGET_P95_MS,
  BREAKER_MIN_HEALTHY_RESIDENCE_MS,
} from "../../config/vector-cortex.js";
import type {
  Breaker,
  BreakerRecord,
  BreakerState,
  BreakerTripKind,
  Mode,
  TriadResult,
} from "./types.js";
import type { ResilienceReporter } from "./emit.js";

/** Monotonic clock supplier (fake-clock testable). */
export type MonotonicClock = () => number;
/** Wall-clock ISO supplier for record timestamps (irrelevant to eligibility). */
export type WallClock = () => string;

export interface BreakerOptions {
  /** Monotonic clock, default performance.now(). */
  readonly now?: MonotonicClock;
  /** Wall-clock ISO, default new Date().toISOString(). */
  readonly wallNow?: WallClock;
  /** Resilience emit seam (flag-gated). */
  readonly reporter?: ResilienceReporter;
  /**
   * Append-only breaker event sink for restart reconstruction. Each transition
   * appends a canonical event; `createBreaker` may replay them to rebuild state.
   */
  readonly onEvent?: (event: Record<string, unknown>) => void;
}

interface SubsystemState {
  state: BreakerState;
  transitionedAtMs: number;
  attempts: number[];
  failures: number[];
  latencies: number[];
  cooldownUntilMs?: number;
  probeCount: number;
  retryAttempt: number;
  frozenFrontier: boolean;
  manualReason?: string;
  tripKind: BreakerTripKind;
  /** Monotonic start of the current healthy-residence window (OPEN_B only). */
  healthyResidenceSinceMs?: number;
}

/** Deterministic +-jitter fraction for a subsystem (0..1) from its digest. */
function jitterSeed(subsystem: string): number {
  let h = 2166136261;
  for (let i = 0; i < subsystem.length; i++) {
    h ^= subsystem.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295; // 0..1
}

/** Iterative backoff delay with +-BREAKER_RETRY_JITTER deterministic jitter. */
export function breakerRetryDelay(subsystem: string, attempt: number): number {
  const exp = Math.min(
    BREAKER_RETRY_BASE_MS * 2 ** attempt,
    BREAKER_RETRY_CAP_MS,
  );
  const frac = jitterSeed(subsystem); // 0..1
  const factor = 1 + (frac * 2 - 1) * BREAKER_RETRY_JITTER; // 0.9..1.1
  return Math.round(exp * factor);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] as number;
}

export interface ConcreteBreaker extends Breaker {
  /** Live per-subsystem record. */
  snapshot(subsystem: string): BreakerRecord;
  /** Admin reset: clears cooldown (never evidence), or unwires MANUAL_HALT. */
  reset(subsystem: string): BreakerRecord;
  /** Whether the breaker is healthy enough that mode A may be attempted. */
  modeFor(subsystem: string): Mode;
}

export function createBreaker(opts: BreakerOptions = {}): ConcreteBreaker {
  const now: MonotonicClock = opts.now ?? (() => performance.now());
  const wallNow: WallClock = opts.wallNow ?? (() => new Date().toISOString());
  const reporter = opts.reporter;
  const onEvent = opts.onEvent;
  const subs = new Map<string, SubsystemState>();

  function get(subsystem: string): SubsystemState {
    let s = subs.get(subsystem);
    if (!s) {
      s = {
        state: "CLOSED_A",
        transitionedAtMs: now(),
        attempts: [],
        failures: [],
        latencies: [],
        retryAttempt: 0,
        probeCount: 0,
        frozenFrontier: false,
        tripKind: "correctness",
      };
      subs.set(subsystem, s);
    }
    return s;
  }

  function pruneWindow(s: SubsystemState, at: number): void {
    const cutoff = at - BREAKER_WINDOW_MS;
    s.attempts = s.attempts.filter((t) => t > cutoff);
    s.failures = s.failures.filter((t) => t > cutoff);
    s.latencies = s.latencies.slice(-s.attempts.length);
  }

  /** Emit a transition with the minimal event surface + optional append. */
  function transition(s: SubsystemState, to: BreakerState, event: string, fields: Record<string, unknown>): void {
    s.state = to;
    s.transitionedAtMs = now();
    if (onEvent) {
      try {
        onEvent({ type: event, to, ...fields, atMs: s.transitionedAtMs });
      } catch {
        /* non-fatal */
      }
    }
    if (reporter) {
      if (event === "breaker_opened") {
        reporter.breakerOpened({
          subsystem: String(fields.subsystem ?? ""),
          fromState: String(fields.fromState ?? ""),
          toState: to,
          code: String(fields.code ?? ""),
          attempts: Number(fields.attempts ?? 0),
          failures: Number(fields.failures ?? 0),
        });
      } else if (event === "probe_promoted") {
        reporter.probePromoted({
          subsystem: String(fields.subsystem ?? ""),
          fromState: String(fields.fromState ?? ""),
          toState: to,
          probeCount: Number(fields.probeCount ?? 0),
          retryAttempt: Number(fields.retryAttempt ?? 0),
        });
      }
    }
  }

  function record(subsystem: string): BreakerRecord {
    const s = get(subsystem);
    const at = now();
    pruneWindow(s, at);
    const failureRate = s.attempts.length === 0 ? 0 : s.failures.length / s.attempts.length;
    const sortedLat = [...s.latencies].sort((a, b) => a - b);
    const p95 = percentile(sortedLat, 95);
    const r: BreakerRecord = {
      subsystem,
      state: s.state,
      windowStartMs: s.attempts.length > 0 ? Math.min(...s.attempts) : at,
      attempts: s.attempts.length,
      failures: s.failures.length,
      tripKind: s.tripKind,
      transitionedAtMs: s.transitionedAtMs,
      cooldownUntilMs: s.cooldownUntilMs,
      probeCount: s.probeCount,
      retryAttempt: s.retryAttempt,
      retryDelayMs: breakerRetryDelay(subsystem, s.retryAttempt),
      frozenFrontier: s.frozenFrontier,
      manualReason: s.manualReason,
      updatedAt: wallNow(),
      p95Ms: p95,
      failureRate,
    };
    return r;
  }

  /** Enter a cooldown + the given open state; returns the open-state name. */
  function openTo(s: SubsystemState, subsystem: string, to: "OPEN_B" | "OPEN_C" | "MANUAL_HALT", kind: BreakerTripKind, code: string): BreakerState {
    const from = s.state;
    s.tripKind = kind;
    if (to === "MANUAL_HALT") {
      s.cooldownUntilMs = undefined;
      s.probeCount = 0;
      transition(s, "MANUAL_HALT", "breaker_opened", { subsystem, fromState: from, code, attempts: s.attempts.length, failures: s.failures.length });
      return "MANUAL_HALT";
    }
    s.cooldownUntilMs = now() + BREAKER_COOLDOWN_MS;
    s.probeCount = 0;
    if (to === "OPEN_B") s.healthyResidenceSinceMs = now(); // start healthy residence
    transition(s, to, "breaker_opened", { subsystem, fromState: from, code, attempts: s.attempts.length, failures: s.failures.length });
    return to;
  }

  /** After cooldown, an open state may PROBE (never directly promote). */
  function maybeProbe(s: SubsystemState, subsystem: string, openState: "OPEN_B" | "OPEN_C"): void {
    const at = now();
    if (s.state !== openState) return;
    if (s.cooldownUntilMs === undefined || at < s.cooldownUntilMs) return;
    // Promotion back toward A additionally requires the minimum healthy
    // residence in OPEN_B (invariant: promotion never precedes the 5min
    // residence, so we may only PROBE here, never directly promote).
    if (openState === "OPEN_B") {
      const since = s.healthyResidenceSinceMs ?? at;
      if (at - since < BREAKER_MIN_HEALTHY_RESIDENCE_MS) return;
    }
    s.cooldownUntilMs = undefined;
    const to = openState === "OPEN_C" ? "PROBE_B" : "PROBE_A";
    transition(s, to, "probe_promoted", { subsystem, fromState: openState, probeCount: 0, retryAttempt: s.retryAttempt });
  }

  /**
   * Promotion hysteresis: promotion requires window failure rate < 2% and p95
   * latency within budget (TRIAD_RESILIENCE). Without it, a recovery probe that
   * passes but with a poor window must NOT promote.
   */
  function canPromote(s: SubsystemState): boolean {
    const failureRate = s.attempts.length === 0 ? 0 : s.failures.length / s.attempts.length;
    if (failureRate >= BREAKER_HYSTERESIS_FAILURE_RATE) return false;
    const sortedLat = [...s.latencies].sort((a, b) => a - b);
    return percentile(sortedLat, 95) <= BREAKER_HYSTERESIS_BUDGET_P95_MS;
  }

  /** A successful probe: advance the count, and promote once N AND hysteresis hold. */
  function advanceProbe(s: SubsystemState, subsystem: string): void {
    if (s.state !== "PROBE_B" && s.state !== "PROBE_A") return;
    s.probeCount += 1;
    if (s.probeCount >= BREAKER_PROBE_COUNT) {
      if (!canPromote(s)) {
        // Probe succeeded but hysteresis not met — stay probing, no promotion.
        s.probeCount = 0;
        return;
      }
      const from = s.state;
      s.probeCount = 0;
      const to = from === "PROBE_B" ? "OPEN_B" : "CLOSED_A";
      transition(s, to, "probe_promoted", { subsystem, fromState: from, probeCount: BREAKER_PROBE_COUNT, retryAttempt: s.retryAttempt });
      if (to === "OPEN_B") {
        s.cooldownUntilMs = now() + BREAKER_COOLDOWN_MS;
        s.healthyResidenceSinceMs = now();
      }
      s.retryAttempt = 0;
    }
  }

  const breaker: ConcreteBreaker = {
    modeFor(subsystem) {
      const s = get(subsystem);
      const at = now();
      pruneWindow(s, at);
      if (s.state === "MANUAL_HALT") return "C";
      if (s.state === "CLOSED_A") return "A";
      // OPEN_B / OPEN_C / PROBE_* — the primary is broken; fall back to B, or C
      // once B itself has tripped.
      if (s.state === "OPEN_C" || s.state === "PROBE_B") return "C";
      return "B";
    },

    execute<T>(
      subsystem: string,
      inputDigest: string,
      run: Record<Mode, () => T>,
      validate: (v: T) => boolean,
    ): TriadResult<T> {
      const s = get(subsystem);
      const at = now();
      pruneWindow(s, at);
      const mode: Mode = breaker.modeFor(subsystem);
      s.attempts.push(at);
      let ok = false;
      let value: T | undefined;
      let errorCode = "";
      try {
        value = run[mode]();
        ok = validate(value);
        if (!ok) errorCode = "TRI_OUTPUT_INVALID";
      } catch {
        errorCode = "TRI_EXEC_THREW";
        ok = false;
      }
      const latency = now() - at;
      s.latencies.push(latency);

      if (ok) {
        const openState: "OPEN_B" | "OPEN_C" =
          s.state === "OPEN_C" ? "OPEN_C" : "OPEN_B";
        maybeProbe(s, subsystem, openState);
        advanceProbe(s, subsystem);
        return {
          ok: true,
          value: value as T,
          mode,
          inputDigest,
          outputDigest: String(((value as { digest?: unknown })?.digest) ?? ""),
          algorithmVersion: "vc0c-triad-1",
          latencyMs: latency,
          breaker: record(subsystem),
        };
      }

      s.failures.push(at);
      // Probe failure: return to the OPEN state it was probing FROM and increment
      // backoff (TRIAD_RESILIENCE §transitions: "Any probe failure returns to its
      // open state and increments backoff"). A probe failure is NOT a fresh trip —
      // it re-enters the originating open state/cooldown and never serves output.
      // This governs both PROBE_A (probing OPEN_B, mode B) and PROBE_B (probing
      // OPEN_C, mode C); without it a PROBE_A failure would mis-trip to OPEN_C and
      // a PROBE_B failure would short-circuit with no revert and no backoff bump.
      if (s.state === "PROBE_A" || s.state === "PROBE_B") {
        const from: "OPEN_B" | "OPEN_C" = s.state === "PROBE_A" ? "OPEN_B" : "OPEN_C";
        openTo(s, subsystem, from, "performance", errorCode);
        s.retryAttempt += 1;
        return { ok: false, mode, code: errorCode, retryable: true, breaker: record(subsystem) };
      }
      // Trip rules for FRESH (non-probe) failures.
      if (mode === "C") {
        // C failures are continuity-level; they do not advance the breaker but
        // surface as retryable C failures (unchanged transcript).
        return { ok: false, mode, code: errorCode, retryable: true, breaker: record(subsystem) };
      }
      if (mode === "B") {
        // Fresh B failure -> OPEN_C.
        openTo(s, subsystem, "OPEN_C", s.failures.length >= BREAKER_CORRECTNESS_FAILURES ? "correctness" : "performance", errorCode);
        s.retryAttempt += 1;
        return { ok: false, mode, code: errorCode, retryable: true, breaker: record(subsystem) };
      }
      // mode === "A" failure: correctness (output validation failed) is
      // ZERO-TOLERANCE and trips on its first occurrence regardless of attempt
      // count (TRIAD_RESILIENCE: "correctness trip on first failure"). The
      // 20-attempt minimum gates only the PERFORMANCE rate trip. A first, isolated
      // failure is a performance-rate signal (rate 1.0), so it needs the window.
      const failureRate = s.failures.length / s.attempts.length;
      const perf = s.failures.length >= BREAKER_PERF_FAILURES || failureRate >= BREAKER_PERF_FAILURE_RATE;
      const correctness =
        errorCode === "TRI_OUTPUT_INVALID" ||
        (s.failures.length >= BREAKER_CORRECTNESS_FAILURES && failureRate < BREAKER_PERF_FAILURE_RATE);
      const trips = correctness || (s.attempts.length >= BREAKER_MIN_ATTEMPTS && perf);
      if (trips) {
        openTo(s, subsystem, "OPEN_B", correctness ? "correctness" : "performance", errorCode);
        s.retryAttempt += 1;
      }
      return { ok: false, mode, code: errorCode, retryable: true, breaker: record(subsystem) };
    },

    recordProbe(...args: readonly unknown[]): BreakerRecord {
      const subsystem = String(args[0] ?? "");
      const s = get(subsystem);
      const openState: "OPEN_B" | "OPEN_C" =
        s.state === "OPEN_C" ? "OPEN_C" : "OPEN_B";
      maybeProbe(s, subsystem, openState);
      advanceProbe(s, subsystem);
      return record(subsystem);
    },

    manualHalt(reason: string): BreakerRecord {
      if (!reason) return record("provider");
      // Authority/digest/causal corruption degrades EVERY tracked subsystem to
      // MANUAL_HALT (the corruption is global, not per-subsystem). Returns the
      // provider's record. A manual halt requires a reason and an explicit
      // admin reset to clear — evidence is never discarded.
      const targets = subs.size === 0 ? ["provider"] : [...subs.keys()];
      let last: BreakerRecord = record("provider");
      for (const subsystem of targets) {
        const s = get(subsystem);
        s.manualReason = reason;
        openTo(s, subsystem, "MANUAL_HALT", "manual", "TRI_MANUAL_HALT");
        last = record(subsystem);
      }
      return last;
    },

    snapshot(subsystem) {
      return record(subsystem);
    },

    reset(subsystem) {
      const s = get(subsystem);
      const at = now();
      pruneWindow(s, at);
      // Manual reset clears cooldown / probe state but NEVER evidence (attempts
      // and failures are retained). A MANUAL_HALT unwires to a probe of B.
      s.cooldownUntilMs = undefined;
      s.probeCount = 0;
      s.manualReason = undefined;
      if (s.state === "MANUAL_HALT") {
        s.state = "OPEN_B";
        s.transitionedAtMs = now();
      }
      return record(subsystem);
    },
  };

  return breaker;
}
