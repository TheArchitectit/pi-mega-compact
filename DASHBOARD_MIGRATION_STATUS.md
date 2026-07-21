# DASHBOARD_MIGRATION_STATUS.md

**Branch:** `game-mode`  
**Last updated:** 2026-07-21  
**Owner:** dashboard-migration workstream  
**Purpose:** Single-source status board for the dashboard rewrite (React frontend) migration. Tracks what is DONE vs TO DO across the 9 sprint specs, the api-contracts split, the tsconfig exclude fix, and the map regeneration.

This document is a *planning + tracking* artifact. The per-sprint authoritative specs live in [`docs/specs/sprint-*.md`](docs/specs/). See the "Sprint specs" section of [`docs/INDEX_MAP.md`](docs/INDEX_MAP.md) for the full index.

---

## Legend

| Marker | Meaning |
| --- | --- |
| ✅ DONE | Spec written and/or implementation merged; gate green. |
| 🟡 SCAFFOLD | Partial implementation present but not complete / not wired. |
| ⬜ TODO | Not yet implemented. |

---

## 1. DONE — Planning & Foundation

All planning artifacts for the dashboard rewrite are complete. No dashboard-client implementation is shipped yet (the React app is scaffold-only and excluded from the TypeScript build via `tsconfig.json`).

### 1.1 Sprint specs written (9/9)

All nine dashboard-migration sprint specs are authored and committed:

| Sprint | Spec | Focus | Status |
| --- | --- | --- | --- |
| A1 | [`sprint-A1-api-contract.md`](docs/specs/sprint-A1-api-contract.md) | API contract, typed endpoints, `EndpointDef` | ✅ spec written, ✅ impl DONE (v0.8.9) |
| B1 | [`sprint-B1-react-scaffold.md`](docs/specs/sprint-B1-react-scaffold.md) | React scaffold, Vite, SSE hook, API client | ✅ spec written, ✅ impl DONE (v0.8.9) |
| C1 | [`sprint-C1-core-tabs.md`](docs/specs/sprint-C1-core-tabs.md) | Core tabs: Overview, Events, context gauge | ✅ spec written, ✅ impl DONE (v0.8.9) |
| C2 | [`sprint-C2-repos-metrics.md`](docs/specs/sprint-C2-repos-metrics.md) | Repos table, metrics, perf charts, drill-down | ✅ spec written, ✅ impl DONE (v0.8.9) |
| C3 | [`sprint-C3-config.md`](docs/specs/sprint-C3-config.md) | Config tab, game-mode settings, theme picker | ✅ spec written, ⬜ impl TODO |
| D1 | [`sprint-D1-resilience.md`](docs/specs/sprint-D1-resilience.md) | Resilience: offline banner, retry, stale indicator | ✅ spec written, ⬜ impl TODO |
| D2 | [`sprint-D2-observability.md`](docs/specs/sprint-D2-observability.md) | Observability, diagnostics panel, health, **provider-failure hook** | ✅ spec written (scope expanded), ⬜ impl TODO |
| D3 | [`sprint-D3-docs-release.md`](docs/specs/sprint-D3-docs-release.md) | Docs + release, tester guide, migration | ✅ spec written, ⬜ impl TODO |
| T1 | [`sprint-T1-tailscale.md`](docs/specs/sprint-T1-tailscale.md) | Tailscale remote access, auth, CSRF | ✅ spec written, ⬜ impl TODO |

### 1.2 api-contracts split into domain modules

The monolithic `extensions/dashboard-server/api-contracts.ts` was decomposed into a typed, domain-structured barrel under `extensions/dashboard-server/api-contracts/`:

| File | Domain |
| --- | --- |
| [`api-contracts/core.ts`](extensions/dashboard-server/api-contracts/core.ts) | `HttpMethod`, `EndpointDef`, all `Sse*` core event types |
| [`api-contracts/snapshot.ts`](extensions/dashboard-server/api-contracts/snapshot.ts) | `SnapshotResponse`, `TriggerResponse`, `CompressionTotalsResponse`, `CompactHistoryEntry`, `CompactionRequest/Response` |
| [`api-contracts/multi-repo.ts`](extensions/dashboard-server/api-contracts/multi-repo.ts) | `RepoListItem`, `RepoSnapshotEntry/Map`, `Indexes*`, `DiffRequest/Response`, `UpdateRepoConfigRequest` |
| [`api-contracts/game.ts`](extensions/dashboard-server/api-contracts/game.ts) | `GameConfig`, `GameStateResponse`, `GameRitualStage`, `SseGame*` events |
| [`api-contracts/infrastructure.ts`](extensions/dashboard-server/api-contracts/infrastructure.ts) | `InfraHealth/Perf/RateLimit`, `ContextLevelState`, tier/fallback/repeat-injection/supersede-gating/minhash-band state |
| [`api-contracts/index.ts`](extensions/dashboard-server/api-contracts/index.ts) | Barrel: re-exports all domains + composite `SseEvent` union |
| [`api-contracts.ts`](extensions/dashboard-server/api-contracts.ts) | **Deprecated** backward-compat barrel — re-exports from `api-contracts/index.js` |

