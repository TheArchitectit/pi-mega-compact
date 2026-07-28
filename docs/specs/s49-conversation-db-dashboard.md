# Sprint 49 — Conversation-tracking DB + Dashboard tab

## Header

- **Sprint ID:** S49
- **Title:** Dedicated conversation-tracking database (turns / turn_recall /
  conversation_branches) + a Dashboard "Conversations" tab with prune / vacuum /
  threshold controls.
- **Status:** SPEC
- **Owner:** (unassigned)
- **Depends on:** S48 (tables + writer landed in v0.8.25), none else.
- **Files touched (planned):**
  - `src/store/conversations.ts` (NEW — the dedicated conversation DB)
  - `src/store/sqlite.ts` (REMOVE the turns/turn_recall/conversation_branches
    tables once migrated; keep a migration path)
  - `src/store/sqlite/schema.ts` (same, post-migration)
  - `extensions/mega-events/*.ts` (wire the writer to the new DB)
  - `extensions/dashboard-server/tabs/conversations.ts` (NEW)
  - `TESTER_GUIDE.md`, `docs/INDEX_MAP.md`, `docs/HEADER_MAP.md`, BACKLOG
- **Regression risk:** moving three tables out of the main context DB touches
  dashboard-server + session_state reads; migration must be additive
  (new-DB-first, legacy rows copied over, never deleted until green).

## Problem

The per-turn / per-conversation relational spine (turns, turn_recall,
conversation_branches) landed in the main `context.db` during S48 with no
dedicated surface and no maintenance tooling:

- The Dashboard has no way to show turn telemetry (ctx_tokens / pressure_band
  per turn) or to let the user trim stale turns/prune old conversations.
- Retention is undocumented (no `MEMORY_MAX_ROWS`-style cap for turns), so the
  S48 tables grow un-bounded across sessions.
- Mixing telemetry with the checkpoint store couples failure domains — a
  conversation-table OOM or lock stalls compaction reads.

S49 moves those three tables into their own DB + exposes them in the Dashboard.

## Goals

1. **Dedicated conversation DB** at `~/.pi/mega-compact/conversations.db` —
   independent schema, same `node:sqlite DatabaseSync` sync model. Writer is
   still synchronous; no async cascade.
2. **Bounded retention:** `turns` pruned at `CONVERSATION_MAX_TURNS` (default
   5000 rows, keeping the most recent per conversation; default matches the
   checkpoint "recent" invariant). `turn_recall` cascade-deletes with its turn.
   `conversation_branches` pruned when the parent conversation's last turn is
   gone and no descendant branch references the parent (leaves never dangle).
3. **Dashboard "Conversations" tab** (Phase C2 surface):
   - **Sessions list**: conversation_id → (turn count, first / last turn time,
     ctx_tokens trend, pressure_band minimap, current model).
   - **Session detail**: per-turn rows (index / duration / ctx_tokens /
     ctx_percent / pressure / model) + the recall provenance for that turn.
   - **Branches view**: conversation_branches rows (parent → child chains) so a
     user can eyeball where forks happened.
   - **Controls:**
     - "Prune old turns" button (respects `CONVERSATION_MAX_TURNS`; bands by
       conversation so old repos get trimmed first).
     - "Vacuum DB" button.
     - Threshold editors: `mega-compact-threshold` +
       `mega-compact-memory-review-interval` (read/write — the spatial surface
       of `/mega-config`, surfaced here since the threshold has been the #1
       config question on S38).
4. **Zero-downtime migration:** first dash / compact open copies any existing
   turn rows from the legacy `context.db` into the new DB (wrap in a retry loop;
   NODE_BUSY → skip and retry on next boot, never crash the extension).
5. **Backward-compat:** the S48 tables are kept as a read-fallback for one
   release cycle; writers stop writing to them once the new DB is hot.

## Risks / resolution

- See S48 risk table — a moved table is additive migration + mirroring; revert
  via removing the writer + deleting the new DB.
- The Dashboard tab is additive UI; the server side serves JSON via existing
  dashboard-server channels (`/api/conversations`, `/api/prune`, `/api/vacuum`,
  config-set). Zero new deps.

## Acceptance criteria

1. `npm run build && npm test` green — new tests: turn-write lands in the new
   DB; prune respects the cap; legacy migration copies rows; dashboard routes
   respond 200 under the existing dashboard-server test harness.
2. `node scripts/cross-repo-e2e.mjs` still all-green.
3. Dashboard `/dashboard` → Conversations tab renders sessions + turns +
   controls without new console errors.
4. A legacy `context.db` with S48 turns migrates to the new DB on first open
   (assert row count + contents match).

## Out of scope

- Disabling the legacy S48 tables in this release (one cycle of fallback first).
- Cross-machine conversation sync (still local).
- Rewriting the S48 writer — keep the current async turn_end flow, redirect the
  persistence target only.
