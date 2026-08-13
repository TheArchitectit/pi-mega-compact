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
| **engineering practices, file limits, splitting pattern, capability gating, append-only, ledger protocol, feature flags, structured logging, sprint gating** | [ENGINEERING_PRACTICES.md](ENGINEERING_PRACTICES.md) | docs/ |

---

## VECTOR CORTEX

| Keyword | Document |
| --- | --- |
| read order, decisions, status | [vector-cortex/README.md](vector-cortex/README.md) |
| readiness checklist | [vector-cortex/IMPLEMENTATION_READINESS.md](vector-cortex/IMPLEMENTATION_READINESS.md) |
| EventV2, PromptDagV1, provider profiles, downgrade | [vector-cortex/CONTRACTS.md](vector-cortex/CONTRACTS.md) |
| authority/data flow | [vector-cortex/ARCHITECTURE.md](vector-cortex/ARCHITECTURE.md) |
| learned architecture/training/package | [vector-cortex/MODEL_ASSET.md](vector-cortex/MODEL_ASSET.md) |
| exact residual/parity math | [vector-cortex/RESIDUAL_CODEC.md](vector-cortex/RESIDUAL_CODEC.md) |
| permissions/privacy/consent | [vector-cortex/SECURITY_PRIVACY.md](vector-cortex/SECURITY_PRIVACY.md) |
| breakers/spool/outage | [vector-cortex/TRIAD_RESILIENCE.md](vector-cortex/TRIAD_RESILIENCE.md) |
| fixtures/migrations | [vector-cortex/CONFORMANCE.md](vector-cortex/CONFORMANCE.md) |
| annotations/power/rollout | [vector-cortex/EVALUATION.md](vector-cortex/EVALUATION.md) |
| 27-sprint roadmap/gates | [vector-cortex/SPRINT_PLAN.md](vector-cortex/SPRINT_PLAN.md) |
| durable sprint evidence | [vector-cortex/EVIDENCE_TEMPLATE.md](vector-cortex/EVIDENCE_TEMPLATE.md) |
| 11 phases / 44 sprint specifications (spec-declared; constants bumped by implementer per convention) | [vector-cortex/phases/](vector-cortex/phases/) / [vector-cortex/sprints/](vector-cortex/sprints/) |
| VC0E sprint: dashboard live data + status badges (COMPLETED v0.20.25) | [vector-cortex/sprints/VC0E-dashboard-live-data.md](vector-cortex/sprints/VC0E-dashboard-live-data.md) |
| **VC0F sprint: dashboard restart-on-upgrade (ACTIVE)** | [vector-cortex/sprints/VC0F-dashboard-restart-on-upgrade.md](vector-cortex/sprints/VC0F-dashboard-restart-on-upgrade.md) |
| VC0D wiring audit + remaining-wiring table for PLAN_V2/VC paths | [PLANV2_REMAINING_WIRING.md](PLANV2_REMAINING_WIRING.md) |
| **PC phase: prompt-cache flag rollout (PLAN_V2 P2/P3 default-ON)** | [vector-cortex/phases/PC-prompt-cache-rollout.md](vector-cortex/phases/PC-prompt-cache-rollout.md) |
| PC-A sprint: messageSeparation flag unification + default ON | [vector-cortex/sprints/PC-A-message-separation-default-on.md](vector-cortex/sprints/PC-A-message-separation-default-on.md) |
| PC-B sprint: cacheStriping flag unification + default ON | [vector-cortex/sprints/PC-B-cache-striping-default-on.md](vector-cortex/sprints/PC-B-cache-striping-default-on.md) |
| PC-C sprint: dashboard prompt-cache per-turn visibility | [vector-cortex/sprints/PC-C-dashboard-cache-visibility.md](vector-cortex/sprints/PC-C-dashboard-cache-visibility.md) |
| PC-D sprint: benchmark validation + conformance roll-up | [vector-cortex/sprints/PC-D-benchmark-validation-rollup.md](vector-cortex/sprints/PC-D-benchmark-validation-rollup.md) |
| **ML5 phase: self-improving cortex — close the Mode-A gate (HG-1/3/4/5)** | [vector-cortex/phases/ML5-self-improving-cortex.md](vector-cortex/phases/ML5-self-improving-cortex.md) |
| ML5-A sprint: five-head training + calibration corpus build (HG-1 partial, closes stubs 1/2/3/7) | [vector-cortex/sprints/ML5-A-encoder-training-five-head.md](vector-cortex/sprints/ML5-A-encoder-training-five-head.md) |
| ML5-B sprint: production bench harness (HG-5 RSS measurement, HG-3 perf input, closes stub 5) | [vector-cortex/sprints/ML5-B-production-bench-harness.md](vector-cortex/sprints/ML5-B-production-bench-harness.md) |
| ML5-C sprint: runtime decision + packaging WASM vs native (HG-3 budget, HG-4 darwin-x64) | [vector-cortex/sprints/ML5-C-runtime-decision-packaging.md](vector-cortex/sprints/ML5-C-runtime-decision-packaging.md) |
| ML5-D sprint: dashboard "Improve Cortex" surface + promote workflow (closes stub 8) | [vector-cortex/sprints/ML5-D-dashboard-improve-cortex.md](vector-cortex/sprints/ML5-D-dashboard-improve-cortex.md) |
| ML5-E sprint: nightly retraining cron + feedback loop (manifest append-only, digest-swap rollback) | [vector-cortex/sprints/ML5-E-nightly-retraining-cron.md](vector-cortex/sprints/ML5-E-nightly-retraining-cron.md) |
| VC6C-IMPL sprint: self-healing controller implementation (closes stub 4, resolves status) | [vector-cortex/sprints/VC6C-IMPL-self-healing-controller.md](vector-cortex/sprints/VC6C-IMPL-self-healing-controller.md) |
| CONFORM-HYGIENE sprint: conformance + docs hygiene (closes Table 4 gaps, Table 2 sentinels, HG-6/7 registration) | [vector-cortex/sprints/CONFORM-HYGIENE-conformance-and-docs-hygiene.md](vector-cortex/sprints/CONFORM-HYGIENE-conformance-and-docs-hygiene.md) |

