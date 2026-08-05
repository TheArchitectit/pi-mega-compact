# PLAN_V2 Remaining Wiring: Cache Striping + Message Separation Production Wiring

## Context

PLAN_V2 spec'd message separation (P2.2) and vector cache striping (P3.x) but the production wiring was never done. The spec-level code exists (tables, stripe computation, prompt builder) but nothing in the live context handler calls it. Discovered during VC0D review that PLAN_V2 phases were deferred and never wired.

## What Was Found Unwired

| Item | What Exists | What's Missing |
|------|-------------|----------------|
| P2.2 write path | `conversation_thread` + `tool_results` tables in `src/store/sqlite/plan-v2.ts` | `dbMirrorAppend.ts` wrote to WRONG schema (role/content instead of tool_call_id/tool_result); no split-insert logic routing user/assistant→thread and tool→results |
| P3.4 cache-optimized prompt | `buildCacheOptimizedPrompt()` in `separated-prompt.ts` | Never invoked from `tailResult.ts` — only `buildSeparatedPrompt` was called |
| P3.5 topic-shift stripe refresh | `cacheStripe.ts` in `turnEndHandler` | Content extraction bug: `msg.content` typed as string (pi API) but code only handled `Array.isArray` — string content produced garbage topic embeddings |
| P4.6 ordering guidance | CacheTab guidance panel | No flag-status surfacing; no mention of how to enable the two flags |
| P1.4/P1.5 verify | `providerCachePct` wired in snapshot | Verified correct |
| P2.5 prefix stability | `prefix-stability.test.ts` + `cache-stripe-impl.ts` | `tailResult.ts` called `computeStabilityScore` with wrong args; replaced with cross-turn fingerprint-based stable-prefix counting |

## Changes Made

### P2.2 Write Path — `dbMirrorAppend.ts`
- Fixed `tool_results` INSERT statement to match actual `plan-v2.ts` schema: `(conversation_id, tool_call_id, tool_result, turn_index, timestamp)` — was writing `(role, content)` against a table expecting `(tool_call_id, tool_result)`
- Added `toolCallIdOf()` helper: narrows `AgentMessage.toolCallId` via `unknown` cast (PREVENT-011 safe), falls back to `bash:{turn}:{idx}` synthetic ID for `bashExecution` (no toolCallId)
- Added dedup guards: `threadHas` + `toolHas` SELECT checks before INSERT to prevent duplicate rows on multi-fire turns

### P3.5 Topic-Shift Stripe Refresh — `cacheStripe.ts`
- Fixed content extraction: handles both `string` content (pi's plain-string assistant messages) and `Array` content (multi-part). Previously only `Array.isArray` branch existed, producing near-empty text when pi sent plain strings → garbage topic embeddings.
- Added proper type narrowing: `typeof t === "string"` after `"text" in part` check, no `any`.

### P4.6 Ordering Guidance — dashboard SETTINGS (not CacheTab)
- Review correction: the agent had added an informational paragraph to `CacheTab.tsx`; that duplicates state and can't be toggled. Reverted CacheTab and instead added both flags to `SETTINGS` in `extensions/dashboard-server/routes-rag-settings-helpers.ts` under "RAG Pipeline" as `boolFlag(..., false)` entries ("Message Separation (P2)" / "Cache Striping (P3)") so they're actually toggleable from the dashboard's config UI (per the all-flags-toggleable memory).

### P2.5 Prefix Stability Measurement — `tailResult.ts`
- **Replaced** incorrect `computeStabilityScore` call (single-chunk API, wrong args) with cross-turn stable-prefix fingerprint counting.
- Uses `computeContentDigest` (L0 dedup digest) on `role|content` for each leading message. Counts how many leading fingerprints match the previous turn's.
- Guards: once-per-turn (`sessionId+turn` equality), cross-session skipped.
- Review correction: instead of adding a `previousTurnPrefix` field to `SessionRuntime` (which forced runtime.ts over the 400-line soft limit and would have tripped soft-as-hard), stores the footprint in a `WeakMap<MegaRuntime, TurnPrefix>` local to `tailResult.ts`. Zero runtime.ts/helpers.ts/reset-runtime.ts impact — they remain byte-identical to the previous release; runtime lifecycle still scopes the map.
- Fire-and-forget, non-fatal try/catch.

### P3.4 Cache-Optimized Prompt — `tailResult.ts`
- Existing `buildCacheOptimizedPrompt()` call already present when `config.cacheStriping` is enabled. Verified correct.

### Read-path gaps the benchmark surfaced (fixed)
1. **Epoch row never visible to stripe reader.** `afterCompact.persistEpochAndMaintain` previously wrote `checkpoint_epochs` only inside `if (config.dbMirror)`, so PLAN_V2-only configurations produced no epoch and `buildCacheOptimizedPrompt` always found none. Fix: emit the epoch row when `dbMirror || messageSeparation || cacheStriping`; keep the wiki/topic/dedup maintenance behind `dbMirror` alone (that's what it was for). Flag-off remains byte-identical.
2. **Stripe write/read key mismatch.** The write path keyed `cache_stripes.chunk_id` by `CAST(c.rowid AS TEXT)` while the read path joined on `context_chunks.id` (chkpt_001-style) — the lookup could never match, so Layer 2 was permanently empty. Fix: key both by `c.id` in `cache-stripe-impl.ts`; also removed the query's phantom `s.access_count`/`s.last_accessed_at` columns (not in the schema; silently dropped the whole SELECT via the try/catch) and score those weights as 0 until a tracking column exists.
3. **Random epoch ids on default call.** `refreshStripeAssignments(stateDir, undefined, …)` produced a random hex epoch, invisible to the reader's latest-epoch lookup. Fix: `undefined` now means "use latest `checkpoint_epochs` row, else random"; `''` retains its original "no epoch filter" semantics.
4. **File size.** `cache-stripe-impl.ts` crossed the 300-line src/ soft limit after the fixes (it was already 384 at baseline). Split pure scoring into `cache-stripe-score.ts` (delegate-shell pattern); `cache-stripe.ts` re-exports, public API unchanged.

### P1.4/P1.5 Verification — `snapshot.ts` / `runtime-snapshot.ts`
- Verified `providerCachePct` correctly flows: `readLatestCacheHitPct(stateDir)` → `computeMegaSnapshot` → `widgetData.cachePct`. Separate from dedup hit rate by design.

## Deploy

After review:
1. `npx tsc --noEmit` — zero errors
2. `npm test` — all pass
3. `python3 scripts/regression_check.py --all`
4. `npm run build:dashboard` — rebuild dist for CacheTab changes
5. `./scripts/deploy.sh <version>`
