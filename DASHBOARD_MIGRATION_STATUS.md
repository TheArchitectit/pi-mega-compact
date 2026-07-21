# DASHBOARD_MIGRATION_STATUS.md

**Branch:** `game-mode`  
**Last updated:** 2026-07-21  
**Owner:** dashboard-migration workstream  
**Purpose:** Single-source status board for the dashboard rewrite (React frontend) migration. Tracks what is DONE vs TO DO across the 9 sprint specs, the api-contracts split, the tsconfig exclude fix, and the map regeneration.

This document is a *planning + tracking* artifact. The per-sprint authoritative specs live in [`docs/specs/sprint-*.md`](docs/specs/). See the "Sprint specs" section of [`docs/INDEX_MAP.md`](docs/INDEX_MAP.md) for the full index.

---

## Legend

| Marker | Meaning |
|---|---|
| ✅ DONE | Spec written and/or implementation merged; gate green. |
| 🟡 SCAFFOLD | Partial implementation present but not complete / not wired. |
| ⬜ TODO | Not yet implemented. |

---

## 1. DONE — Planning & Foundation

All planning artifacts for the dashboard rewrite are complete. No dashboard-client implementation is shipped yet (the React app is scaffold-only and excluded from the TypeScript build via `tsconfig.json`).

### 1.1 Sprint specs written (9/9)

All nine dashboard-migration sprint specs are authored and committed:

| Sprint | Spec | Focus | Status |
|---|---|---|---|
| A1 | [`sprint-A1-api-contract.md`](docs/specs/sprint-A1-api-contract.md) | API contract, typed endpoints, `EndpointDef` | ✅ spec written, ⬜ impl TODO |
| B1 | [`sprint-B1-react-scaffold.md`](docs/specs/sprint-B1-react-scaffold.md) | React scaffold, Vite, SSE hook, API client | ✅ spec written, 🟡 scaffold present |
| C1 | [`sprint-C1-core-tabs.md`](docs/specs/sprint-C1-core-tabs.md) | Core tabs: Overview, Events, context gauge | ✅ spec written, ⬜ impl TODO |
| C2 | [`sprint-C2-repos-metrics.md`](docs/specs/sprint-C2-repos-metrics.md) | Repos table, metrics, perf charts, drill-down | ✅ spec written, ⬜ impl TODO |
| C3 | [`sprint-C3-config.md`](docs/specs/sprint-C3-config.md) | Config tab, game-mode settings, theme picker | ✅ spec written, ⬜ impl TODO |
| D1 | [`sprint-D1-resilience.md`](docs/specs/sprint-D1-resilience.md) | Resilience: offline banner, retry, stale indicator | ✅ spec written, ⬜ impl TODO |
| D2 | [`sprint-D2-observability.md`](docs/specs/sprint-D2-observability.md) | Observability, diagnostics panel, health, **provider-failure hook** | ✅ spec written (scope expanded), ⬜ impl TODO |
| D3 | [`sprint-D3-docs-release.md`](docs/specs/sprint-D3-docs-release.md) | Docs + release, tester guide, migration | ✅ spec written, ⬜ impl TODO |
| T1 | [`sprint-T1-tailscale.md`](docs/specs/sprint-T1-tailscale.md) | Tailscale remote access, auth, CSRF | ✅ spec written, ⬜ impl TODO |

### 1.2 api-contracts split into domain modules

The monolithic `extensions/dashboard-server/api-contracts.ts` was decomposed into a typed, domain-structured barrel under `extensions/dashboard-server/api-contracts/`:

| File | Domain |
|---|---|
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

### 1.7 B1 React scaffold (partial, work-in-progress)

Untracked scaffold files present under `extensions/dashboard-client/src/` (excluded from the TS build per §1.3):

- `App.tsx` — dashboard shell, tab routing, header, `ErrorBoundary`/`TabBar`/`LoadingSpinner` imports (components not yet created).
- `hooks/useApi.ts` — generic typed fetch hook with polling + mount-safety; retry/stale marked `SPRINT-D1-REMAINING`.
- `hooks/useSSE.ts` — `EventSource` hook with ring buffer + reconnect; exponential backoff marked `SPRINT-D1-REMAINING`.

These are 🟡 SCAFFOLD — real content but incomplete (missing `components/`, `tabs/`, Vite config, build pipeline). They are staged in this commit as B1 starting point.

---

## 2. TO DO — Implementation

Implementation order follows the spec dependency chain: **A1 → B1 → C1 → C2 → C3 → D1 → D2 → D3 → T1**.

### 2.1 Sprint A1 — API contract implementation ⬜

Spec: [`sprint-A1-api-contract.md`](docs/specs/sprint-A1-api-contract.md)

- [ ] `ENDPOINTS` registry constant in `api-contracts/core.ts` (or dedicated `endpoints.ts`) — single source of truth for all route paths + methods.
- [ ] `extensions/dashboard-server/types.ts` re-export from `api-contracts/` where shapes overlap; preserve backward compatibility.
- [ ] `extensions/dashboard-server/api-contracts.test.ts` — compile-time `satisfies` structural tests + runtime JSON-shape validation for each endpoint response.
- [ ] JSDoc on every exported interface and `EndpointDef`.
- [ ] Gate green.

### 2.2 Sprint B1 — React scaffold completion 🟡→⬜

Spec: [`sprint-B1-react-scaffold.md`](docs/specs/sprint-B1-react-scaffold.md)

- [ ] Vite config + `dashboard-client/package.json` + dev/build scripts.
- [ ] Create missing components referenced by `App.tsx`: `components/ErrorBoundary.tsx`, `components/TabBar.tsx`, `components/LoadingSpinner.tsx`.
- [ ] Create tab stubs: `tabs/OverviewTab.tsx`, `tabs/ReposTab.tsx`, `tabs/EventsTab.tsx`, `tabs/ConfigTab.tsx`, `tabs/MetricsTab.tsx`.
- [ ] Wire `useApi` + `useSSE` into the shell; verify `/api/snapshot` + `/api/events` connectivity.
- [ ] Build pipeline produces a static bundle the dashboard server can serve.

### 2.3 Sprint C1 — Core tabs ⬜

Spec: [`sprint-C1-core-tabs.md`](docs/specs/sprint-C1-core-tabs.md)

- [ ] Overview tab: tier, model, context gauge, anchor floor.
- [ ] Events tab: live SSE event stream (via `useSSE`).
- [ ] Context gauge widget.

### 2.4 Sprint C2 — Repos & metrics ⬜

Spec: [`sprint-C2-repos-metrics.md`](docs/specs/sprint-C2-repos-metrics.md)

- [ ] Repos table (`/api/repos`, `/api/index`).
- [ ] Metrics + perf charts (`/api/perf`).
- [ ] Drill-down into a single repo snapshot.

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
