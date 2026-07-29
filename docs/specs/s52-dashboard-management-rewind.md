# S52 — Dashboard Management + Rewind (Capability-Gated)

**Date:** 2026-07-29
**Parent program:** `docs/specs/s49-program-per-turn-memory-platform.md`
**Depends on:** S49 (store + capability gating), S50 (metrics + fork), S51 (wiki)
**Priority:** P2
**Status:** SPEC ONLY (implement after S50/S51 land)
**Reuse target:** `src/intent.ts` (rewind-intent queue) is host-agnostic

---

## GOAL

Surface the turn store's capabilities in the dashboard with **capability-gated** access:

1. **Turns tab** — per-conversation turn list with metrics (from S50), recall provenance, and prune
   controls. Dashboard uses `store.asReader()` for display + `store.asAdmin()` only for the prune
   button.
2. **Wiki tab polish** — finalize S51 wiki tab with search + topic drill-down.
3. **Fork action** — `/mega-fork` button in the dashboard (S50 primitive, dashboard UI).
4. **Rewind handshake** — a host-agnostic intent queue that lets the dashboard express "rewind to
   turn N" without the store ever calling back into the host. The store writes a `pending_fork`
   row; the host polls it at `before_agent_start`.

---

## CONTRACT (what hosts get)

```ts
// src/intent.ts — host-agnostic rewind-intent queue
interface RewindIntent {
  id: string;
  conversationId: ConversationId;
  targetTurnIndex: number;
  createdAt: number;
  status: "pending" | "consumed" | "abandoned";
}

interface IntentWriter {
  postIntent(intent: Omit<RewindIntent, "id" | "createdAt" | "status">): RewindIntent;
}

interface IntentReader {
  pendingIntents(): RewindIntent[];
  consumeIntent(id: string): void;
  abandonIntent(id: string): void;
}

// The intent module is a thin queue over the turns.db pending_fork table
// (S49 pre-created the table). The host polls it — the store never calls back.
```

---

## SCOPE

### IN SCOPE — new files

| File | Responsibility | Est. lines |
| ---- | -------------- | ---------- |
| `src/intent.ts` | `IntentWriter` / `IntentReader` over `pending_fork` table | ~100 |
| `src/intent.test.ts` | Post / consume / abandon intent | ~80 |
| `extensions/dashboard-server/routes-turns.ts` | `/api/turns`, `/api/turns/prune`, `/api/turns/vacuum`, `/api/fork` | ~150 |
| `extensions/dashboard-client/src/tabs/TurnsTab.tsx` | React turns tab with prune controls | ~250 |
| `extensions/dashboard-client/src/tabs/WikiTab.tsx` | Polish search + drill-down | ~100 |

### IN SCOPE — modified files

- `extensions/mega-runtime/runtime.ts` — poll `pending_fork` at `before_agent_start`, consume intent
- `extensions/dashboard-server/routes.ts` — register turns routes
- `extensions/dashboard-client/src/App.tsx` — add Turns tab

### OUT OF SCOPE

- Full conversation replay UI (future)
- Multi-device intent sync (future)
- Raw transcript viewer (future)

---

## EXECUTION

### S52A: Rewind Intent Queue

- [ ] `src/intent.ts` — `IntentWriter` / `IntentReader`
- [ ] `src/intent.test.ts`
- [ ] `extensions/mega-runtime/runtime.ts` — poll + consume at `before_agent_start`
- [ ] GATE S52A

### S52B: Dashboard Turns Tab

- [ ] `extensions/dashboard-server/routes-turns.ts`
- [ ] `extensions/dashboard-client/src/tabs/TurnsTab.tsx`
- [ ] Capability check: dashboard uses `asReader()` for display, `asAdmin()` only for prune/vacuum
- [ ] GATE S52B

### S52C: Wiki Polish + Fork Button

- [ ] Wiki tab search + drill-down
- [ ] Fork button (calls `asWriter().forkConversation` + posts a `RewindIntent`)
- [ ] GATE S52C

---

## ACCEPTANCE

1. Dashboard turns tab renders conversation list + turn details + recall provenance
2. Prune button uses `asAdmin()` — capability-gated, proven by type check
3. Rewind intent round-trips: post → pending → consume → consumed
4. Fork button creates a child conversation + posts a rewind intent
5. The store never calls into the host (ledger protocol verified)
6. Full gate green

## ROLLBACK

Remove turns tab + wiki polish + intent module. S49/S50/S51 are untouched.
