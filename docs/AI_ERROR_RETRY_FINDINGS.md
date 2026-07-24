# AI Error Retry Findings (S38)

**Status**: IMPLEMENTED — all failing tests resolved, gate green
**Branch**: `output-error-work`
**Commit**: `ca1ba60` — feat(error-retry): S38 error-retry safety net + circuit breaker
**Date**: 2025-07-22 (original); corrected/resolved 2026-07-23

> **Correction note (2026-07-23):** the original audit below stated "614 passed /
> 6 failed." Re-running the gate fresh showed the real count was **5 failing tests**
> (the parallel `npm test` runner masked 3 via `exit-hung` states). Section 2 now
> records the authoritative failure set and how each was resolved.

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

> **Correction (2026-07-23):** the original commit only applied S38.5 to the
> *legacy* `context` path in `context-handler.ts` (which is disabled by default).
> The production `agent_end` durable-trim path still had the old 10s synchronous
> guard and read the stale `runtime.lastCtxTokens` (only set by the `context`
> event), so the race window S38.5 was written to close was still open. This has
> been fixed: the `agent_end` handler now reads live pressure from
> `ctx.getContextUsage()`, widens the cooldown to `raceGuardStrict ? 30_000 : 10_000`,
> and defers `ctx.compact()` via `setTimeout(500)` with a session-id + stamp
> re-check (mirroring `context-handler.ts:258-287`). Both call sites are now in
> sync. S38.5 tests 50/51 exercise this path (with `MEGACOMPACT_DURABLE_TRIM_FLOOR=0`
> so the tiny mock transcript clears `piCompactWouldNoop()`).

Changes:
1. **Cooldown 10s → 30s** in both call sites to prevent back-to-back compaction races
2. **Deferred `ctx.compact()` with re-check** to close first-race-in-burst window
3. **Rollback env**: `MEGACOMPACT_RACE_GUARD_STRICT=false` reverts to v0.7.4 behavior
4. **Live pressure read**: `agent_end` now reads `ctx.getContextUsage()` (not the
   stale `lastCtxTokens`) so the durable-trim branch is reachable on a standalone
   `agent_end` (e.g. a sub-agent settling without a preceding `context` event).

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
**Files**: `extensions/mega-dashboard.ts` (type), `extensions/mega-runtime/state.ts` (population)

> **Correction (2026-07-23):** the original commit only declared the `retries?`
> field on `DashboardSnapshot`; `MegaRuntime.snapshot()` never populated it, so
> the tile was effectively dead (only the event stream carried retry data).
> `snapshot()` now writes the `retries` block from runtime + config state.

Dashboard now displays retry metrics (`errorRetryCount`, `consecutiveErrors`,
`maxConsecutiveErrors`, `errorRetryHardStop`) in the status tile.

### S38.9 — Preflight Env Validation
**File**: `extensions/mega-compact.ts` (lines 41–54)

> **Correction (2026-07-23):** the original doc located S38.9 in
> `extensions/mega-runtime/helpers.ts`; it actually lives in
> `extensions/mega-compact.ts:41-54`.

Validates config at startup for invalid combinations.

### S38.10 — Mid-Response Error Detection (stream died without stopReason)
**File**: `extensions/mega-events/error-classifier.ts`

Added 2026-07-23 to catch the failure mode where a model provider dies
mid-stream and `turn_end` fires with **no `stopReason`** (undefined or empty
string) and no error text. The original classifier returned `null` (success) for
these, so the agent silently stopped with no retry.

Two enhancements to `classifyError`:

1. **Error-object message extraction** — `{ error: { message: "…" } }` (the shape
   pi surfaces for provider stream failures) now extracts the `.message` string
   for pattern matching instead of `JSON.stringify`-ing the object (which never
   matched the transient patterns).

2. **No-stopReason = transient (mid-stream death)** — when `stopReason` is falsy,
   the classifier returns `'transient'` instead of `null`, **regardless of whether
   partial content was emitted**. This is the key fix for the post-resume
   disconnect scenario: a provider that streams partial text then dies mid-stream
   leaves `turn_end` with `content` populated but `stopReason` undefined. The
   earlier guard only fired when `parts.length === 0` (empty message), so the
   partial-content case fell through to `null` (treated as success, not retried).
   A genuinely successful turn ALWAYS carries `stop`/`tool_use`/`toolUse` (which
   short-circuit to `null` at the top of the function), so any message reaching
   the classifier body with a falsy `stopReason` is a stream failure → retryable.

