# Max-output-token auto-continue (length stop detection + nudge)

**Date:** 2026-07-18
**Focus:** detect the `Model stopped because it reached the maximum output token limit` error (`stopReason === 'length'`) and auto-continue the agent via the existing, debounced S16 resume-nudge path - no new compaction call, no system-role injection.
**Priority:** P1
**Effort:** S (two small additive edits: a `turn_end` flag-set + an extension to the existing `agent_end` nudge condition, plus one config flag + one `SessionRuntime` field).
**Status:** IMPLEMENTED — code landed + tests green (v0.7.8). See "P2-2 implementation notes" below for what was actually built vs. the original DESIGN.
**Depends on:** S16 continuation-nudge pattern (`extensions/mega-events.ts` `agent_end`), S24 unified pressure, S27 tiered % threshold.

---

## SAFETY PROTOCOLS

- **PREVENT-PI-003 - no system-role injection.** The restart uses `pi.sendUserMessage("[mega-compact] continue from the compacted context above.")` - a `role:"user"` message. It never injects via `role:"system"` and never calls the `before_agent_start` systemPrompt prepend. (The recall path keeps that channel; this change is orthogonal to it.)
- **PREVENT-PI-004 - zero network at runtime.** `pi.sendUserMessage` is fully local (in-process pi runtime). No `fetch`/HTTP. The change adds no I/O beyond the existing dashboard event + `logger.info` already used everywhere else in `mega-events.ts`. Guardrails-scan must stay green.
- **PREVENT-PI spirit - never stop the agent from `turn_end`.** We do NOT call `ctx.compact()` from the length-stop path. The existing `agent_end` durable-trim branch (`idle && overThreshold && now >= debounceUntil`) is unchanged and remains the ONLY place that may call `ctx.compact()`; the length-stop nudge is decoupled from it (see Execution).
- **No busy-loop / idempotent / non-fatal.** The nudge reuses the existing `resumeNudgeUntil` 30s debounce and the `idle` guard, so a truncated turn cannot spur a tight restart loop. The whole `agent_end` inner block is wrapped in `try/catch` already - a failed nudge never blocks. The flag resets after one nudge and is re-armed defensively on `turn_start`.
- **Verify gate (per commit):** `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all` all green.
- **NO FORCE PUSH;** branch + PR only (user-permission gate for push).

---

## PROBLEM STATEMENT

When an assistant turn hits the model's **max output tokens** cap, pi terminates the turn and renders:

> `Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.`

**Verified source (pi):** `assistant-message.ts:109` renders that string **solely** when `message.stopReason === 'length'`. The `pi-ai` `StopReason` union is `'stop' | 'length' | 'toolUse' | 'error' | 'aborted'` (`docs/session-format.md:88`). `'length'` means generation reached the model's `max_tokens` OUTPUT cap - it is **INPUT-orthogonal** to context-window overflow (the `session_compact` reason `'overflow'`). The two must not be conflated: a length stop can occur with plenty of context headroom.

**Current behavior (the gap):**

1. The extension registers `turn_end` (`extensions/mega-events.ts:372`) but only uses `event.turnIndex` for the dashboard + memory auto-review. It **never inspects `event.message.stopReason`**, so it is **silent** on a length stop and does nothing to finish the truncated response.
2. The existing S16 `agent_end` continuation block (`mega-events.ts:250-371`) already has a safe, debounced, idle-checked resume path: it calls `pi.sendUserMessage("[mega-compact] continue …")` when the agent settled idle with queued work or after a durable trim (`resumeNudgeUntil` 30s debounce; `idle` + `queued` + `overThreshold` guards; race-guarded durable trim via `lastNativeCompactAt` cooldown + `piCompactWouldNoop`). That path is exactly the right vehicle for a length-stop restart - but it is **not** wired to length stops today.
3. The "auto-compact-when-pressured" half is **already handled**: the live `context` handler trims the window whenever `lastCtxTokens >= runtime.effectiveThreshold` (S27), and pi's native auto-compaction does the durable trim at `agent_end`. So when a length stop coincides with high pressure, the continuation's next context event trims automatically. We must NOT add a new compact call - reusing the existing pressured-trim path makes the room and the nudge restarts generation.

**Root cause:** the extension never observes `stopReason`, so a recoverable generative cap (finish the thought) is surfaced only as a terminal error instead of an auto-continue.

**Intended behavior:** on `turn_end` with `event.message.stopReason === 'length'`, set a flag; let the existing `agent_end` nudge fire **one** debounced, idle-gated continue when that flag is set; rely on the existing pressured-trim path to make room; reset the flag after the nudge. Users can disable via `MEGACOMPACT_AUTO_CONTINUE_LENGTH_STOP`.

