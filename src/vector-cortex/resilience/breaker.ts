/**
 * vector-cortex/resilience/breaker.ts — VC0C breaker factory shell (VC0C).
 *
 * Thin barrel over the state-machine implementation in `breaker-core.ts`
 * (delegate-shell + impl-file split keeps the frequently-touched file small).
 * Owns the public `createBreaker` factory and the monotonic-clock/options types,
 * all re-exported for the safety adapter and tests.
 *
 * Full semantics live in breaker-core.ts (TRIAD_RESILIENCE §breaker). Local-only,
 * no network (PREVENT-PI-004), no `any` (PREVENT-011).
 */

export {
  createBreaker,
  breakerRetryDelay,
} from "./breaker-core.js";
export type {
  MonotonicClock,
  WallClock,
  BreakerOptions,
  ConcreteBreaker,
} from "./breaker-core.js";
