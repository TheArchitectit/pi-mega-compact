# S50 — Per-Turn Metrics + Fork (Contract-First)

**Date:** 2026-07-29
**Parent program:** `docs/specs/s49-program-per-turn-memory-platform.md`
**Depends on:** S49 (TurnStore interface + isolated `turns.db`)
**Priority:** P2
**Status:** SPEC ONLY (implement after S49 lands)
**Reuse target:** host-agnostic — `src/metrics/turns.ts` + `src/fork.ts` are pure over `TurnReader`/`TurnWriter`

---

## GOAL

Layer **metrics** and **fork** on top of the S49 TurnStore, without touching the store's internals.

1. **Per-turn metrics** — recall-hit-rate, miss-rate, and coverage per turn; per-conversation rollups
   (avg hit-rate, pressure distribution, model churn). Pure computation over `TurnReader` — no new
   tables, no new writes.
2. **Conversation fork** — `/mega-fork` creates a child conversation that seeds from the parent's
   recall set at the fork point. The store's `forkConversation` already copies recall; this sprint
   wires it into a slash command + exposes it in the dashboard.
3. **Epoch stamping** — every turn gets an `epoch_id` derived from the compaction epoch that
   produced it. Enables point-in-time reconstruction of the injected set.

---

## CONTRACT (what hosts get)

```ts
// src/metrics/turns.ts — pure over TurnReader
interface TurnMetrics {
  recallHitRate(turnId: TurnId): number;          // recall hits / total turns in conversation
  recallMissRate(conversationId: ConversationId): number;
  coverage(conversationId: ConversationId): number;  // turns with recall / total turns
  conversationRollup(conversationId: ConversationId): ConversationRollup;
}

interface ConversationRollup {
  conversationId: ConversationId;
  turnCount: number;
  avgHitRate: number;
  avgCtxPercent: number;
  pressureDistribution: Record<string, number>;  // "green" → count, etc.
  modelChurn: number;  // distinct models used
  forkCount: number;
}

// src/fork.ts — pure over TurnWriter
interface ForkResult {
  childConversationId: ConversationId;
  seedRecallCount: number;  // how many recall hits were copied
}

declare function forkFromCommand(
  writer: TurnWriter,
  parentConversationId: ConversationId,
  forkTurnIndex: number,
): ForkResult;
```

---

## SCOPE

### IN SCOPE — new files

| File | Responsibility | Est. lines |
| ---- | -------------- | ---------- |
| `src/metrics/turns.ts` | `TurnMetrics` — pure computation over `TurnReader` | ~180 |
| `src/metrics/turns.test.ts` | Metrics correctness | ~150 |
| `src/fork.ts` | `forkFromCommand` — thin over `TurnWriter.forkConversation` | ~60 |
| `src/fork.test.ts` | Fork seeds recall correctly | ~80 |
| `extensions/mega-turn-cmds.ts` | `/mega-fork` slash command | ~60 |

### IN SCOPE — modified files

- `src/store/turns/types.ts` — add `epochId?: string` to `TurnEntry`
- `extensions/mega-compact.ts` — register `/mega-fork` command
- `extensions/mega-events/agent-handlers.ts` — stamp `epochId` at `turn_end`

### OUT OF SCOPE

- Dashboard fork UI (S52)
- Wiki / topic clustering (S51)
- Raw transcript `turn_index` wiring (deferred — not needed for metrics)

---

## EXECUTION

### S50A: Per-Turn Metrics

- [ ] `src/metrics/turns.ts` — `TurnMetrics` class, takes `TurnReader` in constructor
- [ ] `src/metrics/turns.test.ts` — hit-rate, miss-rate, coverage, rollup
- [ ] GATE S50A

### S50B: Fork Command + Epoch Stamping

- [ ] `src/fork.ts` — `forkFromCommand`
- [ ] `src/fork.test.ts`
- [ ] `src/store/turns/types.ts` — add `epochId` to `TurnEntry`
- [ ] `extensions/mega-turn-cmds.ts` — `/mega-fork`
- [ ] `extensions/mega-compact.ts` — register command
- [ ] `extensions/mega-events/agent-handlers.ts` — stamp `epochId`
- [ ] GATE S50B

---

## ACCEPTANCE

1. `TurnMetrics` produces correct hit-rate / miss-rate / coverage over a seeded store
2. `/mega-fork` creates a child conversation with the parent's recall set
3. Every turn in `turns.db` has an `epoch_id` (backfilled for existing rows on migration)
4. All new files < 200 lines; no `src/` file imports from `extensions/`
5. Full gate green at each sub-sprint

## ROLLBACK

Remove `/mega-fork` command + delete `src/metrics/` + `src/fork.ts`. The `epochId` column is
optional (backward-compatible). S49 store is untouched.