---

## SCOPE BOUNDARY

**IN SCOPE:**

- `extensions/mega-config.ts`: add `autoContinueLengthStop: boolean` to `MegaConfig` + `envBool("MEGACOMPACT_AUTO_CONTINUE_LENGTH_STOP", true)` in `loadConfig()`.
- `extensions/mega-runtime.ts`: add `lengthStopPending: boolean` to `SessionRuntime` + init `false` in the `rt` initializer; re-armed to `false` on `session_start`/fresh `rt` (already reset by the `rt` default initializer).
- `extensions/mega-events.ts` `turn_end`: when `config.autoContinueLengthStop && event.message?.stopReason === 'length'`, set `runtime.rt.lengthStopPending = true` and emit dashboard event `length_stop`.
- `extensions/mega-events.ts` `agent_end`: extend the existing nudge condition to also fire when `config.autoContinueLengthStop && runtime.rt.lengthStopPending`; reset `lengthStopPending = false` after the nudge; emit dashboard `length_stop_continue` + `logger.info("length_stop_continue", …)`.
- Tests: assert the nudge fires **once** for a mocked `stopReason:'length'` and that `pi.sendUserMessage` is called with the continue string; assert no `ctx.compact()` on the length-stop path (debounce respected).

**OUT OF SCOPE (do NOT touch):**

- The Trident pipeline (`compactSession`, `engine.ts`, `extractive.ts`, `supersede.ts`, `boundary.ts`) - cut/anchor logic unchanged.
- Dedup tiers (L0/L1/L2/RAPTOR) and `src/config/dedup.ts`.
- Recall/auto-inline (`recall.ts`, `memoryRecall.ts`) - PREVENT-PI-003 path untouched.
- The S27 live-trim / native auto-compaction logic and the S24 pressure math - reused as-is; this change only *observes* the length stop and *reuses* the nudge.
- The existing `agent_end` durable-trim (`ctx.compact()`) branch - unchanged, still gated on `idle && overThreshold` only.

---

## EXECUTION

### `extensions/mega-config.ts` - new flag

Add to the `MegaConfig` interface (near the other `auto*` flags):

```ts
/** S28: auto-continue the agent after a max-output-token length stop by
 *  reusing the existing S16 resume-nudge. Default true. Off = silent (the
 *  prior behavior). PREVENT-PI-003: restart via user-role sendUserMessage. */
autoContinueLengthStop: boolean;
```

In `loadConfig()` (after `auto`/`autoInline`):

```ts
autoContinueLengthStop: envBool("MEGACOMPACT_AUTO_CONTINUE_LENGTH_STOP", true),
```

### `extensions/mega-runtime.ts` - flag field

In `interface SessionRuntime` (after `cacheHitTokens`):

```ts
lengthStopPending: boolean; // S28: set on turn_end when stopReason==='length'
```

In the `rt` initializer (after `cacheHitTokens: 0`):

```ts
lengthStopPending: false,
```

The field is also covered by the `session_start` re-init at `mega-runtime.ts:887` (the `rt` default object) - so it is cleared on every new session. For extra safety we additionally reset it on `turn_start` (see below).

### `extensions/mega-events.ts` - `turn_end` flag-set

Inside the existing `pi.on("turn_end", …)` handler (currently `mega-events.ts:372`), after the memory-review block and before the closing `});`:

```ts
// S28: detect max-output-token truncation. event.message.stopReason is the
// pi-ai StopReason union; 'length' == generation hit max_tokens OUTPUT cap
// (INPUT-orthogonal to context-window overflow). Arm the agent_end nudge.
if (config.autoContinueLengthStop && event.message?.stopReason === "length") {
  runtime.rt.lengthStopPending = true;
  runtime.dashboard.event("length_stop", { turnIndex: event.turnIndex });
}
```

### `extensions/mega-events.ts` - `agent_end` nudge extension

The nudge block is currently (`mega-events.ts:351`):

```ts
if (idle && now >= runtime.resumeNudgeUntil && (didDurableTrim || queued)) {
  runtime.resumeNudgeUntil = now + 30_000;
  pi.sendUserMessage("[mega-compact] continue from the compacted context above.");
}
```

Extend the condition to include the length-stop flag (gated by the same debounce + `idle`), and reset the flag + emit telemetry after firing:

