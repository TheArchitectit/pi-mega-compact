# Backlog — pi-mega-compact

> Deferred work from PLAN.md, sprint specs, and design docs. Items are marked
> by priority and source doc. This is a living document — update as work ships.

---

## P1 — High Priority (Next Branch Candidates)

### S25 — RAPTOR Promotion: Harden Live Hierarchical Recall

**Source:** `docs/specs/s25-raptor-promote.md`
**Status:** ✅ SHIPPED — v0.8.25 (2026-07-28). All 10 work items done (gates, freshness, cache, monitoring) + 5-gate acceptance suite (`src/dedup/raptor/serve-gate.test.ts`). Phase-2 flag `RAPTOR_INJECT_SUMMARIES` also shipped default-ON.

**Problem:** RAPTOR was promoted from shadow to live between S13 and this branch, but the promotion is implicit and fragile:

1. ~~Shadow gate `RAPTOR_SHADOW_MODE` is inert for serving (logging-only)~~ ✅ hard SERVE gate live
2. ~~No freshness check — stale trees can serve~~ ✅ `builtAt < maxCheckpointTimestamp` guard live
3. `parentId` is always null — future parent-walks break silently (tracked separately, non-blocking)
4. ~~High-level summaries NOT injected~~ ✅ `RAPTOR_INJECT_SUMMARIES` (default ON) prepends overview header
5. ~~Per-recall rebuild + linear scan — O(n·leaves) per recall with no cache~~ ✅ `raptorCache` per-session + indexed `maxRaptorNodeBuiltAt` invalidation (`src/vector-search.ts:76-87`)
6. ~~No coverage/latency acceptance tests~~ ✅ `serve-gate.test.ts` (5 gates: shadow / stale / timedOut / breadth / p95<100ms)

**Work Items:**

- [x] Honor `RAPTOR_SHADOW_MODE=false` as hard SERVE gate (not just logging)
- [x] Add `built_at` freshness guard — skip stale trees
- [x] Cache rehydrated `RaptorTree` per session
- [x] `RAPTOR_INJECT_SUMMARIES` flag for high-level summary injection (Phase 2, default ON)
- [x] Monitoring: `raptor_serve` events for canary p95
- [x] Tests: shadow mode disables serve, stale tree fallback, coverage breadth, p95 latency

---

### S25 — Cross-Repo E2E

**Source:** `docs/specs/s25-cross-repo.md`, `docs/WORK_STATUS.md`
**Status:** ⬜ NOT STARTED

**Problem:** The headline "start in repo B, recall repo A" capability has no automated two-repo proof.

**Work Items:**

- [ ] `src/store/repoKey.ts` — shared `repoKey()` + `stateDirForRepo()`
- [ ] `src/vectorStore.ts` — repoId = `repoKey(stateDir)`; hydrate via `stateDirForRepo`
- [ ] `src/memoryOps.ts` — use `repoKey()` instead of local `resolveRepoRootLocal`
- [ ] `extensions/mega-conflict-cmds.ts` — assert `repo == repoKey(stateDir)`
- [ ] `scripts/cross-repo-e2e.mjs` — headless two-repo driver (A/B/C phases)
- [ ] Tests: corrupt-self-heal, dim-guard, content de-dup in cross-repo path

---

### S25 — Durable-Memory DB Round-Trip

**Source:** `docs/specs/s25-memory-db-roundtrip.md`, `docs/WORK_STATUS.md`
**Status:** ⬜ NOT STARTED (test/doc only by default)

**Work Items:**

- [ ] `extensions/mega-memory-roundtrip.test.ts` — headless E2E driver
- [ ] `src/memory.test.ts` — hallucination guard + `consolidateMemories` unit coverage
- [ ] `src/memoryRoundtrip.test.ts` — full write→recall→inline
- [ ] Bloat assertion: review path stays ≤ `MEMORY_MAX_ROWS`
- [ ] Cross-repo floor: wired value pinned; docs and code agree

---

## P2 — Medium Priority (Phase 2-4 from PLAN.md)

> **⚠ SUPERSEDED (2026-07-27):** These three phases already shipped as
> **sprints 9-11** (see `docs/specs/sprint-09.md`, `sprint-10.md`,
> `sprint-11.md` — all marked DONE 2026-07-13). Kept below for historical
> reference only; do NOT treat as pending work.

### Phase 2 — Enhanced Compression + Content-Addressable Dedup

**Source:** `PLAN.md` Phase 2
**Status:** ✅ SHIPPED — Sprint 9 (zstd tiers `0x03`/`0x04`, brotli `0x05`, SHA-256 content dedup, `content_hash` column; `src/store/compression.ts`)

**Work Items:**

- [ ] Add zstd compression tiers (tags `0x03`, `0x04` for zstd-3/9)
- [ ] Add brotli tag `0x05` for large blobs (currently `0x03`)
- [ ] Content-addressable SHA-256 dedup on write
- [ ] `CompressedOriginal` for digest audit trail
- [ ] Streaming decompression for large checkpoint arrays
- [ ] Migration: add `content_hash` column to checkpoints
- [ ] Tests for new tiers + dedup logic

---

### Phase 3 — Tier 0 Exact Match Upgrade

**Source:** `PLAN.md` Phase 3
**Status:** ✅ SHIPPED — Sprint 10 (normalized hashing + `src/store/bloom.ts`; Redis accelerator descoped per PREVENT-PI-004 → local Bloom pre-check instead)

**Work Items:**

