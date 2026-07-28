## Review

### 1. Status table — all 46 specs in `docs/specs/`

| Spec | Status | Evidence |
|---|---|---|
| sprint-08.md → sprint-14.md (7 files) | DONE | Headers DONE; shipped with sprints 8–14 (v0.1.0→v0.2.0) |
| sprint-15.md | DONE (stale header "READY") | v0.2.0 release notes: "Sprint 15 — Benchmarks, DR drill, docs, release" |
| sprint-009-db-maintenance.md | DONE | Header DONE; `mega-db-cmds.ts` exists |
| fix-durable-trim.md | DONE | Header COMPLETE (Fix A–E, 301 tests) |
| fix-pglite-lazy-import.md | DONE | Header: Shipped v0.6.3 |
| slice2-pglite-vector-index.md | DONE (stale header "PLANNED") | CLAUDE.md: PGlite index shipped v0.4.25; `src/store/vectorIndex.ts` exists |
| s24-unified-pressure.md | DONE | Header IMPLEMENTED, v0.6.0 |
| s25-cross-repo.md | **PENDING (P1)** | Header SPEC; ROADMAP/BACKLOG: NOT STARTED |
| s25-memory-db-roundtrip.md | **PENDING (P1)** | Header PLANNED; ROADMAP: NOT STARTED |
| s25-raptor-promote.md | **PENDING (P1)** | Header "implement-ready"; ROADMAP: NOT STARTED |
| s27-tiered-percent-threshold.md | DONE | Header COMPLETE; v0.7.x (tiered % threshold in v0.7.1 notes) |
| s28-max-output-token-auto-continue.md | DONE | Header IMPLEMENTED, v0.7.8 |
| s29-percent-auto-trigger.md | DONE | Header IMPLEMENTED, v0.7.8 |
| sprint-26-diagnostic-0.6.9.md | ARCHIVAL | Diagnostic snapshot doc, not a sprint |
| sprint-26-rich-model-cost-card.md | DONE (stale header "DRAFT") | v0.7.1 "Savings by Model enrichment"; `SavingsByModelTable.tsx` exists |
| sprint-27-agent-token-telemetry.md | DONE (stale header "DRAFT") | v0.7.1 widget "Agent telemetry group"; commit 229c6e8 |
| sprint-27-db-mirror-cache-stability.md + -implementation.md | DONE | Header: Tasks 5–10 implemented, v0.7.4/v0.7.5, "S27 complete" |
| find-pressure-basis-oscillation.md | RESOLVED (stale header "fix not yet written") | Root cause (dual-basis switch) explicitly reconciled by S27 spec (v0.7.x shipped) |
| postmortem-already-compacted-race.md | ARCHIVAL | Post-mortem; guard shipped as S38.5 (v0.8.15) |
| game-mode-sprint-plan.md | DONE core (v0.8.0) | CHANGELOG v0.8.0 "Game Mode (S30–S35)"; 4 P3 items deferred |
| s38-error-retry.md | DONE (stale header "PLANNED") | v0.8.15 release notes + v0.8.21 ESC-cancel follow-up; `mega-compact-s38.test.ts` |
| s39-multi-pi-memory-graph.md | DONE (stale header "PLANNED") | v0.8.18–v0.8.21: Sessions tab, `session_heartbeats`, `token_samples`; `SessionsTab.tsx` |
| s40-importance-scoring.md | **PARTIAL — S40B-rev PENDING** | S40A engine shipped (`src/importance.ts`, commit f24311f) but **nothing imports it** — compactSession not wired |
| s41-self-rag-quality-gate.md | **PENDING** | No code: `src/recall.ts` has zero overlap/critique logic; no selfRag files |
| s42-raptor-multilevel-retrieval.md | **PARTIAL — S42B PENDING** | S42A shipped v0.8.23 (`src/dedup/raptor/multilevel.ts` + 9 tests) but **no importers** (dead engine); S42C deleted by re-plan |
| s43-hyde-vague-queries.md | **PENDING** | No hyde/hypothetical code in src/extensions |
| s44-three-tier-latency-routing.md | **PENDING** | No tier-routing / embedding-cache code |
| s45-crag-quality-metrics.md | **PENDING** | No CRAG/coverage-diversity code |
| s46-visual-memory-map.md | **PENDING** | No reactflow import; no MemoryMap tab (9 tabs, none a map) |
| s47-auto-categorizing-wiki.md | **PENDING** | No wiki/categorize code outside node_modules |
| sprint-A1, B1, C1, C2, C3, D1, D2, D3, T1 (9 files) | DONE (stale headers "PLANNED") | v0.8.14 release notes: React parity, D1 resilience, D2 diagnostics, T1 Tailscale/CSRF |

