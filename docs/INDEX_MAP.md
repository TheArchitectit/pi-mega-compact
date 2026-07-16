# Documentation Index Map — pi-mega-compact

**Purpose:** Find documentation by keyword/category. Saves 60–80% tokens vs full reads.

**Usage:** Search keyword → identify doc → use HEADER_MAP.md for section-level lookup.

---

## CORE GUARDRAILS

| Keyword | Document | Location |
|---------|----------|----------|
| agent safety, four laws, halt conditions, forbidden actions | [AGENT_GUARDRAILS.md](AGENT_GUARDRAILS.md) | docs/ |
| four laws (full) | [four-laws.md](../skills/shared-prompts/four-laws.md) | skills/shared-prompts/ |
| pre-work checklist, regression | [.guardrails/pre-work-check.md](../.guardrails/pre-work-check.md) | .guardrails/ |
| failure registry, known bugs | [.guardrails/failure-registry.jsonl](../.guardrails/failure-registry.jsonl) | .guardrails/ |
| prevention rules (PREVENT-*) | [.guardrails/prevention-rules/pattern-rules.json](../.guardrails/prevention-rules/pattern-rules.json) | .guardrails/ |
| PREVENT-PI rules, local-only invariant | [CLAUDE.md](../CLAUDE.md) | repo root |

---

## PLANNING

| Keyword | Document | Location |
|---------|----------|----------|
| architecture, phased status, design decisions | [PLAN.md](../PLAN.md) | repo root |
| sprints 0–7 (v0.1.0 shipped) | [SPRINT_PLAN.md](../SPRINT_PLAN.md) | repo root |
| sprints 8–15 (v0.2.0), dedup tiers, sqlite store | [SPRINT_PLAN.md](../SPRINT_PLAN.md) | repo root |
| dedup upgrade spec, QA review, MinHash/LSH/RAPTOR | [dedup-implementation-plan.md](dedup-implementation-plan.md) | docs/ |
| compaction redesign notes | [compaction-redesign.md](compaction-redesign.md) | docs/ |
| fix plan: zstd load crash + tokens-grow-on-read + RAPTOR promotion (durable trim, Fix A–E) | [specs/fix-durable-trim.md](specs/fix-durable-trim.md) | docs/ |
| slice 2: PGlite/pgvector async HNSW index (cross-repo recall) | [specs/slice2-pglite-vector-index.md](specs/slice2-pglite-vector-index.md) | docs/ |
| **v0.5.0 branch roadmap: continuity + cross-repo + memory-RAG (S16–S23)** | [superpowers/CONTINUITY-BRANCH-ROADMAP.md](superpowers/CONTINUITY-BRANCH-ROADMAP.md) | docs/ |
| v0.5.0 design spec (compaction continuity + cross-repo + memory-RAG) | [superpowers/specs/2026-07-15-compaction-continuity-cross-repo-memory-design.md](superpowers/specs/2026-07-15-compaction-continuity-cross-repo-memory-design.md) | docs/ |
| v0.5.0 implementation plan (S16–S23, TDD task-by-task) | [superpowers/plans/2026-07-15-compaction-continuity-cross-repo-memory.md](superpowers/plans/2026-07-15-compaction-continuity-cross-repo-memory.md) | docs/ |

---

## SPRINT SPECS (full per-sprint)

