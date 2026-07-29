# Roadmap — RAPTOR Promotion + Dedup Pipeline (raptor-promotion branch)

> Consolidated roadmap for P1/P2 deferred work. The original PLAN.md Phase 2-4
> compression/dedup work shipped as sprints 9-11 (kept for reference only).
> Current focus: S48 deferred wiring, then S25-B/C E2E proofs, then S49+ platform.

**Branch:** `raptor-promotion`
**Created:** 2026-07-20
**Current version:** v0.9.0

---

## Shipped Sprints (Reference)

| Sprint | Description | Version | Date |
| --- | --- | --- | --- |
| S25-A | RAPTOR Promotion (serve gate + freshness + cache + monitoring) | v0.8.25 | 2026-07-28 |
| S42 | Multi-Level Retrieval (S42A engine + S42B integration + S42D build history) | v0.8.25 | 2026-07-28 |
| S48 | Per-Turn Tracking core (turns/recall/fork tables + provenance writers) | v0.8.25 | 2026-07-28 |
| S9 | Zstd + Content Dedup | v0.1.x | 2026-07-13 |
| S10 | Tier 0 Exact Match (Bloom pre-check) | v0.1.x | 2026-07-13 |
| S11 | Tier 1 Near-Duplicate (MinHash+LSH) | v0.1.x | 2026-07-13 |

---

## P1 — High Priority (Next Branch Candidates)

### S48 — Per-Turn Tracking: Deferred Wiring

**Source:** `docs/specs/s48-per-turn-vector-tracking.md`
**Status:** 🔧 IN PROGRESS — core shipped v0.8.25; 5 items deferred
**Priority:** P1 (completes the per-turn tracking feature)

**Deferred Work Items:**

- [ ] Wire `raw_transcript.turn_index` population — column exists but `appendRawTranscript` doesn't set it. Thread `runtime.currentTurn` through the context-handler append path.
- [ ] Wire `turns.epoch_id` on compact commit — FK exists but `turn_end` doesn't set it. When a compact closes an epoch, stamp the turns in the closed epoch's seq range with the `epoch_id`.
- [ ] Dashboard / query surface — no UI yet for per-turn or per-conversation views. Data is SQL-queryable.
- [ ] Live-window replay — `forkConversation` inherits recall state only. True rewind needs message-log snapshot (behind flag, default OFF).
- [ ] `/mega-fork` command — `forkConversation` is a primitive, not a pi command.

**Files:**

- `src/store/sqlite/turns.ts` — `appendRawTranscript` wiring
- `src/store/sqlite/epochs.ts` — epoch_id stamping on compact
- `extensions/mega-events/agent-handlers.ts` — turn_end epoch wiring
- `extensions/dashboard-server.ts` — per-turn/conversation dashboard tab

---

### S25-B — Cross-Repo E2E

**Source:** `docs/specs/s25-cross-repo.md`
**Status:** ⬜ NOT STARTED
**Priority:** P1 (headline feature has no automated two-repo proof)

**Work Items (9 tasks):**

- [ ] `src/store/repoKey.ts` — shared `repoKey()` + `stateDirForRepo()` helpers
- [ ] `src/vectorStore.ts` — use `repoKey(stateDir)` for repoId
- [ ] `src/memoryOps.ts` — use `repoKey()` instead of local resolver
- [ ] `extensions/mega-conflict-cmds.ts` — assert `repo == repoKey(stateDir)`
- [ ] `scripts/cross-repo-e2e.mjs` — headless two-repo driver (A/B/C phases)
- [ ] Phase A: checkpoint recall on resume
- [ ] Phase B: memory augmentation
- [ ] Phase C: kill-switch + corrupt fallback tests
- [ ] Unit-test hardening: vectorIndex corrupt-self-heal, recall.test.ts real HNSW

---

### S25-C — Durable-Memory DB Round-Trip

**Source:** `docs/specs/s25-memory-db-roundtrip.md`
**Status:** ⬜ NOT STARTED
**Priority:** P1 (test/doc only by default)

**Work Items (7 tasks):**

- [ ] `extensions/mega-memory-roundtrip.test.ts` — headless E2E driver
- [ ] E1: `turn_end` auto-review writes a memory
- [ ] E2: `session_start` → `before_agent_start` inlines memory block
- [ ] `src/memoryRoundtrip.test.ts` — full src-level round-trip
- [ ] Bloat assertion: review path stays ≤ `MEMORY_MAX_ROWS`
- [ ] Hallucination guard + `consolidateMemories` unit tests
- [ ] Cross-repo floor reconciliation (code vs docs)

---

## P2 — Medium Priority (RAG Suite + Platform)

