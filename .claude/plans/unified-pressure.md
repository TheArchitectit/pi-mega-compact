# Plan: Unify auto-compact + tier + memory around one pressure signal

## Problem

Three subsystems run as independent triggers that only coincidentally coexist:

- **Auto-compact** fires when `currentTokens >= config.thresholdTokens`
  (`mega-events.ts:222`). Trim depth + brotli quality already scale with
  `pressureFromPct()` (partial coupling).
- **Tier** (`low/medium/high/ultra/mega`) is a *static* threshold preset. Nothing
  auto-escalates it, so the toolbar/dashboard label never moves — the user's
  observation. Only `/mega-tier` changes it.
- **Memory auto-review** fires on a fixed `turn % 10` modulo
  (`mega-events.ts:170`), blind to pressure and to compaction.

Goal: make context pressure the single driver so the label moves, compaction
fires proportionally, and memory keeps pace with session density.

## Design decisions (from user)

1. **Tier = auto only. Remove `/mega-tier`.** Tier becomes a live display of the
   current pressure band; the manual command is deleted.
2. **Memory cadence = pressure-scaled interval AND review-on-compact.** Denser
   review when hot, plus a review fired right after each successful compaction.
3. **Pressure bands = tokens-to-threshold.** Band derived from how close
   `currentTokens` is to `thresholdTokens`.

## Core concept: one `pressure` signal on MegaRuntime

`MegaRuntime` already holds `lastCtxTokens`, `lastCtxPercent`, `lastCtxWindow`,
updated at the top of every `context` event. Add a derived pressure model there.

### Pressure = tokens-to-threshold ratio

```
pressure = clamp01(currentTokens / thresholdTokens)   // 0 = empty, 1 = at fire point, >1 = over
```

`thresholdTokens` stays the fire point (still seeded by `MEGACOMPACT_TIER` /
`MEGACOMPACT_THRESHOLD_TOKENS` at load — the env keeps working as the *base*
threshold). The tier label is now a *readout of pressure*, decoupled from the
static preset name.

### Pressure → tier band (display + behavior)

Map the ratio to a live band name (reusing the existing five names as pressure
levels, so the widget vocabulary is unchanged):

| Band     | tokens/threshold | Meaning                                   |
|----------|------------------|-------------------------------------------|
| `low`    | < 0.50           | calm — plenty of headroom                 |
| `medium` | 0.50 – 0.75      | filling                                   |
| `high`   | 0.75 – 0.90      | hot — near fire point                     |
| `ultra`  | 0.90 – 1.00      | critical — compaction imminent            |
| `mega`   | ≥ 1.00           | at/over fire point — compacting           |

This is a pure function `pressureBand(currentTokens, thresholdTokens)`.

### What the band drives

- **Display:** widget line 1 (`mega-runtime.ts:286`) and dashboard snapshot
  (`mega-runtime.ts:217`) show the live band instead of the frozen preset. The
  label now climbs `low→medium→high→ultra→mega` as context fills — the fix.
- **Trim depth:** already scales via `pressureFromPct()`; switch it to read the
  unified `runtime.pressure` so it's the same signal. (Behavior ~unchanged;
  removes the duplicate local computation.)
- **Memory cadence:** effective interval scales with band (below).

## Changes by file

### `extensions/mega-config.ts`
- Keep `COMPACT_TIERS` + `resolveThreshold()` — they still seed `thresholdTokens`
  from `MEGACOMPACT_TIER`/`MEGACOMPACT_THRESHOLD_TOKENS` at load.
- Repurpose `config.tier`: it stops being the live label. Either drop it from the
  widget path or keep it only as "base threshold name." Simplest: keep
  `thresholdTokens`, stop treating `tier` as authoritative for display.
- **Remove `setTier`** (only used by `/mega-tier`).
- Add pure helpers (or put in a small `pressure.ts`):
  - `pressureRatio(tokens, threshold): number`
  - `pressureBand(tokens, threshold): CompactTier` (the table above)

### `extensions/mega-runtime.ts`
- Add `get pressure(): number` and `get pressureBand(): CompactTier` computed
  from `lastCtxTokens` / `config.thresholdTokens`.
- Dashboard snapshot (`:217`): `tier: this.pressureBand` (live), and add a
  numeric `pressure` field to the snapshot for the dashboard UI.
- Widget line 1 (`:286`): show `⚡ ${this.pressureBand}` (live band) — keep the
  version pill. Optionally tint by band (green→amber→red).

### `extensions/mega-events.ts`
- **Memory review (`:170`)** — replace fixed modulo with pressure-scaled interval:
  ```
  effInterval = round(config.memoryReviewInterval * intervalScale(pressure))
  // intervalScale: ~1.5x when calm (low), 1.0x medium, ~0.5x when hot (high+)
  fire when currentTurn % max(1, effInterval) === 0
  ```
  Extract the review body into a `runMemoryReview(ctx)` helper so it can be
  called from two places.
- Auto-trigger (`:234`): read `runtime.pressure` instead of computing
  `pressureFromPct` locally (single source).