| Keyword | Document | Location |
|---------|----------|----------|
| sprint 8 spec (sqlite store + compression v2) | [specs/sprint-08.md](specs/sprint-08.md) | docs/ |
| sprint 9 spec (content dedup + originals) | [specs/sprint-09.md](specs/sprint-09.md) | docs/ |
| sprint 10 spec (L0 upgrade) | [specs/sprint-10.md](specs/sprint-10.md) | docs/ |
| sprint 11 spec (MinHash/LSH) | [specs/sprint-11.md](specs/sprint-11.md) | docs/ |
| sprint 12 spec (semantic + MMR) | [specs/sprint-12.md](specs/sprint-12.md) | docs/ |
| sprint 13 spec (RAPTOR) | [specs/sprint-13.md](specs/sprint-13.md) | docs/ |
| sprint 14 spec (full pipeline + flags) | [specs/sprint-14.md](specs/sprint-14.md) | docs/ |
| sprint 15 spec (benchmarks, DR, release) | [specs/sprint-15.md](specs/sprint-15.md) | docs/ |
| retention policy (TTL 90d, soft-delete, VACUUM, DR snapshots) | [RETENTION_POLICY.md](RETENTION_POLICY.md) | docs/ |
| dedup runbook (SEV tiers, first-15-min, MARK_ONLY degrade) | [DEDUP_RUNBOOK.md](DEDUP_RUNBOOK.md) | docs/ |

---

## TESTING & RELEASE

| Keyword | Document | Location |
|---------|----------|----------|
| testing, QA, manual testing, bug reports, test suite, DR drill, benchmark | [TESTER_GUIDE.md](../TESTER_GUIDE.md) | repo root |
| install, setup, usage, openclaw plugin, commands, troubleshooting | [INSTALL_AND_USAGE.md](INSTALL_AND_USAGE.md) | docs/ |
| release notes, v0.2.0, migration guide, breaking change, what's new | [RELEASE_NOTES.md](../RELEASE_NOTES.md) | repo root |
| changelog, per-release changes, sprint breakdown | [CHANGELOG.md](../CHANGELOG.md) | repo root |
| dashboard, live monitoring, widget, SSE, token gauge | [DASHBOARD.md](../extensions/DASHBOARD.md) | extensions/ |

---

## FEATURES (v0.5.0 — Slice 3)

| Keyword | Document | Location |
|---------|----------|----------|
| dual-backend store (node:sqlite + PGlite), kill-switch, kill-switch env | [README.md#storage-backend-v050](../README.md#storage-backend-v050) | repo root |
| cross-repo recall (HNSW, cosine floor, source labels, global injected-set) | [README.md#cross-repo-recall-v050](../README.md#cross-repo-recall-v050) | repo root |
| durable memory RAG (auto-review, recall inclusion, dedup, consolidation) | [README.md#memory-v050](../README.md#memory-v050) + [src/memory.ts](../src/memory.ts) + [src/memoryRecall.ts](../src/memoryRecall.ts) + [src/memoryOps.ts](../src/memoryOps.ts) | repo root + src/ |
| tier `-memory` flag on `/mega-recall` + recall dedup logic | [src/recall.ts](../src/recall.ts) + [extensions/mega-commands.ts](../extensions/mega-commands.ts) | src/ + extensions/ |
| memory pipeline trigger (`turn_end` + `doCompact` consolidation gate) | [extensions/mega-events.ts](../extensions/mega-events.ts) + [extensions/mega-pipeline.ts](../extensions/mega-pipeline.ts) | extensions/ |

---

## ARCHITECTURE / SOURCE

| Keyword | Document | Location |
|---------|----------|----------|
| store, compression, state | [src/store.ts](../src/store.ts) | src/ |
| vector store, dedup, recall | [src/vectorStore.ts](../src/vectorStore.ts) | src/ |
| compaction pipeline | [src/engine.ts](../src/engine.ts) | src/ |
| recall/inline layer | [src/recall.ts](../src/recall.ts) | src/ |
| embedder interface | [src/embedder.ts](../src/embedder.ts) | src/ |
| extractive summary | [src/extractive.ts](../src/extractive.ts) | src/ |
| pi extension entry, slash commands | [extensions/mega-compact.ts](../extensions/mega-compact.ts) | extensions/ |

---

## RESEARCH

| Keyword | Document | Location |
|---------|----------|----------|
| pi API constraints, extension mechanics, reference algorithms | [RESEARCH.md](../RESEARCH.md) | repo root |
