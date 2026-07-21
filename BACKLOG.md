# Backlog — pi-mega-compact

> Deferred work from PLAN.md, sprint specs, and design docs. Items are marked
> by priority and source doc. This is a living document — update as work ships.

---

## P1 — High Priority (Next Branch Candidates)

### S25 — RAPTOR Promotion: Harden Live Hierarchical Recall

**Source:** `docs/specs/s25-raptor-promote.md`
**Status:** ⬜ NOT STARTED (RAPTOR built in shadow mode, never promoted to live serving)

**Problem:** RAPTOR was promoted from shadow to live between S13 and this branch, but the promotion is implicit and fragile:

1. Shadow gate `RAPTOR_SHADOW_MODE` is inert for serving (logging-only)
2. No freshness check — stale trees can serve
3. `parentId` is always null — future parent-walks break silently
4. High-level summaries NOT injected — only leaf checkpoints
5. Per-recall rebuild + linear scan — O(n·leaves) per recall with no cache
6. No coverage/latency acceptance tests

**Work Items:**

- [ ] Honor `RAPTOR_SHADOW_MODE=false` as hard SERVE gate (not just logging)
- [ ] Add `built_at` freshness guard — skip stale trees
- [ ] Cache rehydrated `RaptorTree` per session
- [ ] Optional: `raptorSummaryHits` flag for high-level summary injection (Phase 2)
- [ ] Monitoring: `raptor_serve` events for canary p95
- [ ] Tests: shadow mode disables serve, stale tree fallback, coverage breadth, p95 latency

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

### Phase 2 — Enhanced Compression + Content-Addressable Dedup

**Source:** `PLAN.md` Phase 2
**Status:** ⬜ NOT STARTED

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
**Status:** ⬜ NOT STARTED

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
**Status:** ⬜ NOT STARTED

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

### S30-S35 — Game Mode (v0.8.0)

- ✅ S30: Foundation (game_state table, themes, /mega-game command)
- ✅ S31: TUI widget theming + full/minimal display modes
- ✅ S32: Dashboard CSS-variable skin + settings strip
- ✅ S33: Scoring schema + hooks (cache/dedupe/turns/repos scores)
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

### S26-S29 — Dashboard + Threshold (v0.7.x)

- ✅ S26: Dashboard overhaul
- ✅ S27: Tiered percent threshold
- ✅ S28: Max output token auto-continue
- ✅ S29: Percent auto-trigger

---

## Summary Table

| Priority | Item | Source | Status |
| ---------- | ------ | -------- | -------- |
| P1 | RAPTOR Promotion | s25-raptor-promote.md | ⬜ |
| P1 | Cross-Repo E2E | s25-cross-repo.md, WORK_STATUS.md | ⬜ |
| P1 | Memory DB Round-Trip | s25-memory-db-roundtrip.md | ⬜ |
| P2 | Phase 2: Zstd + Content Dedup | PLAN.md | ⬜ |
| P2 | Phase 3: Tier 0 Exact Match | PLAN.md | ⬜ |
| P2 | Phase 4: Tier 1 Near-Duplicate | PLAN.md | ⬜ |
| P3 | Game Mode: Mini-game | game-mode-sprint-plan.md | ⬜ |
| P3 | Game Mode: Time-windowed leaderboards | game-mode-sprint-plan.md | ⬜ |
| P3 | Game Mode: Per-repo themes | game-mode-sprint-plan.md | ⬜ |
| P3 | Game Mode: Theme transitions | game-mode-sprint-plan.md | ⬜ |

---

## Notes

- **RAPTOR Promotion** is the most complete spec ready for implementation — acceptance criteria, rollback plan, and tests defined.
- **Cross-Repo E2E** is a missing test proof, not new functionality — the feature shipped in v0.5.0 but lacks automated two-repo verification.
- **Phase 2-4** are the original PLAN.md compression/dedup pipeline enhancements — still valuable but less urgent than RAPTOR hardening.

---

*Last updated: 2026-07-20 (v0.8.14 release)*
