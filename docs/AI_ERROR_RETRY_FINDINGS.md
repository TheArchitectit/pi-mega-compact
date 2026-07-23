# AI Error Retry Findings (S38)

**Status**: IMPLEMENTED (6 test failures pending)
**Branch**: `output-error-work`
**Commit**: `ca1ba60` — feat(error-retry): S38 error-retry safety net + circuit breaker
**Date**: 2025-07-22

---

## 1. What Was Implemented (S38.1–S38.9)

### S38.1 — Config + Runtime State
**Files**: `extensions/mega-config.ts`, `extensions/mega-runtime/state.ts`

Added configuration and runtime state for error-retry handling:

| Config Field | Env Var | Default | Description |
|--------------|---------|---------|-------------|
| `autoRetryTransientMax` | `MEGACOMPACT_AUTO_RETRY_TRANSIENT_MAX` | `5` | Max retries for transient errors |
| `autoRetryPermanentMax` | `MEGACOMPACT_AUTO_RETRY_PERMANENT_MAX` | `1` | Max retries for permanent errors |
| `maxConsecutiveErrors` | `MEGACOMPACT_MAX_CONSECUTIVE_ERRORS` | `10` | Circuit-breaker threshold |
| `errorRetryHardStop` | `MEGACOMPACT_ERROR_RETRY_HARD_STOP` | `false` | Disable all retries |
| `raceGuardStrict` | `MEGACOMPACT_RACE_GUARD_STRICT` | `true` | 30s cooldown + deferred re-check |

Runtime state additions:
- `errorRetryCount: number` — consecutive error count, reset on success
- `errorRetryUntil: number` — wall-clock debounce for retry nudge
- `consecutiveErrors: number` — circuit-breaker counter

### S38.2 — Error Classifier
**File**: `extensions/mega-events/error-classifier.ts` (87 lines)

New module with two exports:

```typescript
export function classifyError(message: unknown):
  | 'transient'
  | 'permanent'
  | 'compaction-noop'
  | null

export function errorRetryBackoffMs(count: number): number
```

Classification logic:

| Signal Pattern | Category | Notes |
|----------------|----------|-------|
| `stopReason === 'length'` | `null` | S28 handles exclusively |
| `stopReason === 'stop' \|\| 'toolUse'` | `null` | Success, no retry |
| `stopReason === 'error' \|\| 'aborted'` | `'transient'` | Generic pi error |
| `/max(imum)? output token/` | `'transient'` | Output token limit text |
| `/rate.?limit\|429/` | `'transient'` | Rate limiting |
| `/5xx\|internal server/` | `'transient'` | Server errors |
| `/network\|timeout/` | `'transient'` | Network issues |
| `/auth\|unauthorized/` | `'permanent'` | Auth failure |
| `/invalid request\|malformed/` | `'permanent'` | Config error |
| `/already compacted/` | `'compaction-noop'` | NOT retryable — re-throw |
| `/nothing to compact/` | `'compaction-noop'` | NOT retryable — re-throw |
| `/compaction failed/` | `'compaction-noop'` | NOT retryable — re-throw |

Backoff schedule: `5s → 10s → 20s → 30s (cap)`

### S38.3 — Tests
**File**: `extensions/mega-compact.test.ts` (189 lines added)

14 new test cases added:
1. `classifyError` returns `'transient'` for error/aborted stopReasons
2. `classifyError` returns `'transient'` for max-output-token text
3. `classifyError` returns `'permanent'` for auth/unauthorized text
4. `classifyError` returns `null` for stop/toolUse stopReasons
5. `classifyError` returns `null` for `'length'` stopReason (S28 guard)
6. `classifyError` returns `'compaction-noop'` for "Already compacted" text
7. `classifyError` returns `'compaction-noop'` for "Nothing to compact" text
8. `classifyError` returns `'compaction-noop'` for "Auto compaction failed" text
9. `compaction-noop` logs `'compaction_noop_diagnostic'` and resets counter
10. `compaction-noop` does NOT fire `pi.sendUserMessage()` (not retryable)
11. Retry fires up to max (5) for transient errors
12. Retry fires 1x for permanent errors then stops
13. Successful turn resets retry counter
14. `error_retry_exhausted` event logged when max exceeded

### S38.4 — CHANGELOG Entry
**File**: `CHANGELOG.md`

