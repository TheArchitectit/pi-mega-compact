# S24 — Unified pressure signal: auto-compact + tier + memory

**Date:** 2026-07-16
**Parent plan:** `.claude/plans/unified-pressure.md`
**Depends on:** S16 (live trim), S20–S23 (memory store + recall + drift) ✅ committed
**Priority:** P1 (the four subsystems currently run as independent triggers that only coincidentally coexist — they must become one coherent pressure-driven system)
**Status:** IMPLEMENTED (2026-07-16, v0.6.0)
**Target version:** 0.6.0 (behavior change)

---

## SAFETY PROTOCOLS

- **PREVENT-PI-004:** zero network at runtime. No change to network posture. Guardrails-scan must stay green.
- **PREVENT-PI-001 / PREVENT-PI-002:** the live trim keeps its anchor-floor + tool-pair boundary guards. Pressure-scaling must NOT reduce `preserveRecent` below `config.preserveRecentMin`.
- **Best-effort / non-fatal:** memory auto-review and review-on-compact failures must NEVER break the agent loop or compaction (already the case; preserve it).
- **Single source of truth:** one `pressure` signal on `MegaRuntime`. No duplicated local `pressureFromPct()` computations scattered across handlers.
- **No file-backed memory:** pi-mega-compact memory writes ONLY to its SQLite/PGlite stores. It must not fall back to or duplicate pi's file-backed `MEMORY.md` buffer (that buffer has a hard 5000-char per-entry cap that threw `4868/5000 chars` overflow during a session).
- Verify gate (every commit): `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all` all green.
- **NO FORCE PUSH;** branch + push only. Publish via `npm publish` + `pi update --extensions`.

---

## DECISIONS (locked with user, 2026-07-16)

1. **Tier = auto only. Remove `/mega-tier`.** The `low/medium/high/ultra/mega` label becomes a live readout of the current pressure band, not a manual preset. The command is deleted.
2. **Memory cadence = pressure-scaled interval AND review-on-compact.** Review fires more often when context is hot, and once after every successful compaction.
3. **Pressure bands = tokens-to-threshold.** Band derived from `currentTokens / thresholdTokens` (how close compaction is to firing), not a raw percentage.
4. **Memory storage hardening (folded in).** Memory writes only to SQLite/PGlite; per-entry size cap + store-bound LRU eviction so pi's `4868/5000` client-cap overflow cannot recur from our path. Overflow behavior = **truncate** with a `[truncated]` marker (long memories cut, never silently dropped). Store management = **protect + prune** (consolidate near-duplicates first, then LRU evict).

---

## PROBLEM / MOTIVATION

Three subsystems run as independent triggers that only coincidentally coexist:

- **Auto-compact** fires when `currentTokens >= config.thresholdTokens` (`mega-events.ts:222`). Trim depth + brotli quality already scale with `pressureFromPct()` (partial coupling).
- **Tier** (`low..mega`) is a *static* threshold preset. Nothing auto-escalates it, so the toolbar/dashboard label never moves — the user's observation. Only `/mega-tier` changes it.
- **Memory auto-review** fires on a fixed `turn % 10` modulo (`mega-events.ts:170`), blind to pressure and to compaction.

Goal: make **context pressure the single driver** so the label moves, compaction fires proportionally, and memory keeps pace with session density. The `4868/5000 chars` error during a session revealed a second gap: pi-mega-compact memory must own its storage (SQLite/PGlite) and never lean on pi's capped file buffer.

---

## CORE CONCEPT: one `pressure` signal on MegaRuntime

`MegaRuntime` already holds `lastCtxTokens`, `lastCtxPercent`, `lastCtxWindow`, updated at the top of every `context` event. Add a derived pressure model there.

### Pressure = tokens-to-threshold ratio

```
pressure = clamp01(currentTokens / thresholdTokens)   // 0 = empty, 1 = at fire point, >1 = over
```

`thresholdTokens` stays the fire point (still seeded by `MEGACOMPACT_TIER` / `MEGACOMPACT_THRESHOLD_TOKENS` at load — the env keeps working as the *base* threshold). The tier label becomes a *readout of pressure*, decoupled from the static preset name.

### Pressure → tier band (display + behavior)

| Band     | tokens/threshold | Meaning                                   |
|----------|------------------|-------------------------------------------|
| `low`    | < 0.50           | calm — plenty of headroom                 |
| `medium` | 0.50 – 0.75      | filling                                   |
| `high`   | 0.75 – 0.90      | hot — near fire point                     |
| `ultra`  | 0.90 – 1.00      | critical — compaction imminent            |
| `mega`   | ≥ 1.00           | at/over fire point — compacting           |

Pure function `pressureBand(tokens, threshold): CompactTier`.

### What the band drives

- **Display:** widget line 1 (`mega-runtime.ts:286`) and dashboard snapshot (`mega-runtime.ts:217`) show the live band. The label now climbs `low→medium→high→ultra→mega` as context fills — the fix.
- **Trim depth:** already scales via `pressureFromPct()`; switch it to read the unified `runtime.pressure` (single source, behavior ~unchanged).
- **Memory cadence:** effective interval scales with band (below).

---

## EXECUTION (changes by file)

