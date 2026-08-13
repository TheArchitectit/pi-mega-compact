# Post-Mortem — "Already compacted" / "Auto compaction failed" race

**Failure ID:** FAIL-2026071701
**Severity:** high (user-facing error toast during normal compaction)
**Fixed in:** v0.7.4 (commit `848c817`)
**Owner:** mega-compact extension
**Date:** 2026-07-17

---

## 1. Summary

During normal auto-compaction, users saw a spurious red error toast:

```
[compaction]
 Compacted from 309,338 tokens (ctrl+o to expand)

 Error: Compaction failed: Already compacted
 Error: Auto compaction failed: Already compacted
```

The compaction actually succeeded — pi's native auto-compact ran and
appended a compaction entry. But our `agent_end` handler then fired a
**redundant** manual `ctx.compact()` that raced with pi's just-completed
native compaction and threw "Already compacted". Fixed by tracking every
native compaction via a new `session_compact` listener and skipping the
redundant manual call for a 10s cooldown.

## 2. Symptom

Exact user-visible output (pi TUI toast):

```
Error: Compaction failed: Already compacted
Error: Auto compaction failed: Already compacted
```

Two error strings originate in pi's `agent-session.js`:
- `"Compaction failed: ${message}"` — from the **manual** `compact()` catch block (line ~1477).
- `"Auto-compaction failed: ${message}"` — from `_runAutoCompaction`'s catch block (line ~1725), where `message === "Already compacted"`.

The `"Already compacted"` string is thrown at `agent-session.js:1390`:

```js
const preparation = prepareCompaction(pathEntries, settings);
if (!preparation) {
  const lastEntry = pathEntries[pathEntries.length - 1];
  if (lastEntry?.type === "compaction") {
    throw new Error("Already compacted");
  }
  throw new Error("Nothing to compact (session too small)");
}
```

`prepareCompaction()` (compaction.js:456) returns `undefined` when the last
branch entry is already a `compaction` — i.e. a compaction just ran.

## 3. Root Cause

**The extension's `agent_end` manual durable-trim `ctx.compact()` raced with
pi's native auto-compaction, which runs immediately after `agent_end`.**

### Cause chain (end-to-end)

1. Pi's `AgentSession._handlePostAgentRun()` (agent-session.js:769) calls
   `_checkCompaction(msg)` (agent-session.js:1510) **after** `agent_end`.
   Pi's own docstring on `_checkCompaction`:
   > "Check if compaction is needed and run it. Called after agent_end and
   > before prompt submission."

2. `_checkCompaction` → `_runAutoCompaction(reason)` (agent-session.js:1593)
   → `prepareCompaction(pathEntries, settings)`. Native compaction succeeds,
   `sessionManager.appendCompaction()` writes a `compaction` branch entry.

