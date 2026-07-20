# Documentation Index Map — pi-mega-compact

**Purpose:** Find documentation by keyword/category. Saves 60–80% tokens vs full reads.

**Usage:** Search keyword → identify doc → use HEADER_MAP.md for section-level lookup.

---

## CORE GUARDRAILS

| Keyword | Document | Location |
| --------- | ---------- | ---------- |
| agent safety, four laws, halt conditions, forbidden actions | [AGENT_GUARDRAILS.md](AGENT_GUARDRAILS.md) | docs/ |
| four laws (full) | [four-laws.md](../skills/shared-prompts/four-laws.md) | skills/shared-prompts/ |
| pre-work checklist, regression | [.guardrails/pre-work-check.md](../.guardrails/pre-work-check.md) | .guardrails/ |
| failure registry, known bugs | [.guardrails/failure-registry.jsonl](../.guardrails/failure-registry.jsonl) | .guardrails/ |
| prevention rules (PREVENT-*), 32 rules v2.2.0 | [.guardrails/prevention-rules/pattern-rules.json](../.guardrails/prevention-rules/pattern-rules.json) | .guardrails/ |
| prevention-rules JSON Schema (editor/CI) | [.guardrails/prevention-rules/pattern-rules.schema.json](../.guardrails/prevention-rules/pattern-rules.schema.json) | .guardrails/ |
| SEMANTIC-001 scanner (unhandled promises) | [scripts/semantic-scan.mjs](../scripts/semantic-scan.mjs) | scripts/ |
| guardrails-scan README (Node scanner) | [scripts/guardrails-scan.README.md](../scripts/guardrails-scan.README.md) | scripts/ |
| regression-prevention workflow, failure triage | [workflows/REGRESSION_PREVENTION.md](workflows/REGRESSION_PREVENTION.md) | docs/workflows/ |
| shared safety prompts (production-first, scope, halt, three-strikes, error-recovery, clean-arch) | [shared-prompts/](../skills/shared-prompts/) | skills/shared-prompts/ |
| PREVENT-PI rules, local-only invariant | [CLAUDE.md](../CLAUDE.md) | repo root |

---

## PLANNING

| Keyword | Document | Location |
| --------- | ---------- | ---------- |
| architecture, phased status, design decisions | [PLAN.md](../PLAN.md) | repo root |
| sprints 0–7 (v0.1.0 shipped) | [SPRINT_PLAN.md](../SPRINT_PLAN.md) | repo root |
| sprints 8–15 (v0.2.0), dedup tiers, sqlite store | [SPRINT_PLAN.md](../SPRINT_PLAN.md) | repo root |
| dedup upgrade spec, QA review, MinHash/LSH/RAPTOR | [dedup-implementation-plan.md](dedup-implementation-plan.md) | docs/ |
| compaction redesign notes | [compaction-redesign.md](compaction-redesign.md) | docs/ |
| fix plan: zstd load crash + tokens-grow-on-read + RAPTOR promotion (durable trim, Fix A–E) | [specs/fix-durable-trim.md](specs/fix-durable-trim.md) | docs/ |
| slice 2: PGlite/pgvector async HNSW index (cross-repo recall) | [specs/slice2-pglite-vector-index.md](specs/slice2-pglite-vector-index.md) | docs/ |
| **fix: lazy-load PGlite so a missing package degrades instead of crashing extension load (v0.6.3)** | [specs/fix-pglite-lazy-import.md](specs/fix-pglite-lazy-import.md) | docs/ |
| **S24: unified pressure signal — auto-compact + tier + memory tied to one `pressure` (removes `/mega-tier`, memory storage hardening)** | [specs/s24-unified-pressure.md](specs/s24-unified-pressure.md) | docs/ |
| **v0.5.0 branch roadmap: continuity + cross-repo + memory-RAG (S16–S23)** | [superpowers/CONTINUITY-BRANCH-ROADMAP.md](superpowers/CONTINUITY-BRANCH-ROADMAP.md) | docs/ |
| v0.5.0 design spec (compaction continuity + cross-repo + memory-RAG) | [superpowers/specs/2026-07-15-compaction-continuity-cross-repo-memory-design.md](superpowers/specs/2026-07-15-compaction-continuity-cross-repo-memory-design.md) | docs/ |
| v0.5.0 implementation plan (S16–S23, TDD task-by-task) | [superpowers/plans/2026-07-15-compaction-continuity-cross-repo-memory.md](superpowers/plans/2026-07-15-compaction-continuity-cross-repo-memory.md) | docs/ |

