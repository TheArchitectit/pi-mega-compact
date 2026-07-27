# Sprint 39 — Real-time Multi-pi Stacked Memory Graph

**Status**: DONE — shipped v0.8.18–v0.8.21 (Sessions tab, `session_heartbeats`, `token_samples`; `SessionsTab.tsx`)
**Branch**: `feat/multi-pi-memory-graph`
**Prereq**: v0.8.16 (S38 error-retry shipped; dashboard-server multi-repo aggregation + React client already exist).

---

## Problem

The dashboard cannot show a real-time stacked graph of context-memory usage across all active local pi processes. Three concrete gaps:

1. **No chart library** — `dashboard-client/package.json` has only `react` + `react-dom`. All current "visuals" are CSS div-bars (`ContextGauge`, `PerfChart`). There is no line/stacked graph anywhere in `src/`.
2. **No per-session token time-series** — `dashboard.json` is a single atomically-replaced snapshot (no history array); `perf_samples` lacks context-token counts; `events.log` carries `fromTokens`/`toTokens` only on compaction events (sparse, not continuous).
3. **No reliable liveness signal** — `repo_registry.last_seen` updates only on `bindRepo` (repo-switch), so a pi process running in one repo for >30 min appears inactive even while it writes `dashboard.json` every turn. There is no PID registry, no heartbeat, no multi-session enumeration. Concurrent pi processes in the SAME repo collapse to one `repo_registry` row.

**Solution**: add (a) shared `session_heartbeats` + `token_samples` tables in the machine-wide `~/.mega-compact-index/index.sqlite` (mirroring the proven WAL multi-writer pattern of `repo_registry` / `injected_global`), (b) a runtime hook on `snapshot()` that appends a sample + heartbeat, (c) two server endpoints `/api/sessions` + `/api/sessions/timeseries`, and (d) a new `SessionsTab` in the React client using **recharts** for a stacked area + total line.

---

## Safety

- **PREVENT-PI-004 (zero network)** — all new writes are local `node:sqlite` into the shared index DB (WAL, in-process). recharts is bundled into the localhost-served static bundle only; it is not shipped in the pi-extension payload and makes no runtime network calls. Every new endpoint is loopback-only (same-origin, port 9320–9329).
- **PREVENT-PI-003 (no system-role injection)** — feature adds no prompts; purely monitoring.
- **PREVENT-002 (parameterized SQL)** — all new queries use `@named` / `$named` bind parameters (mirrors `global-index.ts`).
- **Non-fatal** — the runtime sample/heartbeat writes are wrapped in try/catch, mirroring the existing `upsertRepoRegistry` block at `state.ts:365-379`. A failed write never breaks the snapshot path or the agent loop.
- **Additive only** — new tables are `CREATE TABLE IF NOT EXISTS`; no per-repo store schema change; no migration of existing data. Existing `ActiveReposTable`, `OverviewTab`, and all `/api/*` routes are untouched.
- **Bounded** — `pruneStaleSessions` + `pruneTokenSamples` garbage-collect dead PIDs and old samples; default 30-min retention keeps the DB small.
- **Rollback** — removing the `state.ts` hook disables the feature without breaking the snapshot path; removing recharts + the Sessions tab reverts the client. Empty tables are harmless.

---

## Architecture

```
pi process A (repo X)                pi process B (repo Y)
  context event ──► runtime.snapshot(ctx)
                     │
                     ├─ this.dashboard.snapshot({...})   (existing — writes dashboard.json)
                     └─ NEW: recordSessionHeartbeat(pid, sid, repoRoot, stateDir, ctxWindow)
                        NEW: appendTokenSample(sid, repoRoot, tokens, percent, ctxWindow)
                                  │
                                  ▼
            shared ~/.mega-compact-index/index.sqlite  (WAL, multi-writer safe)
              ├─ repo_registry          (existing)
              ├─ injected_global        (existing)
              ├─ session_heartbeats     (NEW: PRIMARY KEY(pid, session_id))
              └─ token_samples          (NEW: append-only; idx on ts + (session_id, ts))

dashboard server (loopback, ports 9320–9329)
  GET /api/sessions            ──► readActiveSessions() + pruneStaleSessions()
                                  JOIN heartbeats + latest sample per session
  GET /api/sessions/timeseries?minutes=30
                              ──► readSessionTimeseries(sinceMs) + pruneTokenSamples()
                                  returns recharts-ready stacked shape + total + colors
  /api/events (SSE)           ──► existing tail of events.log; appendTokenSample
                                  ALSO writes a `session_sample` line → free real-time push

React client (dashboard-client, recharts)
  SessionsTab (NEW, 2s poll + SSE)
    ├─ SessionsMemoryChart    stacked <Area> per session + total <Line> + <Tooltip>
    ├─ ActiveSessionsTable    per-session: PID, repo, model, ctx%, tokens/window,
    │                         heartbeat age, state, sparkline
    └─ SessionsSummaryCard    active count, combined tokens, combined % of max window
```

---

## Execution (commits, one per step)

### Step 0 — Verify the already-written 400 context-overflow fix (FIRST, separate commit)

