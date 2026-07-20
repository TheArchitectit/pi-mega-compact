# Documentation Header Map — pi-mega-compact

**Purpose:** Section-level lookup with file:line references for targeted reading.

**Usage:** Identify section → read with offset → minimal token consumption.

---

## AGENT_GUARDRAILS.md (docs/AGENT_GUARDRAILS.md)

| Section | Line | Offset |
|---------|------|--------|
| Applicability | 9 | 0 |
| Purpose | 27 | 18 |
| Four Laws (quick ref) | 49 | 40 |
| Pre-Execution Checklist | 58 | 49 |
| Git Safety Rules | 74 | 65 |
| Code Safety Rules | 87 | 78 |
| Test/Production Separation | 100 | 91 |
| HALT CONDITIONS | 134 | 125 |
| FORBIDDEN ACTIONS | 160 | 151 |
| SCOPE BOUNDARIES | 214 | 205 |
| pi-mega-compact Project Rules (PREVENT-PI) | 251 | 242 |
| Verification gate (every sprint) | 263 | 254 |

---

## CLAUDE.md (repo root)

| Section | Line | Offset |
|---------|------|--------|
| Navigation Maps | 3 | 0 |
| Context & Setup | 11 | 8 |
| Token-Saving Rules | 21 | 18 |
| Workflow | 29 | 26 |
| Hard Project Constraints (PREVENT-PI) | 39 | 36 |
| Architecture at a Glance | 57 | 54 |
| Documentation Standards | 73 | 70 |

---

## PLAN.md (repo root)

| Section | Line | Offset |
|---------|------|--------|
| Current Status (phases) | 18 | 0 |
| Confirmed design decisions | 32 | 0 |
| Architecture Overview | 56 | 0 |
| Phase 1 Dynamic Compression (done) | 94 | 0 |
| Phase 2 Enhanced Compression | 111 | 0 |
| Phase 3 Tier 0 Exact Match | 207 | 0 |
| Phase 4 Tier 1 MinHash/LSH | 239 | 0 |
| Phase 5 Tier 2 Semantic | 276 | 0 |
| Phase 6 RAPTOR | 336 | 0 |
| QA Critical Fix Register | 442 | 0 |

---

## SPRINT_PLAN.md (repo root)

| Section | Line | Offset |
|---------|------|--------|
| Sprint 0 Bootstrap | 15 | 0 |
| Sprint 1 Core engine | 45 | 0 |
| Sprint 2 Vector store (done) | 67 | 0 |
| Sprint 3 Extension wiring (done) | 88 | 0 |
| Sprint 4 Recall layer (done) | 116 | 0 |
| Sprint 5 Commands/UX (done) | 141 | 0 |
| Sprint 6 Hardening/Release (done) | 158 | 0 |
| Sprint 7 Optional backlog | 193 | 0 |
| Phases 2–7 plan (v0.2.0) | 297 | 0 |
| Resolved architecture decisions | 318 | 0 |
| Sprint 8 SQLite backbone | 352 | 0 |
| Sprint 9 Content dedup | 397 | 0 |
| Sprint 10 L0 upgrade | 426 | 0 |
| Sprint 11 MinHash/LSH | 460 | 0 |
| Sprint 12 Semantic + MMR | 492 | 0 |
| Sprint 13 RAPTOR | 529 | 0 |
| Sprint 14 Full pipeline | 560 | 0 |
| Sprint 15 Release | 587 | 0 |

---

## docs/RETENTION_POLICY.md

| Section | Line | Offset |
|---------|------|--------|
| Storage backend (source of truth) | 9 | 0 |
| TTL — 90 days | 28 | 0 |
| Soft-delete via dedup_status | 44 | 0 |
| Reclaiming space — VACUUM cadence | 70 | 0 |
| Disaster-recovery snapshots | 96 | 0 |
| Privacy / local-only guarantee | 118 | 0 |

---

## docs/DEDUP_RUNBOOK.md

| Section | Line | Offset |
|---------|------|--------|
| Severity tiers | 9 | 0 |
| First 15 minutes — checklist | 28 | 0 |
| Tier reference | 62 | 0 |
| MARK_ONLY — safe partial degrade | 84 | 0 |
| Monitoring & canary (local) | 108 | 0 |
| DR restore drill | 140 | 0 |
| Rollback cheat-sheet | 156 | 0 |

---

## TESTER_GUIDE.md (repo root)

