/**
 * cache-stripe.ts — Vector-Aware Cache Striping shell (PLAN_V2 Phase 3).
 *
 * Shell: re-exports types and function signatures from the implementation.
 * The heavy logic lives in cache-stripe-impl.ts. This keeps the public API
 * surface clean and respects the src/ 300-line soft limit.
 *
 * Pi-agnostic: no pi runtime types, no network (PREVENT-PI-004).
 * All SQL is parameterized (PREVENT-002).
 */

export {
  computeStabilityScore,
  stabilityToStripe,
  refreshStripeAssignments,
} from "./cache-stripe-impl.js";

export type { CacheStripe, ChunkInput, EmbedderLike } from "./cache-stripe-impl.js";