**Read order:** README → readiness → contracts/architecture → model/codec/privacy → triad/conformance/evaluation → plan → active phase/sprint.

---

## AUDITS & SELF-IMPROVEMENT

| Keyword | Document |
| --- | --- |
| **Stub / hard-gate / mock-data audit (2026-08-05, 5-agent sweep, file:line-verified)** | [audits/2026-08-05-stub-gate-mock-audit.md](audits/2026-08-05-stub-gate-mock-audit.md) |
| **Self-improving development framework (8 proposed PREVENT-STUB/MOCK/HYGIENE rules)** | [development-framework/SELF_IMPROVING_DEVELOPMENT.md](development-framework/SELF_IMPROVING_DEVELOPMENT.md) |

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
| **S40 spec (importance scoring for compaction — typed multipliers, age decay, recency/retention boost, feature-flagged preservation of decisions/errors)** | [specs/s40-importance-scoring.md](specs/s40-importance-scoring.md) | docs/specs/ |
| **S41 spec (self-RAG quality gate — word-overlap critique for recall injection, factual accuracy, completeness, relevance, clarity metrics)** | [specs/s41-self-rag-quality-gate.md](specs/s41-self-rag-quality-gate.md) | docs/specs/ |
| **S42 RAG spec (RAPTOR multi-level retrieval + incremental enrichment — level-weighted scoring, leaf expansion, build history, enrichment scheduler)** | [specs/s42-raptor-multilevel-retrieval.md](specs/s42-raptor-multilevel-retrieval.md) | docs/specs/ |
| **S43 RAG spec (HyDE for vague recall queries — hypothetical document embedding, multi-query expansion, RRF fusion, vagueness detection)** | [specs/s43-hyde-vague-queries.md](specs/s43-hyde-vague-queries.md) | docs/specs/ |
| **S44 spec (three-tier latency-aware recall routing — L0 in-memory cache, L1 FTS5 trigram, L2 PGlite HNSW; embedding cache, session invalidation, hit-rate tracking)** | [specs/s44-three-tier-latency-routing.md](specs/s44-three-tier-latency-routing.md) | docs/specs/ |
| **S45 spec (CRAG quality metrics — relevance, coverage, diversity, specificity; query expansion on low quality, quality telemetry)** | [specs/s45-crag-quality-metrics.md](specs/s45-crag-quality-metrics.md) | docs/specs/ |
| **S46 spec (visual memory map dashboard — reactflow graph of memories, temporal/causal/topical edges, filter controls, detail panel)** | [specs/s46-visual-memory-map.md](specs/s46-visual-memory-map.md) | docs/specs/ |
| **S47 spec (auto-categorizing memory wiki — rule-based + LLM topic assignment, wiki page generation, topic tree browser)** | [specs/s47-auto-categorizing-wiki.md](specs/s47-auto-categorizing-wiki.md) | docs/specs/ |
| **S48 spec (per-turn vector tracking — `turns` + `turn_recall` + `conversation_branches` tables, turn_end writer, recall provenance, forkConversation primitive, recall-to-point design)** | [specs/s48-per-turn-vector-tracking.md](specs/s48-per-turn-vector-tracking.md) | docs/specs/ |
| **S49–S52 program (per-turn memory platform — isolated turns.db, per-turn metrics + fork, full auto-categorizing wiki, dashboard rewind; reuse-grade for own TUI + API gateway)** | [specs/s49-program-per-turn-memory-platform.md](specs/s49-program-per-turn-memory-platform.md) | docs/specs/ |
| **S49 spec (turn-db foundation — revision 1: contract-first, event-sourced, capability-gated `TurnStore` interface, `SqliteTurnStore` + `InMemoryTurnStore`, main-db→turns.db migration, retention/pruning; S49A/S49B/S49C gated)** | [specs/s49-turn-db-foundation.md](specs/s49-turn-db-foundation.md) | docs/specs/ |
| **S49 revision record (v0→v1: dependency rule → contract-first kernel + append-only + capability gating + ledger protocol + StoreSnapshot)** | [specs/s49-rev1-architecture-upgrade.md](specs/s49-rev1-architecture-upgrade.md) | docs/specs/ |
| **PMA-0–PMA-7 program (provider/model analytics — isolated analytics.db lifecycle, Cache+Performance sub-tabs, Plexus dashboard parity, truthful measurement policy)** | [specs/provider-model-analytics-program.md](specs/provider-model-analytics-program.md) | docs/specs/ |
| **S50 spec (per-turn metrics + fork — `TurnMetrics` over `TurnReader`, `/mega-fork` over `TurnWriter`, epoch stamping)** | [specs/s50-per-turn-metrics-fork.md](specs/s50-per-turn-metrics-fork.md) | docs/specs/ |
| **S51 spec (auto-categorizing wiki — k-means topic clustering, TF-IDF labels, extractive wiki pages; replaces S47)** | [specs/s51-auto-categorizing-wiki.md](specs/s51-auto-categorizing-wiki.md) | docs/specs/ |
| **S52 spec (dashboard management + rewind — capability-gated turns tab, wiki polish, fork button, rewind-intent queue)** | [specs/s52-dashboard-management-rewind.md](specs/s52-dashboard-management-rewind.md) | docs/specs/ |
| **S39 spec (real-time multi-pi stacked memory graph — shared `session_heartbeats` + `token_samples` tables in `~/.mega-compact-index`, runtime snapshot hook, `/api/sessions` + `/api/sessions/timeseries`, recharts Sessions tab; PREVENT-PI-004 safe)** | [specs/s39-multi-pi-memory-graph.md](specs/s39-multi-pi-memory-graph.md) | docs/specs/ |
| **game-mode design spec v0.2 (gamified stats: per-metric leaderboards, MEGA CACHE, 6 themes, 3-toggle panel, minimalist TUI)** | [game-mode-design.md](game-mode-design.md) | docs/ |
| **game-mode QA review + sprint plan S30–S35 (guardrail adherence, 12 QA findings, 52 pre-defined TODOs; S31 ✅ DONE)** | [specs/game-mode-sprint-plan.md](specs/game-mode-sprint-plan.md) | docs/specs/ |
| **S41 spec (db mirror: byte-stable prompt cache via raw transcript mirror + deterministic epoch nonce)** | [specs/sprint-27-db-mirror-cache-stability.md](specs/sprint-27-db-mirror-cache-stability.md) | docs/ |
| **promptcache-stats sprint (display provider cache in dashboard/TUI + RECOMPACT_PCT_DELTA 10→50 + replay-exempt-from-debounce; external-audit disposition table)** | [specs/sprint-promptcache-stats.md](specs/sprint-promptcache-stats.md) | docs/specs/ |
| **S53 spec (recall tail injection — staged recall/memory blocks move from one-shot systemPrompt prepend to append-only tail user message; kills the 2 full cache misses per /mega-recall)** | [specs/s53-recall-tail-injection.md](specs/s53-recall-tail-injection.md) | docs/specs/ |
| **setup-flow spec (embedder configuration — dashboard Setup tab "Use Ollama" buttons + .mega-compact.env loader at startup; fixes write-only wizard + dead mega-embed-wizard.ts)** | [specs/setup-flow-embedder-config.md](specs/setup-flow-embedder-config.md) | docs/specs/ |
| **dashboard compaction-gate fixes spec (why wiki/memory-map/repos are always blank; lower wiki cadence 10→3 + seed from live turns + informative empty states + turns-DB memory-graph fallback)** | [specs/dashboard-compaction-gate-fixes.md](specs/dashboard-compaction-gate-fixes.md) | docs/specs/ |
| **prompt cache plans (findings, competitive gap analysis, v2 vertical striping plan)** | [PROMPTCACHE_FINDINGS.md](PROMPTCACHE_FINDINGS.md) + [PROMPTCACHE_FULL_GAP_ANALYSIS.md](PROMPTCACHE_FULL_GAP_ANALYSIS.md) + [PROMPTCACHE_PLAN_V2.md](PROMPTCACHE_PLAN_V2.md) | docs/ |
| **S27 sprint plan (tasks 5–9: context hook, dedup pipeline, recall demotion, tests, DB maintenance /commands)** | [specs/sprint-27-db-mirror-implementation.md](specs/sprint-27-db-mirror-implementation.md) | docs/ |
| **post-mortem: "Already compacted" / "Auto compaction failed" race (agent_end vs native _checkCompaction)** | [specs/postmortem-already-compacted-race.md](specs/postmortem-already-compacted-race.md) | docs/specs/ |
| **AI error-retry findings (S38.1–S38.10: classifier, retry contract, circuit breaker, hard-stop, race guard, retries tile, mid-response stream-death detection, test-file split + closeVectorIndex hang fix)** | [AI_ERROR_RETRY_FINDINGS.md](AI_ERROR_RETRY_FINDINGS.md) | docs/ |
| **S27 Task 10: DB maintenance /commands (/mega-db-stats, prune, vacuum, check, reconcile) + auto-maintenance on session_start** | `extensions/mega-db-cmds.ts` + `src/store/sqlite.ts` | extensions/ + src/ |
| **3WF design spec (three-way failback for the context-management critical path — IMPLEMENTED v0.20.84→v0.21.0; §12 v2 QA amendments A1–A6 are the binding text; per-amendment sprint/commit disposition in §0)** | [superpowers/specs/2026-08-12-three-way-failback-design.md](superpowers/specs/2026-08-12-three-way-failback-design.md) | docs/superpowers/specs/ |
| **3WF-1…3WF-5 sprint program (TriggerGuard; threshold invariant = % of ACTUAL model window + compaction ladder/ReductionValidator/ThrashGuard; read-only 3-source recall vote + same-repo cosine floor; InjectionConfirm; toggles/telemetry/docs — all behind `MEGACOMPACT_THREE_WAY_FAILBACK`, flag-OFF byte-identical)** | [specs/three-way-failback-sprints.md](specs/three-way-failback-sprints.md) | docs/specs/ |
| retention policy (TTL 90d, soft-delete, VACUUM, DR snapshots) | [RETENTION_POLICY.md](RETENTION_POLICY.md) | docs/ |
| dedup runbook (SEV tiers, first-15-min, MARK_ONLY degrade) | [DEDUP_RUNBOOK.md](DEDUP_RUNBOOK.md) | docs/ |