The composite `SseEvent` union (all 20 core + game events) is composed in `index.ts`.

### 1.3 tsconfig dashboard-client exclude fix

`tsconfig.json` `exclude` now includes `"extensions/dashboard-client"` so the React/TSX scaffold (which imports not-yet-created components and relies on a separate Vite build pipeline) does not break the extension's `tsc -p tsconfig.json` build or `tsc --noEmit` lint.

```diff
- "exclude": ["node_modules", "dist", "guardrails-template", "extensions/openclaw-mega-compact.ts"]
+ "exclude": ["node_modules", "dist", "guardrails-template", "extensions/openclaw-mega-compact.ts", "extensions/dashboard-client"]
```

### 1.4 HEADER_MAP regenerated with accurate line numbers

[`docs/HEADER_MAP.md`](docs/HEADER_MAP.md) was regenerated so all `file:line` references reflect the current document state (the dashboard-migration section and api-contracts entries shifted line numbers in prior commits).

### 1.5 INDEX_MAP entries added

[`docs/INDEX_MAP.md`](docs/INDEX_MAP.md) gained a **DASHBOARD REWRITE (React frontend sprints)** section indexing all 9 sprint specs plus per-file entries for every api-contracts domain module and the deprecated barrel.

### 1.6 D2 provider-failure observability scope added

[`docs/specs/sprint-D2-observability.md`](docs/specs/sprint-D2-observability.md) scope was expanded beyond the original diagnostics panel to also cover **provider (model endpoint) failure observability**:

- Problem statement now documents that non-2xx provider responses were only recorded as latency samples with a `status` tag — not flagged, counted, or surfaced.
- Scope adds: `extensions/mega-events/perf-handler.ts` (flag non-2xx `after_provider_response` as `provider_failure`), `extensions/dashboard-server/server.ts` (`/api/diag` returning provider failure count + rate + last status), and `DiagnosticsPanel.tsx` (provider-failure row, green/red).
- Execution directions add a `PROVFAIL` step and acceptance/rollback checkboxes for failure flagging, `/api/diag`, and the DiagnosticsPanel surface.

### 1.7 B1 React scaffold — ✅ COMPLETE

The React + Vite scaffold is fully built and served by the dashboard server:

- `dashboard-client/` is a standalone Vite + React + TypeScript sub-project (own `package.json`, `tsconfig.json`, `vite.config.ts`, `.gitignore`). Dev deps: react 18, vite 5, @vitejs/plugin-react, typescript 5. Build artifacts (`dist/`, `node_modules/`) are git-ignored.
- `src/main.tsx` + `index.html` — React entry, StrictMode, `#root` mount.
- `src/App.tsx` — shell: header (title + tier pill + version), `TabBar` (Overview|Repos|Events|Config|Metrics), lazy-loaded tab routing, `ErrorBoundary` + `Suspense`.
- `src/components/` — `ErrorBoundary` (catch render errors + reload), `TabBar` (role=tablist), `LoadingSpinner`.
- `src/api/client.ts` — typed fetch wrappers for all 13 A1 endpoints using the `ENDPOINTS` registry; `ApiError` on non-2xx; relative paths only (loopback, PREVENT-PI-004).
- `src/tabs/` — 5 B1 stubs (Overview shows tier; others placeholder, marked `SPRINT-C1/C2/C3-REMAINING`).
- `src/hooks/useApi.ts` + `src/hooks/useSSE.ts` — pre-existing scaffold hooks retained; retry/backoff/stale still marked `SPRINT-D1-REMAINING`.
- `server.ts` — Sprint B1 static-serve: multi-candidate `clientDist` resolution (dist build + dev layouts); `serveClientAsset` serves real assets with correct MIME + SPA fallback (`index.html`) for unknown non-`/api/*` routes; falls back to legacy `html.ts` when client dist absent. CORS tightened from wildcard `*` to localhost/127.0.0.1 origins only.
- Root `package.json` — `build:dashboard` script added.

Gate green: build, `build:dashboard` (45 modules, 147KB main + 5 lazy chunks), 589 tests/0 fail, lint, regression_check, guardrails-scan. Smoke: `GET /` serves React `#root`; `/assets/*.js` → `text/javascript`; `/api/snapshot` → JSON; `/repos` SPA fallback → `#root`.

---

## 2. TO DO — Implementation