The OpenRouter "maximum context length ... requires at least N tokens ... reduce your input" 400 error did not match the existing S38.8 `context-overflow` regex (`too long|context window|...`) and fell through to the transient branch, firing 5 blind retry nudges that re-submitted the same oversized prompt → re-400 → busy-loop. The fix (already in the working tree, unverified):

- `extensions/mega-events/error-classifier.ts` — broaden the regex to also match `maximum context length|context length exceeded|requires at least \d+ tokens|reduce your input`.
- `extensions/mega-compact-s38.test.ts` — 3 regression tests with the exact user-facing error string.
- Gate: `npm run build` → `node --test dist/extensions/mega-compact-s38.test.js` → `node scripts/guardrails-scan.mjs` → `python3 scripts/regression_check.py --all`. Commit as `fix(error-classifier): broaden context-overflow regex for OpenRouter max-context 400`.

### Step 1 — Shared time-series store (`src/store/sqlite/global-index.ts`)

Extend `openIndexStore` schema with two new tables + indexes. Add helpers: `recordSessionHeartbeat`, `appendTokenSample`, `pruneStaleSessions`, `pruneTokenSamples`, `readActiveSessions`, `readSessionTimeseries`, `clearSessionHeartbeat`. All parameterized; mirror the `upsertRepoRegistry` / `markInjectedGlobal` conventions.

### Step 2 — Runtime hook (`extensions/mega-runtime/state.ts`)

Inside `snapshot()`, right after `this.dashboard.snapshot({...})` (line ~449), behind the existing material-change signature gate (`this.lastSnapshotSig === sig` already computed at 399-403 — no new throttle): call `recordSessionHeartbeat` + `appendTokenSample` with `process.pid`, `this.rt.sessionId`, `resolveRepoRoot(ctx.cwd) ?? this.currentStateDir`, `this.lastCtxTokens/Percent/Window`. try/catch non-fatal. Skip sample when `lastCtxTokens == null`.

### Step 3 — Server endpoints (`extensions/dashboard-server/server.ts` + api-contracts)

`GET /api/sessions` (active list + prune), `GET /api/sessions/timeseries?minutes=N` (recharts shape + total + stable per-session colors, minutes clamped [1,1440]). Extend `overlayCurrentRepo` → `overlayActiveSessions` for all active sessions (not just launcher). New contracts `ActiveSession` / `SessionsResponse` / `SessionTimeseriesResponse` / `SessionSeries` in `api-contracts/` + `endpoints.ts` registry.

### Step 4 — Client: recharts + Sessions tab (`extensions/dashboard-client/`)

Add `recharts` dep. New `SessionsMemoryChart` (stacked `<Area>` + total `<Line>` + `<Tooltip>` + `<Legend>` + `<ResponsiveContainer>`), `ActiveSessionsTable` (per-session rows + sparkline), `SessionsTab` (2s poll + SSE, window selector 5/15/30/60). Wire `sessions` tab into `App.tsx`. `fetchSessions` + `fetchSessionTimeseries` in `api/client.ts`. Styles in `src/styles/`.

### Step 5 — SSE real-time push (polish, low effort)

`appendTokenSample` also appends a `{type:'session_sample', ts, sessionId, tokens, percent}` line to the launcher repo's `events.log`. The existing `/api/events` SSE tail streams it for free → chart updates instantly between polls.

---

## Acceptance

- Step 0: S38 tests green (incl. 3 new context-overflow tests); guardrails + regression_check clean.
- Step 1: `node --test` over new `global-index` helpers (seed + read + prune) passes.
- Step 2: snapshot path still writes `dashboard.json`; a new sample row appears in `token_samples` per material change; no sample when `lastCtxTokens == null`.
- Step 3: `/api/sessions` returns active sessions with stale ones pruned; `/api/sessions/timeseries?minutes=10` returns the stacked shape + total; existing `dashboard-server*.test.js` still green.
- Step 4: `cd extensions/dashboard-client && npm run typecheck && npm run build` succeeds; Sessions tab renders the stacked graph from seeded data; empty state shows "No active sessions."
- Step 5: SSE delivers `session_sample` events.
- `node scripts/guardrails-scan.mjs` green (no new network; parameterized SQL).
- `python3 scripts/regression_check.py --all` green.
- Manual: two pi processes in two repos → both sessions stack in real time on the Sessions tab.

---

## Rollback

- Remove the `state.ts` snapshot hook → feature silently disabled; snapshot path unaffected.
- Drop the new tables (`DROP TABLE session_heartbeats; DROP TABLE token_samples;`) — safe, additive only.
- Remove recharts from `dashboard-client/package.json` + delete Sessions components/tab → client reverts.
- No per-repo store change, no data migration, no existing route changed.

---

## Out of scope

- Persisting token history beyond ~30 min (prune keeps the DB bounded; a future "History" tab can extend the window).
- Cross-MACHINE aggregation — the dashboard is loopback-only (PREVENT-PI-004). Multi-machine would require an explicit opt-in remote relay; not now.
- Replacing the existing `ActiveReposTable` or `OverviewTab` — additive only.