3. **Stream-interruption patterns** — added `stream (interrupted|closed|ended|failed)`
   and `disconnected` to the transient regex set so provider errors that name
   the stream explicitly are classified as retryable.

> **Audit (2026-07-23):** a 5-dimension haiku-agent workflow
> (`audit-resume-disconnect-retry`) traced the resume → disconnect → retry flow
> and adversarially verified each finding. Conclusions:
> - **Partial-content + no-stopReason was a real gap** (Shape 6) — the
>   `parts.length === 0` guard missed it; fixed by widening to `!sr`.
> - **The post-resume `already compacted` race is NOT a blocker in the default
>   config** — the S38.5 strict guard's `setTimeout(500)` + stamp re-check
>   catches it when `raceGuardStrict=true` (default). Only `raceGuardStrict=false`
>   reopens the window. No fix needed.
> - **`resetRuntime` on resume is NOT a flaw** — the same-session guard
>   (state.ts:820) preserves S38 state when resuming the live session that
>   already persisted checkpoints. Refuted as false-alarm.
> - **Counter bounds hold** — `errorRetryCount` resets per `turn_start` (so the
>   "max 5" is per-turn); the cross-turn backstop is `consecutiveErrors >
>   maxConsecutiveErrors` (default 10), reset on a successful `turn_end`. Bounded,
>   not unbounded.

Verified by 6 new S38 tests (classifier-level) + 2 integration tests that fire
`turn_end` through the real extension and assert a retry nudge fires.

---

## 2. Test File Split (2026-07-23)

The extension test suite hung for ~40 minutes when `closeVectorIndex()`
(`src/store/vectorIndex.ts`) stalled on a PGlite WASM worker that never
settled — `node --test` blocks on the open handle and never flushes its summary.
Two fixes:

1. **Timeout race on cleanup** — every `cleanup` test now wraps
   `closeVectorIndex()` in `Promise.race([…, setTimeout(3000)])` so a stalled
   WASM close cannot block the suite. Applied to `mega-compact.test.ts`,
   `mega-compact-s38.test.ts`, and `mega-teamrun.test.ts`.

2. **S38 tests extracted** into a focused, fast-isolated file:
   `extensions/mega-compact-s38.test.ts` (308 lines, 24 tests, ~4s standalone).
   The S38 classifier + retry + race-guard tests no longer share a process with
   the heavier auto-trigger / dashboard / game-mode tests. The original
   `mega-compact.test.ts` retains the auto-trigger / recall / S28 / S29 / S24
   / monitoring / game-mode tests.

3. **`scripts/run-tests.mjs`** — added `--test-force-exit` to the per-file
   `node --test` invocation as a belt-and-suspenders guard against open handles.

The full gate now runs in ~35s (was effectively infinite).

---

## 2. Current Test Status

### Summary (corrected 2026-07-23)
- **Authoritative failure count: 5** (the original "6" included 3 tests masked as
  `exit-hung(tests passed)` by the parallel `npm test` runner — they were real
  failures surfaced only by `node --test dist/extensions/mega-compact.test.js`).
- **All 5 now resolved.** Full gate (`npm test`) is green; `node --test` on
  `mega-compact.test.js` reports 52 pass / 0 fail.

### Failing Tests (5) — and how each was resolved