Entry added for v0.8.15 documenting S38 features.

### S38.5 — Strengthen Race Guard
**Files**: `extensions/mega-events/agent-handlers.ts`, `extensions/mega-events/context-handler.ts`

Changes:
1. **Cooldown 10s → 30s** in both call sites to prevent back-to-back compaction races
2. **Deferred `ctx.compact()` with re-check** to close first-race-in-burst window
3. **Rollback env**: `MEGACOMPACT_RACE_GUARD_STRICT=false` reverts to v0.7.4 behavior

### S38.6 — Circuit Breaker
**Files**: `extensions/mega-config.ts`, `extensions/mega-events/agent-handlers.ts`

New runtime counter `consecutiveErrors` tracks errors across turns:
- Incremented on every error
- Reset to 0 on successful `turn_end`
- When `consecutiveErrors > maxConsecutiveErrors`, circuit opens and stops retrying
- Dashboard event: `error_retry_circuit_open`

### S38.7 — Hard-Stop Switch
**Env**: `MEGACOMPACT_ERROR_RETRY_HARD_STOP=true`

When set, bypasses ALL retry logic — reverts to S28-only behavior (length-stop continues only).

### S38.8 — Retries Dashboard Tile
**File**: `extensions/mega-dashboard.ts`

Dashboard now displays retry metrics in the status tile.

### S38.9 — Preflight Env Validation
**File**: `extensions/mega-runtime/helpers.ts`

Validates config at startup for invalid combinations.

---

## 2. Current Test Status

### Summary
- **Total**: 614 tests passed, 6 failed across 57 files
- **Failed File**: `dist/extensions/mega-compact.test.js` (46 pass / 6 fail)

### Failing Tests (6)

| Test # | Name | Status |
|--------|------|--------|
| 1 | `auto-trigger (legacy): past threshold persists a chkpt and starts a durable trim via ctx.compact` | FAIL |
| 30 | `S28: non-length stopReasons do not arm the flag (no nudge, no length_stop event)` | FAIL |
| 45 | `S38: retry fires up to max (5) for transient errors, then stops` | FAIL |

*(3 additional failures in same file — exit-hung state may mask names)*

### Test Command Output
```
✗ dist/extensions/mega-compact.test.js  (46 pass / 6 fail, 17.0s)
  not ok 1 - auto-trigger (legacy): past threshold persists a chkpt and starts a durable trim via ctx.compact
  not ok 30 - S28: non-length stopReasons do not arm the flag (no nudge, no length_stop event)
  not ok 45 - S38: retry fires up to max (5) for transient errors, then stops
```

---

## 3. What Needs Investigation

### Priority 1: S38 Test Failure (Test 45)
**Issue**: `S38: retry fires up to max (5) for transient errors, then stops` is failing.

**Hypothesis**: The test mock may not be correctly simulating consecutive error `turn_end` events with the correct `stopReason: 'error'`. Need to verify:
1. Test mock correctly increments `errorRetryCount`
2. `classifyError()` returns `'transient'` for the test message
3. Backoff debounce (`errorRetryUntil`) is not blocking the test's rapid fire
4. Circuit breaker (`consecutiveErrors`) is not tripping prematurely

**Files to check**:
- `extensions/mega-compact.test.ts` lines for S38 retry test
- `extensions/mega-events/agent-handlers.ts` `turn_end` handler

### Priority 2: S28 Regression (Test 30)
**Issue**: `S28: non-length stopReasons do not arm the flag (no nudge, no length_stop event)` is failing.

**Hypothesis**: S38's `turn_end` handler changes may have affected the S28 `lengthStopPending` logic. The S38 classifier is called BEFORE the S28 check in some branches. Need to verify:
1. S28 `lengthStopPending` is still armed correctly for `stopReason === 'length'`
2. S38 classifier returns `null` for `stopReason === 'length'` (it should)
3. No unintended side-effects from S38's `errorRetryCount` reset on success

**Files to check**:
- `extensions/mega-events/agent-handlers.ts` `turn_end` handler (lines 310–380)
- `extensions/mega-compact.test.ts` S28 test cases

### Priority 3: Legacy Test Regression (Test 1)
**Issue**: `auto-trigger (legacy): past threshold persists a chkpt and starts a durable trim via ctx.compact` is failing.

