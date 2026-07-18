# Sprint 9 — DB Maintenance / Housekeeping

**Date:** 2026-07-17
**Focus:** DB housekeeping + raw transcript mirroring + epoch tracking
**Priority:** P0
**Effort:** S (≈0.5 day)
**Status:** DONE
**Depends on:** Sprint 8 (SQLite store, FTS5, WAL mode, checkpoint_epochs)

---

## SAFETY PROTOCOLS

- Gate: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`
- PREVENT-002: parameterized SQLite queries only (`?` placeholders).
- PREVENT-PI-004: no network. All operations are local SQLite.
- Stay in scope: only `extensions/mega-events.ts`, `src/store/sqlite.ts`.

---

## PROBLEM STATEMENT

No `/db` command exists for housekeeping. Users cannot:
- See DB size, age, WAL status
- Manually trigger retention cleanup
- Force a WAL checkpoint
- Check index health

Additionally, the new `raw_transcript` and `checkpoint_epochs` tables (Sprint 8)
need event wiring to actually receive data.

---

## SCOPE BOUNDARY

**IN SCOPE:**
- `/db` command with sub-commands: status, retention, wal, reindex
- DB-mirror event hooks (opt-in via `MEGACOMPACT_DB_MIRROR=1`)
- Auto-retention on compaction (once per cycle)
- WAL mode enablement + journal_size_limit

**OUT OF SCOPE:**
- Full context-chunks materialization (Sprint 10)
- FTS5 upgrades (Sprint 10)
- Vector index changes (Sprint 10)

---

## IMPLEMENTATION

### 6.1 `/db` command

Sub-commands:
- `status` — DB path, size, age, WAL mode, table counts, index health
- `retention` — manual retention cleanup (delete old epochs, vacuum)
- `wal` — force WAL checkpoint
- `reindex` — rebuild FTS5 indexes

### 6.2 DB-mirror event hooks

When `MEGACOMPACT_DB_MIRROR=1`:
- `compaction:after` → write checkpoint epoch + backfill epoch IDs in transcript
- `ingestion:after` → append raw transcript rows
- `post_inject:after` → append raw transcript rows
- `conversation_turn:after` → append raw transcript rows

### 6.3 Auto-retention

On each compaction cycle:
- Delete checkpoint epochs older than 30 days
- Delete raw transcript rows older than 30 days
- VACUUM if DB > 100 MB

---

## ACCEPTANCE CRITERIA

- [x] `/db` command responds with status info
- [x] DB-mirror flag is opt-in (default off)
- [x] Auto-retention runs once per compaction cycle
- [x] All 388 tests pass (0 fail)
- [x] `npx tsc --noEmit` clean

---

## Implementation Notes (v0.7.4)

### Files created
- `src/store/sqlite.dbmirror.test.ts` — 12 unit tests for the new tables
- `extensions/mega-events.test.ts` — 4 integration tests for DB-mirror flag

### Files modified
- `src/store/sqlite.ts` — added `raw_transcript` + `checkpoint_epochs` tables to `openStore`, plus `appendRawTranscript`, `listRawTranscriptRange`, `writeCheckpointEpoch`, `readCheckpointEpoch`, `getActiveEpochForSession`, `listCheckpointEpochs`, `countRawTranscript`
- `extensions/mega-events.ts` — wired `compaction:after`, `ingestion:after`, `post_inject:after`, `conversation_turn:after` hooks for DB-mirror writes; added `/db` command (status/index/reindex/wal/archive); added `applyRetention`, `getDbAgeDays`, `getDbSizeBytes`, `rebuildTranscriptIndex`, `runRetention`

### Validation
- 388 tests pass (0 fail) — all pre-existing Trident, dedup, and extension tests unaffected
- `npx tsc --noEmit` clean
- DB-mirror tables created on first `openStore` (idempotent)
- Auto retention runs once per compaction cycle (not on every event fire)
- WAL mode enabled for concurrent read/write safety
- PRAGMA journal_size_limit = 64 MB caps WAL growth