---

## SPRINT SPECS (full per-sprint)

| Keyword | Document | Location |
| --------- | ---------- | ---------- |
| sprint 8 spec (sqlite store + compression v2) | [specs/sprint-08.md](specs/sprint-08.md) | docs/ |
| sprint 9 spec (content dedup + originals) | [specs/sprint-09.md](specs/sprint-09.md) | docs/ |
| sprint 10 spec (L0 upgrade) | [specs/sprint-10.md](specs/sprint-10.md) | docs/ |
| sprint 11 spec (MinHash/LSH) | [specs/sprint-11.md](specs/sprint-11.md) | docs/ |
| sprint 12 spec (semantic + MMR) | [specs/sprint-12.md](specs/sprint-12.md) | docs/ |
| sprint 13 spec (RAPTOR) | [specs/sprint-13.md](specs/sprint-13.md) | docs/ |
| sprint 14 spec (full pipeline + flags) | [specs/sprint-14.md](specs/sprint-14.md) | docs/ |
| sprint 15 spec (benchmarks, DR, release) | [specs/sprint-15.md](specs/sprint-15.md) | docs/ |
| S24 spec (unified pressure signal: auto-compact + tier + memory; memory storage hardening) | [specs/s24-unified-pressure.md](specs/s24-unified-pressure.md) | docs/ |
| S27 spec (tiered % compaction threshold — `tierPct × contextWindow`; fires below pi native ~80% auto-compact for any model size; reconciles dual-basis pressure flicker) | [specs/s27-tiered-percent-threshold.md](specs/s27-tiered-percent-threshold.md) | docs/ |
| **S28 spec (max-output-token auto-continue — detect `stopReason==='length'` + reuse S16 debounced resume-nudge; no new compact call, PREVENT-PI-003/004 safe)** | [specs/s28-max-output-token-auto-continue.md](specs/s28-max-output-token-auto-continue.md) | docs/specs/ |
| **S29 spec (percent-based auto-compact trigger — gate on context %, not under-reported token counts; `MEGACOMPACT_AUTO_PCT_TRIGGER` override; pct-null token fallback preserves S27)** | [specs/s29-percent-auto-trigger.md](specs/s29-percent-auto-trigger.md) | docs/specs/ |
| **game-mode design spec v0.2 (gamified stats: per-metric leaderboards, MEGA CACHE, 6 themes, 3-toggle panel, minimalist TUI)** | [game-mode-design.md](game-mode-design.md) | docs/ |
| **game-mode QA review + sprint plan S30–S35 (guardrail adherence, 12 QA findings, 52 pre-defined TODOs; S31 ✅ DONE)** | [specs/game-mode-sprint-plan.md](specs/game-mode-sprint-plan.md) | docs/specs/ |
| **S27 spec (db mirror: byte-stable prompt cache via raw transcript mirror + deterministic epoch nonce)** | [specs/sprint-27-db-mirror-cache-stability.md](specs/sprint-27-db-mirror-cache-stability.md) | docs/ |
| **S27 sprint plan (tasks 5–9: context hook, dedup pipeline, recall demotion, tests, DB maintenance /commands)** | [specs/sprint-27-db-mirror-implementation.md](specs/sprint-27-db-mirror-implementation.md) | docs/ |
| **post-mortem: "Already compacted" / "Auto compaction failed" race (agent_end vs native _checkCompaction)** | [specs/postmortem-already-compacted-race.md](specs/postmortem-already-compacted-race.md) | docs/specs/ |
| **S27 Task 10: DB maintenance /commands (/mega-db-stats, prune, vacuum, check, reconcile) + auto-maintenance on session_start** | `extensions/mega-db-cmds.ts` + `src/store/sqlite.ts` | extensions/ + src/ |
| retention policy (TTL 90d, soft-delete, VACUUM, DR snapshots) | [RETENTION_POLICY.md](RETENTION_POLICY.md) | docs/ |
| dedup runbook (SEV tiers, first-15-min, MARK_ONLY degrade) | [DEDUP_RUNBOOK.md](DEDUP_RUNBOOK.md) | docs/ |

