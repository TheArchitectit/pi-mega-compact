# Sprint 13 — Phase 6: RAPTOR Pre-Compression

**Date:** 2026-07-13
**Archive date:** (set on completion)
**Focus:** Hierarchical summary tree + hallucination guards
**Priority:** P2
**Effort:** L (≈2 days)
**Status:** READY
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
- PGlite `raptor_nodes(id, session_id, level, parent_id, children TEXT[], summary, embedding real[], quality_marker, token_estimate)`.
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

- [ ] `npm test` green.
- [ ] RAPTOR tree builds within 5s budget on a 1K-chunk fixture; <10 chunks → single summary node.
- [ ] Guardrails CATCH a fixture hallucinated claim (un-grounded entity) → `quality_marker='extractive_fallback'` or `'low'`.
- [ ] Shadow mode: builds + logs to `events.log`, does NOT change `recallAndInline` output.
- [ ] Eval (offline fixture): nDCG@K drop < 0.05 vs flat retrieval; entity preservation ≥ 0.70; redundancy reduction ≥ 15%.
- [ ] `guardrails-scan` clean (Ollama local; extractive default).

---

## ROLLBACK PROCEDURE

```bash
git revert <this-commit-sha>
```
`raptor_nodes` table additive; shadow mode means retrieval already ignores it.
No production behavior change until Sprint 14 enables it.
