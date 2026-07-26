# Sprint 38 — Output-Error Auto-Retry (Layered on S28)

**Status**: PLANNED
**Branch**: `output-error-work`
**Prereq**: S28 (v0.7.8) — this layer sits on top of S28, not replacing it.

---

## Problem

Users still see the following error in production despite S28 being shipped:

> Error: Model stopped because it reached the maximum output token limit.
> The response may be incomplete.

Possible root causes:
1. Installed pi-mega-compact version < 0.7.8 (S28 missing)
2. `MEGACOMPACT_AUTO_CONTINUE_LENGTH_STOP=false` (S28 disabled)
3. Pi emits a `stopReason` other than `'length'` for this model/provider combo
4. The error fires from a different event path (provider failure, network timeout, etc.) that S28's detector does not cover

**Solution**: Add a broader error-retry safety net that catches ALL error types, not just `stopReason === 'length'`.

---

## Safety

- **Non-fatal**: A retry failure must never break the agent loop
- **Debounced**: Exponential backoff (5s, 10s, 20s, 30s, 30s cap) prevents busy-loops
- **Max-retry gated**: Transient errors cap at 5 retries; permanent at 1 retry
- **Counter reset**: Successful `turn_end` resets the retry counter
- **S28 untouched**: `stopReason === 'length'` returns `null` from the classifier — S28's existing agent_end path handles it exclusively
- **Rollback**: `MEGACOMPACT_AUTO_RETRY_TRANSIENT_MAX=0` disables all retries (reverts to S28-only)

---

## Architecture

```
turn_end event
  +-- stopReason === 'length'  -->  S28 (existing path, untouched)
  |   stopReason === 'stop'|'toolUse'  -->  success, reset retry counter
  |
  +-- stopReason === 'error'|'aborted'  OR  message error text
      |
      +-- classifyError(msg) -> 'transient' | 'permanent' | 'compaction-noop'
      |
      +-- compaction-noop:
      |   +-- log 'compaction_noop_diagnostic', reset errorRetryCount, re-throw (NOT retried)
      |
      +-- transient:
      |   +-- count <= 5  -->  fire retry nudge (debounced)
      |   +-- count > 5   -->  log 'error_retry_exhausted', surface error
      |
      +-- permanent:
          +-- count <= 1  -->  fire retry nudge (debounced)
          +-- count > 1   -->  log 'error_retry_exhausted', surface error
```

---

## Error Classification

| Signal | Category | Notes |
|--------|----------|-------|
| `stopReason === 'length'` | **null** | S28 handles exclusively |
| `stopReason === 'stop'` | **null** | Success |
| `stopReason === 'toolUse'` | **null** | Normal tool flow |
| `stopReason === 'error'` | **transient** | Generic pi error |
| `stopReason === 'aborted'` | **transient** | User/system abort |
| `/max(imum)? output token/` | **transient** | The exact error we are catching |
| `/rate.?limit|429|too many requests/` | **transient** | Rate limiting |
| `/5xx|internal server|bad gateway|service unavailable/` | **transient** | Server errors |
| `/network|timeout|connection (lost|refused|reset)/` | **transient** | Network issues |
| `/auth|unauthorized|invalid (api )?key|permission/` | **permanent** | Auth failure |
| `/invalid request|malformed|bad request/` | **permanent** | Config/input error |
| `/already compacted/` | **compaction-noop** | pi race (FAIL-2026071701); NOT retryable — re-throw |
| `/compaction failed/` | **compaction-noop** | pi manual compact catch; NOT retryable — re-throw |
| `/nothing to compact/` | **compaction-noop** | session too small; NOT retryable — re-throw |
| `/auto.?compaction failed/` | **compaction-noop** | pi auto-compaction catch; NOT retryable — re-throw |
| Anything else | **null** | Unknown — do not retry |

---

## Sub-Sprints

### S38.1 — Config + Runtime State
**Files**: `extensions/mega-config.ts`, `extensions/mega-runtime/helpers.ts`

- Add to `MegaConfig` interface:
  - `autoRetryTransientMax: number` (env: `MEGACOMPACT_AUTO_RETRY_TRANSIENT_MAX`, default `5`)
  - `autoRetryPermanentMax: number` (env: `MEGACOMPACT_AUTO_RETRY_PERMANENT_MAX`, default `1`)
