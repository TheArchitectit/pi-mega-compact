# Roadmap — RAPTOR Promotion + Dedup Pipeline (raptor-promotion branch)

> Consolidated roadmap for P1 and P2 deferred work. This branch focuses on RAPTOR
> Promotion as the primary deliverable, with cross-repo E2E and memory round-trip
> as parallel P1 items, and Phase 2-4 compression/dedup enhancements as P2.

**Branch:** `raptor-promotion`
**Created:** 2026-07-20
**Target version:** v0.9.0

---

## P1 — High Priority (Primary Deliverables)

### S25-A — RAPTOR Promotion: Harden Live Hierarchical Recall

**Source:** `docs/specs/s25-raptor-promote.md`
**Status:** ⬜ NOT STARTED
**Priority:** P1 (correctness + latency hardening)

**Problem:** RAPTOR was promoted from shadow to live but the promotion is implicit and fragile:

1. Shadow gate `RAPTOR_SHADOW_MODE` is inert for serving (logging-only)
2. No freshness check — stale trees can serve
3. `parentId` is always null — future parent-walks break silently
4. High-level summaries NOT injected — only leaf checkpoints
5. Per-recall rebuild + linear scan — O(n·leaves) with no cache
6. No coverage/latency acceptance tests

**Work Items (10 tasks):**

- [ ] Add `built_at` column to `raptor_nodes` schema
- [ ] Plumb `builtAt` through `runRaptor` → `saveRaptorTree` → `upsertRaptorNode`
- [ ] Extend `rehydrateRaptorTree` to return `builtAt` + `timedOut` metadata
- [ ] Add `raptorCache` to `VectorStore` class (per-session, invalidated on save)
- [ ] Honor `RAPTOR_SHADOW_MODE=false` as hard SERVE gate in `raptorSearchHits`
- [ ] Freshness guard: skip stale trees (`builtAt < maxCheckpointTimestamp`)
- [ ] Skip `timedOut` extractive-fallback trees (level===99)
- [ ] Record `raptor_serve` events for canary p95 monitoring
- [ ] Optional: `RAPTOR_INJECT_SUMMARIES` flag for high-level summary injection
- [ ] Tests: shadow mode, stale fallback, coverage breadth, p95 latency

**Files:**

- `src/store/sqlite.ts` — `raptor_nodes` schema + `built_at` column
- `src/dedup/raptor/index.ts` — `builtAt` param, `rehydrateRaptorTree` metadata
- `src/vectorStore.ts` — `raptorCache`, serve gate, freshness check
- `src/config/dedup.ts` — `RAPTOR_INJECT_SUMMARIES` flag
- `src/recall.ts` — optional `formatRaptorBlock`
- `extensions/mega-pipeline.ts` — pass `builtAt` from checkpoint timestamps
- `src/dedup/raptor/serve-gate.test.ts` — new test file

---

### S25-B — Cross-Repo E2E

**Source:** `docs/specs/s25-cross-repo.md`
**Status:** ⬜ NOT STARTED
**Priority:** P1 (headline feature has no automated two-repo proof)

**Problem:** The "start in repo B, recall repo A" capability has no automated two-repo proof. Current tests fake one half or mock `searchAsync` entirely.

**Work Items (9 tasks):**

- [ ] `src/store/repoKey.ts` — shared `repoKey()` + `stateDirForRepo()` helpers
- [ ] `src/vectorStore.ts` — use `repoKey(stateDir)` for repoId
- [ ] `src/memoryOps.ts` — use `repoKey()` instead of local resolver
- [ ] `extensions/mega-conflict-cmds.ts` — assert `repo == repoKey(stateDir)`
- [ ] `scripts/cross-repo-e2e.mjs` — headless two-repo driver (A/B/C phases)
- [ ] Phase A: checkpoint recall on resume (repo A checkpoint → repo B session_start)
- [ ] Phase B: memory augmentation (repo A decision → repo B memory block)
- [ ] Phase C: kill-switch + corrupt fallback tests
- [ ] Unit-test hardening: vectorIndex corrupt-self-heal, recall.test.ts real HNSW

**Files:**

- `src/store/repoKey.ts` — new
- `src/vectorStore.ts` — repoId change
- `src/memoryOps.ts` — repoKey integration
- `scripts/cross-repo-e2e.mjs` — new
- `src/store/vectorIndex.test.ts` — extend
- `src/recall.test.ts` — extend
- `TESTER_GUIDE.md` — add two-repo manual check

---

### S25-C — Durable-Memory DB Round-Trip

**Source:** `docs/specs/s25-memory-db-roundtrip.md`
**Status:** ⬜ NOT STARTED
**Priority:** P1 (test/doc only by default)

**Problem:** The durable-memory subsystem is individually unit-tested but the end-to-end chain is unproven:

- No full round-trip test (review → apply → recall → inline)
- No resume-inline E2E (`pendingMemoryRecallBlock` through handler chain)
- No bloat assertion (review path stays bounded)
- Hallucination guard unproven
- `consolidateMemories` untested
- Cross-repo floor inconsistency (0.3 vs 0.90)

**Work Items (7 tasks):**

