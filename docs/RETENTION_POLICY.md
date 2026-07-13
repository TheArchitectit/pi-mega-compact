# Retention Policy — pi-mega-compact

**Applies to:** v0.2.0 (Sprint 8 SQLite store + Sprints 9–14 dedup pipeline)
**Owner:** pi-mega-compact maintainers
**Status:** DONE

This document describes how long stored context-checkpoint data lives, how
deletion is performed safely, and how storage is reclaimed. It is the operational
companion to `DEDUP_RUNBOOK.md` (incident response) and `CHANGELOG.md` (v0.2.0
breaking change: SQLite replaces gzipped JSON).

---

## 1. Storage backend (source of truth)

From v0.2.0 the **one store** is a single SQLite database powered by
`better-sqlite3`:

| Property | Value |
|---|---|
| Engine | `better-sqlite3` (in-process native SQLite, **not** async PGlite) |
| Location | `~/.pi/agent/extensions/pi-mega-compact/sqlite.db` |
| Override | `MEGACOMPACT_STATE_DIR` (read at call time) |
| Journal | `WAL` (`PRAGMA journal_mode = WAL`) |
| Network | **Zero.** No `fetch`/HTTP at runtime (PREVENT-PI-004). |
| Indexes | FTS5 `trigram` tokenizer + B-tree indexes on `session_id`, `region_hash`, `content_hash` |

The database holds the following tables (additive across sprints):

- `context_chunks` — the checkpoint rows + their `embedding_blob` (Float32 cosine
  vector) + `compressed_original` (audit/replay BLOB).
- `minhash_signatures` / `dedup_lsh_buckets` — Sprint 11 L1 near-dup state.
- `session_state` — per-session runtime state.
- `raptor_nodes` — Sprint 13 hierarchical summary tree (shadow by default).
- `backfill_progress` — Sprint 14 resumable backfill cursor.

All queries are parameterized (PREVENT-002); there is no SQL string
concatenation.

---

## 2. TTL — 90 days

Checkpoints have a `timestamp` column (epoch ms). The **retention window is 90
days** (`90 * 24 * 60 * 60 * 1000 = 7,776,000,000 ms`).

**Policy:**

- A checkpoint whose `timestamp` is older than 90 days is **eligible for
  expiry**.
- Expiry is a **maintenance procedure**, not an inline auto-deleter on every
  `add()`. The dedup pipeline must never drop rows mid-session (PREVENT-PI-001
  anchor-floor guard applies to live compaction, not to the maintenance sweep).
- Expired rows are removed with the soft-delete lifecycle below, **then** the
  freed pages are reclaimed via `VACUUM` (§4).

> Operational note: there is no background cron inside the extension. Run the
> retention sweep as part of your periodic maintenance (§4), or script a
> threshold query (`WHERE timestamp < ?`) and delete in bounded batches.

---

## 3. Soft-delete via `dedup_status`

Deletion is **never a hard `DELETE`** for dedup collapses. Rows carry a
`dedup_status` column (`TEXT DEFAULT 'active'`) with three lifecycle states:

| `dedup_status` | Meaning | Set by |
|---|---|---|
| `active` | Normal, retrievable checkpoint. | Default / insert. |
| `removed` | Semantically redundant — **kept, not deleted**; excluded from retrieval. | SemDeDup (`semDedup()`). |
| `dup-resolved` | Collapsed during backfill; original kept for audit. | Backfill orchestrator. |

### SemDeDup marks `removed`, it does not delete

`VectorStore.semDedup(sessionId, threshold)` runs a **single idempotent scan**
over the session's `context_chunks` (skipping rows already `removed`), finds
near-duplicate pairs with cosine > threshold, and marks the **lower
`token_estimate`** row `dedup_status = 'removed'`. The higher-quality row stays
`active`.

```ts
// vectorStore.semDedup — marks, never deletes
setDedupStatus(drop.checkpointId, sid, "removed", this.stateDir);
// search() then filters them out:
(cp) => cp.dedupStatus !== "removed"
```

**Why keep them:** the kept-but-removed rows preserve the full dedup decision
history (so we can replay, audit, and un-remove if a tier is flipped to
`MARK_ONLY`), and `compressed_original` lets us re-summarize or re-inject a
region later. Hard-deleting would destroy that audit trail.

---

## 4. Reclaiming space — VACUUM cadence

`better-sqlite3` uses WAL. Marking rows `removed` frees *logical* space but
leaves *physical* pages allocated until the file is compacted.

**Recommended cadence:**

| Action | Frequency | Command |
|---|---|---|
| `PRAGMA integrity_check` | Before + after maintenance | `PRAGMA integrity_check;` (expect `ok`) |
| `VACUUM` | Monthly, or after a large `removed` sweep | `VACUUM;` |
| WAL checkpoint | On shutdown / before backup | `PRAGMA wal_checkpoint(TRUNCATE);` |

> `VACUUM` is an exclusive, blocking operation on the single in-process
> connection. Run it **off-peak** (the extension is not mid-session). Because the
> store is in-process and reused via a module-level connection cache, schedule
> maintenance when no pi session is compacting.

Bounded-batch alternative for live systems (avoid a full `VACUUM` lock): delete
expired/`removed` rows in pages of ≤1000 with `PRAGMA wal_checkpoint(TRUNCATE)`
between batches, then a single `VACUUM` when quiet.

---

## 5. Disaster-recovery snapshots (legacy JSON retained)

The pre-v0.2.0 gzipped JSON checkpoint files are **retained as a fallback**, not
deleted on migration:

- Legacy path: `<sessionId>.checkpoints.json.gz` (smart-compressed; detects
  legacy gzip via magic byte `0x1f`).
- `migrateJsonToSqlite(stateDir)` reads every `<sess>.checkpoints.json.gz`,
  imports rows into `sqlite.db`, and **keeps the JSON file in place** as a DR
  snapshot. Re-running is idempotent (no duplicate import).
- `compressed_original` BLOB in each `context_chunks` row is the in-database
  reconstructible raw region for audit/replay/re-summarize.

**Restore drill** (`scripts/dedup-restore-drill.sh`, per Sprint 15):

1. `PRAGMA integrity_check` — assert `ok`.
2. Count `context_chunks` rows; compare against the JSON snapshot's checkpoint
   count.
3. Recompute the `region_hash` set; compare to stored hashes (catches state
   drift).
4. If `sqlite.db` is missing/corrupt: rebuild from `<sess>.checkpoints.json.gz`.

---

## 6. Privacy / local-only guarantee

Everything above lives on local disk only. There is **no network egress**: no
telemetry, no remote backup, no API. The only allowed network surface is the
user-triggered `/dashboard` localhost UI server and an optional user-spawned
localhost embedding server (PREVENT-PI-004). To fully purge data, delete the
state dir:

```bash
rm -rf ~/.pi/agent/extensions/pi-mega-compact
```

This removes `sqlite.db`, the `-wal`/`-shm` files, `events.log`,
`dashboard.json`, `bloom.json.gz`, and the legacy `*.checkpoints.json.gz`
snapshots together.
