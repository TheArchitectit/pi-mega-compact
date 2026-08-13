# The bridge, the bug, and the bug that wasn't — a C2 postmortem

*2026-08-13 · pi-mega-compact ↔ pi-ithacus-agent-framework bidirectional bridge*

> A story about building a direct adapter between two extensions, shipping it, and then discovering — during the first real end-to-end test — a bug that looked exactly like the new code's fault and wasn't. What follows is how we actually got to the truth, including the wrong turn we took first.

## The premise

We run two pi.dev extensions that had never met.

**pi-mega-compact** is a compaction, memory, recall, and vector-cortex extension. It owns durable context: it compacts conversations into checkpoints, embeds them, recalls them by semantic similarity, forks conversations off prior turns, and maintains a vector-cortex over the whole corpus.

**pi-ithacus-agent-framework** ("ithacus") is an agent/team/swarm orchestrator. It dispatches child subprocesses, tracks turns, and — importantly — had a gap: its dispatched children were **compaction/recall-blind**. They spawned with `--no-extensions` and got only a mailbox tool. ithacus also had no persisted turn table, so it couldn't fork. Its `ith_memories` table was write-dead.

The question was: should we build a **direct adapter** between the two, so ithacus (parent *and* children) could use mega-compact's durable memory, compaction, checkpoint recall, memory recall, conversation fork, and vector-cortex?

We said yes. Bidirectional, both repos change. Include child agents now. Flag default ON, env-OFF.

## The design (the short version)

Two constraints shaped everything:

1. ithacus ships with **`dependencies: {}`** — a zero-runtime-deps invariant. We would not break it.
2. mega-compact is fully local (zero network at runtime). We would not break that either.

So no static dependency edge, and no SQLite-mediated coupling (recall needs the embedding engine + FTS5 + a PGlite HNSW vector index — code, not raw tables). The chosen seam:

- mega-compact exposes a pi-agnostic **bridge module** (`src/bridge/` → compiled to `dist/src/bridge.js`) with a `createMegaBridge({ stateDir })` factory returning a 9-method surface: `compact`, `recallCheckpoints`, `recallMemories`, `recallAndInlineAsync`, `fork`, `cortexQuery`, `addMemory`, `recordTurn`, `close`.
- ithacus loads it via **dynamic `import("pi-mega-compact/dist/src/bridge.js")`** — dynamic so tsc never needs to resolve the package statically; local so it isn't a network construct.
- ithacus declares mega-compact as an **optional peer dependency** (peer ≠ dep; the zero-deps invariant holds) and keeps a **local contract type** (`src/mega-bridge-contract.ts`) that mirrors mega's `MegaBridge` field-for-field. The dynamic import is cast to the local contract; a cross-repo conformance test keeps the two honest.

Every code change got **triple redundancy**: (a) a config flag gate, (b) a non-fatal try/catch, (c) degradation to existing behavior. Plus three "4th layers": a child path-resolution guard, a sessionId-stability validation, and — the one that matters later — a **single-compaction-authority** guard: the bridge must never compact the parent session, because mega-compact's own extension already owns parent compaction. Two compactors racing was the cause of a previous rollback (v0.20.80–82); we weren't going to reintroduce it.

`pi --help` confirmed the load-bearing assumption for children: `-e <path>` **can be used multiple times**. A child could load its mailbox extension *and* mega-compact's minimal child extension together.

## We shipped it

- **Sprint A** (mega-compact side, v0.21.3): the bridge API, the child extension (`mega-compact-child.ts` — recall at `before_agent_start`, compact at `session_shutdown`, no tools, no console.log), the flag (`MEGACOMPACT_ITHACUS_BRIDGE`, default ON), the dashboard toggle.
- **Sprint B** (ithacus side, v0.6.15 → 0.6.16): the contract, the loader, the flag (`ITHACUS_MEGA_BRIDGE`, default ON), the runtime wiring, the parent recall + recordTurn handlers, the child spawn second `-e`, the conformance test.
- **Sprint C1**: a cross-repo conformance smoke test in ithacus's CI — 9-method surface + 4 round-trips, all passing against the live published `pi-mega-compact@0.21.3`.

Everything green. We declared Sprints A, B, C1 done.

Then we ran C2 — the first **real end-to-end** test, on a live device, in a real repo.

## C2: the status line looked fine. The log didn't.

