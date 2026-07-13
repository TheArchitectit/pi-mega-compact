# Sprint 12 — Phase 5: L2 Semantic Dedup (embed + cosine + MMR)

**Date:** 2026-07-13
**Archive date:** (set on completion)
**Focus:** Semantic near-dup + retrieval diversity
**Priority:** P1
**Effort:** L (≈2 days)
**Status:** READY
**Depends on:** Sprint 11 (cascade seam, pglite store)

---

## SAFETY PROTOCOLS

- Gate as Sprint 8.
- PREVENT-PI-004: MiniLM (if enabled) loads a LOCAL ONNX model file — no API call. TrigramEmbedder is default (zero network).
- PREVENT-002: parameterized; pgvector `<->` operator for MiniLM path.
- HALT if embedding dim mismatch or empty-vector guard regresses.

---

## PROBLEM STATEMENT

`PLAN.md` Phase 5 wants semantic dedup + MMR retrieval diversity. The shipped
`TrigramEmbedder` ceiling (~0.94 cosine) means a 0.95 threshold can never fire,
so we set threshold 0.85 for trigram (can fire) and 0.95 for MiniLM (flag-gated,
384-dim, local). `VectorStore.search()` currently does a full sort (QA #4) and
has no MMR diversity (QA #10-era). SemDeDup offline cleanup (QA #17-era) is
needed to prune redundant stored embeddings.

**Root cause:** no semantic tier; full-sort search; no retrieval diversity.

---

## SCOPE BOUNDARY

**IN SCOPE:**
- `src/embedder.ts` — add `MiniLM` embedder (all-MiniLM-L6-v2 via `onnxruntime-node`, 384-dim, local model file) behind `MEGACOMPACT_EMBEDDER=minilm` (off by default); `TrigramEmbedder` stays default.
- `src/dedup/mmr.ts` — `mmrRerank()` (λ=0.5) applied in `vectorStore.search()`.
- `vectorStore.add()` L2 tier: cosine ≥ 0.85 (trigram) / 0.95 (MiniLM); single load per add (QA #5).
- Heap-based top-k (min-heap, O(N log k)) replaces full sort (QA #4).
- Unit-normalize on write; empty-vector guard → 0 (QA #6/#17).
- `L2_ENABLED` flag; SemDeDup offline cleanup job (cosine > 0.95 → `dedup_status='removed'`).
- `chunk_embeddings(chunk_id, embedding vector(384))` + pglite `pgvector` ONLY when MiniLM active (QA #8/#9).

**OUT OF SCOPE:** RAPTOR (Sprint 13); flag orchestration across all tiers (Sprint 14).

---

## EXECUTION DIRECTIONS

```
1. embedder  MiniLM implements Embedder (dim 384). Load model from MODEL_DIR (local).
             default = TrigramEmbedder (dim 512). Selected via MEGACOMPACT_EMBEDDER.
2. L2 tier   add(): after L1, if L2_ENABLED:
             embed regionText (single call); SELECT nearest by cosine
             (trigram: TS cosineSimilarity; MiniLM: ORDER BY embedding <=> $1 LIMIT k)
             if best >= threshold -> dedup (reason:"l2Semantic")
3. normalize store unit-normalized embedding; cosineSimilarity guards empty -> 0
4. search    replace .sort by heap top-k (min-heap size k); then mmrRerank(hits, qvec, 0.5)
5. semdedup  offline job: REPEATABLE READ snapshot; mark cosine>0.95 pairs'
             lower-quality row dedup_status='removed' (keep higher tokenEstimate)
```

**Key details:**
- **Two embedders, one interface:** `Embedder` seam unchanged (Sprint 7.1 deferral honored — trigram default, MiniLM opt-in).
- **Threshold honesty:** 0.85 for trigram (its real ceiling), 0.95 for MiniLM. Documented in `src/config/dedup.ts` (Sprint 14).
- **Heap top-k** (QA #4): O(N log k) vs O(N log N) full sort — matters at 10K checkpoints.
- **MMR** (QA #10): `score = λ·rel − (1−λ)·maxSimToSelected`, λ=0.5 — diversifies recall injection.

---

## ACCEPTANCE CRITERIA

- [ ] `npm test` green.
- [ ] L2 (MiniLM fixture) catches semantically-similar but differently-worded content that L0/L1 miss.
- [ ] MMR diversifies: a cluster of near-identical hits yields ≤ k distinct-relevance results.
- [ ] Heap top-k matches brute-force full-sort on a 1K fixture (same top-k set).
- [ ] Empty-vector guard: `cosineSimilarity([], x) === 0` (no NaN).
- [ ] `L2_ENABLED=false` → L2 skipped; trigram path still dedups at 0.85.
- [ ] SemDeDup marks redundant rows `dedup_status='removed'` without deleting; retrieval excludes them.
- [ ] `guardrails-scan` clean (MiniLM is local; no fetch).

---

## ROLLBACK PROCEDURE

```bash
git revert <this-commit-sha>
```
`chunk_embeddings` + pgvector extension are additive. Falls back to L0/L1 +
content-similarity. TrigramEmbedder default unchanged.