Implementation order follows the spec dependency chain: **A1 → B1 → C1 → C2 → C3 → D1 → D2 → D3 → T1**.

### 2.1 Sprint A1 — API contract implementation ✅ DONE

Spec: [`sprint-A1-api-contract.md`](docs/specs/sprint-A1-api-contract.md)

Completed in v0.8.9 on `game-mode`. Deliverables:

- [x] `ENDPOINTS` registry constant in `api-contracts/endpoints.ts` — single source of truth for all 13 API routes (12 paths + PUT `/api/game-state`), each typed as `EndpointDef` / `SseEndpointDef`.
- [x] `extensions/dashboard-server/types.ts` re-exports `IndexRepo` (as `IndexesIndexRow`) and `SnapshotResponse` from `api-contracts/`; back-compat barrel `api-contracts.ts` preserved.
- [x] `extensions/dashboard-server/api-contracts.test.ts` — 24 tests: 13 compile-time `satisfies EndpointDef<...>` checks + runtime registry/path cross-reference + per-endpoint JSON payload validation.
- [x] JSDoc on every exported interface and field across all 6 `api-contracts/*.ts` modules (units documented for numeric fields; enum values for string-literal unions).
- [x] Gate green: build ✅, 589 tests / 0 fail ✅, lint ✅, regression_check ✅, guardrails-scan ✅.

**Next unblocker:** Sprint B1 (React scaffold completion).

### 2.2 Sprint B1 — React scaffold completion ✅ DONE

Spec: [`sprint-B1-react-scaffold.md`](docs/specs/sprint-B1-react-scaffold.md)

Completed in v0.8.9 on `game-mode` (see §1.7 for full deliverable list).

- [x] Vite config + `dashboard-client/package.json` + dev/build scripts.
- [x] Created missing components: `ErrorBoundary.tsx`, `TabBar.tsx`, `LoadingSpinner.tsx`.
- [x] Created tab stubs: `OverviewTab.tsx`, `ReposTab.tsx`, `EventsTab.tsx`, `ConfigTab.tsx`, `MetricsTab.tsx`.
- [x] Wired `useApi` + `useSSE` into the shell; `/api/snapshot` fetched via typed `fetchSnapshot()`; `/api/events` consumed by `useSSE`.
- [x] Build pipeline produces a static bundle the dashboard server serves (SPA fallback + asset MIME types).
- [x] `html.ts` fallback preserved when client dist absent.

**Next:** Sprint C1 (core tabs — real Overview/Events content, context gauge).

### 2.3 Sprint C1 — Core tabs ✅ DONE

Spec: [`sprint-C1-core-tabs.md`](docs/specs/sprint-C1-core-tabs.md)

Completed in v0.8.9 on `game-mode`.

- [x] **OverviewTab** — 4-card grid (ContextGauge, CompressionCard, TriggerStatus, SessionInfo) consuming typed `SnapshotResponse` fields; header with tier pill + last-updated timestamp. Polls `/api/snapshot` every 5s (wired in `App.tsx` via `useApi({pollInterval:5000})`).
- [x] **EventsTab** — live SSE stream via `useSSE` hook + `EventStream` component; connection-status dot (connected/connecting/disconnected/error) + event count.
- [x] **ContextGauge** — color-coded percent fill bar (green <60%, yellow 60–80%, red >80%); sublabel `{tokens} / {contextWindow} tokens ({percent}%)`; K/M token formatting.
- [x] **CompressionCard** — stat grid: tokens in/out, freed (highlighted green), compression %, dedup %.
- [x] **TriggerStatus** — armed/ready bullets (glow when on), threshold + current tokens, fast-gate %.
- [x] **SessionInfo** — state badge (idle/compacting colored), persisted tag, checkpoints, tokens saved, dedup hit rate.
- [x] **EventStream** — type-filter chips (all / compact_start / compact_end / recall_inject / checkpoint_persisted), colored type badges (per-type palette), expandable JSON detail row, ring-buffer render window (last 200 of 500) to keep DOM light, timestamp formatting.
- [x] Responsive: 1-column card grid + compacted event rows at ≤768px.
- [x] All components use typed A1 contracts (`SnapshotResponse`, `SseEvent`).

Gate green: build, `build:dashboard` (51 modules; Overview 5KB + Events 4KB chunks vs 0.2KB stubs), 589 tests/0 fail, lint, regression_check, guardrails-scan.

**Next:** Sprint C2 (repos table + metrics/perf charts).

### 2.4 Sprint C2 — Repos & metrics ✅ DONE

Spec: [`sprint-C2-repos-metrics.md`](docs/specs/sprint-C2-repos-metrics.md)

Completed in v0.8.9 on `game-mode`.

