# Continuity + Cross-Repo + Memory-RAG — Branch Roadmap

> **Branch:** `feat/continuity-crossrepo` (forked from `feat/durable-trim` @ `469fd95`)
> **Baseline:** v0.4.28 (published)
> **Target:** v0.5.0
> **Date:** 2026-07-15

This branch delivers the next major line of work for pi-mega-compact, organized
as sprints **S16–S23**. It was prompted by an audit of the *actual* call paths in
v0.4.28 (not the sprint checkboxes), which found one live bug and two large
capabilities that were built but not delivering. This doc is the map: it links the
design spec, the implementation plan, the prior queued plans that fed in, and the
release history so anyone landing on this branch can orient fast.

---

## 1. What this branch solves (audited against the real code)

| # | Finding | Evidence | Sprint |
|---|---------|---------|--------|
| 1a | **pi STOPS after our auto-compact.** `ctx.compact()` maps to pi's manual compaction path, which `abort()`s the in-flight turn and stops the agent (`agent-session.js:1345`). pi's native auto-compaction (`_runAutoCompaction`, `:1565`) is the *continuing* path. | traced the installed pi source | **S16** |
| 1b | **"Nothing to compact" gate (v0.4.28) is a band-aid.** It treated the symptom of 1a; removing `ctx.compact()` from the auto-trigger retires it. | `piCompactWouldNoop` in `mega-events.ts` | **S16** (retire) |
| 1c | **PGlite/pgvector cross-repo HNSW index is built + tested but has ZERO callers.** `recallAndInlineAsync` is exported and never imported; the live recall path uses the sync per-session scan. We pay to mirror the index, nothing reads it. | `grep -rn recallAndInlineAsync` → only its own definition | **S17–S18** |
| 1d | **Multi-repo dashboard gap (Phase 5b, never built).** Each pi's dashboard binds to one repo; no cross-repo view. | `multi-repo-dashboard.md` | **S19** |
| 1e | **Memory table is passive, not RAG.** `/mega-memory` is hand-saved; recall never queries the `memories` table (the "reduce new token requests" lever is unloaded). | `memory-rag-auto-review.md` | **S20–S21** |
| 1f | **Slice 3 packaging ~95% done — README missing the dual backend.** `package.json`/`.npmrc`/CLAUDE.md reflect it; README has zero mention. | `grep -c node:sqlite README.md` → 0 | **S22** |

---

## 2. The core design decision (S16, foundation)

**Stop calling `ctx.compact()` from the auto-trigger.** Replace it with a two-layer design:

- **Live layer (model view, every LLM call, never aborts):** the `context` event runs our non-blocking `runCompact` (persist the recall checkpoint) and returns `{ messages: [recallSummary, ...recentAnchor] }`. This feeds pi's `transformContext` (`sdk.js:226` → `agent-loop.js:180`) so the model sees a compacted window every call. The turn continues — no stop.
- **Durable layer (disk/resume, best-effort):** pi's *native* auto-compaction fires at agent-end, does NOT abort, continues, and emits `session_before_compact` — where our `driveNativeCompaction` supplies the summary and pi truncates the transcript on disk. No `ctx.compact()`.

**Documented trade-off (accepted):** the live trim can suppress pi's native durable trim when pi accounts the trimmed (smaller) usage, so durable becomes best-effort. Acceptable because the model's context is bounded by the *live* trim regardless (the actual token-growth bug is fixed), and resume re-trims via the context event + the capped recall block.

**Rollback:** `MEGACOMPACT_LEGACY_DURABLE_TRIM=true` restores v0.4.28 (ctx.compact + the no-op gate) for one release.

---

## 3. Sprint map