| Section | Line | Offset |
|---------|------|--------|
| Prerequisites | 10 | 0 |
| Test Environment Setup | 53 | 0 |
| Running the Test Suite | 91 | 0 |
| Manual Testing Checklist | 152 | 0 |
| 1. Auto-Compaction | 156 | 0 |
| 2. Resume / Auto-Inline | 202 | 0 |
| 3. On-Demand Recall | 238 | 0 |
| 4. Dedup Verification | 270 | 0 |
| 5. Dashboard | 318 | 0 |
| 6. DR Drill | 359 | 0 |
| 7. Benchmark | 400 | 0 |
| What to Include in a Bug Report | 432 | 0 |
| Known Issues & Limitations | 474 | 0 |
| Severity Classification | 516 | 0 |

---

## RELEASE_NOTES.md (repo root)

| Section | Line | Offset |
|---------|------|--------|
| v0.2.0 (2026-07-13) | 3 | 0 |
| Highlights | 10 | 0 |
| Breaking Change | 26 | 0 |
| Migration Guide | 37 | 0 |
| What's New (by sprint) | 112 | 0 |
| Fixed in this release | 129 | 0 |
| Verified (live) | 143 | 0 |
| v0.1.0 (2026-07-11) | 151 | 0 |

---

## extensions/DASHBOARD.md

| Section | Line | Offset |
|---------|------|--------|
| Quick Start | 7 | 0 |
| Commands | 20 | 0 |
| Architecture | 28 | 0 |
| Browser UI | 78 | 0 |
| Development | 90 | 0 |
| Live Stats Widget | 111 | 0 |
| Security | 145 | 0 |
| Troubleshooting | 152 | 0 |

---

## docs/dedup-implementation-plan.md

| Section | Line | Offset |
|---------|------|--------|
| Architecture Overview (4 tiers) | 35 | 0 |
| Phase 1 L0 Exact + MMR | 89 | 0 |
| Phase 2 RAPTOR | 289 | 0 |
| Phase 3 L1 MinHash/LSH | 1217 | 0 |
| Phase 4 L2 Semantic + HNSW | 1458 | 0 |
| Disaster Recovery | 1568 | 0 |
| Integration Points | 1640 | 0 |
| Security Hardening | 1691 | 0 |
| Baseline Collection | 1769 | 0 |
| Observability / Metrics | 1889 | 0 |
| Circuit Breakers | 1965 | 0 |
| Backfill Orchestration | 2154 | 0 |
| Testing & Validation | 2421 | 0 |

---

## docs/specs/fix-durable-trim.md

| Section | Line | Offset |
|---------|------|--------|
| Safety Protocols | 13 | 0 |
| Problem Statement | 27 | 0 |
| Scope Boundary | 56 | 0 |
| Execution: Fix A (lazy zstd) | 71 | 0 |
| Execution: Fix B (durable trim driver) | 78 | 0 |
| Execution: Fix C (honest + bounded recall) | 96 | 0 |
| Execution: Fix D (RAPTOR promotion) | 107 | 0 |
| Execution: Fix E (adaptive pressure) | 124 | 0 |
| Execution: Install hardening | 146 | 0 |
| Files To Change | 152 | 0 |
| Acceptance | 178 | 0 |
| Rollback | 187 | 0 |

## docs/specs/slice2-pglite-vector-index.md

| Section | Line | Offset |
|---------|------|--------|
| Safety Protocols | 10 | 0 |
| Decisions (locked) | 22 | 0 |
| Problem / Motivation | 30 | 0 |
| Architecture | 36 | 0 |
| Scope (in/out) | 52 | 0 |
| Execution: vectorIndex.ts | 70 | 0 |
| Execution: vectorStore wiring | 86 | 0 |
| Execution: recall crossRepo | 98 | 0 |
| Files To Change | 110 | 0 |
| Acceptance | 122 | 0 |
| Rollback | 134 | 0 |

## docs/specs/fix-pglite-lazy-import.md

| Section | Line | Offset |
|---------|------|--------|
| Safety | 9 | 0 |
| Problem | 18 | 0 |
| Scope | 40 | 0 |
| Execution | 47 | 0 |
| Acceptance | 70 | 0 |
| Rollback | 84 | 0 |

## docs/superpowers/CONTINUITY-BRANCH-ROADMAP.md (branch map for v0.5.0)

| Section | Line | Offset |
|---------|------|--------|
| What this branch solves (audited findings) | 1 | 0 |
| The core design decision (S16) | 2 | 0 |
| Sprint map (S16–S23) | 3 | 0 |
| Primary documents (read order) | 4 | 0 |
| Prior queued plans that fed this | 5 | 0 |
| Guardrails | 6 | 0 |
| Execution | 7 | 0 |
| Rollback summary | 8 | 0 |

## docs/superpowers/specs/2026-07-15-compaction-continuity-cross-repo-memory-design.md