- [ ] Normalized content hashing (lowercase, strip ANSI, collapse whitespace)
- [ ] SQLite UNIQUE index with NOT NULL constraint
- [ ] Optional Bloom filter pre-check (feature-flagged)
- [ ] Optional Redis cache (accelerator-only, never sole arbiter)
- [ ] Circuit breaker on Redis (timeout + fallback to DB-only)
- [ ] Transactional coupling: DB + cache update in single transaction
- [ ] Backfill strategy: UNIQUE index BEFORE backfill, or CONCURRENTLY
- [ ] Tests for race conditions, NULL handling, cache staleness

---

### Phase 4 — Tier 1 Near-Duplicate (MinHash + LSH)

**Source:** `PLAN.md` Phase 4
**Status:** ✅ SHIPPED — Sprint 11 (`src/dedup/l1-minhash.ts`, `src/dedup/l1-lsh.ts`, FTS5 trigram verify, `minhash_signatures` table)

**Work Items:**

- [ ] MinHash with universal hashing (proper a_i, b_i, p parameters)
- [ ] LSH banding (20 bands × 12 rows)
- [ ] FTS5 trigram verification layer (pg_trgm-equivalent)
- [ ] Candidate cap (50 per bucket, 200 DB roundtrips per batch)
- [ ] `minhash_signatures` table + migration
- [ ] Benchmark: latency per chunk at 1K, 10K, 100K chunks

---

## P3 — Lower Priority (Future Game Mode)

### Game Mode Deferred Items

**Source:** `docs/specs/game-mode-sprint-plan.md` §7
**Status:** ⬜ DEFERRED

**Work Items:**

- [ ] Mini-game inside the High Score dashboard
- [ ] Time-windowed leaderboards (daily/weekly)
- [ ] Per-repo theme overrides
- [ ] Animated transitions between themes in the TUI

---

## Shipped Items (Reference)

### S44-S35 — Game Mode (v0.8.0)

- ✅ S44: Foundation (game_state table, themes, /mega-game command)
- ✅ S45: TUI widget theming + full/minimal display modes
- ✅ S46: Dashboard CSS-variable skin + settings strip
- ✅ S47: Scoring schema + hooks (cache/dedupe/turns/repos scores)
- ✅ S34: Game Mode dashboard tab (leaderboards, MEGA CACHE banner, Opie easter egg)
- ✅ S35: Achievements system (9 achievements + hidden Opie unlock)

### Slice 1-2 — PGlite Vector Index (v0.4.23-v0.4.25)

- ✅ Slice 1: node:sqlite sync store
- ✅ Slice 2: PGlite + pgvector HNSW async index

### S16-S24 — Compaction Continuity + Cross-Repo + Memory-RAG (v0.5.0-v0.6.2)

- ✅ S16: Live context-event trim (compact and continue)
- ✅ S17: Cross-repo recall wire-up
- ✅ S18: Global injected-set + repo registry
- ✅ S19: Multi-repo dashboard
- ✅ S20: Memory auto-review
- ✅ S21: Memory recall inclusion + consolidation
- ✅ S22: Dual-backend docs
- ✅ S24: Unified pressure + memory DB hardening

### S40-S43 — Dashboard + Threshold (v0.7.x)

- ✅ S40: Dashboard overhaul
- ✅ S41: Tiered percent threshold
- ✅ S42: Max output token auto-continue
- ✅ S43: Percent auto-trigger

---

## Summary Table

| Priority | Item | Source | Status |
| ---------- | ------ | -------- | -------- |
| P1 | ~~RAPTOR Promotion~~ ✅ v0.8.25 | s25-raptor-promote.md | ✅ |
| P1 | Cross-Repo E2E | s25-cross-repo.md, WORK_STATUS.md | ⬜ |
| P1 | Memory DB Round-Trip | s25-memory-db-roundtrip.md | ⬜ |
| P2 | Phase 2: Zstd + Content Dedup | PLAN.md | ✅ Sprint 9 |
| P2 | Phase 3: Tier 0 Exact Match | PLAN.md | ✅ Sprint 10 |
| P2 | Phase 4: Tier 1 Near-Duplicate | PLAN.md | ✅ Sprint 11 |
| P3 | Game Mode: Mini-game | game-mode-sprint-plan.md | ⬜ |
| P3 | Game Mode: Time-windowed leaderboards | game-mode-sprint-plan.md | ⬜ |
| P3 | Game Mode: Per-repo themes | game-mode-sprint-plan.md | ⬜ |
| P3 | Game Mode: Theme transitions | game-mode-sprint-plan.md | ⬜ |
| P2 | **S49: conversation-tracking DB + Dashboard tab (turns / turn_recall / conversation_branches → dedicated DB + prune/vacuum/threshold controls)** | [docs/specs/s49-conversation-db-dashboard.md](docs/specs/s49-conversation-db-dashboard.md) | ⬜ |

---

## Notes

- **RAPTOR Promotion** fully shipped v0.8.25 — serve gate, freshness, session cache, monitor events, 5-gate acceptance suite, and the Phase-2 `RAPTOR_INJECT_SUMMARIES` flag all live.
- **Cross-Repo E2E** is a missing test proof, not new functionality — the feature shipped in v0.5.0 but lacks automated two-repo verification.
- **Phase 2-4** shipped as sprints 9-11 (2026-07-13); sections retained for reference.
- **Sprint numbering collision:** `docs/specs/s40`-`s47` (RAG suite) reuse numbers already spent on earlier shipped work (see BACKLOG Shipped Items + ROADMAP numbering note).

---

*Last updated: 2026-07-28 (v0.8.26 doc-release; S25 marked shipped)*
