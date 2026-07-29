# Roadmap — pi-mega-compact

> Consolidated roadmap for P1/P2 deferred work. Current version: v0.10.0 (master).
> The `raptor-promotion` branch has been merged into master.

**Branch:** `master`
**Current version:** v0.10.0

---

## Shipped Sprints (Reference)

| Sprint | Description | Version | Date |
| --- | --- | --- | --- |
| S25-A | RAPTOR Promotion (serve gate + freshness + cache + monitoring) | v0.8.25 | 2026-07-28 |
| S25-B | Cross-Repo E2E (repoKey unification + headless two-repo driver) | v0.9.0 | 2026-07-29 |
| S25-C | Durable-Memory Round-Trip (memory DB suite + test-runner hardening) | v0.9.0 | 2026-07-29 |
| S42 | Multi-Level Retrieval (S42A engine + S42B integration + S42D build history) | v0.8.25 | 2026-07-28 |
| S48 | Per-Turn Tracking core (turns/recall/fork tables + provenance writers) | v0.8.25 | 2026-07-28 |
| S9 | Zstd + Content Dedup | v0.1.x | 2026-07-13 |
| S10 | Tier 0 Exact Match (Bloom pre-check) | v0.1.x | 2026-07-13 |
| S11 | Tier 1 Near-Duplicate (MinHash+LSH) | v0.1.x | 2026-07-13 |

---

## P1 — High Priority (Next Work)

### S48 — Per-Turn Tracking: Deferred Wiring

**Source:** `docs/specs/s48-per-turn-vector-tracking.md`
**Status:** ✅ SHIPPED (v0.8.25 + S49 program) — per-turn tracking landed via S49/S50. The five deferred items below are all addressed: `raw_transcript.turn_index` is populated, `turns.epoch_id` is stamped via `asAdmin().stampTurnsEpoch` (S50B), the dashboard/query surface is the S52 Turns tab, `/mega-fork` is a primitive + dashboard action (S52).

**Resolved Work Items:**

- [x] Wire `raw_transcript.turn_index` population (S49 adapter)
- [x] Wire `turns.epoch_id` on compact commit — `stampTurnsEpoch` (S50B)
- [x] Dashboard / query surface — S52 Turns tab (turn-by-turn viz + recall)
- [ ] Live-window replay — `forkConversation` inherits recall state only; true rewind needs message-log snapshot (still a non-goal)
- [x] `/mega-fork` command — primitive + dashboard Fork action (S52)

---

### S49 — Turn-DB Foundation (Contract-First)

**Source:** `docs/specs/s49-turn-db-foundation.md`
**Status:** ✅ SHIPPED — contract-first TurnStore (reconciled s49-turn-db ∪ master) v0.10.0-dev
**Priority:** P1 (foundation for the S49–S52 program)

**Work Items (from spec, S49A/S49B/S49C gated):**

- [x] S49A: `TurnStore` contract (`types.ts`) + `SqliteTurnStore` + `InMemoryTurnStore` + shared compliance suite
- [x] S49B: Migration (main-db → turns.db) + config flags (`TURNS_DB_ENABLED`)
- [x] S49C: Retention + `StoreSnapshot` + adapter re-point + legacy quarantine

---

## P2 — Medium Priority (Platform + RAG Suite)

### S50 — Per-Turn Metrics + Fork

**Source:** `docs/specs/s50-per-turn-metrics-fork.md`
**Status:** ✅ SHIPPED — per-turn metrics + `forkFromConversation` primitive + `/mega-metrics` command (reconciled to the contract-first store)
**Depends on:** S49

### S51 — Auto-Categorizing Wiki (replaces S47)

**Source:** `docs/specs/s51-auto-categorizing-wiki.md`
**Status:** ✅ SHIPPED — topics + memory_topics tables + k-means+TF-IDF clustering + `/mega-topics` command + `/api/topics` + TopicsTab
**Depends on:** S49

### S52 — Dashboard Management + Rewind

**Source:** `docs/specs/s52-dashboard-management-rewind.md`
**Status:** ✅ SHIPPED — Turns tab (turn-by-turn memory viz + recall provenance), Wiki tab search + drill-down, fork action, rewind-intent handshake (`src/intent.ts` + `before_agent_start` consumer).
**Depends on:** S50, S51

### RAG Suite (spec-only, no consumer code)

| Sprint | Description | Spec |
| --- | --- | --- |
| S43 | HyDE Vague Queries (re-planned as local query reformulation) | `docs/specs/s43-hyde-vague-queries.md` |
| S44 | Three-Tier Latency Routing | `docs/specs/s44-three-tier-latency-routing.md` |
| S45 | CRAG Quality Metrics | `docs/specs/s45-crag-quality-metrics.md` |
| S46 | Visual Memory Map | `docs/specs/s46-visual-memory-map.md` |

---

## P3 — Lower Priority (Future)

### Game Mode Deferred Items

- [ ] Mini-game inside the High Score dashboard
- [ ] Time-windowed leaderboards (daily/weekly)
- [ ] Per-repo theme overrides
- [ ] Animated transitions between themes in the TUI

---

## Execution Order

**Next (P1):**

1. S49 Turn-DB Foundation (contract-first, S49A→S49B→S49C)
2. S48 Deferred Wiring (turn_index, epoch_id, dashboard surface)

**Then (P2):**

1. S50 Per-Turn Metrics + Fork
2. S51 Auto-Categorizing Wiki
3. S52 Dashboard Management + Rewind

---

## Rollback

All items are **additive + non-breaking**:

- RAPTOR: `MEGACOMPACT_RAPTOR_ENABLED=false` → flat MMR fallback
- Multi-level: `MEGACOMPACT_RAPTOR_MULTILEVEL=false` → leaf-only retrieval
- Cross-Repo: `MEGACOMPACT_PGLITE_DISABLED=true` → same-repo-only fallback
- Turns DB: `MEGACOMPACT_TURNS_DB=0` → legacy main-db path (S49 flag)

---

## References

- `docs/specs/s49-program-per-turn-memory-platform.md` — the 4-sprint program
- `docs/specs/s49-rev1-architecture-upgrade.md` — v0→v1 revision record
- `docs/ENGINEERING_PRACTICES.md` — codified structural conventions
- `BACKLOG.md`

---

*Last updated: 2026-07-29 (raptor-promotion merged to master; v0.10.0; S25-B/C marked shipped; S49 upgraded to P1)*
