# Sprint 10 — Phase 3: L0 Exact-Match Upgrade (normalized + bloom + atomic + backfill)

**Date:** 2026-07-13
**Archive date:** (set on completion)
**Focus:** Robust exact dedup + local accelerator + safe migration
**Priority:** P0
**Effort:** L (≈2 days)
**Status:** READY
**Depends on:** Sprint 9 (normalize + digest)

---

## SAFETY PROTOCOLS

- Gate as Sprint 8.
- PREVENT-002: parameterized queries; bloom is an index, never a query builder.
- PREVENT-PI-004: bloom is in-process (pglite `bloom` index or in-memory `bloom-filters` Map persisted to `STATE_DIR/bloom.json.gz`). **PGlite is always the source of truth** — cache hit still confirmed via query (QA #2 local re-map).
- HALT if any test fails; do not hand-roll SQL without reading pglite API.

---

## PROBLEM STATEMENT

Sprint 9 adds `content_hash` dedup but (a) doesn't normalize before matching, so
"Foo  bar" vs "foo bar" still store twice; (b) has no accelerator for large
sessions; (c) has no atomicity guarantee if the process dies mid-write; (d) the
Sprint 8 migration populated hashes for existing data, but a fresh backfill
orchestration (for the MinHash/LSH tables later) must be resumable + idempotent
(QA #14).

**Root cause:** no normalization tier; no accelerator; no atomic write; no backfill controller.

---

## SCOPE BOUNDARY

**IN SCOPE:**
- `src/vectorStore.ts` — L0 key = `sha256(normalize(regionText))`; normalization handles case/whitespace/ANSI.
- PGlite partial UNIQUE index `idx_content_hash (WHERE content_hash IS NOT NULL)` (QA #1).
- Local bloom accelerator (pglite `bloom` index OR in-memory Map → `bloom.json.gz`); miss→skip scan; hit→confirm via query.
- Atomic write: single PGlite transaction for insert + index + bloom update (QA #12); query-timeout guard → degrade to "store, skip dedup this pass" (QA #13).
- Backfill orchestrator (`src/store/backfill.ts`): non-unique index → backfill hashes → resolve dups (keep oldest) → UNIQUE CONCURRENTLY → drop temp.
- Integrity checks (`src/store/integrity.ts`): sentinel vs recomputed; orphan id detection.

**OUT OF SCOPE:**
- MinHash/LSH signatures (Sprint 11) — but backfill must be structured so Sprint 11 plugs in its own phase.
- Semantic / RAPTOR.

---

## EXECUTION DIRECTIONS

```
1. L0 upgrade   add(): normalizedText = normalize(regionText);
                digest = computeContentDigest(normalizedText);
                SELECT ... WHERE content_hash=$1 AND content_hash2=$2
                (normalized -> catches case/whitespace/ANSI variants)
2. UNIQUE       CREATE UNIQUE INDEX idx_content_hash ON context_chunks(session_id, content_hash)
                WHERE content_hash IS NOT NULL;  -- partial (QA #1)
                INSERT ... ON CONFLICT DO NOTHING
3. BLOOM        option A: pglite `bloom` extension index on (session_id, content_hash)
                option B: bloom-filters Map persisted to STATE_DIR/bloom.json.gz
                miss -> skip full scan; hit -> ALWAYS confirm via SELECT (never sole arbiter)
4. ATOMIC       BEGIN; INSERT chunk; UPDATE bloom; COMMIT;
                timeout guard: if query > 50ms, catch -> insert with dedup_status='active', skip bloom
5. BACKFILL     src/store/backfill.ts: progress table; batches of 1000; throttle;
                resumable (stores last_processed_id); idempotent (ON CONFLICT DO NOTHING)
6. INTEGRITY    src/store/integrity.ts: recompute regionHash set from context_chunks,
                compare to storedRegionHashes; flag orphan injectedCheckpointId
```

**Key details:**
- **Bloom is accelerator only** (QA #2): with 0 false negatives, a miss truly means "new" and skips the scan; a hit is a candidate that MUST be confirmed by the SELECT. This bounds the happy path without ever trusting the cache.
- **Partial UNIQUE** (QA #1): `WHERE content_hash IS NOT NULL` so null rows don't violate the constraint; `ON CONFLICT DO NOTHING` makes backfill safe.
- **Atomic + timeout** (QA #12/#13): one transaction; if the DB is slow/unavailable, degrade to "store without dedup this pass" so we never lose a checkpoint.

---

## ACCEPTANCE CRITERIA

- [ ] `npm test` green.
- [ ] L0 normalization: "Foo  bar" and "foo bar" and "FOO BAR" (ANSI-stripped) all dedup to one row.
- [ ] Bloom FP rate < 1% (measured on a 1K-checkpoint fixture); miss path skips scan; hit path confirmed via query.
- [ ] Atomic write recovery: simulate crash mid-transaction → no partial row; replay succeeds.
- [ ] Backfill idempotent: running twice yields identical row count + no duplicate `content_hash` (partial UNIQUE enforced).
- [ ] Integrity check flags a tampered `storedRegionHashes` (recomputed ≠ stored) and detects an orphan `injectedCheckpointId`.
- [ ] `guardrails-scan` clean.

---

## ROLLBACK PROCEDURE

```bash
git revert <this-commit-sha>
```
`idx_content_hash` index remains; bloom files are additive. L0 falls back to
Sprint 9's non-normalized `content_hash` match (still correct, just less
aggressive). Backfill is re-runnable.