> **RAG Suite specs** (`docs/specs/s43`-`s47`) are spec-only — no consumer code
> or feature flags yet. S42 RAPTOR flags are ON by default and verified.

### S49 — Per-Turn Memory Platform

**Source:** `docs/specs/s49-program-per-turn-memory-platform.md`, `docs/specs/s49-turn-db-foundation.md`
**Status:** ⬜ SPEC ONLY (docs committed, no implementation)
**Priority:** P2

**Work Items (from S49 program spec):**

- [ ] Turn-DB foundation: dedicated DB, prune/vacuum/threshold controls
- [ ] Per-turn recall quality metrics (recall-hit-rate, miss-rate per turn)
- [ ] Dashboard tab for per-turn / per-conversation views
- [ ] Retention policies (time-windowed, conversation-scoped)

### S43 — HyDE Vague Queries

**Source:** `docs/specs/s43-hyde-vague-queries.md`
**Status:** ⬜ SPEC ONLY

### S44 — Three-Tier Latency Routing

**Source:** `docs/specs/s44-three-tier-latency-routing.md`
**Status:** ⬜ SPEC ONLY

### S45 — CRAG Quality Metrics

**Source:** `docs/specs/s45-crag-quality-metrics.md`
**Status:** ⬜ SPEC ONLY

### S46 — Visual Memory Map

**Source:** `docs/specs/s46-visual-memory-map.md`
**Status:** ⬜ SPEC ONLY

### S47 — Auto-Categorizing Wiki

**Source:** `docs/specs/s47-auto-categorizing-wiki.md`
**Status:** ⬜ SPEC ONLY

---

## P3 — Lower Priority (Future)

### Game Mode Deferred Items

- [ ] Mini-game inside the High Score dashboard
- [ ] Time-windowed leaderboards (daily/weekly)
- [ ] Per-repo theme overrides
- [ ] Animated transitions between themes in the TUI

---

## Execution Order

**Current Sprint:**

1. ~~S25-A RAPTOR Promotion~~ ✅ v0.8.25
2. ~~S42 Multi-Level Retrieval~~ ✅ v0.8.25
3. ~~S48 Core (turns/recall/fork)~~ ✅ v0.8.25
4. **S48 Deferred Wiring** — 🔧 IN PROGRESS
5. S25-B Cross-Repo E2E — next P1
6. S25-C Memory Round-Trip — next P1

**Future:**

1. S49 Per-Turn Memory Platform
2. S43-S47 RAG Suite (spec-only, prioritize by need)

---

## Acceptance Gates

### P1 Acceptance

- [x] S25-A: RAPTOR serve gate + freshness + cache + p95 < 100ms
- [x] S42: Multi-level retrieval + build history + coherence scores
- [x] S48 Core: turns/recall/fork tables + provenance writers
- [ ] S48 Wiring: `turn_index` populated + `epoch_id` stamped
- [ ] Cross-Repo: Two-repo E2E passes all phases
- [ ] Memory: Full round-trip proven; bloat bounded; hallucination guard verified
- [ ] All existing tests green; no regressions
- [ ] `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all` clean

### P2 Acceptance

- [x] S9: Zstd + content dedup (backward-compatible)
- [x] S10: Tier 0 exact match (Bloom pre-check)
- [x] S11: Tier 1 MinHash+LSH near-duplicate

---

## Rollback

All items are **additive + non-breaking**:

- RAPTOR: `MEGACOMPACT_RAPTOR_ENABLED=false` → flat MMR fallback
- Multi-level: `MEGACOMPACT_RAPTOR_MULTILEVEL=false` → leaf-only retrieval
- Cross-Repo: `MEGACOMPACT_PGLITE_DISABLED=true` → same-repo-only fallback
- Memory: Test-only, no runtime changes by default

---

## References

- `docs/specs/s25-raptor-promote.md`
- `docs/specs/s25-cross-repo.md`
- `docs/specs/s25-memory-db-roundtrip.md`
- `docs/specs/s42-raptor-multilevel-retrieval.md`
- `docs/specs/s48-per-turn-vector-tracking.md`
- `docs/specs/s49-program-per-turn-memory-platform.md`
- `docs/specs/s49-turn-db-foundation.md`
- `docs/specs/s43-hyde-vague-queries.md` — S47
- `BACKLOG.md`

---

*Last updated: 2026-07-28 (S48 deferred items documented; S42/S48 shipped status synced; S49-S52 specs added; QA audit results recorded; ROADMAP restructured)*

> **Numbering note:** the newer RAG specs (`docs/specs/s40`-`s47`) reuse sprint
> numbers already assigned to earlier shipped work. Treat the `docs/specs/s4x-*.md`
> files as a separate *RAG suite* series.
