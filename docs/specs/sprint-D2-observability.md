# Sprint D2 — Observability & Diagnostics

**Date:** 2026-07-21
**Focus:** Performance monitoring, health checks, server diagnostics, debug panel
**Priority:** P2
**Effort:** S (≈ ½ day)
**Status:** PLANNED
**Depends on:** Sprint D1 (resilience)

---

## SAFETY PROTOCOLS

- Read `docs/AGENT_GUARDRAILS.md` + `skills/shared-prompts/four-laws.md` first.
- Gate before commit:
  ```bash
  npm run build && npm run build:dashboard && npm test && npm run lint && python3 scripts/regression_check.py --all && node scripts/guardrails-scan.mjs
  ```
- PREVENT-PI-004: all API calls use relative paths. No external network.

---

## PROBLEM STATEMENT

When the dashboard behaves unexpectedly (slow loads, missing data, stale events), there's no way to diagnose the issue without reading server logs. A diagnostics panel shows API response times, SSE connection health, data freshness, and server version.

---

## SCOPE BOUNDARY

**IN SCOPE (may modify):**
- `extensions/dashboard-client/src/components/DiagnosticsPanel.tsx` (NEW)
- `extensions/dashboard-client/src/components/HealthCheck.tsx` (NEW)
- `extensions/dashboard-client/src/components/ApiTiming.tsx` (NEW)
- `extensions/dashboard-client/src/hooks/useDiagnostics.ts` (NEW)
- `extensions/dashboard-client/src/App.tsx` — add diagnostics toggle.
- `extensions/dashboard-server/server.ts` — add `/api/health` endpoint (lightweight ping).

**OUT OF SCOPE:**
- External monitoring integrations.
- `src/` modules.

---

## EXECUTION DIRECTIONS

```
1. HEALTH    server.ts: GET /api/health → { status: 'ok', uptime, version, db: 'ok'|'error' }.
             Lightweight — no file reads, just timestamp + version.
2. HOOK      useDiagnostics.ts: track API response times (rolling window of 20).
             Track SSE events received count. Track last successful fetch time.
3. PANEL     DiagnosticsPanel.tsx: toggle via header button (⚙ icon).
             Shows:
             - Server version + uptime.
             - API timing: p50/p95 for last 20 requests.
             - SSE status: connected/disconnected, events received, last event time.
             - Data freshness: time since each tab's last successful fetch.
             - Health check: periodic /api/health ping (every 30s).
4. HEALTH    HealthCheck.tsx: green dot when healthy, red when unhealthy.
             Tooltip shows last check time.
5. TIMING    ApiTiming.tsx: sparkline of response times.
             Color: green <100ms, yellow 100-500ms, red >500ms.
6. TOGGLE    App.tsx: gear icon in header toggles DiagnosticsPanel.
             Panel slides in from right.
7. TEST      Unit: timing calculations, health check logic.
```

---

## QA VERIFICATION ROUND

Before proceeding to D3, verify:

1. **Build + Test + Lint + Regression + Guardrails** — all green.
2. **Health:** /api/health returns ok within 10ms.
3. **Panel:** diagnostics panel shows all sections.
4. **Timing:** API response times update in real-time.
5. **SSE:** event count increments on each event.
6. **Toggle:** panel opens/closes smoothly.

---

## ACCEPTANCE CRITERIA

- [ ] /api/health endpoint responds quickly.
- [ ] Diagnostics panel shows server health, API timing, SSE status.
- [ ] Health check runs periodically.
- [ ] Response time tracking with color coding.
- [ ] All gates green.

---

## ROLLBACK PROCEDURE

```bash
git revert <sha>
```