- [ ] `extensions/mega-memory-roundtrip.test.ts` — headless E2E driver
- [ ] E1: `turn_end` auto-review writes a memory
- [ ] E2: `session_start` → `before_agent_start` inlines memory block
- [ ] `src/memoryRoundtrip.test.ts` — full src-level round-trip
- [ ] Bloat assertion: review path stays ≤ `MEMORY_MAX_ROWS`
- [ ] Hallucination guard + `consolidateMemories` unit tests
- [ ] Cross-repo floor reconciliation (code vs docs)

**Files:**

- `extensions/mega-memory-roundtrip.test.ts` — new
- `src/memoryRoundtrip.test.ts` — new
- `src/memory.test.ts` — extend
- `TESTER_GUIDE.md` — extend §10

---

## P2 — Medium Priority (Phase 2-4 from PLAN.md)

### Phase 2 — Enhanced Compression + Content-Addressable Dedup

**Source:** `PLAN.md` Phase 2
**Status:** ⬜ NOT STARTED
**Priority:** P2

**Work Items (7 tasks):**

- [ ] Add zstd compression tiers (tags `0x03`, `0x04` for zstd-3/9)
- [ ] Add brotli tag `0x05` for large blobs (currently `0x03`)
- [ ] Content-addressable SHA-256 dedup on write
- [ ] `CompressedOriginal` for digest audit trail (reconstructible context)
- [ ] Streaming decompression for large checkpoint arrays
- [ ] Migration: add `content_hash` column to checkpoints
- [ ] Tests for new tiers + dedup logic

**Files:**

- `src/store/compression.ts` — zstd tiers
- `src/store.ts` — content hashing
- `src/store/sqlite.ts` — `content_hash` column

---

### Phase 3 — Tier 0 Exact Match Upgrade

**Source:** `PLAN.md` Phase 3
**Status:** ⬜ NOT STARTED
**Priority:** P2

**Work Items (7 tasks):**

- [ ] Normalized content hashing (lowercase, strip ANSI, collapse whitespace)
- [ ] SQLite UNIQUE index with NOT NULL constraint
- [ ] Optional Bloom filter pre-check (feature-flagged)
- [ ] Optional Redis cache (accelerator-only, never sole arbiter)
- [ ] Circuit breaker on Redis (timeout + fallback to DB-only)
- [ ] Transactional coupling: DB + cache update in single transaction
- [ ] Backfill strategy: UNIQUE index BEFORE backfill

**Files:**

- `src/dedup/contentHash.ts` — new
- `src/store/sqlite.ts` — UNIQUE index
- `src/dedup/bloom.ts` — optional Bloom filter

---

### Phase 4 — Tier 1 Near-Duplicate (MinHash + LSH)

**Source:** `PLAN.md` Phase 4
**Status:** ⬜ NOT STARTED
**Priority:** P2

**Work Items (6 tasks):**

- [ ] MinHash with universal hashing (proper a_i, b_i, p parameters)
- [ ] LSH banding (20 bands × 12 rows, Jaccard threshold 0.7)
- [ ] FTS5 trigram verification layer (pg_trgm-equivalent)
- [ ] Candidate caps: 50 per bucket, 200 DB roundtrips per batch
- [ ] `minhash_signatures` table + migration
- [ ] Benchmark: latency per chunk at 1K, 10K, 100K chunks

**Files:**

- `src/dedup/minhash.ts` — new
- `src/dedup/lsh.ts` — new
- `src/store/sqlite.ts` — `minhash_signatures` table

---

## Execution Order

**Sprint 1 (P1):**

1. S25-A RAPTOR Promotion (primary focus)
2. S25-B Cross-Repo E2E (parallel, test-only)
3. S25-C Memory Round-Trip (parallel, test-only)

**Sprint 2 (P2 - optional, future branch):**

1. Phase 2: Zstd + Content Dedup
2. Phase 3: Tier 0 Exact Match
3. Phase 4: Tier 1 Near-Duplicate

---

## Acceptance Gates

### P1 Acceptance

- [ ] RAPTOR: `RAPTOR_SHADOW_MODE=false` disables serving; freshness guard works; p95 < 100ms
- [ ] Cross-Repo: Two-repo E2E passes all phases (checkpoint + memory + fallback)
- [ ] Memory: Full round-trip proven; bloat bounded; hallucination guard verified
- [ ] All existing tests green; no regressions
- [ ] `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all` clean

### P2 Acceptance

- [ ] Zstd compression working with backward compatibility
- [ ] Content-addressable dedup reduces storage
- [ ] MinHash/LSH catches near-duplicates that exact-hash misses
- [ ] All P1 acceptance criteria still pass

---

## Rollback

All P1 items are **additive + non-breaking**:

- RAPTOR: `MEGACOMPACT_RAPTOR_ENABLED=false` → flat MMR fallback
- Cross-Repo: `MEGACOMPACT_PGLITE_DISABLED=true` → same-repo-only fallback
- Memory: Test-only, no runtime changes by default

P2 items are **feature-flagged** and can be disabled individually.

---

## References

- `docs/specs/s25-raptor-promote.md`
- `docs/specs/s25-cross-repo.md`
- `docs/specs/s25-memory-db-roundtrip.md`
- `PLAN.md` Phase 2-4
- `BACKLOG.md`

---

*Last updated: 2026-07-20*
