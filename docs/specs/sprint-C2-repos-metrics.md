# Sprint C2 — Repos & Metrics Tabs

**Date:** 2026-07-21
**Focus:** All-Repos table with drill-down + Metrics/Performance tab
**Priority:** P1
**Effort:** M (≈ 1 day)
**Status:** PLANNED
**Depends on:** Sprint C1 (core tabs)

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

The existing dashboard shows repo data inline in the HTML template. With 10+ repos, the table becomes unwieldy. A dedicated Repos tab with search, sort, and a drill-down modal provides better UX. The Metrics tab surfaces performance data (perf samples, token rates, model info).

---

## SCOPE BOUNDARY

**IN SCOPE (may modify):**
- `extensions/dashboard-client/src/tabs/ReposTab.tsx` (NEW)
- `extensions/dashboard-client/src/tabs/MetricsTab.tsx` (NEW)
- `extensions/dashboard-client/src/components/RepoTable.tsx` (NEW) — sortable table.
- `extensions/dashboard-client/src/components/RepoDetailModal.tsx` (NEW) — drill-down.
- `extensions/dashboard-client/src/components/SummaryTiles.tsx` (NEW) — header tiles.
- `extensions/dashboard-client/src/components/PerfChart.tsx` (NEW) — perf sparklines.
- `extensions/dashboard-client/src/components/ModelBadge.tsx` (NEW) — model + provider.
- `extensions/dashboard-client/src/App.tsx` — wire tabs.

**OUT OF SCOPE:**
- Server-side changes.
- Config/Game tabs.
- `src/` modules.

---

## EXECUTION DIRECTIONS

```
1. REPOS     ReposTab.tsx: fetch /api/repos + /api/summary.
             SummaryTiles: total repos, active repos, total checkpoints,
             total tokens saved.
             RepoTable: columns (name, model, checkpoints, tokens saved,
             last compacted, sessions). Sort by any column. Search by name.
2. MODAL     RepoDetailModal.tsx: full repo detail from /api/index row.
             Token breakdown (kept/dropped), model info, context window,
             perf samples if available. Click backdrop to close.
3. METRICS   MetricsTab.tsx: fetch /api/perf.
             PerfChart: sparkline for p50/p95 latency, TPS, cache hit %.
             ModelBadge: current model + provider + rates.
             CPU/Memory gauges if available.
4. SORT      RepoTable: client-side sort (no server round-trip).
             Default: last_seen DESC. Click header to toggle.
5. SEARCH    Filter repos by displayName (case-insensitive substring).
6. WIRE      App.tsx: register Repos + Metrics tabs.
7. TEST      Component tests: sort logic, search filter, modal open/close,
             empty states.
```

---

## QA VERIFICATION ROUND

Before proceeding to C3, verify:

1. **Build + Test + Lint + Regression + Guardrails** — all green.
2. **Visual:** Repos tab shows sortable table. Click repo → modal opens.
3. **Search:** typing filters repos in real-time.
4. **Metrics:** perf charts render with sample data.
5. **Empty state:** "No repos yet" message when index is empty.
6. **Performance:** table with 50+ repos renders without lag.

---

## ACCEPTANCE CRITERIA

- [ ] Repos tab shows sortable, searchable table with drill-down modal.
- [ ] Metrics tab shows perf charts and model info.
- [ ] Summary tiles show aggregate stats.
- [ ] Empty states handled gracefully.
- [ ] All gates green.

---

## ROLLBACK PROCEDURE

```bash
git revert <sha>
```