---

## TESTING & RELEASE

| Keyword | Document | Location |
| --------- | ---------- | ---------- |
| testing, QA, manual testing, bug reports, test suite, DR drill, benchmark | [TESTER_GUIDE.md](../TESTER_GUIDE.md) | repo root |
| install, setup, usage, openclaw plugin, commands, troubleshooting | [INSTALL_AND_USAGE.md](INSTALL_AND_USAGE.md) | docs/ |
| release notes, v0.2.0, migration guide, breaking change, what's new | [RELEASE_NOTES.md](../RELEASE_NOTES.md) | repo root |
| changelog, per-release changes, sprint breakdown | [CHANGELOG.md](../CHANGELOG.md) | repo root |
| dashboard, live monitoring, widget, SSE, token gauge | [DASHBOARD.md](../extensions/DASHBOARD.md) | extensions/ |

---

## FEATURES (v0.5.0 — Slice 3)

| Keyword | Document | Location |
| --------- | ---------- | ---------- |
| dual-backend store (node:sqlite + PGlite), kill-switch, kill-switch env | [README.md#storage-backend-v050](../README.md#storage-backend-v050) | repo root |
| cross-repo recall (HNSW, cosine floor, source labels, global injected-set) | [README.md#cross-repo-recall-v050](../README.md#cross-repo-recall-v050) | repo root |
| durable memory RAG (auto-review, recall inclusion, dedup, consolidation) | [README.md#memory-v050](../README.md#memory-v050) + [src/memory.ts](../src/memory.ts) + [src/memoryRecall.ts](../src/memoryRecall.ts) + [src/memoryOps.ts](../src/memoryOps.ts) | repo root + src/ |
| tier `-memory` flag on `/mega-recall` + recall dedup logic | [src/recall.ts](../src/recall.ts) + [extensions/mega-commands.ts](../extensions/mega-commands.ts) | src/ + extensions/ |
| memory pipeline trigger (`turn_end` + `doCompact` consolidation gate) | [extensions/mega-events.ts](../extensions/mega-events.ts) + [extensions/mega-pipeline.ts](../extensions/mega-pipeline.ts) | extensions/ |
| cross-repo drift detection (stale / compaction-lag / model-churn) | [src/driftDetection.ts](../src/driftDetection.ts) + `GET /api/drift` in [extensions/dashboard-server.ts](../extensions/dashboard-server.ts) | src/ + extensions/ |
| machine-wide injected-set (dedup cross-repo) + `/api/repos` + `/api/summary` | [src/store/sqlite.ts](../src/store/sqlite.ts) (`markInjectedGlobal`/`wasInjectedGlobal`) + [extensions/dashboard-server.ts](../extensions/dashboard-server.ts) | src/ + extensions/ |

---

## ARCHITECTURE / SOURCE

| Keyword | Document | Location |
| --------- | ---------- | ---------- |
| store, compression, state | [src/store.ts](../src/store.ts) | src/ |
| vector store, dedup, recall | [src/vectorStore.ts](../src/vectorStore.ts) | src/ |
| compaction pipeline | [src/engine.ts](../src/engine.ts) | src/ |
| recall/inline layer | [src/recall.ts](../src/recall.ts) | src/ |
| embedder interface | [src/embedder.ts](../src/embedder.ts) | src/ |
| extractive summary | [src/extractive.ts](../src/extractive.ts) | src/ |
| pi extension entry, slash commands | [extensions/mega-compact.ts](../extensions/mega-compact.ts) | extensions/ |
| **S27: raw_transcript (byte-stable message mirror), append-only log, seq ordering** | [src/store/sqlite.ts](../src/store/sqlite.ts) | src/store/ |
| **S27: dedup_mirror (space-efficient dedup storage), ref_count, content_hash** | [src/mirror/dedup.ts](../src/mirror/dedup.ts) | src/mirror/ |
| **S27: epoch.ts (deterministic epoch-id derivation, FNV-1a nonce, checkpoint_epochs)** | [src/mirror/epoch.ts](../src/mirror/epoch.ts) | src/mirror/ |
| **S27: DB-mirror sprint plan (tasks 5–9: context hook, dedup pipeline, recall demotion, tests, DB maintenance)** | [specs/sprint-27-db-mirror-implementation.md](specs/sprint-27-db-mirror-implementation.md) | docs/specs/ |

---

## PERF DASHBOARD (v0.8.8)\n\n| Keyword | Document | Location |\n| --------- | ---------- | ---------- |\n| Perf tab, live instrumentation, model latency, TPS, cache hit %, CPU/mem, snapshot cost | [dashboard-server/server.ts](../extensions/dashboard-server/server.ts) + [dashboard-server/html.ts](../extensions/dashboard-server/html.ts) | extensions/dashboard-server/ |\n| perf_samples table, recordPerfSample, readPerfSamples | [sqlite/perf-samples.ts](../src/store/sqlite/perf-samples.ts) | src/store/sqlite/ |\n| perf event capture (turn/provider latency, 5s cpu/mem interval) | [mega-events/perf-handler.ts](../extensions/mega-events/perf-handler.ts) | extensions/mega-events/ |\n| snapshot() recompute + disk-write cost instrumentation, Dashboard.lastWriteMs | [mega-runtime/state.ts](../extensions/mega-runtime/state.ts) + [mega-dashboard.ts](../extensions/mega-dashboard.ts) | extensions/ |\n| GET /api/perf (rolling p50/p95 aggregates, diag counts) | [dashboard-server/server.ts](../extensions/dashboard-server/server.ts) | extensions/dashboard-server/ |\n\n## RESEARCH

| Keyword | Document | Location |
|---------|----------|----------|
| pi API constraints, extension mechanics, reference algorithms | [RESEARCH.md](../RESEARCH.md) | repo root |

---

## GAME MODE

| Keyword | Document | Location |
| --------- | ---------- | ---------- |
| game mode, /mega-compact-settings, themes, TUI widget, achievements | [specs/game-mode-sprint-plan.md](specs/game-mode-sprint-plan.md) | docs/specs/ |
| game-mode design (§3b oopsie, §9b achievements, themes) | [game-mode-design.md](game-mode-design.md) | docs/ |
| themes (6 palettes, hex+ANSI) | [config/themes.ts](../src/config/themes.ts) | src/config/ |
| game_scores / game_state / game_achievements tables | [sqlite/schema.ts](../src/store/sqlite/schema.ts) | src/store/sqlite/ |
| scoring helpers (turnLevel, evaluateAchievements) | [game/scoring.ts](../src/game/scoring.ts) | src/game/ |
| /api/game-scores, /api/game-state, /api/achievements (loopback) | [dashboard-server/server.ts](../extensions/dashboard-server/server.ts) | extensions/dashboard-server/ |
| GET /api/game-scores, /api/achievements, /api/game-state | [dashboard-server/server.ts](../extensions/dashboard-server/server.ts) | extensions/dashboard-server/ |

---

## DASHBOARD REWRITE (React frontend sprints)

| Keyword | Document | Location |
| --------- | ---------- | ---------- |
| **A1: API contract, typed endpoints, EndpointDef** | [specs/sprint-A1-api-contract.md](specs/sprint-A1-api-contract.md) | docs/specs/ |
| **B1: React scaffold, Vite, SSE hook, API client** | [specs/sprint-B1-react-scaffold.md](specs/sprint-B1-react-scaffold.md) | docs/specs/ |
| **C1: core tabs, Overview, Events, context gauge** | [specs/sprint-C1-core-tabs.md](specs/sprint-C1-core-tabs.md) | docs/specs/ |
| **C2: repos table, metrics, perf charts, drill-down** | [specs/sprint-C2-repos-metrics.md](specs/sprint-C2-repos-metrics.md) | docs/specs/ |
| **C3: config tab, game mode settings, theme picker** | [specs/sprint-C3-config.md](specs/sprint-C3-config.md) | docs/specs/ |
| **D1: resilience, offline banner, retry, stale indicator** | [specs/sprint-D1-resilience.md](specs/sprint-D1-resilience.md) | docs/specs/ |
| **D2: observability, diagnostics panel, health check** | [specs/sprint-D2-observability.md](specs/sprint-D2-observability.md) | docs/specs/ |
| **D3: docs + release, tester guide, migration** | [specs/sprint-D3-docs-release.md](specs/sprint-D3-docs-release.md) | docs/specs/ |
| **T1: tailscale remote access, auth, CSRF** | [specs/sprint-T1-tailscale.md](specs/sprint-T1-tailscale.md) | docs/specs/ |
| API contracts — barrel (deprecated, re-exports from api-contracts/) | [dashboard-server/api-contracts.ts](../extensions/dashboard-server/api-contracts.ts) | extensions/dashboard-server/ |
| API contracts — index barrel (all domain re-exports) | [dashboard-server/api-contracts/index.ts](../extensions/dashboard-server/api-contracts/index.ts) | extensions/dashboard-server/api-contracts/ |
| API contracts — core types (EndpointDef, SSE events) | [dashboard-server/api-contracts/core.ts](../extensions/dashboard-server/api-contracts/core.ts) | extensions/dashboard-server/api-contracts/ |
| API contracts — snapshot (snapshot, trigger, compaction) | [dashboard-server/api-contracts/snapshot.ts](../extensions/dashboard-server/api-contracts/snapshot.ts) | extensions/dashboard-server/api-contracts/ |
| API contracts — multi-repo (repos, indexes, drift, diff) | [dashboard-server/api-contracts/multi-repo.ts](../extensions/dashboard-server/api-contracts/multi-repo.ts) | extensions/dashboard-server/api-contracts/ |
| API contracts — game (game state, rituals, themes) | [dashboard-server/api-contracts/game.ts](../extensions/dashboard-server/api-contracts/game.ts) | extensions/dashboard-server/api-contracts/ |
| API contracts — infrastructure (health, perf, rate-limit, diagnostics) | [dashboard-server/api-contracts/infrastructure.ts](../extensions/dashboard-server/api-contracts/infrastructure.ts) | extensions/dashboard-server/api-contracts/ |
| React App shell (tabs, error boundary, lazy imports) | [dashboard-client/src/App.tsx](../extensions/dashboard-client/src/App.tsx) | extensions/dashboard-client/src/ |
| useApi hook (typed fetch, retry, stale detection) | [dashboard-client/src/hooks/useApi.ts](../extensions/dashboard-client/src/hooks/useApi.ts) | extensions/dashboard-client/src/hooks/ |
| useSSE hook (event stream, reconnect, backoff) | [dashboard-client/src/hooks/useSSE.ts](../extensions/dashboard-client/src/hooks/useSSE.ts) | extensions/dashboard-client/src/hooks/ |
