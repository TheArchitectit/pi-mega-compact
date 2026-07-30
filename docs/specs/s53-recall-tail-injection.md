# S53 — Recall Tail Injection (Prefix-Preserving Recall)

**Date:** 2026-07-29
**Branch:** `feature/promptcache-stats`
**Priority:** P0 (each `/mega-recall` costs two full-context cache misses today)
**Status:** Draft — designed from external audit finding #2, verified against source
**Effort:** M (≈1 day, single sub-sprint series A/B)
**Depends on:** promptcache-stats sub-sprint D recommended first (replay/debounce ordering —
S53's tail injection composes with the replay view; landing D first keeps the interaction simple)
**Audit source:** external review, verified at `session-handlers.ts:149-179`

---

## SAFETY PROTOCOLS

- **PREVENT-PI-001** (anchor floor): tail injection appends; it never drops messages. ✅
- **PREVENT-PI-002** (tool pairs): the recall message is appended at the very END of the view,
  after the last transcript message — it can never split a toolCall/toolResult pair. ✅
- **PREVENT-PI-003** (no system role): the recall block rides as a **user-role view message**,
  never `role:"system"`. The systemPrompt prepend is *removed* (flag ON) — this sprint makes the
  system prompt MORE static, which is the entire point. Note: PI-003's sanction of the
  `before_agent_start` prepend exists because pi forbids mid-conversation system messages; the
  `context` event view is an equally sanctioned extension mechanism (it is how live trim works).
- **PREVENT-PI-004**: no network. View-only change. ✅
- **Feature flag**: `MEGACOMPACT_RECALL_TAIL_INJECT` (default ON). Flag OFF = legacy
  `before_agent_start` systemPrompt prepend, byte-identical to pre-sprint behavior.
- **Non-fatal**: any failure in view augmentation returns the unmodified view.
- **Gate:** `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`.

---

## PROBLEM

`/mega-recall` and resume-recall stage `runtime.pendingRecallBlock` /
`runtime.pendingMemoryRecallBlock`. At the next `before_agent_start`
(`session-handlers.ts:172-178`):

```typescript
const composed = [cpBlock, memBlock].filter(Boolean).join("\n\n");
return { systemPrompt: `${event.systemPrompt}\n\n${composed}` };
```

The blocks are consumed (set `undefined`) in the same handler — so the system prompt changes for
**exactly one agent run, then reverts**.

The system prompt is byte zero of the provider cache prefix. Consequence:

| Turn | Prompt shape | Cache result |
| ---- | ------------ | ------------ |
| N (recall fired) | `[SP+recall, ...T]` | **full miss** — SP bytes changed |
| N+1 (reverted) | `[SP, ...T']` | **full miss** — SP bytes changed back |

Two full-context misses per recall, at full input price. On a 40K-token context that's ~80K
uncached tokens per `/mega-recall`.

## FIX

Inject the composed block as a **user-role message at the tail of the context view**
(append-only), pinned for the whole turn, consumed at `turn_end`.

| Turn | Prompt shape | Cache result |
| ---- | ------------ | ------------ |
| N (recall) | `[SP, ...T, recallMsg]` | **hit** on `[SP, ...T]`; only tail is new |
| N (tool loop) | `[SP, ...T, recallMsg, asst, toolResult]` | **hit** on `[SP, ...T, recallMsg]` — the pin keeps the recall position stable |
| N+1 (consumed) | `[SP, ...T, recallMsg?]`→ absent; transcript grew | **hit** on `[SP, ...T]` — longest-common-prefix match against turn N's prompt |

Append-only growth on both transitions; the stable prefix is never invalidated.

---

## SCOPE

### IN SCOPE

| File | Change | Est. lines |
| ---- | ------ | ---------- |
| `extensions/mega-events/context-handler.ts` | `withRecallTail()` helper + wire into all three view-return paths + new early inject path | +55 |
| `extensions/mega-events/session-handlers.ts` | Gate the systemPrompt prepend behind flag-OFF; keep rewind-intent consumption + `captureModel` unconditional | −8/+10 |
| `extensions/mega-events/agent-handlers.ts` | Consume staged blocks at `turn_end` **only if injected this turn** | +12 |
| `extensions/mega-runtime/runtime.ts` | `recallInjectedThisTurn: boolean` field; update `pendingRecallBlock` doc comments (consumed at turn_end, not before_agent_start) | +6 |
| `extensions/mega-config.ts` | `recallTailInject: boolean` (env `MEGACOMPACT_RECALL_TAIL_INJECT`, default `true`) | +4 |
| `extensions/mega-commands.ts` | Notify text: "(injected at the next turn via system prompt)" → "(injected at the tail of the next turn's context)" | +2 |
| `tests/` (context-handler + session-handler tests) | see Testing | +180 |

### OUT OF SCOPE

- Persisting recall content into the transcript (view-only, same as today's prepend semantics).
- Reordering recall content for relevance weighting (PLAN_V2 striping territory).
- Memory-recall UX changes beyond the same tail mechanism (`pendingMemoryRecallBlock` rides the
  same composed block, as today).
- The other audit items (DB-mirror high-water mark, as-built pass) — see
  `docs/specs/sprint-promptcache-stats.md` §Future Work.

---

## DESIGN

### Where injection lands (context-handler.ts)

The `context` handler has three view-return paths plus skip paths. The helper:

```typescript
/**
 * S53: append the staged recall/memory block as a user-role tail message.
 * View-only: never written to raw_transcript (the dbMirror append at :172-183
 * runs on the real transcript BEFORE any view is built) and never persisted.
 * PREVENT-PI-002: appended after the last message — cannot split a tool pair.
 * Non-fatal: any failure returns the view unchanged.
 */
function withRecallTail(
  runtime: MegaRuntime,
  messages: AgentMessage[],
): AgentMessage[] {
  const cpBlock = runtime.pendingRecallBlock;
  const memBlock = runtime.pendingMemoryRecallBlock;
  if (!cpBlock && !memBlock) return messages;
  const composed = [cpBlock, memBlock].filter(Boolean).join("\n\n");
  runtime.recallInjectedThisTurn = true; // consumed at turn_end (agent-handlers)
  return [
    ...messages,
    {
      role: "user",
      content: composed,
      // Stable per-turn timestamp (NOT Date.now()) so replays within the turn
      // are byte-identical — mirrors the v0.8.6 summaryAgentMsg rationale.
      timestamp: runtime.perfTurnStart ?? Date.now(),
    } as unknown as AgentMessage,
  ];
}
```

**Wiring — three existing view paths** (apply `withRecallTail(runtime, ...)` to the returned
array at each):

1. Replay path (:255): `return { messages: withRecallTail(runtime, [{ ...trimCache.summaryAgentMsg }, ...recent]) }`
   — recall tail composes with the replay cache; the replayed prefix bytes are unchanged.
2. Fresh compaction path (:483): same wrapper.
3. *(post-D)* Skip-fallback replay paths: same wrapper.

**New early path — recall pending but no trim action:**

Today, recall injection is independent of `config.auto` (the prepend fires at
`before_agent_start` regardless). Parity requires the tail injection to fire even when the
context handler takes no compaction action. Insert immediately after the stats/snapshot block
(~:164), BEFORE `if (!config.auto) return;`:

```typescript
// S53: recall pending → return the full transcript + recall tail even when no
// trim fires (auto off, below threshold). Prefix = last turn's transcript →
// cache hit; only the tail is new. Not debounced (this is not compaction work).
if (config.recallTailInject &&
    (runtime.pendingRecallBlock || runtime.pendingMemoryRecallBlock)) {
  return { messages: withRecallTail(runtime, messages) };
}
```

Wait — one subtlety: this early path returns a view for EVERY context event while blocks are
staged, including when compaction would also fire. Resolution: place the early path so it only
short-circuits when the handler would otherwise return nothing (auto off / below threshold). When
the trim path proceeds, paths 1–2 apply the tail to the trimmed view instead. Implementation
detail: compute `hasRecall` once; use it in the early return only when the handler would
otherwise `return;` with no view. (In code: the early block sits after the auto/threshold gates
decide "no action", not before them — the gates run first, and every gate's bare `return;`
becomes `return { messages: withRecallTail(runtime, messages) }` when recall is pending.)

### Turn-scoped consumption (agent-handlers.ts)

Blocks must persist across ALL context events of a turn (tool loops), then clear:

```typescript
pi.on("turn_end", async (event, ctx) => {
  // ... existing handlers ...
  // S53: consume staged recall blocks ONLY if they were actually injected into
  // a view this turn. If no context event fired (edge: turn ended before any
  // LLM call), keep them staged so the next turn's first context event injects.
  if (config.recallTailInject && runtime.recallInjectedThisTurn) {
    runtime.pendingRecallBlock = undefined;
    runtime.pendingMemoryRecallBlock = undefined;
    runtime.recallInjectedThisTurn = false;
  }
});
```

`recallInjectedThisTurn` is set by `withRecallTail` on first injection and also reset at
`session_start` / `resetRuntime`.

### Legacy path (flag OFF)

`session-handlers.ts:172-178` keeps the existing prepend, gated:

```typescript
if (!config.recallTailInject) {
  // ... existing consume + systemPrompt prepend, unchanged (byte-identical) ...
  return { systemPrompt: `${event.systemPrompt}\n\n${composed}` };
}
```

The rewind-intent consumption and `captureModel` stay unconditional.

---

## TESTING

| Test | Asserts |
| ---- | ------- |
| Tail inject shape | Recall pending + context fires → last view message is `role:"user"` with composed cp+mem block; `before_agent_start` returns nothing recall-related |
| Prefix preservation | View with recall vs prior turn's transcript: shared prefix length == prior transcript length (only tail differs) |
| Pin across tool loop | Two context events in one turn → both views carry the tail; bytes of the tail message identical (stable timestamp) |
| Consumption at turn_end | After `turn_end` (with injection), staged blocks are undefined; next context view has no tail |
| No-injection edge | Blocks staged but turn ends with zero context events → blocks REMAIN staged for next turn |
| Replay + recall | Valid trimCache + recall pending → view = replayed prefix + recall tail; replay prefix bytes identical to recall-free replay |
| auto off | `config.auto=false` + recall pending → early path returns full transcript + tail |
| Flag OFF parity | `recallTailInject=false` → `before_agent_start` prepends exactly as pre-sprint (byte-identical systemPrompt), context handler never appends |
| Tool-pair safety | Transcript ending in a toolResult → appended user message produces a valid message list (no orphaned pair) |
| Mirror exclusion | Injected tail message does NOT appear in `raw_transcript` |

---

## ACCEPTANCE

- Scripted session: `/mega-recall` mid-session → subsequent `cache_hit_pct` samples show no
  full-invalidation dip at inject or revert (vs baseline: two ~0% samples).
- All tests green incl. new file(s); lint + regression + guardrails clean.
- Flag OFF produces byte-identical prompts to pre-sprint (snapshot test).

## RISKS

| Risk | Mitigation |
| ---- | ---------- |
| pi validates/merges consecutive user-role messages differently than expected | Test explicitly; if pi merges, the content still lands in-prefix-tail position with identical cache behavior |
| Model treats tail recall as a new user instruction | Message content is prefixed with the existing recall framing text ("The following compacted context was recalled…") — same text as today's systemPrompt block, so instruction-behavior risk is unchanged from today |
| View returned every context event while staged adds render churn | One extra array spread per event; bounded by consumption at turn_end |
| Interaction with S52 rewind intents | Rewind consumption stays in `before_agent_start`, untouched |
