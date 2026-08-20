# Live-Trim & Overflow Recovery — How It Works and How to Validate Fixes

**Status:** authoritative for v0.21.11+. Written after the 2026-08-20 GLM-4.7 32k
truncate-loop incident (7 fix attempts) so that future changes to this path can be
checked against the actual data flow instead of re-derived from scratch.

**Read this before touching anything in** `extensions/mega-events/context-handler/`.

---

## 0. The one-paragraph model

Every turn, pi fires a **context event** carrying the *real session transcript*.
mega-compact's handler decides (the **gate**) whether the session is close enough
to the model's context window **including the output reserve** to justify a trim.
If so, it runs the compaction pipeline (summarize → checkpoint → live-trim view)
and *replaces* the messages pi will send to the provider. The replacement is a
**trim view**: `[summaryAgentMsg, ...tail]`, where the tail is capped so that
`tailTokens + summaryTokens + outputReserve + safetyMargin <= ctxWindow`.
pi's own durable compaction and one-shot overflow recovery run **separately** and
almost never help small-context models — our trim view is the actual safety net.

---

## 1. The pi side (what we do NOT control)

All paths below are in pi-coding-agent's dist (read-only):

| Concern | Location | Behavior |
| --- | --- | --- |
| Context event | `core/extensions/runner.js` `emitContext` (~line 747) | Builds `currentMessages = structuredClone(messages)`; each registered extension's context handler returns `{messages}` which **replaces** `currentMessages` for the next handler. **Extension handlers are the only code that can shrink what the model sees.** |
| Message conversion | `core/messages.js` `convertToLlm` (~line 75) | user/assistant/toolResult messages pass to the provider **verbatim**. Every content block ships: text, thinking, toolCall `name` + full `arguments` JSON, toolResult `output`, role wrappers. **Any token estimator that only reads `content[].text` will massively undercount tool-heavy sessions.** |
| Overflow detection | `agent-session.js` `_checkCompaction` (~line 1510) | On `isRecoverableLength`/`isContextOverflow` errors: sets `willRetry = stopReason !== "stop"`, runs **one-shot** `_runAutoCompaction("overflow", true)` |
| Overflow recovery | `agent-session.js` `_runAutoCompaction` (~line 1595) | Emits `session_before_compact`; on success appends a durable compaction entry (truncates the *pi transcript*, not just the view) and retries. Guarded by a single-use `_overflowRecoveryAttempted` flag — a **second** overflow in the same user turn emits *"Context overflow recovery failed after one compact-and-retry attempt."* The flag resets on user `message_start` (~line 344/386). |
| Recovery no-op condition | `compaction.js` `prepareCompaction` (~line 492) | Returns `undefined` when the last transcript entry is already a compaction **or** there is nothing left to summarize (fewer than 2 cut points / too few tokens). **A session whose recent history is one fat tool-call pair can be *permanently unrecoverable* through pi's durable path** — the trim view is the only working mechanism there. |
| The banner | `agent-session.js` `getContextUsage` (~line 2542) | `estimateContextTokens(this.messages)` over pi's *real* transcript — **never the trimmed view**. The `32k/32k (100%)` meter can stay pegged even when the model is receiving a 10k trim view. Never use the banner to judge whether the trim worked; use `dashboard.json` `diag.liveTrimFires` / provider usage. |

Other extensions in the context chain (audited 2026-08-20): neuralwatt-mcr
(requests undefined for non-MCR models), ithacus (observer-only), pi-btw
(filter-only). None can re-inflate the trimmed view, but **the chain is sequential
and order-dependent** — if a future extension re-adds dropped messages it breaks
everything below.

---

## 2. The mega side (what we control)

### 2.1 Context handler skeleton — `extensions/mega-events/context-handler/context-handler.ts`

Per context event, in order:

1. **TriggerGuard** — per-session token-pressure bookkeeping (`armed`/`ready`).
2. **Gate evaluation** — `evaluateGate` (gateCheck.ts). Fire points, all
   **percent-based** (identical at 32k/200k/1M/5M):
   - fast gate: `effectiveThresholdPct` of window (default 80%)
   - **output-headroom gate** (v0.21.9, `gate.headroomExceeded`): fires when
     `currentTokens + reserveTokens + safetyMargin >= ctxWindow`. This is the
     check that actually matches the provider's budget (vLLM reserves the FULL
     declared `maxTokens`).
   - Phase H one-shots: `forceCompactNextGate` armed by `stopReason:"length"`
     (output-error catch) or explicit manual compact.
3. **Replay cache (D.2)** — if `trimCache` holds a view keyed on
   `rt.lastCheckpointId` and no new turn state requires a fresh pipeline run,
   the cached view is returned. Replay re-caps the tail against the *current*
   window (see 2.4). Keying on `lastCheckpointId` (set on **dedup-only** epochs
   too, v0.21.10 C1) is what makes replay survive restarts.
4. **Thrash guard** (thrashGuard.ts) — blocks a re-fire that would shrink less
   than 2% (`ReductionValidator`) until tokens fall below
   `blocked_until = tokensAtArm + rearmPct × effectiveThreshold`. **Headroom
   trips are exempt** — otherwise a permanently-armed guard (blocked_until can
   exceed the window, see §4) would deadlock a session at the overflow edge.
5. **Debounce (2 s)** — suppresses double-fires on consecutive context events.
   **Headroom trips are exempt** (v0.21.10 C2) because pi's
   400 → compact → retry cycle must see the new view immediately.
6. **invokePipeline** → `runCompact` (summarize) → `persistEpochAndMaintain`
   (store checkpoint, dedup tiers) → **buildLiveTrimView** (liveTrim.ts).

### 2.2 The trim view — `buildLiveTrimView`

1. `computeLiveTrimCut` — finds the cut index; returns `null` (→ no trim, retry
   next event) when the cut would violate the anchor floor (PREVENT-PI-001:
   recent N user messages always kept) or the criticalOver hatch (pct ≥ 90 ||
   pressure ≥ 0.9 allows a deeper cut).
2. Build `[summaryAgentMsg, ...messages.slice(cut)]`.
3. **applyTailCap** (headroom.ts) — the overflow firewall. See below.
4. Cache in `trimCache`, bump `diagLiveTrimFires++`.

### 2.3 The tail cap — `applyTailCap` (headroom.ts)

```
reserveTokens = resolveOutputReserve(window, maxTokens, reservePct)
  - maxTokens wins when 0 < maxTokens <= 0.95 × window   (vLLM reserves it ALL;
    do not "correct" real configs like 32k/20k = 62.5% — that was attempt #6)
  - otherwise clamp(reservePct, 0.1, 0.95) × window       (default 30%;
    covers sentinel junk like maxTokens=1e9/1e38/0)
safetyMargin = ceil(window × safetyMarginPct/100)          (default 5%)
budget = max(1, window − reserveTokens − safetyMargin − summaryTokens)
```

Walk the tail **backwards**, summing per-message estimates until the sum exceeds
`budget`; keep everything newer. Never drop the final message (the agent must
respond). Then advance the start past any leading *orphan* toolResults
(PREVENT-PI-002: never split a toolCall/toolResult pair — the pair drops whole
or not at all). A negative-budget edge is floored at 1 so the cap can never
silently disable itself (pre-v0.21.9 bug).

### 2.4 Replay re-cap — `recapReplayedTail` (headroom.ts)

The replay paths (D.2 in context-handler.ts, D.3 in pipelineRun.ts) return the
cached view verbatim — which would bypass the fire-time tail cap. On a mid-epoch
model switch that *shrinks* the window, the stale view overflows the new model.
`recapReplayedTail` re-runs `applyTailCap` against the **current** window with
the margin stored at fire time (`trimCache.safetyMarginPct`).

### 2.5 The per-message estimator — `estimateAgentMessageBudgetTokens` (headroom.ts)