The device was the `RADOPENCODE` repo, with `pi-mega-compact@0.21.3` and `ithacus@0.6.16` co-loaded. The status line was encouraging:

```
mega-compact: ready
ithacus v0.6.16
```

Both extensions loaded. No crash. No duplicate-tool hard-fail. The big unknown from the design — would the dynamic `import()` actually resolve `pi-mega-compact` in a real `pi install` layout, where both extensions live under `~/.pi/agent/npm/node_modules/`? — appeared to have a happy answer.

Then we read `events.log`:

```
557 × "turn_write_failed": "Duplicate turn: conversation \"conv_…\" already has turnIndex N"
```

Five hundred and fifty-seven duplicate-turn errors. And the status line had been showing `drift warn` and an `errorRate` pinned at `1.0`.

This is the part of the story where it's very tempting to be confident about the wrong thing.

## The wrong turn (and how it looked right)

The `DuplicateTurnError` stack trace pointed into:

```
~/.pi/agent/npm/node_modules/pi-mega-compact/src/store/turns/sqlite-store/write.ts:64
  at SqliteTurnStore.appendTurn
```

And the new variable in the system was the bridge. ithacus's parent `turn_end` handler called `bridge.recordTurn`; mega-compact's own native `turn_end` handler also called `recordTurnRow`. Two writers, same `turns.db`, same `(conversationId, turnIndex)` key — obviously they were racing, and the loser threw `DuplicateTurnError`. Right?

We even had a name for it: "double turn-recording authority," a sibling of the double-compaction authority we'd already guarded against. The fix wrote itself: drop the parent-side `bridge.recordTurn`, let mega's native handler own parent turns (single-turn-recording-authority), keep `bridge.recordTurn` in the contract for the child path. We handed the fix to an implementation agent. It ran the gate, committed, all green.

That fix is correct, and it shipped. But the *reasoning* in its commit comment was wrong, and we didn't know that yet — because we hadn't read the data.

## The data exonerated the bridge

The fix agent, being diligent, flagged one assumption it couldn't verify in its own repo: *does a later `bridge.fork()` really read mega's natively-recorded turns?* That sent us back to `turns.db` to check whose turns were actually in there.

The conversation ids told the whole story.

ithacus's `runtime.sessionId` — the value the bridge passed as `conversationId` to `recordTurn` — defaults to `"global"` (set at `session_start` from `event.sessionId ?? "global"`). And sure enough, `turns.db` had a `"global"` conversation with 8 sparse rows: `model=null`, no `ctxTokens`, `session_id="global"`. Those were the bridge's. They wrote successfully.

The `DuplicateTurnError` events, though, were all on `conv_*` ids — mega's conversations. Not `"global"`. The bridge and mega were **not writing to the same conversation at all**. They couldn't have been racing.

So who was re-writing `conv_*` turns? The timestamps made it undeniable:

| conversation | turns written | failures | when written | when failures occurred |
|---|---|---|---|---|
| `conv_34c99041ba1d7e6e` | 68 | **502** | 08-02 18:43 → 08-03 12:54 (~18h) | throughout that 18h |
| `conv_6a2df43939dd1e1c` | 43 | 45 | 08-03 17:43 → 18:11 | 08-03 17:51 → 18:23 |
| `conv_a616e8f373fa07cd` | 11 | 10 | 08-13 02:58 → 03:00 | 08-13 04:34 → 04:43 |

Look at the last row: the conversation's 11 turns were written at 02:58–03:00. The 10 duplicate-write attempts on that conversation happened at **04:34–04:43** — two hours later. The conversation already had turns 0–10; something tried to write turn 0 to it again at 04:34 and kept failing.

That something was **mega's own native handler**, and the reason was **session resume**. When pi resumes a session with the same mega `sessionId`, mega's conversation persists (the `conv_*` rows survive across the resume) but `turnIndex` **restarts at 0**. So mega's native `recordTurnRow` re-attempts turns that already exist → `DuplicateTurnError`, caught and logged as `turn_write_failed`. 502 of the 557 came from one long-lived conversation resumed roughly seven times over eighteen hours.

And the bridge's own duplicates? ithacus wrapped its `bridge.recordTurn` call in `try/catch` (triple-redundancy layer b). When the bridge's `"global"` write collided with an earlier `"global"` write, ithacus swallowed the error. That's why **zero** of the 557 logged errors mention `"global"` — mega logs `turn_write_failed`; ithacus silently absorbs its own. The bridge was, in the most literal sense, innocent of every single one of the 557 logged errors.

