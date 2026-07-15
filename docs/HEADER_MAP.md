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
| Rollback | 187 | 0 | |
