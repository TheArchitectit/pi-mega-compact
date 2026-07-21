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
      +-- classifyError(msg) -> 'transient' | 'permanent'
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

- Add `classifyError(message): 'transient' | 'permanent' | null` helper (inline or extracted)
- In `turn_end` handler, AFTER existing S28 detection:
  1. If `stopReason === 'length'` -> skip (S28 handles)
  2. Call `classifyError(event.message)`
  3. If `null` (success) -> reset `runtime.rt.errorRetryCount = 0`
  4. If category found:
     a. Get max retries from config (`transient` -> `autoRetryTransientMax`, `permanent` -> `autoRetryPermanentMax`)
     b. Increment `errorRetryCount`
     c. If over max -> log `'error_retry_exhausted'` dashboard event, reset counter, return
     d. If under max -> compute backoff, check debounce, set `errorRetryUntil`, log `'error_retry'` event, fire `pi.sendUserMessage()` with retry nudge
  5. All wrapped in `try/catch` (non-fatal)
- In `turn_start` handler: reset `errorRetryCount` (alongside existing `lengthStopPending` reset)

### S38.3 — Tests
**Files**: `extensions/mega-compact.test.ts`

- Test: classifyError returns 'transient' for error/aborted stopReasons
- Test: classifyError returns 'transient' for max-output-token text
- Test: classifyError returns 'permanent' for auth/unauthorized text
- Test: classifyError returns null for stop/toolUse stopReasons
- Test: classifyError returns null for 'length' stopReason (S28 guard)
- Test: retry fires up to max for transient errors
- Test: retry fires 1x for permanent errors then stops
- Test: successful turn resets retry counter
- Test: error_retry_exhausted event logged when max exceeded

### S38.4 — Integration + Ship
**Files**: `CHANGELOG.md`

- Add changelog entry for S38
- Run: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all && node scripts/guardrails-scan.mjs`
- Commit + push

---

## Config Reference

| Env Var | Type | Default | Description |
|---------|------|---------|-------------|
| `MEGACOMPACT_AUTO_RETRY_TRANSIENT_MAX` | number | `5` | Max retries for transient errors (length/5xx/429/network) |
| `MEGACOMPACT_AUTO_RETRY_PERMANENT_MAX` | number | `1` | Max retries for permanent errors (auth/config/malformed) |
| `MEGACOMPACT_AUTO_CONTINUE_LENGTH_STOP` | bool | `true` | Existing S28 toggle — separate from retry |

---

## Acceptance Criteria

- [ ] `npm run build` — zero errors
- [ ] `npm test` — all existing + new tests pass
- [ ] `npm run lint` — zero errors
- [ ] `python3 scripts/regression_check.py --all` — passes
- [ ] `node scripts/guardrails-scan.mjs` — zero violations
- [ ] S28 existing tests unbroken (no regression)
- [ ] New S38 tests pass (classifier + retry behavior)
- [ ] CHANGELOG.md updated
- [ ] `MEGACOMPACT_AUTO_RETRY_TRANSIENT_MAX=0` disables all retries cleanly

---

## Rollback

- `MEGACOMPACT_AUTO_RETRY_TRANSIENT_MAX=0` disables all retries (reverts to S28-only)
- `MEGACOMPACT_AUTO_RETRY_PERMANENT_MAX=0` disables permanent error retries
- Full revert: `git revert <commit>` on the S38 commits
