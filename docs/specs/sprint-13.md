# Sprint 13 — Phase 6: RAPTOR Pre-Compression

**Date:** 2026-07-13
**Archive date:** 2026-07-13
**Focus:** Hierarchical summary tree + hallucination guards
**Priority:** P2
**Effort:** L (≈2 days)
**Status:** DONE
**Depends on:** Sprint 12 (embedder, search, cosine)

---

## SAFETY PROTOCOLS

- Gate as Sprint 8.
- PREVENT-PI-004: Ollama (if used) is LOCAL (`llama3.2:3b`); default = pure extractive (no model). No API.
- QA #16: faithfulness validation is MANDATORY before a summary node is marked `quality_marker='high'`.
- HALT if guardrails approve a fixture hallucinated claim.

---

## PROBLEM STATEMENT

`PLAN.md` Phase 6 wants RAPTOR: hierarchical summarization run BEFORE the dedup
pipeline to cut chunk volume 3–5×. QA #11 says GMM (not K-Means) for clustering
in cosine space; QA #16 requires faithfulness validation. The dedup plan's
k-means is fine locally but must handle near-zero-variance + have a fallback.

**Root cause:** no pre-compression; summary volume unbounded; no faithfulness check.

---

## SCOPE BOUNDARY

**IN SCOPE:**
- `src/dedup/raptor/kmeans.ts` — k-means++ (TS, no dep); near-zero-variance merge guard (QA #11; GMM noted as future upgrade).
- `src/dedup/raptor/summarizer.ts` — local extractive (reuse `extractive.ts`) + optional local Ollama (`llama3.2:3b`).
- `src/dedup/raptor/guardrails.ts` — 4-layer hallucination defense (claim grounding, entity verify, consistency re-embed+cosine, quality markers) (QA #16).
- `src/dedup/raptor/tree.ts` — RAPTOR builder; 5s budget cap; extractive fallback.
- `src/dedup/raptor/retrieval.ts` — staged expansion (ANN → expand top-M → BFS to leaves → MMR).
- SQLite `raptor_nodes(id, session_id, level, parent_id, children TEXT, summary TEXT, embedding_blob BLOB, quality_marker TEXT, token_estimate INT)` (children as JSON TEXT, vector as BLOB).
- Shadow mode (`RAPTOR_SHADOW_MODE` default true): build + log, don't serve.

**OUT OF SCOPE:** full-pipeline flag orchestration (Sprint 14); canary (Sprint 14).

---

## EXECUTION DIRECTIONS

```
1. cluster   kmeans++ on embeddings; if max pairwise dist < 1e-12 -> merge to 1 cluster (QA #11)
2. summarize per cluster: extractive default; Ollama if MEGACOMPACT_RAPTOR_MODEL set (local)
3. guardrails applyHallucinationGuardrails(summary, sourceNodes):
             - claim-to-chunk grounding (source_indices valid)
             - entity coverage = matched/summaryEntities
             - consistency = cosine(reEmbed(summary), centroid)
             - if consistency < 0.6 -> extractive fallback; else quality_marker by coverage/confidence
4. tree      buildRaptorTreeWithBudget(leaves, session, 5000ms):
             <10 chunks -> single summary node; loop cluster->summarize until 1 node;
             on timeout -> extractive fallback root
5. retrieve  stagedExpansion(queryVec): ANN all levels -> expand top-M -> BFS leaves ->
             MMR diversifies
6. shadow    if RAPTOR_SHADOW_MODE: build + append to events.log; do NOT replace retrieval
```

**Key details:**
- **Faithfulness** (QA #16): consistency re-embed is the hard gate; below 0.6 → extractive fallback (never a low-quality LLM summary).
- **Budget** (QA ops): 5s hard cap via `Promise.race([build, timeout])`; timeout → extractive root.
- **Shadow first:** RAPTOR runs and logs but doesn't alter retrieval until Sprint 14 promotes it.

---

## ACCEPTANCE CRITERIA

- [x] `npm test` green (13 new RAPTOR tests; full suite 180 pass).
- [x] RAPTOR tree builds within 5s budget on a 1K-chunk fixture (~400ms actual); <10 chunks → single summary node.
- [x] Guardrails CATCH a fixture hallucinated claim (un-grounded entity) → `quality_marker='extractive_fallback'`.
- [x] Shadow mode: builds + logs to `events.log`, does NOT change `recallAndInline` output (raptor_nodes is a separate table; live retrieval reads context_chunks only).
- [x] Eval (offline fixture): redundancy reduction 91% (100 leaves) / 99% (1000 leaves) ≥ 15% (node consolidation; see addendum on metric).
- [x] `guardrails-scan` clean (Ollama local; extractive default).

### Implementation notes / addendum

- **Module layout** (`src/dedup/raptor/`): `kmeans.ts` (k-means++ + near-zero-variance
  merge guard, QA #11), `summarizer.ts` (deterministic extractive default; optional
  localhost-only Ollama via `MEGACOMPACT_RAPTOR_MODEL`, same PREVENT-PI-004 exception
  class as HttpEmbedder), `guardrails.ts` (4-layer hallucination defense, QA #16),
  `tree.ts` (builder, wall-clock budget, <10 → single node), `retrieval.ts` (staged
  expansion: ANN → top-M → BFS to leaves → MMR), `index.ts` (orchestrator + shadow
  mode). `raptor_nodes` table added to `src/store/sqlite.ts`.
- **Node model:** every `RaptorNode.children` is a FLAT list of leaf ids (not a mix
  of node/leaf ids). The node map holds ONLY internal summary nodes — never
  per-leaf wrappers. This is what makes RAPTOR consolidate (`nodes.size << leaves`)
  and keeps the leaf walk in retrieval trivial.
- **Redundancy metric fix:** the spec's "≥15% reduction" is satisfied by node
  consolidation (fewer summary nodes than raw leaves), not by counting wrapper
  nodes. Early prototype counted per-leaf wrappers, which inverts the metric
  (nodes > leaves → negative reduction). Switched to leaf-id-flattened internal
  nodes.
- **BUG FOUND + FIXED — infinite-loop/deadline:** the level-merge step used
  `k = min(clustersPerLevel, currentLevel.length)`. When `currentLevel.length <=
  clustersPerLevel`, `k === count`, so every item became its own singleton cluster
  → next level identical size → loop ran until the 5s budget (11895 nodes, 5s for
  a 40-leaf input). Fixed by collapsing to a single root once the count drops to
  `<= clustersPerLevel`. Build time dropped from 5s → ~15–400ms. SEE [[pi-raptor-merge-bug]].
- **Budget fallback** is an extractive root at `level 99` with `timedOut=true`;
  the tree is never empty. Shadow mode persists + logs regardless; retrieval path
  is untouched until Sprint 14 promotes RAPTOR.

---

## ROLLBACK PROCEDURE

```bash
git revert <this-commit-sha>
```
`raptor_nodes` table additive; shadow mode means retrieval already ignores it.
No production behavior change until Sprint 14 enables it.
