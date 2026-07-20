# Sprint B1 — React Frontend Scaffold

**Date:** 2026-07-21
**Focus:** Add React + Vite build pipeline; create shell app with routing, layout, SSE hook
**Priority:** P0
**Effort:** M (≈ 1 day)
**Status:** PLANNED
**Depends on:** Sprint A1 (API contracts)

---

## SAFETY PROTOCOLS

- Read `docs/AGENT_GUARDRAILS.md` + `skills/shared-prompts/four-laws.md` first.
- Gate before commit:
  ```bash
  npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all && node scripts/guardrails-scan.mjs
  ```
- PREVENT-PI-004: React dev server runs on localhost only. Production build is static files served by the existing Node HTTP server. No external network calls.
- PREVENT-PI-004 annotation: every `fetch()` in client code must target `window.location.origin` or relative paths (loopback-only).
- `src/` remains pi-agnostic. React code goes in `extensions/dashboard-client/`.

---

## PROBLEM STATEMENT

The dashboard is a 1072-line inline HTML template (`html.ts`) with embedded `<script>` blocks. This is unmaintainable for multi-tab, interactive features (game mode, settings, repos drill-down). A React frontend enables component reuse, typed API consumption, and proper build tooling.

**Root cause:** monolithic HTML template cannot scale to the planned feature set.

---

## SCOPE BOUNDARY

**IN SCOPE (may modify):**
- `extensions/dashboard-client/` (NEW directory) — React app source.
  - `package.json` — workspace or sub-project with React, Vite, TypeScript.
  - `vite.config.ts` — build config; output to `extensions/dashboard-client/dist/`.
  - `tsconfig.json` — extends root or standalone.
  - `src/main.tsx` — React entry point.
  - `src/App.tsx` — shell layout: header, tab bar, content area.
  - `src/hooks/useSSE.ts` — SSE hook (wraps EventSource, reconnect on close).
  - `src/hooks/useApi.ts` — typed fetch hook (uses A1 contracts).
  - `src/api/client.ts` — fetch wrapper with error handling + type safety from A1.
  - `src/components/TabBar.tsx` — tab navigation.
  - `src/components/ErrorBoundary.tsx` — React error boundary.
  - `src/components/LoadingSpinner.tsx` — loading state.
- `extensions/dashboard-server/server.ts` — serve static React build at `/` (fallback to `html.ts` if build absent).
- `package.json` (root) — add `build:dashboard` script.

**OUT OF SCOPE:**
- Tab content components (Sprint C1+).
- `src/` modules.
- Tailscale/auth (Sprint T1).

---

## EXECUTION DIRECTIONS

```
1. SCAFFOLD   extensions/dashboard-client/: Vite + React + TypeScript. Minimal
              package.json (react, react-dom, vite, @vitejs/plugin-react, typescript).
2. ENTRY      src/main.tsx: ReactDOM.createRoot → <App />.
3. APP        src/App.tsx: layout with header (title + tier pill + version),
              TabBar (Overview | Repos | Events | Config | Game), content area.
              Uses React Router or simple state-based tab switching.
4. API CLIENT src/api/client.ts: typed fetch wrappers using A1 EndpointDef types.
              fetchSnapshot(), fetchIndex(), fetchRepos(), etc.
              All requests to relative paths (loopback-only, PREVENT-PI-004).
5. SSE HOOK   src/hooks/useSSE.ts: EventSource to /api/events. Auto-reconnect
              with backoff (1s → 2s → 4s → max 30s). Exposes { events, status }.
6. API HOOK   src/hooks/useApi.ts: generic SWR-like hook: useApi(fetchFn) →
              { data, error, loading, refetch }. Polling interval configurable.
7. SERVE      server.ts: check for client dist/ at startup. If present, serve
              index.html for all non-/api/* routes. If absent, fall back to html.ts.
              This preserves backward compat when client isn't built.
8. BUILD      Root package.json: "build:dashboard" → cd extensions/dashboard-client
              && npx vite build. Update "build" to include dashboard build.
9. TEST       Smoke test: build client, start server, fetch /, verify React app
              mounts (check for root div content). Unit: API client error handling.
```

**Key details:**
- Client builds to `extensions/dashboard-client/dist/` (static files).
- Server checks `existsSync(join(here, "../dashboard-client/dist/index.html"))` at startup.
- SSE hook uses native `EventSource` (no polyfill needed for modern browsers).
- All API calls use relative URLs (`/api/snapshot`) — never `http://localhost:PORT`.
- Error boundary catches render errors, shows fallback with reload button.

---

## QA VERIFICATION ROUND

Before proceeding to C1, verify:

1. **Build:** `npm run build && npm run build:dashboard` — both succeed.
2. **Test gate:** `npm test` — zero regressions (existing tests unaffected).
3. **Lint:** `npm run lint` — clean (client has its own tsconfig/eslint or inherits).
4. **Regression:** `python3 scripts/regression_check.py --all` — clean.
5. **Guardrails:** `node scripts/guardrails-scan.mjs` — no new network in `src/` or `extensions/` except annotated localhost server.
6. **Smoke:** start server with client build, navigate to `/`, verify React mounts.
7. **Fallback:** start server WITHOUT client build, verify `html.ts` still serves.
8. **SSE:** connect to `/api/events` from React app, verify events stream.

---

## ACCEPTANCE CRITERIA

- [ ] `extensions/dashboard-client/` builds with Vite.
- [ ] React app mounts at `/` when client dist exists.
- [ ] `html.ts` fallback works when client dist absent.
- [ ] SSE hook connects and receives events.
- [ ] API client makes typed requests using A1 contracts.
- [ ] Error boundary catches render errors.
- [ ] `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all && node scripts/guardrails-scan.mjs` — all green.

---

## ROLLBACK PROCEDURE

```bash
git revert <sha>   # removes dashboard-client/; server falls back to html.ts
```

No data migration. Server fallback is automatic.