```ts
const lengthStop = config.autoContinueLengthStop && runtime.rt.lengthStopPending;
if (idle && now >= runtime.resumeNudgeUntil && (didDurableTrim || queued || lengthStop)) {
  runtime.resumeNudgeUntil = now + 30_000;
  if (runtime.rt.lengthStopPending) {
    runtime.rt.lengthStopPending = false; // one-shot: never re-fire for same stop
    runtime.dashboard.event("length_stop_continue", { turnIndex: runtime.currentTurn });
    runtime.logger.info("length_stop_continue", {
      sessionId: runtime.rt.sessionId,
      didDurableTrim,
      queued,
    });
  }
  pi.sendUserMessage("[mega-compact] continue from the compacted context above.");
}
```

**Why this is safe:**

- `idle` guard => no restart mid in-flight turn. On a length stop the turn has ended, `agent_end` fires with `activeAgents === 0`, and `ctx.isIdle?.() ?? true` is true.
- `now >= runtime.resumeNudgeUntil` => 30s debounce; a truncated turn cannot tight-loop.
- `lengthStop` is **independent** of `didDurableTrim`/`queued`: a length stop with low pressure (not `overThreshold`) still nudges to finish the thought, while the existing overThreshold durable-trim branch fires its own `ctx.compact()` when pressure is high. The two paths compose without a new compact call on the length-stop side.
- `ctx.compact()` is **never** called from this branch; it is only reachable inside the `idle && overThreshold && now >= debounceUntil` block above, which is unchanged.

### `extensions/mega-events.ts` - `turn_start` re-arm (defense)

In the existing `turn_start` handler (`mega-events.ts:367`), clear a stale flag so a leftover arm from a prior turn can never carry across a user-driven turn boundary:

```ts
runtime.rt.lengthStopPending = false;
```

(This is belt-and-suspenders; the `agent_end` reset already one-shots it.)

---

## FILES TO CHANGE

| File | Change | Status |
|------|--------|--------|
| `extensions/mega-config.ts` | `MegaConfig.autoContinueLengthStop` + `envBool("MEGACOMPACT_AUTO_CONTINUE_LENGTH_STOP", true)` in `loadConfig()` | design |
| `extensions/mega-runtime.ts` | `SessionRuntime.lengthStopPending: boolean` + init `false` in `rt` | design |
| `extensions/mega-events.ts` | `turn_end`: set flag + `length_stop` dashboard event (gated by `autoContinueLengthStop`) | design |
| `extensions/mega-events.ts` | `agent_end`: extend nudge condition with `lengthStop`; reset flag + `length_stop_continue` telemetry | design |
| `extensions/mega-events.ts` | `turn_start`: re-arm `lengthStopPending = false` | design |
| `extensions/mega-events.test.ts` (new or extend) | mock `stopReason:'length'` -> assert one nudge + `sendUserMessage` called with continue string + no `ctx.compact()` + debounce respected | design |

---

## ACCEPTANCE