**This is the function the 2026-08-20 incident proved must count everything
`convertToLlm` ships.** For each content block it counts: `text`, `thinking`,
toolCall `name` + `JSON.stringify(arguments)`, toolResult `output`, plus a small
per-block envelope (len/4 + 1 family, same as `estimateBlockTokens` in
src/tokens.ts). Unknown shapes fall back to serialization length; a pathological
message falls back to text-only estimation in `catch` (never throws on the agent
loop).

Contrast: `messageContentText` (messageText.ts) is **lossy on purpose**
(analytics/display text) and `estimateMessageTokens`/`estimateBlockTokens` in
src/tokens.ts are generic helpers. Using any of *them* for budget arithmetic was
the root cause — a GLM-4.7 assistant message with ~12 kB of toolCall `arguments`
registered as ~77 tokens, a ~30k-token tail passed a ~10.3k budget, the model
overflowed on both the turn and pi's one-shot retry (27k prefix-cache hit proves
the retry resent the same fat tail), and pi then gave up with
"Context overflow recovery failed after one compact-and-retry attempt."
Regression coverage: `headroom.test.ts` §"2026-08-20 incident"
(failing-first reproduced with `dropped=0`).

### 2.6 Budget arithmetic quick reference (GLM-4.7 incident numbers)

```
window 32000 | maxTokens 20000 (real) | margin 5% = 1600 | summary ~100
budget = 32000 − 20000 − 1600 − 100 = 10300 tokens for the WHOLE tail
```

If a future fix "increases" this budget by shrinking the reserve, it reopens the
provider-side overflow. The reserve must equal what the provider actually
reserves, not what we wish it reserved.

---

## 3. How to validate a future fix to this path

1. **Unit**: the change must have a failing-first test in
   `extensions/mega-events/context-handler/*.test.ts` (handler-level) or
   `headroom.test.ts` (pure math). Percent-based invariants: run the same test
   at 32k / 200k / 1M and assert identical *ratios* (see
   "percent-based" tests in headroom.test.ts).
2. **Gate**: `npm run build && npm test && npm run lint &&
   python3 scripts/regression_check.py --all && node scripts/guardrails-scan.mjs`
   — all green. The soft-as-hard file-size gate runs against the previous
   release tag; split sibling files rather than squeezing.
3. **Live**: after `pi update --extensions`, reproduce against a real small-context
   model session. Watch `.pi/mega-compact/dashboard.json`:
   - `diag.headroomTrips` / `diag.liveTrimFires` increment,
   - `session.lastCheckpointId` advances,
   - provider usage shows output no longer truncated at 1 token,
   - no "Context overflow recovery failed" in the pi session.
   Do **not** judge by the banner percentage (it reads the untrimmed transcript).
4. **Negative space**: assert what must NOT happen — trim never drops below the
   anchor floor, never splits a tool pair, never fires inside debounce/thrash
   (except headroom exemptions), replay never exceeds the current window.

---

## 4. Known sharp edges (not yet patched — validate before building on top)

- **Thrash-guard `blocked_until` can exceed the window.** Arming at 32235 with a
  2560 rearm offset stores 34795 > 32000 → permanently armed. Harmless today only
  because headroom fires are exempt; any new non-exempt fire path hits it.
- **pi `prepareCompaction` silently no-ops** when the last transcript entry is a
  compaction or nothing is summarizable — pi's durable overflow recovery can be a
  no-op *and still consume* the one-shot `_overflowRecoveryAttempted` flag.
- **The runtime logger is debug-gated** — `mega-compact.log` has no entries in
  production; `events.log` + `dashboard.json` are the always-on observability.
- **The context chain is order-dependent**: any extension returning unreduced
  messages after ours re-inflates the model input. Re-audit `emitContext`
  registrants after pi upgrades or new extension installs.
- **Estimates are heuristics (len/4 + 1)**, not tokenizer-exact. The safety
  margin (default 5%) absorbs estimate error; shrinking it removes that margin.