### `extensions/mega-config.ts`
- Keep `COMPACT_TIERS` + `resolveThreshold()` — they still seed `thresholdTokens` from `MEGACOMPACT_TIER`/`MEGACOMPACT_THRESHOLD_TOKENS` at load.
- Repurpose `config.tier`: stop treating it as the live label; keep `thresholdTokens` as authoritative for the gate.
- **Remove `setTier`** (only used by `/mega-tier`).
- Add pure helpers: `pressureRatio(tokens, threshold)` and `pressureBand(tokens, threshold)`.

### `extensions/mega-runtime.ts`
- Add `get pressure(): number` and `get pressureBand(): CompactTier` from `lastCtxTokens` / `config.thresholdTokens`.
- Dashboard snapshot (`:217`): `tier: this.pressureBand` (live) + numeric `pressure` field for the dashboard UI.
- Widget line 1 (`:286`): show `⚡ ${this.pressureBand}` (live band) — keep the version pill; optionally tint by band (green→amber→red).

### `extensions/mega-events.ts`
- **Memory review (`:170`):** replace fixed modulo with pressure-scaled interval:
  ```
  effInterval = round(config.memoryReviewInterval * intervalScale(pressure))
  // intervalScale: ~1.5x when calm (low), 1.0x medium, ~0.5x when hot (high+)
  fire when currentTurn % max(1, effInterval) === 0
  ```
  Extract the review body into a `runMemoryReview(ctx)` helper so it can be called from two places.
- Auto-trigger (`:234`): read `runtime.pressure` instead of computing `pressureFromPct` locally (single source).

### `extensions/mega-pipeline.ts`
- **Review-on-compact:** after a *successful* compaction, call `runMemoryReview(ctx)` (best-effort, non-fatal) around the existing `consolidateMemories` gate, so a compaction always refreshes memory. Keep the `memoriesTouchedThisCompaction > 0` gate for consolidation.
- Pressure arg for `preserveRecentForPressure` / `compressSmart`: source from `runtime.pressure`.

### `extensions/mega-commands.ts`
- **Delete the `/mega-tier` command** (`:242–264`) and its `setTier`/`CompactTier` imports. `/mega-status` (`:129`) shows the live band + threshold + pressure %.

### `src/memory.ts` / `src/memoryOps.ts` (storage hardening)
- **Per-entry size cap:** `MEMORY_MAX_CHARS` (default 4000). Trim overflow with a `[truncated]` marker; never let a write fail on size.
- **Store-bound prune:** when `memories` exceeds `MEMORY_MAX_ROWS` (default 500) or total bytes, run `consolidateMemories()` (near-duplicate merge) first, then LRU-evict lowest `last_referenced` / oldest `source_turn`.
- **No file fallback:** confirm `applyMemoryOps` / `reviewConversation` write only via the SQLite helpers; remove any path that appends to pi's `MEMORY.md`/file memory.
- **(Optional) PGlite mirror:** mirror memory rows into the existing async PGlite store (`src/store/vectorIndex.ts`) for cross-repo memory recall, same degrade-to-sync pattern. Kill-switch = `MEGACOMPACT_PGLITE_DISABLED`. Keep memory authoritative in SQLite.

New config (in `src/config/dedup.ts` or a `memory` block):
- `MEGACOMPACT_MEMORY_MAX_CHARS` (default 4000) — per-entry truncation cap.
- `MEGACOMPACT_MEMORY_MAX_ROWS` (default 500) — store size before LRU eviction.

### Docs + tests
- README: replace "Set the compaction tier" with a note that tier is an automatic pressure readout; drop `/mega-tier` from the command table; update the config table (`MEGACOMPACT_TIER` now = base threshold). Document the memory storage hardening + new env vars.
- TESTER_GUIDE: update Scenario 1 (tier auto-climbs with context), remove the `/mega-tier` step, add a memory-cadence-under-pressure check and a memory-overflow (truncate + LRU) check.
- Tests:
  - Unit test `pressureBand()` / `pressureRatio()` boundaries.
  - Drop `/mega-tier` coverage from `mega-commands.test.ts`.
  - Update any test asserting a static `tier` on the snapshot/widget to expect the derived band.
  - Test that memory review fires on compaction and interval shrinks under high pressure.
  - Memory hardening: entry over `MEMORY_MAX_CHARS` truncated with marker; store over `MEMORY_MAX_ROWS` evicts LRU after consolidate; writes go to SQLite only.

---

## ACCEPTANCE

- Widget + dashboard tier label visibly climbs `low→…→mega` as context fills and falls back as it's relieved (post-compaction).
- `/mega-tier` is gone; `/mega-status` reports live band + pressure %.
- Memory review fires more often under pressure AND once per successful compaction.
- Trim depth/compression read the same `runtime.pressure`.
- **Memory writes only to SQLite/PGlite (never pi's file buffer); entries are size-capped and the store is bounded by consolidate + LRU eviction — the `4868/5000` client-cap failure cannot recur from our path.**
- `npm run lint`, `python3 scripts/regression_check.py --all`, full test suite green.
- Version bump (0.5.2 → 0.6.0, behavior change) + publish, per project workflow.

---

## ROLLBACK

- `MEGACOMPACT_TIER` still pins the base threshold. If auto-band is unwanted, a single env flag (`MEGACOMPACT_STATIC_TIER=1`) restores the frozen label (optional escape hatch — add only if desired).
- Memory hardening is purely additive (new caps + eviction); removing it reverts to unbounded SQLite growth but no data loss.
