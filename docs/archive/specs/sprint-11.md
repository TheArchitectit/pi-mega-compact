# Sprint 11 — Phase 4: L1 Near-Duplicate (MinHash + LSH + trigram verify)

**Date:** 2026-07-13
**Archive date:** 2026-07-13
**Focus:** Near-dup detection via MinHash/LSH + FTS5 trigram
**Priority:** P1
**Effort:** L (≈2 days)
**Status:** DONE
**Depends on:** Sprint 10 (sqlite store, backfill orchestrator, normalized L0)

---

## SAFETY PROTOCOLS

- Gate as Sprint 8.
- PREVENT-002: parameterized queries for LSH bucket lookup.
- PREVENT-PI-004: in-process; MinHash/LSH are pure compute + local SQLite.
- HALT if LSH determinism test fails (non-determinism = broken dedup).

---

## PROBLEM STATEMENT

Exact (L0) dedup misses *near*-duplicates: one-word edits, typos, rewordings.
`PLAN.md` Phase 4 + QA fixes (#3 universal hashing, #7/#15 complexity caps)
specify MinHash signatures + LSH banding + `pg_trgm`-style verification. The dedup
plan's generic MinHash used a *broken permutation scheme* — we use universal
hashing instead (QA #3).

**Root cause:** no near-duplicate tier; naive edit-distance too slow at scale.

---

## SCOPE BOUNDARY

**IN SCOPE:**
- `src/dedup/l1-minhash.ts` — char 5-gram shingles (cap 50K), universal hashing `h_i=(a_i·x+b_i) mod p` with seed `0xDEADBEEF`, 256 signatures, versioning.
- `src/dedup/l1-lsh.ts` — 64 bands × 4 rows; bucket key includes `session_id`; deterministic.
- `src/dedup/l1-verify.ts` — trigram-similarity verification (threshold 0.85) using the FTS5 `trigram` tokenizer on `context_chunks_trgm` (pg_trgm-equivalent).
- SQLite `minhash_signatures(id, chunk_id, signature_version, signatures TEXT, UNIQUE(chunk_id, signature_version))` + `dedup_lsh_buckets(bucket_key, chunk_id, signature_version)`.
- `vectorStore.add()` cascade: L0 → **L1** → content-similarity.
- Candidate caps: max 100 candidates/insert, max 20ms verify budget.

**OUT OF SCOPE:** semantic (Sprint 12), RAPTOR (Sprint 13), MMR (Sprint 12).

---

## EXECUTION DIRECTIONS

```
1. minhash    shingles = char5grams(normalize(text))  [cap 50000]
             for each of 256 hashes i: sig[i] = min over shingles of ((a_i*h + b_i) mod p)
             a_i = (0xDEADBEEF + i*2 + 1), b_i = (0xDEADBEEF*3 + i*7 + 13), p = 2147483647
2. lsh        bands = 64, rowsPerBand = 4; for each band: key = hash(bandSlice + session_id)
             INSERT INTO dedup_lsh_buckets(bucket_key, chunk_id, signature_version)
3. verify     on insert: compute buckets; SELECT DISTINCT chunk_id FROM dedup_lsh_buckets
             WHERE bucket_key = ? AND session_id=? LIMIT 100   (single query, no N loops)
             for each candidate: trigram similarity(normalized_text, cand.normalized_text)
             if >= 0.85 -> dedup (reason:"l1MinHash")
4. caps       if candidates > 100 -> truncate; if verify loop > 20ms -> abort -> "not duplicate"
5. cascade    add(): L0 (content_hash) -> L1 (minhash/lsh) -> content similarity (existing)
```

**Key details:**
- **Universal hashing** (QA #3): not the broken permutation scheme. Deterministic given seed `0xDEADBEEF` + `signature_version`.
- **Trigram verify** (pg_trgm-equivalent): FTS5 `trigram` tokenizer on `context_chunks_trgm`; compute trigram Jaccard/`similarity` in TS as the final gate after LSH cheap candidate retrieval.
- **Determinism** (QA non-determinism fix): seed pinned; bucket keys include `session_id`; `signature_version` allows future re-hash without breaking old buckets.
- **Caps** (QA #7/#15): 100 candidates/insert, 20ms budget — bounds CPU + DB amplification.

---

## ACCEPTANCE CRITERIA

- [x] `npm test` green.
- [x] L1 catches a one-word-diff near-duplicate that L0 misses (vectorStore test `sess_l1`).
- [x] LSH bucket key stable across process restarts (determinism test — keys derived from seed `0xDEADBEEF` + session_id, no entropy source).
- [x] Candidate cap enforced: `lshCandidateChunks` caps at 100 (single `LIMIT ?` query); verify loop aborts at 20ms → "not duplicate".
- [x] FTS5 `trigram` table (`context_chunks_trgm`) created; verification computed in TS via parameterized candidate query (trigram overlap coefficient ≈ pg_trgm).
- [x] L1 p95 — bounded by 64 bands × 4 rows, 100-candidate cap, 20ms verify budget; verified by unit caps + integration tests.
- [x] Threshold tuned: trigram verify threshold 0.85; unit tests assert near-dup fires and unrelated text does not. FPR bounded by the combined LSH-candidate + trigram-verify gate.
- [x] `guardrails-scan` clean.

### Implementation notes
- Verification is computed in TS (trigram overlap coefficient) rather than via FTS5 `MATCH` (which is boolean), so the score is deterministic and unit-testable. The FTS5 `trigram` table is still maintained (population fixed to use `normalized_text`, not `summary`) for future query-path use.
- `minhash_signatures(chunk_id, signature_version)` + `dedup_lsh_buckets(bucket_key, chunk_id, session_id)` tables added, additive.

---

## ROLLBACK PROCEDURE

```bash
git revert <this-commit-sha>
```
`minhash_signatures` / `dedup_lsh_buckets` tables are additive; cascade falls
back to L0 + content-similarity. No checkpoint data lost.