- Add to `SessionRuntime` interface:
  - `errorRetryCount: number` (consecutive error count, reset on success)
  - `errorRetryUntil: number` (wall-clock ms debounce for error retry nudge)
- Add `envFlag` loaders in `loadConfig()` for both new fields
- Initialize `errorRetryCount: 0` and `errorRetryUntil: 0` in runtime init

### S38.2 — Error Classifier + Turn-End Watcher
**Files**: `extensions/mega-events/agent-handlers.ts`

- Add `classifyError(message): 'transient' | 'permanent' | 'compaction-noop' | null` helper (inline or extracted)
- In `turn_end` handler, AFTER existing S28 detection:
  1. If `stopReason === 'length'` -> skip (S28 handles)
  2. Call `classifyError(event.message)`
  3. If `null` (success) -> reset `runtime.rt.errorRetryCount = 0`
  4. If `'compaction-noop'` -> log `'compaction_noop_diagnostic'` dashboard event, reset `errorRetryCount = 0`, and re-throw / surface the original error WITHOUT firing a retry nudge (null-equivalent for retry; the compaction already succeeded via pi's native path — see FAIL-2026071701)
  5. If `'transient'` or `'permanent'` (category found):
     a. Get max retries from config (`transient` -> `autoRetryTransientMax`, `permanent` -> `autoRetryPermanentMax`)
     b. Increment `errorRetryCount`
     c. If over max -> log `'error_retry_exhausted'` dashboard event, reset counter, return
     d. If under max -> compute backoff, check debounce, set `errorRetryUntil`, log `'error_retry'` event, fire `pi.sendUserMessage()` with retry nudge
  6. All wrapped in `try/catch` (non-fatal)
- In `turn_start` handler: reset `errorRetryCount` (alongside existing `lengthStopPending` reset)

### S38.3 — Tests
**Files**: `extensions/mega-compact.test.ts`

- Test: classifyError returns 'transient' for error/aborted stopReasons
- Test: classifyError returns 'transient' for max-output-token text
- Test: classifyError returns 'permanent' for auth/unauthorized text
- Test: classifyError returns null for stop/toolUse stopReasons
- Test: classifyError returns null for 'length' stopReason (S28 guard)
- Test: classifyError returns 'compaction-noop' for "Already compacted" text
- Test: classifyError returns 'compaction-noop' for "Nothing to compact" text
- Test: classifyError returns 'compaction-noop' for "Auto compaction failed" text
- Test: compaction-noop logs 'compaction_noop_diagnostic' and resets counter (no retry fired)
- Test: compaction-noop does NOT fire `pi.sendUserMessage()` (NOT retryable — re-throw)
- Test: retry fires up to max for transient errors
- Test: retry fires 1x for permanent errors then stops
- Test: successful turn resets retry counter
- Test: error_retry_exhausted event logged when max exceeded

### S38.4 — Integration + Ship
**Files**: `CHANGELOG.md`

- Add changelog entry for S38 (error-retry safety net + compaction-noop category + S38.5 race-guard strengthening)
- Run: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all && node scripts/guardrails-scan.mjs`
- Commit + push

### S38.5 — Strengthen Race Guard (compaction-noop prevention)
**Files**: `extensions/mega-events/agent-handlers.ts`, `extensions/mega-events/context-handler.ts`
**Prereq**: v0.7.4 race fix (postmortem FAIL-2026071701, commit `848c817`)

**Why**: The v0.7.4 `lastNativeCompactAt` cooldown only prevents BACK-TO-BACK
races — a second `agent_end` within 10s of a prior compaction is skipped. It
does NOT close the FIRST race in a burst: when a session crosses the threshold
after a long idle, `lastNativeCompactAt` is stale (last compaction >10s ago),
so `now - lastNativeCompactAt < 10_000` is false and the `agent_end` handler
calls `ctx.compact()` synchronously — racing pi's about-to-run native
`_checkCompaction` (which fires AFTER `agent_end`, per pi's docstring) and
throwing "Already compacted". The compaction-noop classifier (S38.2) contains
the fallout; S38.5 prevents the throw at the source.

**Changes**:
1. **Cooldown 10s -> 30s** in both call sites:
   - `agent-handlers.ts` (~line 124): `if (sinceCompact < 10_000)` -> `30_000`
   - `context-handler.ts` (~line 257): `if (sinceCompact < 10_000 || ...)` -> `30_000`
   Widens the back-to-back guard so one compaction stamp suppresses the next
   several `agent_end` cycles in a burst, not just the immediate next.
2. **Deferred `ctx.compact()` with re-check** — replace the synchronous call
   with a deferred invocation (`setTimeout(_, 500)` to span pi's async
   compaction-summary append, or `queueMicrotask` if that append is confirmed
   synchronous) that re-validates BEFORE calling:
   - Re-check `piCompactWouldNoop(ctx)` — by deferral time pi's native
     `_checkCompaction` has appended its `compaction` branch entry, so this
     returns `true` and we skip. This closes the first-race window the cooldown
     cannot (no prior stamp on the burst's first `agent_end`).
   - Re-check `idle` — if work queued since (sub-agent settled late), skip.
   - Re-check `sinceCompact < 30_000` — a `session_compact` may have fired
     during the deferral; honor it.
   Only if all three pass does the deferred callback call `ctx.compact()`.
3. Preserve existing `diagAgentEndDurableSkipRecent` / `diagAgentEndDurable`
   counters and the `debounceUntil` 2s trim debounce (orthogonal to this guard).

**Non-goal**: do NOT remove `piCompactWouldNoop` or the cooldown — both remain
as defense-in-depth. The deferred re-check is additive.

**Tests** (`extensions/mega-compact.test.ts`):
- Test: cooldown skip fires at `sinceCompact < 30_000` (not 10_000)
- Test: deferred `ctx.compact()` re-checks `piCompactWouldNoop` + idle; skips
  when pi has since appended a compaction entry (first-race-in-burst)
- Test: `MEGACOMPACT_RACE_GUARD_STRICT=false` reverts to synchronous 10s guard

**Rollback**: `MEGACOMPACT_RACE_GUARD_STRICT=false` (new env, default `true`)
reverts to the v0.7.4 synchronous 10s-cooldown behavior.

---

## Config Reference

| Env Var | Type | Default | Description |
|---------|------|---------|-------------|
| `MEGACOMPACT_AUTO_RETRY_TRANSIENT_MAX` | number | `5` | Max retries for transient errors (length/5xx/429/network) |
| `MEGACOMPACT_AUTO_RETRY_PERMANENT_MAX` | number | `1` | Max retries for permanent errors (auth/config/malformed) |
| `MEGACOMPACT_AUTO_CONTINUE_LENGTH_STOP` | bool | `true` | Existing S28 toggle — separate from retry |
| `MEGACOMPACT_RACE_GUARD_STRICT` | bool | `true` | S38.5: 30s cooldown + deferred re-check; `false` reverts to v0.7.4 10s synchronous guard |

---

## Acceptance Criteria

- [ ] `npm run build` — zero errors
- [ ] `npm test` — all existing + new tests pass
- [ ] `npm run lint` — zero errors
- [ ] `python3 scripts/regression_check.py --all` — passes
- [ ] `node scripts/guardrails-scan.mjs` — zero violations
- [ ] S28 existing tests unbroken (no regression)
- [ ] New S38 tests pass (classifier + retry behavior)
- [ ] compaction-noop errors ("Already compacted" / "Nothing to compact" / "Compaction failed" / "Auto compaction failed") classified and NOT retried — diagnostic logged, counter reset, error surfaced
- [ ] S38.5: `lastNativeCompactAt` cooldown raised 10s -> 30s in both `agent-handlers.ts` and `context-handler.ts`
- [ ] S38.5: deferred `ctx.compact()` re-checks `piCompactWouldNoop` + idle before calling (first-race-in-burst closed)
- [ ] S38.5 integration test: first-race-in-burst no longer throws "Already compacted"
- [ ] CHANGELOG.md updated
- [ ] `MEGACOMPACT_AUTO_RETRY_TRANSIENT_MAX=0` disables all retries cleanly

---

## Rollback

- `MEGACOMPACT_AUTO_RETRY_TRANSIENT_MAX=0` disables all retries (reverts to S28-only)
- `MEGACOMPACT_AUTO_RETRY_PERMANENT_MAX=0` disables permanent error retries
- Full revert: `git revert <commit>` on the S38 commits
