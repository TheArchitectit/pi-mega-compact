# Sprint 10 — Phase 3: L0 Exact-Match Upgrade (normalized + bloom + atomic + backfill)

**Date:** 2026-07-13
**Archive date:** 2026-07-13
**Focus:** Robust exact dedup + local accelerator + safe migration
**Priority:** P0
**Effort:** L (≈2 days)
**Status:** DONE
**Depends on:** Sprint 9 (normalize + digest)

---

## SAFETY PROTOCOLS

- Gate as Sprint 8.
- PREVENT-002: parameterized queries (`?`); bloom is an index, never a query builder.
- PREVENT-PI-004: bloom is in-process (in-memory `bloom-filters` Map persisted to `STATE_DIR/bloom.json.gz`). **SQLite is always the source of truth** — cache hit still confirmed via query (QA #2 local re-map).
- HALT if any test fails; do not hand-roll SQL without reading the better-sqlite3 API.

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
- SQLite partial UNIQUE index `idx_content_hash (WHERE content_hash IS NOT NULL)` (QA #1).
- Local bloom accelerator (in-memory `bloom-filters` Map persisted to `STATE_DIR/bloom.json.gz`); miss→skip scan; hit→confirm via query.
- Atomic write: single SQLite `db.transaction()` for insert + index + bloom update (QA #12); query-timeout guard → degrade to "store, skip dedup this pass" (QA #13).
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
                SELECT ... WHERE content_hash=? AND content_hash2=?
                (normalized -> catches case/whitespace/ANSI variants)
2. UNIQUE       CREATE UNIQUE INDEX idx_content_hash ON context_chunks(session_id, content_hash)
                WHERE content_hash IS NOT NULL;  -- partial (QA #1)
                INSERT ... ON CONFLICT DO NOTHING
3. BLOOM        in-memory bloom-filters Map persisted to STATE_DIR/bloom.json.gz
                miss -> skip full scan; hit -> ALWAYS confirm via SELECT (never sole arbiter)
4. ATOMIC       db.transaction(() => { INSERT chunk; UPDATE bloom; }); COMMIT;
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

- [x] `npm test` green.
- [x] L0 normalization: "Foo  bar" / "foo bar" / "FOO BAR" / ANSI-stripped all dedup to one row (case-fold added to `normalize`).
- [x] Bloom accelerator: miss path skips scan (`maybeHas` is definitive false-negative); hit path confirmed via the SQLite `all` scan. Persisted to `bloom.json.gz` and reloaded warm. (FP rate bounded by 8KiB/7-hash design; measured <1% at 1K fixture in unit checks.)
- [x] Atomic write: every `upsertCheckpoint` runs inside `db.transaction()`; QA #13 timeout guard degrades the O(n) similarity scan to "store without dedup" rather than lose a checkpoint.
- [x] Backfill idempotent: second run processes 0 rows (resumable cursor on (session_id, id)); partial UNIQUE enforces no duplicate `content_hash`.
- [x] Integrity check flags a tampered `storedRegionHashes` (recomputed ≠ stored) and detects an orphan `injectedCheckpointId`.
- [x] `guardrails-scan` clean.

### Notable fixes surfaced during Sprint 10
- **Cross-session PK collision (real bug):** `context_chunks.id` was a global PRIMARY KEY, but checkpoint ids are only unique per session (`chkpt_001` per session). The second session's `upsertCheckpoint` silently overwrote the first session's row. Fixed by making the PK composite `(session_id, id)` (unique index `idx_chunks_pk`). Backfill cursor retargeted to `(session_id, id)`.
- **Session-state source-of-truth split:** `vectorStore` and `integrity` were reading `storedRegionHashes` from two different backends (JSON `store.js` vs SQLite `sqlite.js`), so the sentinel/integrity never agreed. Unified both on the SQLite `session_state` table.

---

## ROLLBACK PROCEDURE

```bash
git revert <this-commit-sha>
```
`idx_content_hash` index remains; bloom files are additive. L0 falls back to
Sprint 9's non-normalized `content_hash` match (still correct, just less
aggressive). Backfill is re-runnable.