- [x] **ReposTab** — fetches `/api/repos` + `/api/summary` (10s poll); renders `SummaryTiles` + `RepoTable`; row click opens `RepoDetailModal`; empty states for no repos / no search match.
- [x] **SummaryTiles** — 4 aggregate tiles: total repos, active (24h), total checkpoints, total tokens saved (highlighted).
- [x] **RepoTable** — sortable columns (name, model, checkpoints, saved, last compacted, sessions); client-side sort (click header toggles asc/desc, default lastCompactedAt DESC); case-insensitive substring search by displayName; nulls-last sort UX.
- [x] **RepoDetailModal** — full `/api/index` row drill-down: token breakdown (kept/dropped/saved), model info (provider, rates, context window, max tokens, reasoning), activity timestamps, compressed bytes; backdrop-click + Escape-key close.
- [x] **MetricsTab** — fetches `/api/perf` (30min window, 10s poll) + `/api/snapshot` (for model); renders `ModelBadge` + `PerfChart`.
- [x] **ModelBadge** — model name + provider + provider id + input/output token rates.
- [x] **PerfChart** — stat-card chart: turn/provider latency p50/p95 bars, TPS avg, cache hit avg/latest, DB recompute + disk write p95; resource gauges (RSS, heap, CPU user/sys); diagnostic counters (fast-gate fires, live trim fires/replays).
- [x] **CSS split** — `styles.css` monolith (548 lines) split into `styles/base.css` (121), `styles/overview-events.css` (318), `styles/repos-metrics.css` (119) — all under 500, two under 300, per doc-length guideline. `main.tsx` imports all three.
- [x] All components use typed A1/C2 contracts (`IndexesIndexRow`, `IndexesSummaryResponse`, `PerfResponse`, `SummaryResponse`).

Gate green: build, `build:dashboard` (56 modules; Repos 6.9KB + Metrics 4.7KB chunks vs 0.2KB stubs), 589 tests/0 fail, lint, regression_check, guardrails.

**Next:** Sprint C3 (config form + theme picker).

### 2.5 Sprint C3 — Config ⬜

Spec: [`sprint-C3-config.md`](docs/specs/sprint-C3-config.md)

- [ ] Config tab (`/mega-compact-settings`).
- [ ] Game-mode settings.
- [ ] Theme picker.

### 2.6 Sprint D1 — Resilience ⬜

Spec: [`sprint-D1-resilience.md`](docs/specs/sprint-D1-resilience.md)

- [ ] Offline banner.
- [ ] Retry with exponential backoff in `useApi`/`useSSE` (replace `SPRINT-D1-REMAINING` stubs).
- [ ] Stale-data indicator.

### 2.7 Sprint D2 — Observability + provider-failure hook ⬜

Spec: [`sprint-D2-observability.md`](docs/specs/sprint-D2-observability.md) (scope expanded per §1.6)

- [ ] `extensions/mega-events/perf-handler.ts`: flag non-2xx `after_provider_response` as `provider_failure` (record sample + increment counter); latency sample still recorded; non-fatal.
- [ ] `extensions/dashboard-server/server.ts`: `GET /api/health` (lightweight ping) + `GET /api/diag` (aggregated: timing, SSE health, provider failure count + rate + last status).
- [ ] `components/DiagnosticsPanel.tsx`, `HealthCheck.tsx`, `ApiTiming.tsx`, `hooks/useDiagnostics.ts`.
- [ ] `App.tsx` diagnostics toggle.
- [ ] Tests: 2xx → no failure; 500/non-2xx → failure counted.

### 2.8 Sprint D3 — Docs & release ⬜

Spec: [`sprint-D3-docs-release.md`](docs/specs/sprint-D3-docs-release.md)

- [ ] Tester guide update.
- [ ] Migration notes.
- [ ] Release notes + version bump.

### 2.9 Sprint T1 — Tailscale ⬜

Spec: [`sprint-T1-tailscale.md`](docs/specs/sprint-T1-tailscale.md)

- [ ] Tailscale remote access integration.
- [ ] Auth + CSRF protection.

---

## 3. Verification gate (every sprint)

```bash
npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all && node scripts/guardrails-scan.mjs
```

As of this commit the gate is green: build ✅, test 565 passed / 0 failed ✅, lint (tsc --noEmit + guardrails-scan + semantic-scan) ✅, regression_check ✅, guardrails-scan ✅.

---

## 4. Notes

- The dashboard-client React app is **not** part of the shipped extension build yet; it is excluded from `tsconfig.json` and has no Vite pipeline until B1 completes.
- `.playwright-mcp/` artifacts (page/console capture logs) are scratch tooling output and are intentionally **not** tracked.
- All api-contracts types are pure TypeScript — zero network (PREVENT-PI-004 compliant). The dashboard server remains loopback-only.