We had to correct the fix's commit comment. The fix itself (single-turn-recording-authority) still stood — the bridge's sparse `"global"` rows were a useless duplicate-in-spirit of mega's full native rows, and consolidating authority under mega's handler is the right principle. But it does **not** fix the 557 errors. Those are a mega-compact session-resume bug, and they're now tracked for a mega-compact follow-up.

## Two more findings, hiding behind the first

Once we were reading the right data, two more things surfaced that we'd have missed if we'd stopped at "the bridge is double-writing."

### The health dashboard was green while 557 errors logged

mega's `errorRate` context-health sub-score is `1 - (errors/total)` over a ring buffer of per-turn `lastErrorCategory` values. `lastErrorCategory` is set to `null` at the start of every turn and only set to a non-null category in the **API-error retry path**. The `turn_write_failed` event — fired by `recordTurnRow` when `appendTurn` throws — **does not touch `lastErrorCategory`**. So the 557 internal store-write errors were completely invisible to the `errorRate` metric. It read `1.0` — the *healthy* extreme — the entire time.

The dashboard said green. The log said red. They were looking at different things, and only one of them was wired to the UI. That's an observability gap, and it's now tracked for a fix: internal errors need to reach the health view, not just API retry errors.

### "drift warn" was a red herring

The `drift warn` on the status line — which we'd vaguely assumed was related to the error noise — is produced by an entirely separate detector: `detectCrossRepoDrift()`, which flags a repo `warn` when it is **active but not compacted** (a `compaction_lag` signal: "never compacted" or "Nh behind last activity"). For `RADOPENCODE` that was simply true — the repo had never been compacted. The status line said so itself: `compact never`. It had nothing to do with the duplicate turns, the bridge, or `errorRate`. Naming this so nobody chases a "drift" that's really a "you haven't compacted yet."

## What we shipped, and what's next

We shipped **ithacus v0.6.17**: the single-turn-recording-authority hygiene fix. It's correct and tested and it consolidates turn recording under mega's native handler, which is the right design. The release notes say exactly that — and also say, plainly, that it does *not* fix the 557 errors, so nobody mistakes it for the whole fix.

Then we tracked the real work:

1. **mega-compact: fix the session-resume `turnIndex` restart.** On resume, detect the existing conversation and continue the turn index from its high-water mark (or skip-existing on `DuplicateTurnError`). This is the actual source of the 557 `turn_write_failed` events, and the fix lives in mega-compact, not ithacus.
2. **mega-compact: surface internal store-write errors in the health dashboard.** `turn_write_failed` (and its siblings) need to reach the error-rate signal or get their own sub-score, so `errorRate` stops reading 1.0 while errors accumulate.
3. **Continue C2:** parent recall injection, memory write to `<repo>/.pi/mega-compact/sqlite.db`, child dispatch with the second `-e mega-compact-child.js`, cross-dispatch recall, fork after `recordTurn`s, and `ITHACUS_MEGA_BRIDGE=false` byte-identity.

## How we'll use this

Three things we're taking forward.

**End-to-end is the only honest gate.** Sprints A, B, and C1 passed every unit, integration, smoke, guardrails, schema, and conformance check we have. None of them could have found the resume bug, because none of them resume a real pi session with a real mega `sessionId` against a real persisted conversation. The bug only exists in the intersection of "session resumed" + "conversation persisted" + "turnIndex restarted" — a state that appears at runtime, in a real layout, on a real device. C2 isn't ceremonial; it's the only place certain bugs can live.

**Plausible is not confirmed.** The bridge-double-write story was a good story. The stack trace pointed at mega's `appendTurn`; the new variable was the bridge; the fix had a clean name and a clean principle. It was wrong. The conversation ids and the timestamps were five minutes of `node` away, and they overturned it. The lesson is the one we already had written down — *verify before commit* — but the trap is that "verify" can feel done when the story is good. It wasn't done until we read the data.

**Single authority is a principle, not just a guard.** We guarded compaction against double authority and it worked. We missed that turn recording had the same shape until C2 surfaced it. The general rule — *one owner per write-lane, and the host's own extension is the default owner; the bridge fills only the gaps the host can't* — is the one we're codifying, for turns now and for whatever the next shared lane is.

The bridge is live, the bug that wasn't is exonerated, the bug that is has a name and an owner, and the dashboard is going to stop lying. That's a good night's C2.
