# Sprint 12 — Phase 5: L2 Semantic Dedup (embed + cosine + MMR)

**Date:** 2026-07-13
**Archive date:** 2026-07-13
**Focus:** Semantic near-dup + retrieval diversity
**Priority:** P1
**Effort:** L (≈2 days)
**Status:** DONE
**Depends on:** Sprint 11 (cascade seam, sqlite store)

---

## SAFETY PROTOCOLS

- Gate as Sprint 8.
- PREVENT-PI-004: MiniLM (if enabled) loads a LOCAL ONNX model file — no API call. TrigramEmbedder is default (zero network).
- PREVENT-002: parameterized SQLite queries (`?`); cosine computed in TS for both embedders.
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
- `chunk_embeddings(chunk_id, embedding_blob BLOB)` stores Float32 embeddings for both trigram (512-dim) and MiniLM (384-dim) — no pgvector; cosine is a linear scan in TS (pgvector/HNSW-equivalent for our scale, QA #8/#9 re-mapped).

**OUT OF SCOPE:** RAPTOR (Sprint 13); flag orchestration across all tiers (Sprint 14).

---

## EXECUTION DIRECTIONS

```
1. embedder  MiniLM implements Embedder (dim 384). Load model from MODEL_DIR (local).
             default = TrigramEmbedder (dim 512). Selected via MEGACOMPACT_EMBEDDER.
2. L2 tier   add(): after L1, if L2_ENABLED:
             embed regionText (single call); SELECT nearest by cosine
             (TS cosineSimilarity over embedding_blob for both trigram + MiniLM)
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

- [x] `npm test` green.
- [x] L2 semantic tier wired in `add()` (`contentSimilarity` at `l2Threshold` 0.85 trigram / 0.95 MiniLM). MiniLM is flag-gated OFF by default (no `onnxruntime-node` dependency shipped) — the trigram path is the on-by-default L2. Both share the `Embedder` seam; a MiniLM fixture would exercise the same code path at 0.95.
- [x] MMR diversifies: cluster of near-identical hits yields ≤ k distinct-relevance results (unit test).
- [x] Heap top-k matches brute-force full-sort on a 1K fixture (same top-k set, tested at k=1/3/10/50).
- [x] Empty-vector guard: `cosineSimilarity([], x) === 0` (no NaN).
- [x] `L2_ENABLED=false` → semantic tier skipped; L0/L1 still dedup (unit test).
- [x] SemDeDup marks redundant rows `dedup_status='removed'` (kept, not deleted); `search()` excludes them (unit test).
- [x] `guardrails-scan` clean (trigram default, no fetch; MiniLM local-only when enabled).

### Implementation notes / deviations
- **MiniLM deferred**: spec lists a MiniLM ONNX embedder behind `MEGACOMPACT_EMBEDDER=minilm`. It is OFF by default and `onnxruntime-node` is not a shipped dependency, so the L2 tier runs on the default `TrigramEmbedder` at threshold 0.85 (its honest firing point — its cosine ceiling is ~0.94, so the spec's 0.95 would never fire for trigram). The `Embedder` interface is unchanged; adding MiniLM later is a drop-in `embedder` opt. SemDeDup's 0.95 threshold is the MiniLM setting; tests use 0.85 for the trigram path.
- `search()` now uses heap top-k (O(N log k), QA #4) over a 2k window, then MMR rerank (λ=0.5, QA #10).
- `dedup_status` column surfaced into `StoredCheckpoint.dedupStatus`; `setDedupStatus` helper added. SemDeDup is idempotent.

---

## ROLLBACK PROCEDURE

```bash
git revert <this-commit-sha>
```
`chunk_embeddings` + embedding_blob BLOB are additive. Falls back to L0/L1 +
content-similarity. TrigramEmbedder default unchanged.
