# Sprint D1 — Resilience & Error Handling

**Date:** 2026-07-21
**Focus:** Error boundaries, offline detection, retry logic, stale data indicators
**Priority:** P1
**Effort:** M (≈ 1 day)
**Status:** PLANNED
**Depends on:** Sprint C3 (config tab)

---

## SAFETY PROTOCOLS

- Read `docs/AGENT_GUARDRAILS.md` + `skills/shared-prompts/four-laws.md` first.
- Gate before commit:
  ```bash
  npm run build && npm run build:dashboard && npm test && npm run lint && python3 scripts/regression_check.py --all && node scripts/guardrails-scan.mjs
  ```
- PREVENT-PI-004: all API calls use relative paths. No external network.
- SEMANTIC-001: all async paths have `.catch()` / try-catch.

---

## PROBLEM STATEMENT

The dashboard has no resilience patterns. When the server is down, requests fail silently. Stale data shows as current. Network errors crash React components. A robust dashboard needs offline detection, retry with backoff, stale data indicators, and graceful degradation.

---

## SCOPE BOUNDARY

**IN SCOPE (may modify):**
- `extensions/dashboard-client/src/hooks/useApi.ts` — add retry logic, stale detection.
- `extensions/dashboard-client/src/hooks/useSSE.ts` — reconnect with exponential backoff.
- `extensions/dashboard-client/src/components/OfflineBanner.tsx` (NEW)
- `extensions/dashboard-client/src/components/StaleIndicator.tsx` (NEW)
- `extensions/dashboard-client/src/components/ErrorFallback.tsx` (NEW)
- `extensions/dashboard-client/src/components/ErrorBoundary.tsx` — enhance with retry.
- `extensions/dashboard-client/src/utils/retry.ts` (NEW) — generic retry utility.
- `extensions/dashboard-client/src/utils/staleness.ts` (NEW) — staleness detection.
- `extensions/dashboard-client/src/App.tsx` — integrate OfflineBanner.

**OUT OF SCOPE:**
- Server-side changes.
- New features beyond resilience.
- `src/` modules.

---

## EXECUTION DIRECTIONS

```
1. RETRY     utils/retry.ts: retryWithBackoff(fn, { maxRetries, baseMs, maxMs })
             Exponential backoff: 1s → 2s → 4s → 8s → max 30s.
             Returns { data, error, retries }.
2. API HOOK   useApi.ts: integrate retry. On fetch failure:
             - First failure: retry immediately.
             - Subsequent: retry with backoff.
             - After maxRetries: set error state, show stale indicator.
             - On success: clear error, update data + timestamp.
3. SSE HOOK   useSSE.ts: on close/error:
             - Attempt reconnect with backoff.
             - After 5 failures: set status='disconnected'.
             - On successful reconnect: reset backoff.
4. OFFLINE    OfflineBanner.tsx: shown when server unreachable.
             "Dashboard server is not responding. Retrying..."
             Uses navigator.onLine + API health check.
5. STALE      StaleIndicator.tsx: "Data is X seconds old" badge.
             Turns yellow after 30s, red after 60s.
             Pulses on hover.
6. FALLBACK   ErrorFallback.tsx: render error boundary fallback.
             Shows error message + "Retry" button + "Reload" button.
             Logs error to console for debugging.
7. BOUNDARY   ErrorBoundary.tsx: enhance with:
             - Reset on retry click.
             - Error logging.
             - Fallback UI.
8. STALENESS  utils/staleness.ts: isStale(timestamp, thresholdMs)
             staleColor(timestamp) → 'ok' | 'warning' | 'critical'
9. INTEGRATE  App.tsx: wrap in ErrorBoundary, add OfflineBanner at top.
             Each tab shows StaleIndicator for its data source.
10. TEST      Unit: retry logic, staleness calc, offline detection.
             Integration: simulate server down, verify retry + banner.
```

---

## QA VERIFICATION ROUND

Before proceeding to D2, verify:

1. **Build + Test + Lint + Regression + Guardrails** — all green.
2. **Offline:** stop server → banner appears → start server → banner disappears.
3. **Retry:** simulate network error → requests retry with backoff.
4. **Stale:** wait 30s without refresh → indicator turns yellow.
5. **Error boundary:** throw error in component → fallback UI renders → click retry → recovers.
6. **SSE reconnect:** kill SSE connection → auto-reconnect within 5s.
7. **No crashes:** dashboard never crashes, even with server down.

---

## ACCEPTANCE CRITERIA

- [ ] Offline banner shows when server unreachable.
- [ ] Stale indicator shows data age.
- [ ] API calls retry with exponential backoff.
- [ ] SSE reconnects automatically.
- [ ] Error boundaries catch and display errors gracefully.
- [ ] Dashboard never crashes from network errors.
- [ ] All gates green.

---

## ROLLBACK PROCEDURE

```bash
git revert <sha>
```

Dashboard reverts to prior behavior (errors may crash components).