**Hypothesis**: S38.5's 30s cooldown change may have affected the timing of `agent_end` durable-trim trigger. The test may expect a synchronous `ctx.compact()` call but now sees deferred behavior.

**Files to check**:
- `extensions/mega-events/agent-handlers.ts` `agent_end` handler (lines ~100–160)
- `extensions/mega-compact.test.ts` legacy auto-trigger test

### Priority 4: Exit-Hung Tests
**Issue**: Several tests show `exit-hung(tests passed)` in the output.

**Hypothesis**: Tests may have dangling timers, event listeners, or async operations that prevent clean exit. Common causes:
1. `setTimeout` / `setInterval` not cleared in tests
2. Dashboard server not shutting down cleanly
3. Test harness (`scripts/run-tests.mjs`) not forcing exit after timeout

**Files to check**:
- `extensions/mega-compact.test.ts` teardown logic
- `scripts/run-tests.mjs` timeout handling

---

## 4. Key Code Locations

### Core Implementation

| File | Purpose | Lines |
|------|---------|-------|
| `extensions/mega-events/error-classifier.ts` | Error classification logic | 1–88 |
| `extensions/mega-events/agent-handlers.ts` | `turn_end` handler with retry logic | 310–380 |
| `extensions/mega-config.ts` | Config interface + defaults | 70–100 |
| `extensions/mega-runtime/state.ts` | Runtime state interface | 30–50 |

### Sprint Spec
| File | Purpose |
|------|---------|
| `docs/specs/s38-error-retry.md` | Full sprint specification (224 lines) |

### Tests
| File | Purpose |
|------|---------|
| `extensions/mega-compact.test.ts` | Unit tests for S28 + S38 behavior |

### Configuration Reference

```typescript
// MegaConfig additions (S38)
autoRetryTransientMax: number;      // default 5
autoRetryPermanentMax: number;      // default 1
maxConsecutiveErrors: number;        // default 10
errorRetryHardStop: boolean;         // default false
raceGuardStrict: boolean;           // default true

// SessionRuntime additions (S38)
errorRetryCount: number;             // reset on success
errorRetryUntil: number;             // debounce wall-clock ms
consecutiveErrors: number;          // circuit-breaker counter
```

---

## 5. Architecture Flow

```
turn_end event
  ├── stopReason === 'length'
  │   └── S28 path (unchanged) → arm lengthStopPending
  │
  └── other stopReason
      │
      ├── classifyError(message)
      │   ├── 'length' → null (S28 guard)
      │   ├── 'stop' / 'toolUse' → null (success)
      │   ├── 'error' / 'aborted' → 'transient'
      │   ├── 'compaction-noop' text → 'compaction-noop'
      │   └── unknown → null
      │
      ├── category === null
      │   └── Reset errorRetryCount, consecutiveErrors → done
      │
      ├── category === 'compaction-noop'
      │   ├── Log 'compaction_noop_diagnostic'
      │   ├── Reset counters
      │   └── Surface error (NO retry)
      │
      └── category in ['transient', 'permanent']
          │
          ├── Hard-stop enabled? → skip
          │
          ├── Circuit open? → skip
          │
          ├── Increment counters
          │   ├── Over max? → log 'error_retry_exhausted', reset
          │   └── Under max?
          │       ├── Check debounce
          │       ├── Set backoff
          │       ├── Log 'error_retry'
          │       └── pi.sendUserMessage('[mega-compact] the last turn ended with an error; please retry.')
```

---

## 6. Next Steps

1. **Fix S38 retry test (Test 45)** — Verify mock setup and debounce behavior
2. **Fix S28 regression (Test 30)** — Ensure `lengthStopPending` still armed correctly
3. **Fix legacy auto-trigger (Test 1)** — Investigate 30s cooldown timing impact
4. **Address exit-hung tests** — Add proper teardown or force-exit in test harness
5. **Run full gate**: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all && node scripts/guardrails-scan.mjs`
6. **Re-commit** after tests pass

---

## 7. References

- Sprint Spec: `docs/specs/s38-error-retry.md`
- Commit: `ca1ba60360c8a5e0927bc9864a54e185027fadc7`
- Parent Branch: `game-mode` (v0.8.14)
- CHANGELOG: `CHANGELOG.md` (S38 entry)
