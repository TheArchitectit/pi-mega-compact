# PC — Prompt Cache Flag Rollout

**Status:** planned | **Depends on:** VC9D reviewer-accepted | **Sprints:** PC-A, PC-B, PC-C, PC-D

## Phase goal and boundary

Unify the PLAN_V2 prompt-cache feature flags (`MEGACOMPACT_MESSAGE_SEPARATION`, `MEGACOMPACT_CACHE_STRIPING`) from their current double-gate, default-OFF state to the standard positive-sprint-flag convention (default ON, `=0` byte-identical to predecessor), then surface the cache metrics in the dashboard and validate hit-rate improvement. Inputs: accepted predecessor evidence + the normative [contracts](../CONTRACTS.md), [evaluation](../EVALUATION.md), [triads](../TRIAD_RESILIENCE.md). Outputs: **flag-parity fixtures, stripe-distribution metrics, hit-rate trend data, conformance roll-up**.

Both features are purely structural prompt reordering — no external LLM calls. Fallback when off or when no reordering is needed is byte-identical to the pre-sprint behavior.

## Sprint boundaries

- **PC-A:** `messageSeparation` flag unification + default ON. Remove the in-function env gate from `buildSeparatedPrompt`; single config-driven gate at the call site. Includes the `mega-config.ts` delegate-shell split (the file is over the 400 extension soft limit and trips the soft-as-hard headroom gate on any edit).
- **PC-B:** `cacheStriping` flag unification + default ON. Same pattern — remove the in-function env gate from `buildCacheOptimizedPrompt`. Depends on PC-A (buildCacheOptimizedPrompt delegates to buildSeparatedPrompt).
- **PC-C:** Dashboard Phase 4 — stripe distribution card, per-turn cache breakdown, hit-rate trend chart. Depends on PC-A + PC-B.
- **PC-D:** Benchmark validation + conformance roll-up. Measured hit-rate vs projected. Depends on all.

No implementation crosses into the next boundary before predecessor evidence is reviewer-accepted.

## Failure and evaluation

A is the flag-on path (reordered prompt for better cache prefix stability); B is an independent assertion (fixture-driven, different inputs); C is the flag-off path (`=0`, byte-identical to predecessor). No payload bytes are logged or exported — cache metrics are aggregate counts and ratios only (EVAL-REDACT-002).

## Migration, config, privacy, dashboard

Migration disposition: **pure — no schema/state changes** (prompt reordering is in-memory only). Every flag is positive `MEGACOMPACT_*`, default ON, `=0` byte-identical, represented in SETTINGS as a visible boolDirect toggle (never `EXCLUDED_SETTINGS`). Privacy: no payload leakage; metrics are structural counts only. Dashboard sprints (PC-C) use the common dashboard API/route/client ownership.

## Phase exit and rollback

All four sprint evidence files reviewer-accepted; exact project gates pass. Rollback per sprint: `MEGACOMPACT_MESSAGE_SEPARATION=0` / `MEGACOMPACT_CACHE_STRIPING=0` restores byte-identical pre-sprint prompt arrays. PC-D restates the measured hit-rate improvement (or lack thereof) as a permanent record.