| Section | Line | Offset |
|---------|------|--------|
| Context (why now) | 1 | 0 |
| Goals / Non-goals | 2–3 | 0 |
| Resolved decisions | 4 | 0 |
| Architecture (compaction-continuity redesign) | 5 | 0 |
| Workstream breakdown (S16–S23) | 6 | 0 |
| Per-workstream design | 7 | 0 |
| Risks / HALT | 8 | 0 |
| Testing strategy | 9 | 0 |
| Rollback | 10 | 0 |
| Optional split | 11 | 0 |

## docs/specs/s27-tiered-percent-threshold.md

| Section | Line | Offset |
|---------|------|--------|
| Safety Protocols | 12 | 0 |
| Problem Statement | 22 | 0 |
| Scope Boundary | 37 | 0 |
| Execution | 57 | 0 |
| Files To Change | 100 | 0 |
| Acceptance | 113 | 0 |
| Rollback | 124 | 0 |

## docs/specs/s28-max-output-token-auto-continue.md

| Section | Line | Offset |
|---------|------|--------|
| Safety Protocols | 12 | 0 |
| Problem Statement | 23 | 0 |
| Scope Boundary | 43 | 0 |
| Execution | 63 | 0 |
| Files To Change | 161 | 0 |
| Acceptance | 174 | 0 |
| Rollback | 188 | 0 |
| P2-2 implementation notes | 196 | 0 |

## docs/specs/s29-percent-auto-trigger.md

| Section | Line | Offset |
|---------|------|--------|
| Safety Protocols | 12 | 0 |
| Problem Statement | 24 | 0 |
| Scope Boundary | 36 | 0 |
| Execution | 52 | 0 |
| Acceptance | 93 | 0 |
| Rollback | 104 | 0 |
| Relationship to S28 | 112 | 0 |

## docs/superpowers/plans/2026-07-15-compaction-continuity-cross-repo-memory.md

| Section | Line | Offset |
|---------|------|--------|
| File structure (all sprints) | top | 0 |
| Sprint S16 — Compaction Continuity | S16 | 0 |
| Sprint S17 — Cross-Repo Recall Wire-Up | S17 | 0 |
| Sprint S18 — Cross-Repo Dedup Markers + Tracking | S18 | 0 |
| Sprint S19 — Multi-Repo Dashboard (Phase 5b) | S19 | 0 |
| Sprint S20 — Memory-RAG: Auto-Review | S20 | 0 |
| Sprint S21 — Memory-RAG: Recall + Consolidation | S21 | 0 |
| Sprint S22 — Slice 3 Docs Close-Out | S22 | 0 |
| Sprint S23 — Release (tag v0.5.0) | S23 | 0 |
| Self-Review | end | 0 |

---

## docs/specs/game-mode-sprint-plan.md (docs/specs/game-mode-sprint-plan.md)

| Section | Line | Offset |
|---------|------|--------|
| Guardrail Adherence Review | 13 | 0 |
| QA Review of the v0.2 Spec | 33 | 0 |
| Sprint Roadmap (S30–S35) | 55 | 0 |
| S30 Foundation: state + themes + command | 67 | 0 |
| S31 TUI widget theming + display modes + level | 109 | 0 |
| S32 Dashboard CSS-variable skin + settings strip | 135 | 0 |
| S33 Scoring schema + hooks | 169 | 0 |
| S34 High Score dashboard tab + animations + release | 191 | 0 |
| S35 Achievements system (capstone) | 228 | 0 |
| Consolidated Pre-Defined TODO Ledger | 267 | 0 |
| Resolved Open Questions | 289 | 0 |
| Deferred (future phases) | 303 | 0 |

## docs/game-mode-design.md (docs/game-mode-design.md)

| Section | Line | Offset |
|---------|------|--------|
| Goal | 9 | 0 |
| Scoring model | 17 | 0 |
| MEGA CACHE | 30 | 0 |
| MEGA CACHE overshoot — oopsie alert + Opie's Wild Ride hidden unlock | 55 | 0 |
| Levels on turns | 101 | 0 |
| Theme system | 108 | 0 |
| Toggle panel | 131 | 0 |
| State storage | 153 | 0 |
| Dashboard | 162 | 0 |
| Open implementation questions | 170 | 0 |
| Achievements (S35) | 189 | 0 |
| Future | 223 | 0 |

## src/ (v0.5.0 source index)