| Test # | Name | Root cause | Resolution |
|--------|------|-----------|------------|
| 1 | `auto-trigger (legacy): past threshold persists a chkpt…` | S38.5 defers `ctx.compact()` via setTimeout; test asserted a synchronous call | Test now awaits the deferred callback (`setTimeout(700)`) before asserting `compactCalls.length === 1` |
| 30 | `S28: non-length stopReasons do not arm the flag` | Behavioral conflict: S38 retries `error`/`aborted`, but the S28 test asserted zero nudges for them | Test rewritten — `tool_use` asserts 0 nudges; `error`/`aborted` assert 1 transient retry each (S38 owns them). Keeps the no-`length_stop` assertion |
| 45 | `S38: retry fires up to max (5)…` | Backoff debounce (`errorRetryUntil`) suppressed turns 2-5 → only 1 nudge | Removed the per-nudge debounce gate; each error turn now fires its nudge immediately, capped by `max` + the circuit breaker |
| 47 | `S38: successful turn resets the retry counter` | Cascade of #45 (same debounce) | Fixed by #45 |
| 50, 51 | `S38.5: …race guard…` (strict + non-strict) | S38.5 was only on the disabled legacy path; `agent_end` used the 10s sync guard and stale `lastCtxTokens` → durable-trim branch unreachable + `piCompactWouldNoop` skipped the tiny mock session | Ported S38.5 to `agent_end` (live `ctx.getContextUsage()` read, 30s cooldown, deferred re-check); tests set `MEGACOMPACT_DURABLE_TRIM_FLOOR=0` so the mock transcript clears the noop floor |

### Verification
```
node --test dist/extensions/mega-compact.test.js   → 52 pass / 0 fail
npm test                                            → full suite green
```

### Environmental note: zstd
`src/store/compression.test.js` previously failed the zstd roundtrip because npm
blocked the `@mongodb-js/zstd` native install script (no `build/Release/zstd.node`).
This is **not an S38 / code defect** — the test explicitly asserts graceful load
without the addon. Approving + rebuilding the native addon (`npm install-scripts
approve @mongodb-js/zstd && npm rebuild @mongodb-js/zstd`) makes the test pass.

---

## 3. Investigation Findings (resolved)

The four original investigation priorities were all confirmed and fixed. Notes
for the record:

- **S38 retry-max (was test 45):** the debounce gate (`now >= errorRetryUntil`)
  suppressed turns 2-5 under rapid fire. Decision: the per-turn `max` cap plus the
  session circuit breaker (`consecutiveErrors > maxConsecutiveErrors`) already
  bound a tight turn_end storm, so the debounce was removed. `errorRetryUntil`
  and `errorRetryBackoffMs()` are retained on the runtime/export for future
  optional pacing but are no longer gating.
- **S28 regression (was test 30):** genuine behavioral conflict, not a bug. S38
  deliberately classifies `error`/`aborted` as transient and retries them; the
  S28 test's zero-nudge assertion for those stopReasons was stale. Decision: S38
  owns `error`/`aborted`; the S28 test now only asserts the length-stop flag is
  not armed (its actual concern).
- **Legacy auto-trigger (was test 1):** correctly diagnosed — the S38.5 defer
  moved the `ctx.compact()` call off the synchronous path. Test awaits the timer.
- **Exit-hung tests:** these are pre-existing resource-cleanup notes (PGlite WASM
  worker / pending timers), not failures. `scripts/run-tests.mjs` already forces
  exit after a grace window. They mask *real* failures only when a test file
  exits non-zero *and* hangs — which is exactly why the parallel runner reported
  "2 failed" while the true count was 5. Running `node --test` per file is the
  reliable signal.

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
          │       ├── Log 'error_retry'
          │       └── pi.sendUserMessage('[mega-compact] the last turn ended with an error; please retry.')
```

> **Note:** the per-nudge debounce (`errorRetryUntil` / backoff window) was
> **removed** — it suppressed turns 2..max on a fast-erroring provider. Each error
> turn now fires its nudge immediately; the `max` cap and the session circuit
> breaker bound the loop. `errorRetryBackoffMs()` remains exported for
> optional/future use.

---

## 6. Status

All five failing tests are resolved and the full gate is green:

```
npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all
```

Remaining before release as v0.8.15:
- Package version bumped `0.8.14 → 0.8.15` (`package.json`).
- Open the PR upstream (push to a fork) — pending maintainer action.

---

## 7. References

- Sprint Spec: `docs/specs/s38-error-retry.md`
- Commit: `ca1ba60360c8a5e0927bc9864a54e185027fadc7`
- Parent Branch: `game-mode` (v0.8.14)
- CHANGELOG: `CHANGELOG.md` (S38 entry)
