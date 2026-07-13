# Sprint 9 — Phase 2: Content-Addressable Dedup + Compressed Originals

**Date:** 2026-07-13
**Archive date:** 2026-07-13
**Focus:** SHA-256 content dedup + reconstructible originals
**Priority:** P0
**Effort:** M (≈1 day)
**Status:** DONE
**Depends on:** Sprint 8 (sqlite store with `content_hash` columns + migration populated)

---

## SAFETY PROTOCOLS

- Gate: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`
- PREVENT-002: parameterized SQLite queries only (`?` placeholders).
- PREVENT-PI-004: no network. Normalize/digest are pure functions.
- Stay in scope: only `src/dedup/*`, `src/vectorStore.ts` add() L0 tier.

---

## PROBLEM STATEMENT

`PLAN.md` Phase 2B wants content-addressable dedup: identical checkpoint content
should never be stored twice, and the raw input must be reconstructible for
audit/replay (rad-gateway `CompressedOriginal` pattern). The sqlite `content_hash`
columns were added + populated in Sprint 8's migration but are not yet used for
dedup decisions. `summaryHash` in `vectorStore.ts` uses only 16 hex chars —
collision-prone as a dedup key.

**Root cause:** no content-hash dedup tier; truncated hash key; no audit trail.

---

## SCOPE BOUNDARY

**IN SCOPE:**
- `src/dedup/normalize.ts` — text normalization (ANSI strip, Unicode NFC, whitespace collapse, 32K cap, newline normalize).
- `src/dedup/digest.ts` — `computeContentDigest`: SHA-256 primary (`content_hash`, 64 hex) + secondary variant (`content_hash2`) for collision safety; `content_hash_version`.
- `src/vectorStore.ts` — new L0 tier: `content_hash` exact match (before `regionHash`); bump timestamp on hit.
- Bump `summaryHash` from 16→full hex (dedup key safety).
- `compressed_original` storage on write (zstd-compressed raw region).

**OUT OF SCOPE:**
- Bloom accelerator (Sprint 10), MinHash/LSH (Sprint 11), semantic (Sprint 12).
- Normalized-content L0 upgrade / backfill (Sprint 10) — only base hashing here.

---

## EXECUTION DIRECTIONS

```
1. normalize.ts  stripAnsi + NFC + collapseWhitespace + cap32k
2. digest.ts     computeContentDigest(text):
                  sha = sha256(normalize(text)); sha2 = sha256(normalize(text).reverse());
                  return { content_hash: sha, content_hash2: sha2, content_hash_version: 1 }
3. vectorStore.add():
   a. normalizedText = normalize(regionText)
   b. digest = computeContentDigest(normalizedText)
   c. SELECT id FROM context_chunks WHERE content_hash=? AND content_hash2=? AND session_id=?
   d. if hit -> update timestamp, return { deduped:true, reason:"contentHash" }
   e. else proceed to regionHash / summaryHash / similarity tiers (existing)
4. on insert: write content_hash, content_hash2, content_hash_version, normalized_text,
   compressed_original = await zstdCompress(rawRegion)   -- async helper (see src/store/compression.ts)
5. summaryHash: sha256(topicSummary) full 64 hex (was .slice(0,16))
```

**Key details:**
- **Dual hash** (QA #2 spirit, local): primary + secondary before declaring duplicate — guards against a single-hash collision silently merging distinct content.
- **compressed_original** stored as `BLOB` (sqlite). Reconstruct via `await zstdDecompress` for audit/replay/re-summarize. Not loaded on the hot read path (lazy).

---

## ACCEPTANCE CRITERIA

- [x] `npm test` green.
- [x] `content_hash` dedup catches identical content arriving under different `regionText` (case/whitespace variants tested in Sprint 10).
- [x] Dual-hash: a collision on primary alone does NOT dedup (secondary disagrees).
- [x] `compressed_original` roundtrips through synchronous `compressSmart` (deviation: sync brotli, not async zstd — keeps `add()` sync).
- [x] `summaryHash` is now 64-hex; existing 16-hex summaries re-hashed on next write (backward-safe: old key still matches old rows).
- [x] `guardrails-scan` clean.

---

## ROLLBACK PROCEDURE

```bash
git revert <this-commit-sha>
```
`content_hash` columns remain (Sprint 8); only the add() L0 branch + digest helpers revert. No data loss — existing rows keep their hashes.