### 2. Pending sprints, ordered by priority

**Carryover cleanups (de-facto P0 — half-wired shipped engines):**
1. **S40B-rev** — Wire `src/importance.ts` scoring into `compactSession()`. Scope: 1 sprint, `src/engine.ts` + config flag. Deps: S40A (done). Risk: dead code until wired.
2. **S42B** — Wire `src/dedup/raptor/multilevel.ts` into VectorStore + config. Scope: small (engine done). Deps: S42A (done, v0.8.23). Conflicts with S25-A (same files).

**P1 (ROADMAP "Sprint 1", target v0.9.0):**
3. **S25-A RAPTOR Promotion** — Hard serve gate, `built_at` freshness guard, per-session tree cache, p95 monitoring. 10 tasks; touches `sqlite.ts`, `dedup/raptor/index.ts`, `vectorStore.ts`, `config/dedup.ts`, `recall.ts`, `mega-pipeline.ts`. Deps: S13/S14 (done).
4. **S25-B Cross-Repo E2E** — Headless two-repo proof (checkpoint + memory + fallback). 9 tasks; new `repoKey.ts` + `scripts/cross-repo-e2e.mjs`. Test-only. Deps: none pending.
5. **S25-C Memory DB Round-Trip** — write→recall→inline E2E, bloat + hallucination-guard tests. 7 tasks, test-only. Deps: S20/S21/S24 (done).

**P2 — RAG suite v0.9.x (S41 blocks the rest):**
6. **S41 Self-RAG quality gate** — word-overlap critique on recall injection (`recall.ts`, `vectorStore.ts`).
7. **S43 HyDE vague-query reformulation** — hyde + RRF fusion. Deps: S12, S41.
8. **S44 Three-tier recall routing** — L0 cache / L1 FTS5 / L2 HNSW. Deps: S14, S41, S42(B).
9. **S45 CRAG quality metrics** — relevance/coverage/diversity telemetry + query expansion. Deps: S41.
10. **S46 Visual memory map** — reactflow dashboard tab. Deps: memory subsystem (done), dashboard client (done).
11. **S47 Auto-categorizing wiki** — topic assignment + wiki pages. Deps: memory subsystem; heaviest spec.

**P3 (game mode):** mini-game, time-windowed leaderboards, per-repo themes, theme transitions.

### 3. Risks / conflicts
- **File overlap hotspot `src/vectorStore.ts`:** S25-A, S25-B, S42B, S41, S43, S44 all target it — must be serialized; recommend S42B → S25-A → S41 → (S43/S44).
- **S42 vs S25-A ordering:** S42A engine sits unwired; S25-A adds serve-gate/cache to the same RAPTOR recall path. Wire S42B first (or jointly) to avoid re-doing S25-A's freshness/cache work.
- **ROADMAP/BACKLOG P2 "Phases 2–4" are superseded** — the described zstd/content-hash/L0-normalized-bloom/MinHash-LSH work already shipped as sprints 9–11 (`src/store/compression.ts` versioned tags, `bloom.ts`, `l1-minhash.ts`, `minhash_signatures` table all exist). ROADMAP (2026-07-20) needs those sections closed, else they look like real pending work.
- **Sprint-number collisions:** RAG specs were renumbered into S40–S47, colliding with already-used numbers — S40 (importance scoring vs v0.8.21 "S40 context gauges"), S41 (self-RAG vs INDEX_MAP's "S41 db-mirror"), S44 (latency-routing vs game mode). Commit/release-note ambiguity guaranteed.
- **S41 is the critical path:** S43, S44, S45 all declare "depends on S41" but S41 has zero code.

### 4. Stale / superseded / unmarked specs
- Stale "PLANNED/DRAFT/READY" headers on **12+ shipped specs**: slice2, sprint-15, sprint-26-cost-card, sprint-27-telemetry, s38, s39, A1–D3, T1. A one-pass header sync is due.
- `find-pressure-basis-oscillation.md` — root cause was fixed by S27; should be annotated not left open.
- ROADMAP.md + BACKLOG.md P2 sections superseded by shipped sprints 9–11 (see above).
- RELEASE_NOTES.md/CHANGELOG.md stop at **v0.8.21**; v0.8.22 (license), v0.8.23 (S42A), v0.8.24 (mega-runtime decomposition) are undocumented.