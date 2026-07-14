# Plan — True "tokens saved" metric + SQLite stats foundation

## Problem
`VectorStore.add()` stores `tokenEstimate` (the stored summary's size) as
"tokens saved". Under the chosen stored-sum definition this equals
`totalTokenEstimate`, and deduped compactions contribute 0. The user wants the
honest metric: **tokens removed from context** = original dropped-region size
− stored summary size, with a deduped compaction counting the whole region.

Also requested: per-session total tokens, repo total tokens, per-session saved,
repo saved, plus a SQLite schema foundation for future resume-session / lessons
/ daily-log features.

## Key facts (verified)
- `compactSession` (engine.ts:78) is the ONLY place that knows both the original
  region (`compactable` = messages before `keepFrom`) and the stored summary.
  It already imports `estimateSessionTokens` (tokens.ts).
- `tokenEstimate` is overloaded: extractive path = summary size; legacy path
  (engine.ts:125) = `estimateSessionTokens(compactable)` = ORIGINAL size.
- `add()` (vectorStore.ts:138) returns `deduped` and calls `addTokensSaved` on
  new rows only. It has `input.tokenEstimate` + `input.regionText`.
- Repo cumulative saved lives in SQLite `meta` key `tokens_saved` (bumped in
  `add()`). Per-session saved = runtime `rt.tokensSaved` in the extension (reset
  on session_start). `stats().tokensSaved` currently = per-session stored sum.
- engine.test.ts asserts no `tokenEstimate` values, so changing its computation
  is safe. vectorStore tests pass `tokenEstimate` explicitly to `add()` → safe.

## Changes

### 1. Engine returns the original region size (engine.ts)
- `import { estimateSessionTokens, estimateBlockTokens } from "./tokens.js"`.
- Compute `const regionTokens = estimateSessionTokens(compactable);`
  (`compactable` already sliced at engine.ts:80).
- Compute `const storedTokens = estimateBlockTokens(summary);` (actual stored
  summary size — honest for both paths).
- Set the checkpoint `tokenEstimate` to `storedTokens` (so `totalTokenEstimate`
  = Σ stored summaries, correct).
- Add `originalTokenEstimate: regionTokens` to `CompactResult` (engine.ts:43
  interface) and to the `add({...})` call (new `originalTokenEstimate` field on
  `AddInput`, vectorStore.ts:47).
- Keep `tokenEstimate` = `storedTokens` in the returned `CompactResult`.

### 2. `add()` computes true saved (vectorStore.ts)
- `AddInput` gains `originalTokenEstimate?: number`.
- In `add()`: `const stored = input.tokenEstimate ?? 0;`
  `const orig = input.originalTokenEstimate ?? stored;`
- New-checkpoint branch (after the existing `addTokensSaved` call): change it to
  `addTokensSaved(Math.max(0, orig - stored), this.stateDir);`
- Deduped return branches: bump `addTokensSaved(orig, this.stateDir)` (whole
  region saved, nothing new stored). Add after each `bumpDedupStats(true,...)`.
- `stats().tokensSaved` (per-session, DB-derived): compute as
  `Σ over session rows of MAX(0, original_token_estimate - token_estimate)`.

### 3. Schema: store original size + foundation tables (sqlite.ts)
- Add `original_token_estimate INTEGER` column to `context_chunks` (upsert +
  rowToCheckpoint; no migration needed — additive column, defaults null → 0).
- `StoredCheckpoint` gets `originalTokenEstimate?: number`.
- Add forward-looking scaffold tables in `initSchema` (foundation for the
  features the user named; populated minimally now, full features later):
  - `sessions(session_id PK, repo TEXT, started_at INTEGER, ended_at INTEGER,
     last_compacted_at INTEGER, status TEXT)`
  - `daily_log(id PK, day TEXT, session_id TEXT, event TEXT, detail TEXT,
     tokens_saved INTEGER, ts INTEGER)`
  - `lessons(id PK, session_id TEXT, repo TEXT, lesson TEXT, ts INTEGER)`
- Helpers (cheap, single-purpose):
  - `touchSession(sessionId, repo, stateDir)` upserts a `sessions` row.
  - `logDaily(sessionId, event, detail, tokensSaved, stateDir)` inserts a
    `daily_log` row (day = YYYY-MM-DD).
  - `addLesson(sessionId, repo, lesson, stateDir)` inserts a `lessons` row.

### 4. Wire runtime per-session saved + future-feature hooks (mega-compact.ts)
- `CompactResult` now has `originalTokenEstimate` + we add `saved`. Compute
  `const saved = result.deduped ? result.originalTokenEstimate
                                  : Math.max(0, result.originalTokenEstimate - result.tokenEstimate);`
- `rt.tokensSaved += saved;` (replaces the current `+= result.tokenEstimate`).
- On compact, call `touchSession(sid, repo, stateDir)` and
  `logDaily(sid, "compact", result.checkpointId, saved, stateDir)` (cheap, makes
  the daily-log table real and gives the repo a usable history).
- Dashboard per-session `store.tokensSaved` stays `rt.tokensSaved` (full, incl
  deduped). Repo `repo.tokensSaved` stays the SQLite meta counter (full).

### 5. Dashboard: show all requested stats (dashboard-server.ts)
- Vector Store card already has per-session Checkpoints/Stored/Saved/Injected/
  Dedup/Dedup-rate/Collapsed. Add **per-session "Tokens Saved"** already present;
  ensure **per-session total tokens** vs **saved** are both visible (they are:
  "Tokens Stored" + "Tokens Saved"). 
- Repo card: add `originalTokens` (repo) so it shows Total / Saved / Original.
- Snapshot `store`/`repo` interfaces gain `originalTokens`.

### 6. Tests (vectorStore.test.ts)
- New: deduped add bumps `tokensSaved` by the FULL original region (not 0).
- New: new add bumps `tokensSaved` by `orig - stored`, and `originalTokens` is
  tracked per session via `stats().originalTokens`.
- `repoStats().tokensSaved` spans sessions and counts deduped orig.

## Files touched
- src/engine.ts (CompactInput/CompactResult, originalTokenEstimate, storedTokens)
- src/vectorStore.ts (AddInput.originalTokenEstimate, add() saved calc, stats)
- src/store/sqlite.ts (original_token_estimate col, sessions/daily_log/lessons
  tables + helpers)
- src/store.ts (StoredCheckpoint.originalTokenEstimate)
- extensions/mega-compact.ts (rt.tokensSaved saved calc, touchSession/logDaily)
- extensions/dashboard-server.ts (SnapShot originalTokens, repo render)
- src/vectorStore.test.ts (new tests)

## Gate (every step)
`npm run build && npm run lint && python3 scripts/regression_check.py --all &&
npm test` — must be green. Then bump 0.4.1→0.4.2, commit, `npm publish`, and on
the device `pi update --extensions` (or re-`pi install npm:pi-mega-compact`) to
validate the real cross-device path (per memory [[pi-npm-workflow]]).

## Out of scope (future)
Full resume-session restore UI, lessons browse/recall, daily-log viewer. Tables
+ minimal population are scaffolded now so data collects from day one.