### `extensions/mega-pipeline.ts`
- **Review-on-compact (decision #2 part 2):** after a *successful* compaction,
  call `runMemoryReview(ctx)` (best-effort, non-fatal) before/around the existing
  `consolidateMemories` gate, so a compaction always refreshes memory. Keep the
  `memoriesTouchedThisCompaction > 0` gate for consolidation.
- `preserveRecantForPressure` / `compressSmart` pressure arg: source from
  `runtime.pressure` (already effectively does; confirm one signal).

### `extensions/mega-commands.ts`
- **Delete the `/mega-tier` command** (`:242–264`) and its `setTier`/`CompactTier`
  imports. `/mega-status` (`:129`) shows the live band + threshold + pressure %.

### Memory storage hardening (folded in: file-backed memory overflow)

**Root cause of the `4868/5000 chars` error:** that limit is **pi's native
file-backed memory** (`MEMORY.md` buffer), a *separate* system from
pi-mega-compact. pi-mega-compact already writes its own memories to its SQLite
`memories` table (`src/store/sqlite.ts:523` via `addMemory`/`replaceMemory` in
`src/memoryOps.ts`) — so the overflow came from pi's path, not ours. Fix: make
pi-mega-compact memory live **entirely in SQLite/PGlite** and never fall back to
or duplicate into pi's file buffer, and add self-management so a single entry /
the store can never blow a ceiling.

Changes:
- **`src/memory.ts` / `src/memoryOps.ts`** — add a hard size guard on every
  written entry: cap each memory at `MEMORY_MAX_CHARS` (default e.g. 4000, safe
  under any client cap). Trim overflow rather than let the write fail; record a
  `[truncated]` marker so recall knows. (Chosen behavior: **truncate**, per
  decision — long memories are cut, never lost silently without the marker.)
- **Prune / rotation in our own store** — when the `memories` table exceeds
  `MEMGACOMPACT_MEMORY_MAX_ROWS` (default e.g. 500) or total bytes, evict
  lowest-`last_referenced` / oldest `source_turn` first. Reuse the existing
  `consolidateMemories()` (near-duplicate merge) as the first pass, then LRU
  eviction. This is the "protect + prune" behavior and keeps our store bounded
  instead of monotonically growing toward a client-side cap.
- **No file fallback.** Confirm `applyMemoryOps` / `reviewConversation` write
  only via the SQLite helpers; remove any path that appends to pi's
  `MEMORY.md`/file memory. If pi's native memory is also enabled in the session,
  that's pi's concern — pi-mega-compact must not share a buffer with it.
- **Mirror to PGlite index (optional, best-effort).** Memory rows can be
  mirrored into the existing async PGlite store (`src/store/vectorIndex.ts`) for
  cross-repo memory recall, same degrade-to-sync pattern as checkpoints. Kill-
  switch = `MEGACOMPACT_PGLITE_DISABLED`. Keep memory authoritative in SQLite.

New config (in `src/config/dedup.ts` or a `memory` config block):
- `MEGACOMPACT_MEMORY_MAX_CHARS` (default 4000) — per-entry truncation cap.
- `MEGACOMPACT_MEMORY_MAX_ROWS` (default 500) — store size before LRU eviction.

### Docs + tests
- README: replace "Set the compaction tier" row with a note that tier is now an
  automatic pressure readout; drop `/mega-tier` from the command table; update the
  config table (`MEGACOMPACT_TIER` now = base threshold, not a live mode).
- TESTER_GUIDE: update Scenario 1 (tier auto-climbs with context) and remove the
  "/mega-tier to switch tiers" step; add a memory-cadence-under-pressure check.
- Tests:
  - New unit test for `pressureBand()` / `pressureRatio()` boundaries.
  - Update `extensions/mega-commands.test.ts` (or wherever) to drop `/mega-tier`
    coverage.
  - Update any test asserting a static `tier` on the snapshot/widget to expect the
    derived band.
  - Add a test that memory review fires on compaction and that the effective
    interval shrinks under high pressure.
  - **Memory hardening:** entry over `MEMORY_MAX_CHARS` is truncated with the
    `[truncated]` marker; store over `MEMORY_MAX_ROWS` evicts LRU after a
    consolidate pass; writes go to SQLite only (no file path).

## Acceptance
- Widget + dashboard tier label visibly climbs `low→…→mega` as context fills and
  falls back as it's relieved (post-compaction).
- `/mega-tier` is gone; `/mega-status` reports live band + pressure %.
- Memory review fires more often under pressure AND once per successful compaction.
- Trim depth/compression read the same `runtime.pressure`.
- **Memory writes only to SQLite/PGlite (never pi's file buffer); entries are
  size-capped and the store is bounded by consolidate + LRU eviction — the
  `4868/5000` client-cap failure cannot recur from our path.**
- `npm run lint`, `python3 scripts/regression_check.py --all`, full test suite green.
- Version bump (0.5.2 → 0.6.0, behavior change) + publish, per project workflow.

## Rollback
- `MEGACOMPACT_TIER` still pins the base threshold. If auto-band is unwanted, a
  single env flag (`MEGACOMPACT_STATIC_TIER=1`) can restore the frozen label
  (optional; add only if you want the escape hatch).

## Open sub-decision (will pick sensible default unless told)
- Exact `intervalScale` curve and whether to add the `MEGACOMPACT_STATIC_TIER`
  rollback flag. Default: scale 1.5x/1.0x/0.5x by band, and DO add the rollback
  flag (cheap safety).