3. Our extension's `pi.on("agent_end", …)` handler (extensions/mega-events.ts)
   independently decides to fire a **manual durable trim** when it sees
   `idle && overThreshold`. It guards with `piCompactWouldNoop(ctx)` — a
   synchronous branch read that checks whether the last entry is a
   `compaction` (mirroring pi's `prepareCompaction` check).

4. **The race window:** pi emits `agent_end` BEFORE its own
   `_checkCompaction`. So at the moment our `agent_end` handler reads the
   branch, pi has NOT yet appended its compaction entry. Our
   `piCompactWouldNoop(ctx)` returns false (no compaction at the tail yet),
   so we call `ctx.compact()`.

5. pi's native compaction completes (appends `compaction` entry).
6. Our `ctx.compact()` runs pi's manual `compact()` path, which calls
   `prepareCompaction()` again — now the last entry IS a `compaction` →
   throws `"Already compacted"`.

7. The throw surfaces to the user via the `compaction_end` event's
   `errorMessage` field as both `"Compaction failed: Already compacted"`
   (manual path) and `"Auto-compaction failed: Already compacted"` (auto
   path), producing the two-line toast. (The double string suggests both the
   manual `ctx.compact()` and pi's own `_runAutoCompaction` surfaced the
   condition.)

### Why `piCompactWouldNoop` couldn't see it

`piCompactWouldNoop` (extensions/mega-pipeline.ts:349) is synchronous and
reads `ctx.sessionManager.getBranch()`. It mirrors pi's
`prepareCompaction` checks. But it can only see compaction entries already
appended to the branch — it cannot see pi's in-flight native compaction that
hasn't appended yet. The race is fundamentally about ordering between pi's
internal compaction append and our synchronous branch read, which no amount
of in-branch checking can close.

## 4. Why It Produced the Symptom

The cause chain above walks directly to the symptom:

- The redundant manual `ctx.compact()` hit pi's `prepareCompaction` AFTER
  the native compaction appended → `lastEntry.type === "compaction"` →
  `throw new Error("Already compacted")`.
- The throw was caught and surfaced via `compaction_end.errorMessage` →
  user-visible toast.

The compaction itself was never broken — the user's context WAS compacted
(by the native path). The error was purely the redundant-second-call
fallout.

## 5. Fix

**Track every native compaction via a new `session_compact` event listener
and skip the redundant manual call for a 10s cooldown.**

Commit `848c817` (`fix(compaction): prevent "Already compacted" race in agent_end`).

### Changes (`extensions/mega-runtime.ts`, `extensions/mega-events.ts`)

1. **New field `rt.lastNativeCompactAt`** (`mega-runtime.ts`) — wall-clock
   ms of the last NATIVE pi compaction. Distinct from
   `rt.lastCompactAt`, which `runCompact()` (mega-pipeline.ts:149) also
   stamps for our own checkpoint persistence — using `lastCompactAt` for
   the guard would falsely skip the legacy `ctx.compact()` path (test
   `auto-trigger (legacy)` caught this on first attempt).

2. **New `session_compact` event listener** (`mega-events.ts`) — fires for
   EVERY compaction (manual/threshold/overflow, ours or pi's own) and
   stamps `rt.lastNativeCompactAt = Date.now()`. This is the race-closing
   signal: by the time `agent_end` checks it, pi's native compaction (which
   completed before `agent_end` fires the next time) has stamped it.

3. **10s cooldown guards** on both `ctx.compact()` call sites:
   - `agent_end` mid-run durable trim (line ~310): skip if
     `now - lastNativeCompactAt < 10_000`.
   - Legacy `MEGACOMPACT_LEGACY_DURABLE_TRIM` path (line ~516): same guard.

4. **Diagnostic counter `diagAgentEndDurableSkipRecent`** — counts skips
   from the cooldown, for observability.

### Why this addresses root cause

The root cause is a race between pi's native compaction append and our
synchronous `piCompactWouldNoop` branch read. We cannot make the branch
read see the future. Instead we close the race with a **temporal** signal:
pi's `session_compact` event fires atomically when a compaction completes,
and our guards honor a 10s cooldown after it. By the next `agent_end` the
native compaction has long since stamped `lastNativeCompactAt`.

## 6. How It Was Found

- **Repro:** any session that crossed the auto-compact threshold while our
  `agent_end` durable-trim guard was armed (long team runs were the main
  trigger — sub-agents settle, `agent_end` fires, both paths compact).
- **Tools:** grep of pi's shipped `dist/core/agent-session.js` for the
  literal strings (`"Already compacted"`, `"Auto-compaction failed"`,
  `"Compaction failed"`), then reading `_checkCompaction` /
  `_runAutoCompaction` / the manual `compact()` catch.
- **Hypotheses tried and rejected:**
  1. *"Our `session_before_compact` handler supplies a bad compaction"* —
     rejected: the handler returns `{}` (lets pi run its own) when
     `driveNativeCompaction` returns undefined, and the fallback path
     always supplies a non-empty summary. The throw is in pi's
     `prepareCompaction`, before our handler ever runs on the second call.
  2. *"`piCompactWouldNoop` has a bug"* — rejected: it correctly mirrors
     pi's checks; the gap is temporal (it can't see the in-flight native
     compaction), not logical.
  3. *"Double-fire in `agent_end` itself"* — rejected: only one
     `ctx.compact()` call site in `agent_end`; the double toast is pi
     surfacing the same underlying condition on two code paths (manual +
     auto).
- **Confirming experiment:** reading
  `_handlePostAgentRun` → `_checkCompaction` ordering in
  `agent-session.js:769/782` confirmed pi runs native compaction AFTER
  `agent_end`, proving the race window is real and inherent to the
  `agent_end` hook.

## 7. Why It Slipped Through

- **No integration test fires `agent_end` AFTER a native compaction.** The
  existing `mega-compact.test.ts` harness fires synthetic `context` /
  `session_before_compact` events with mocks; it never simulates pi's
  `_handlePostAgentRun` ordering (native compaction appended between
  `agent_end` and our branch read). A unit test cannot reproduce a race
  that depends on pi's internal event sequencing.
- **The guard (`piCompactWouldNoop`) was correct for the threat model it
  was written against** — pi's manual `compact()` no-op throw on a stale
  session. It was not designed against the native-auto-compaction race
  because the ordering (`agent_end` before `_checkCompaction`) is
  documented but easy to miss.
- **Latent code:** the `agent_end` durable-trim path was added in S16
  specifically to relieve mid-team-run context bloat, where the race is
  most likely to fire (long sessions cross the threshold repeatedly).

## 8. Validation

- **Regression coverage:** existing test
  `auto-trigger (legacy): past threshold persists a chkpt and starts a
  durable trim via ctx.compact` (`mega-compact.test.ts:230`) caught the
  first fix attempt (which used `lastCompactAt` instead of
  `lastNativeCompactAt` and falsely skipped the legacy path). The
  corrected fix keeps this test green.
- **Full suite:** 395/395 pass (40 files), lint clean, regression check
  clean. No new tests added (see Action Items).
- **Validated config:** legacy path (the test exercises it). The default
  `agent_end` path is guarded identically but is not unit-tested for the
  race (no harness for pi's `_handlePostAgentRun` ordering).
- **Live validation:** pending v0.7.4 install on the device that hit the
  original error.

## 9. Action Items

- [ ] **Add an integration test** that simulates the `agent_end` → native
  compaction append → `agent_end`-fired `ctx.compact()` ordering and
  asserts the cooldown skips the redundant call. Owner: mega-compact.
  Track: TODO in `extensions/mega-compact.test.ts`.
- [ ] **Add a regression assertion** that `diagAgentEndDurableSkipRecent`
  increments when a `session_compact` event precedes an `agent_end` within
  10s. Owner: mega-compact.
- [ ] **Consider documenting** the pi extension-event ordering
  (`agent_end` BEFORE `_checkCompaction`) in
  `docs/AGENT_GUARDRAILS.md` so future compaction-trigger work accounts
  for it. Owner: mega-compact.