| Sprint | Workstream | Size | Depends on |
|---|---|---|---|
| **S16** | Compaction continuity (remove ctx.compact; live trim + native durable) | L | — (foundation) |
| **S17** | Cross-repo recall wire-up (searchAsync on resume + `/mega-recall --cross-repo`; stricter floor + source labels) | M | S16 |
| **S18** | Cross-repo dedup markers + tracking (machine-wide injected-set; events/dashboard) | M | S17 |
| **S19** | Multi-repo dashboard (Phase 5b: Summary + All-repos tabs on the global index) | L | S18 |
| **S20** | Memory-RAG: auto-review (conversation → add/replace/remove ops) | L | — (parallel thread) |
| **S21** | Memory-RAG: include memories in recall + auto-consolidate | M | S20 (+ S17's recall path) |
| **S22** | Slice 3 docs close-out + polish (README dual-backend; maps; CHANGELOG) | S | all |
| **S23** | Release: benchmarks, DR, tag v0.5.0 + npm publish | M | all |

**Threads:** A = S16→S17→S18→S19 (compaction + cross-repo + dashboard). B = S20→S21 (memory). C = S22→S23 (docs + release). S16 first (everything rests on "compact and continue"); S20 can run in parallel with S17–S19.

---

## 4. Primary documents (read in order)

| Step | Doc | What |
|---|---|---|
| 1 | [`docs/superpowers/specs/2026-07-15-compaction-continuity-cross-repo-memory-design.md`](superpowers/specs/2026-07-15-compaction-continuity-cross-repo-memory-design.md) | **The design** — verified facts, the compaction-continuity redesign, per-workstream components, risks, rollback. Approved. |
| 2 | [`docs/superpowers/plans/2026-07-15-compaction-continuity-cross-repo-memory.md`](superpowers/plans/2026-07-15-compaction-continuity-cross-repo-memory.md) | **The implementation plan** — bite-sized TDD tasks per sprint with real test + implementation code, exact commands, commit messages. |
| 3 | [`SPRINT_PLAN.md`](../SPRINT_PLAN.md) | Sprints 0–15 history (all DONE, shipped v0.1.0→v0.2.0); S16+ continue the numbering. |
| 4 | [`CHANGELOG.md`](../CHANGELOG.md) | Release history; S16–S22 entries land here as each sprint ships. |

---

## 5. Prior queued plans that fed this effort

These live in `.claude/plans/` and are the source material the design drew on.
Where a queued plan is now *consumed* by a sprint, that's noted.

| Queued plan | Status | Sprint that consumes it |
|---|---|---|
| [`backend-pglite-sqlite.md`](../.claude/plans/backend-pglite-sqlite.md) | Slice 1 ✅, Slice 2 ✅ (0.4.25), Slice 3 mostly done (README = S22) | S22 (Slice 3 README close-out) |
| [`multi-repo-dashboard.md`](../.claude/plans/multi-repo-dashboard.md) | Not started | **S19** (builds it on the global index) |
| [`memory-rag-auto-review.md`](../.claude/plans/memory-rag-auto-review.md) | Gap analysis only | **S20–S21** (implements it) |
| [`compat-memory-takeover.md`](../.claude/plans/compat-memory-takeover.md) | ✅ shipped (0.4.21: `memories` table + conflict scanner) | — (foundation S20 builds on) |
| [`split-mega-compact.md`](../.claude/plans/split-mega-compact.md) | ✅ shipped (0.4.16/0.4.17: 7 modules) | — (the modules S16+ modify) |

---

## 6. Guardrails (every sprint must pass)

```bash
npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all
```

- **PREVENT-PI-004** (critical): zero network at runtime (TrigramEmbedder, node:sqlite, PGlite WASM, optional localhost Ollama loopback-only). Grep-verified in CI.
- **PREVENT-PI-001/002/003**: compaction preserves anchor-floor + tool-pair; recall prepends via `before_agent_start` (never `role:"system"`).
- **PREVENT-DIST-001**: ship via `npm publish` only — **never a `.tgz` tarball** (`.gitignore` rejects `*.tgz`).
- **3-minute test timeout** (`--test-timeout=180000`, set in `package.json`).
- One focused commit per task; AI-attribution (`Co-Authored-By:`) enforced by pre-commit hook.

---

## 7. Execution

Per the implementation plan's handoff, execute via **subagent-driven-development**
(recommended: a fresh subagent per task, two-stage review between tasks) or
**executing-plans** (inline, batch with checkpoints). Start with **S16** — it is
load-bearing (partial revert of "Fix B") and fixes the live "pi stops" bug, so a
continuity-fix build should be published (0.5.0 or a 0.4.29 patch) before
stacking S17–S21.

---

## 8. Rollback summary

- S16: `MEGACOMPACT_LEGACY_DURABLE_TRIM=true` → v0.4.28 behavior.
- S17/S20: `MEGACOMPACT_CROSSREPO_ENABLED=false` / `MEGACOMPACT_MEMORY_AUTO_REVIEW=false` → disable the new paths.
- PGlite: `MEGACOMPACT_PGLITE_DISABLED=true` → cross-repo index off; recall falls back to sync per-session scan.
- node:sqlite store + RAPTOR stay authoritative; dropping any new layer loses only the additive capability.