1. **Detection.** With `MEGACOMPACT_AUTO_CONTINUE_LENGTH_STOP=true`, a `turn_end` whose `event.message.stopReason === 'length'` sets `runtime.rt.lengthStopPending = true` and emits dashboard event `length_stop`. A `stopReason` of `'stop'`/`'toolUse'`/`'error'`/`'aborted'` leaves the flag unset.
2. **One nudged continue.** The existing `agent_end` fires exactly **one** `pi.sendUserMessage("[mega-compact] continue from the compacted context above.")` when `lengthStopPending && idle && now >= resumeNudgeUntil`; the flag is reset to `false` immediately after, so a second `agent_end` without a new length stop does not re-nudge.
3. **No compaction from the length-stop path.** A length stop with **low** pressure (not `overThreshold`) nudges but does **not** call `ctx.compact()`. (`ctx.compact()` is still reachable only via the unchanged `idle && overThreshold` durable-trim branch.) A length stop with **high** pressure additionally triggers the existing pressured durable-trim, then the nudge restarts - both expected.
4. **Debounce honored.** Two length stops within 30s produce at most one nudge (the second is suppressed by `resumeNudgeUntil`).
5. **Idle gate honored.** If `ctx.isIdle?.()` returns false at `agent_end` (shouldn't happen on a length stop, but defensive), the nudge is withheld until the next eligible `agent_end`.
6. **Disable switch.** `MEGACOMPACT_AUTO_CONTINUE_LENGTH_STOP=false` makes `turn_end` leave the flag unset and the nudge extension inert - fully backward-compatible (prior silent behavior).
7. **Telemetry.** `length_stop` (turn_end) + `length_stop_continue` (agent_end) dashboard events fire; `logger.info("length_stop_continue", …)` is written to `events.log`.
8. **Guardrails + build.** `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all` all green; `scripts/guardrails-scan.mjs` green (no PREVENT-PI-003/004/001/002 violation); no new `fetch`.
9. **Unit test with mock.** A unit test builds a fake `event = { message: { stopReason: 'length' }, turnIndex: n }` and a spy `pi.sendUserMessage`; it asserts the nudge fires once with the continue string, `ctx.compact` is not called, and the flag resets.

---

## ROLLBACK

- **Soft (no code revert):** set `MEGACOMPACT_AUTO_CONTINUE_LENGTH_STOP=false`. The `turn_end` flag-set is gated by this flag, so the extension reverts to the prior silent behavior with zero code change.
- **Hard (code revert):** drop the `turn_end` flag-set + `length_stop` event; revert the `agent_end` nudge condition to `(didDurableTrim || queued)` and remove the `lengthStop` branch + telemetry; remove `runtime.rt.lengthStopPending = false` from `turn_start`; drop `autoContinueLengthStop` from `MegaConfig` + `loadConfig()`; drop `lengthStopPending` from `SessionRuntime` + the `rt` initializer. All changes are small and additive - revert is mechanical and safe.
- The change is **additive + backward-shaped**: the default (`true`) only *adds* an auto-continue where before there was none; disabling it is byte-identical to prior behavior. NO FORCE PUSH; revert/reset via PR only.

---

## P2-2 implementation notes (IMPLEMENTED v0.7.8)

The landed code (`extensions/mega-events.ts`, `extensions/mega-config.ts`, `extensions/mega-runtime.ts`) matches the spec's intent but diverges from the EXECUTION section above in four deliberate ways. This block records the as-built behavior so the spec and the code agree.

1. **`agent_end` outer guard widened.** The continuation block's outer `if` is `(config.auto || config.autoContinueLengthStop) && runtime.activeAgents === 0` (not just `config.auto && …`). This is what lets the length-stop nudge fire when `MEGACOMPACT_AUTO=false` (the second S28 test asserts this): `autoContinueLengthStop` is the SOLE gate for the length-stop path, independent of `auto`.

2. **Durable/queued nudge terms gated on `config.auto`.** The inner nudge condition is `idle && now >= runtime.resumeNudgeUntil && ((config.auto && (didDurableTrim || queued)) || lengthStop)`. The `config.auto &&` wrap on the durable-trim and queued terms ensures that when `auto=false` the ONLY thing that can trip the nudge is `lengthStop` — so disabling `auto` does not silently enable durable-trim/queued nudges. `lengthStop` is `config.autoContinueLengthStop && runtime.rt.lengthStopPending`, so it is inert whenever the flag is false (no spurious nudge).

3. **Branched nudge message.** When `lengthStop && !didDurableTrim` the nudge text is `[mega-compact] the last response hit the output-token cap; continue from where it stopped.`; otherwise it is the existing `[mega-compact] continue from the compacted context above.` This branches so a length-stop nudge never claims a compaction that did not occur. When BOTH a durable trim and a length stop happened, the durable-trim message wins (a compaction DID occur) — `lengthStop && !didDurableTrim` is false → "compacted context". This is correct.

4. **`turn_start` re-arm.** `runtime.rt.lengthStopPending = false` runs defensively at the top of every `turn_start` (belt-and-suspenders; the `agent_end` one-shot reset already clears it).

**Telemetry:** `turn_end` emits dashboard event `length_stop`; `agent_end` emits `length_stop_continue` + `logger.info("length_stop_continue", …)`. Both are written to `<stateDir>/events.log` as JSONL via `Dashboard.event` (`extensions/mega-dashboard.ts`).

**Tests** (`extensions/mega-compact.test.ts`): "S28: length-stop auto-continue nudges once, no ctx.compact on low-pressure length path" (normal-stop no-nudge + length-stop exactly one nudge matching `/output-token cap/` + `compactCalls.length === 0` + one-shot); "S28: length-stop auto-continue fires even when config.auto === false"; plus dashboard-event + non-`"length"`-stopReason assertions added in the v0.7.8 audit pass (OPEN issue #3).

**Relationship to S29 (v0.7.8):** S28 is the *reactive* recovery (finish a truncated turn). S29 (percent-based auto-compact trigger) is the *preventive* fix that compacts before the context reaches 100% so the length stop becomes rare. The two compose: S29 shrinks the working set on pressure; S28 nudges the agent to continue if a length stop still occurs.