| File | Purpose (sprint) |
|------|-------------------|
| `src/memory.ts` | Auto-review (`reviewConversation`) + consolidation (`consolidateMemories`) for the durable `memories` table (S20/S21). |
| `src/memoryOps.ts` | Applies `reviewConversation` `MemoryOp`s to the `memories` table — thin layer over `src/store/sqlite.ts` helpers (S20.3). |
| `src/memoryRecall.ts` | Semantic recall over `memories` with cosine + category/recency boosting; marks hits `last_referenced` (S21.1). |
| `src/recall.ts` | Unified recall/inline layer — checkpoint + memory merge, source-repo labels, cross-repo dedup against the machine-wide injected-set (S17/S21). |
| `src/driftDetection.ts` | Cross-repo drift report over `repo_registry` — stale / compaction-lag / model-churn signals (R4). Read-only. |
| `src/store/sqlite.ts` | Source-of-truth `node:sqlite` store; also hosts `markInjectedGlobal` / `wasInjectedGlobal` / `countInjectedGlobal` (the S18 machine-wide injected-set). |
| `extensions/dashboard-server.ts` | Multi-repo dashboard HTTP server; `/api/index`, `/api/repos`, `/api/summary`, `/api/drift` (S19/R4). |
| `extensions/mega-events.ts` | Event wiring: live context-trim (S16), resume cross-repo (S17), memory auto-review trigger (S20). |
| `extensions/mega-pipeline.ts` | `doRecallAsync`, `doCompact` → `consolidateMemories` gate (S17/S21). |

---

## specs/s24-unified-pressure.md (docs/specs/s24-unified-pressure.md)

| Section | Line | Offset |
|---------|------|--------|
| SAFETY PROTOCOLS | 11 | 0 |
| DECISIONS (locked with user) | 25 | 14 |
| PROBLEM / MOTIVATION | 44 | 33 |
| CORE CONCEPT: one `pressure` signal | 56 | 45 |
| Pressure → tier band table | 70 | 59 |
| EXECUTION (changes by file) | 90 | 79 |
| Memory storage hardening | 130 | 119 |
| ACCEPTANCE | 168 | 157 |
| ROLLBACK | 178 | 167 |

## docs/specs/sprint-27-db-mirror-cache-stability.md

| Section | Line | Offset |
|---------|------|--------|
| SAFETY PROTOCOLS | 15 | 0 |
| PROBLEM (root cause: Date.now() + shifting slice) | 47 | 0 |
| SCOPE (in/out) | 76 | 0 |
| EXECUTION (Tasks 1–9) | 137 | 0 |
| ACCEPTANCE (grep + behavioral) | 240 | 0 |
| ROLLBACK | 268 | 0 |
| RISKS / EDGE CASES | 283 | 0 |

## src/mirror/ (S27 DB-mirror)

| File | Purpose |
|------|--------|
| `src/mirror/epoch.ts` | Deterministic epoch-id derivation (FNV-1a nonce, epochIdFor) |
| `src/mirror/raw_transcript.ts` | Append-only raw message log (upsertRawTranscript, listRawTranscriptRange) |
| `src/mirror/dedup.ts` | Dedup pipeline for space-efficient storage (dedupTranscript, getDedupRatio) |

## docs/specs/sprint-27-db-mirror-implementation.md

| Section | Line | Offset |
|---------|------|--------|
| SAFETY PROTOCOLS | 11 | 0 |
| DECISIONS (locked) | 20 | 9 |
| SCOPE (in/out) | 37 | 26 |
| EXECUTION (Tasks 1–9) | 57 | 46 |
| Task 1 — Schema + Dedup columns (P0) | 60 | 49 |
| Task 2 — Insert helpers (P0) | 73 | 62 |
| Task 3 — Epoch nonce (P0) | 96 | 85 |
| Task 4 — Config flag (P0) | 113 | 102 |
| Task 5 — Context hook (P0) | 126 | 115 |
| Task 6 — Dedup pipeline (P1) | 138 | 127 |
| Task 7 — Recall Demotion (P2) | 149 | 138 |
| Task 8 — Tests (P0) | 165 | 154 |
| Task 9 — Maps + Guardrails (P3) | 188 | 177 |
| Task 10 — DB Maintenance Commands (NEW) | 197 | 186 |
| Dependency graph | 229 | 218 |
| ACCEPTANCE | 237 | 226 |
| ROLLBACK | 258 | 247 |

## docs/specs/postmortem-already-compacted-race.md

| Section | Line | Offset |
|---------|------|--------|
| Summary (Failure ID FAIL-2026071701) | 11 | 0 |
| Symptom (exact toast + throw sites in agent-session.js) | 30 | 22 |
| Root Cause (agent_end vs _checkCompaction race) | 59 | 51 |
| Why It Produced the Symptom | 110 | 102 |
| Fix (lastNativeCompactAt cooldown, commit 848c817) | 124 | 116 |
| How It Was Found (repro + hypotheses rejected) | 163 | 155 |
| Why It Slipped Through | 191 | 183 |
| Validation | 208 | 200 |
| Action Items | 224 | 216 |
