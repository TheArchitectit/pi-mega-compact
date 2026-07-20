# Sprint C1 — Core Dashboard Tabs

**Date:** 2026-07-21
**Focus:** Overview + Events tabs — the primary monitoring views
**Priority:** P0
**Effort:** M (≈ 1 day)
**Status:** PLANNED
**Depends on:** Sprint B1 (React scaffold)

---

## SAFETY PROTOCOLS

- Read `docs/AGENT_GUARDRAILS.md` + `skills/shared-prompts/four-laws.md` first.
- Gate before commit:
  ```bash
  npm run build && npm run build:dashboard && npm test && npm run lint && python3 scripts/regression_check.py --all && node scripts/guardrails-scan.mjs
  ```
- PREVENT-PI-004: all API calls use relative paths (`/api/*`). No external network.
- `src/` remains pi-agnostic.

---

## PROBLEM STATEMENT

The React scaffold (B1) has empty tab panels. Users need the Overview tab (context gauge, compression stats, trigger state, session info) and Events tab (SSE stream with filtering) to monitor compaction activity.

---

## SCOPE BOUNDARY

**IN SCOPE (may modify):**
- `extensions/dashboard-client/src/tabs/OverviewTab.tsx` (NEW)
- `extensions/dashboard-client/src/tabs/EventsTab.tsx` (NEW)
- `extensions/dashboard-client/src/components/ContextGauge.tsx` (NEW) — token usage meter.
- `extensions/dashboard-client/src/components/CompressionCard.tsx` (NEW) — compression stats.
- `extensions/dashboard-client/src/components/TriggerStatus.tsx` (NEW) — armed/ready/threshold.
- `extensions/dashboard-client/src/components/SessionInfo.tsx` (NEW) — session state + checkpoint count.
- `extensions/dashboard-client/src/components/EventStream.tsx` (NEW) — SSE event list with type filters.
- `extensions/dashboard-client/src/App.tsx` — wire tabs.

**OUT OF SCOPE:**
- Repos tab (C2), Config tab (C3), Game tab (C4+).
- Server-side changes.
- `src/` modules.

---

## EXECUTION DIRECTIONS

```
1. OVERVIEW  OverviewTab.tsx: layout grid of 4 cards:
             - ContextGauge: percent fill bar (green <60%, yellow 60-80%, red >80%)
               using snapshot.context.{tokens,percent,contextWindow}.
             - CompressionCard: tokens in/out, freed, compression %, dedup %
               from snapshot.compression.repo.
             - TriggerStatus: armed/ready bullets, threshold vs current tokens
               from snapshot.trigger.
             - SessionInfo: session state, checkpoint count, tokens saved
               from snapshot.session + snapshot.store.
             Header: tier pill, last updated timestamp.
2. EVENTS    EventsTab.tsx: useSSE hook + EventStream component.
             Filter by event type (compact_start, compact_end, recall_inject,
             checkpoint_persisted). Show timestamp, type, details.
             Max 500 events in memory (ring buffer).
3. GAUGE     ContextGauge.tsx: SVG or CSS meter. Color transitions.
             Sublabel: "{tokens} / {contextWindow} tokens ({percent}%)".
4. COMPRESS  CompressionCard.tsx: bar chart or stat grid.
             tokensIn → tokensOut with freed amount highlighted.
5. TRIGGER   TriggerStatus.tsx: two bullets (armed, ready) + threshold display.
             "Fast gate: {pct}%" label.
6. SESSION   SessionInfo.tsx: state badge, checkpoint count, tokens saved.
7. EVENTS    EventStream.tsx: virtualized list (react-window or manual).
             Type badge colored by event type. Expandable detail row.
8. WIRE      App.tsx: register Overview + Events tabs in TabBar.
9. TEST      Component render tests with mock snapshot/event data.
```

---

## QA VERIFICATION ROUND

Before proceeding to C2, verify:

1. **Build:** `npm run build && npm run build:dashboard` — both succeed.
2. **Test gate:** `npm test` — zero regressions.
3. **Lint:** `npm run lint` — clean.
4. **Regression:** `python3 scripts/regression_check.py --all` — clean.
5. **Guardrails:** `node scripts/guardrails-scan.mjs` — clean.
6. **Visual:** Overview tab renders 4 cards with real data. Events tab shows SSE stream.
7. **Responsive:** dashboard works at 1024px and 768px widths.
8. **Performance:** Events tab handles 500+ events without jank.

---

## ACCEPTANCE CRITERIA

- [ ] Overview tab shows context gauge, compression stats, trigger status, session info.
- [ ] Events tab streams real-time events with type filtering.
- [ ] Context gauge color-codes by utilization level.
- [ ] All components use typed A1 contracts.
- [ ] `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all && node scripts/guardrails-scan.mjs` — all green.

---

## ROLLBACK PROCEDURE

```bash
git revert <sha>   # removes tab components; App.tsx shows empty panels
```