---

## ITHACUS BRIDGE (bidirectional mega-compact ↔ ithacus)

| Keyword | Document | Location |
| --------- | ---------- | ---------- |
| **C2 postmortem (the bridge, the bug, and the bug that wasn't — design + investigation narrative)** | [blog/2026-08-13-bridge-c2-the-bug-that-wasnt.md](blog/2026-08-13-bridge-c2-the-bug-that-wasnt.md) | docs/blog/ |
| **C2 fixes — full execution spec (Sprints R + H + C2-cont; Option B monotonic conversation turnIndex)** | [specs/c2-resume-and-health-fixes.md](specs/c2-resume-and-health-fixes.md) | docs/specs/ |
| C2 findings — sprint plan overview (draft, superseded by full spec) | [specs/c2-findings-sprint-plan.md](specs/c2-findings-sprint-plan.md) | docs/specs/ |
| C2 finding — resume duplicate-turn (draft investigation record) | [specs/c2-finding-resume-duplicate-turn.md](specs/c2-finding-resume-duplicate-turn.md) | docs/specs/ |
| C2 finding — health observability gap + drift clarity (draft) | [specs/c2-finding-health-observability-gap.md](specs/c2-finding-health-observability-gap.md) | docs/specs/ |
| bridge API (createMegaBridge — compact/recall/fork/cortex/memory/turns) | [src/bridge.ts](../src/bridge.ts) + [src/bridge/factory.ts](../src/bridge/factory.ts) | src/ |
| bridge child extension (recall-at-start + compact-on-shutdown, no tools/console) | [extensions/mega-compact-child.ts](../extensions/mega-compact-child.ts) | extensions/ |
| bridge contract (ithacus local mirror of MegaBridge) | (ithacus) `src/mega-bridge-contract.ts` | ithacus repo |
| bridge loader (dynamic import + optional peer dep + child path resolution) | (ithacus) `src/mega-bridge-loader.ts` | ithacus repo |

> **Outstanding branches** (review, not yet merged to master):
> - `feat/ithacus-bridge` — the bridge itself (shipped mega-compact v0.21.3 + ithacus v0.6.17) + this C2 blog post.
> - `fix/c2-findings` — C2 fixes specs (Sprint R + H); **no code yet**, execution-ready for the AM.
> - (ithacus repo) `feat/mega-bridge` — ithacus side of the bridge (merged to ithacus master @ v0.6.17).

---

## TESTING & RELEASE

| Keyword | Document | Location |
| --------- | ---------- | ---------- |
| testing, QA, manual testing, bug reports, test suite, DR drill, benchmark | [TESTER_GUIDE.md](../TESTER_GUIDE.md) | repo root |
| install, setup, usage, openclaw plugin, commands, troubleshooting | [INSTALL_AND_USAGE.md](INSTALL_AND_USAGE.md) | docs/ |
| release notes, v0.2.0, migration guide, breaking change, what's new | [RELEASE_NOTES.md](../RELEASE_NOTES.md) | repo root |
| changelog, per-release changes, sprint breakdown | [CHANGELOG.md](../CHANGELOG.md) | repo root |
| release pipeline, publish gate, deploy.sh, npm publish gate (v0.8.16) | [scripts/deploy.sh](../scripts/deploy.sh) | scripts/ |
| S25-B spec (cross-repo + durable-memory headless two-repo E2E — repoKey unification, kill-switch + corrupt-dir fallback) | [specs/s25-cross-repo.md](specs/s25-cross-repo.md) | docs/specs/ |
| S25-B two-repo driver (checkpoint + memory cross-repo through real handlers) | [scripts/cross-repo-e2e.mjs](../scripts/cross-repo-e2e.mjs) | scripts/ |
| **S49 spec (conversation-tracking DB + Dashboard conversations tab — turns / recall provenance / branches with prune + vacuum + threshold controls)** | [specs/s49-conversation-db-dashboard.md](specs/s49-conversation-db-dashboard.md) | docs/specs/ |
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
