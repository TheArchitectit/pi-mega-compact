# Sprint 26 — Rich Model Cost Card (Dashboard)

**Date:** 2026-07-17
**Archive date:** (set on completion)
**Focus:** Make the dashboard cost card multi-dimensional, historical, and actionable
**Priority:** P1
**Effort:** M (≈1.5 days)
**Status:** DRAFT
**Depends on:** Sprints 8 (SQLite store), 15 (dashboard v0.2.0), S24 (unified pressure), S25 (cross-repo + model snapshots)

---

## SAFETY PROTOCOLS

- Gate: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`.
- PREVENT-PI-004: dashboard server is localhost-only (`127.0.0.1`), already audited — NO new network paths.
- PREVENT-002: all SQL reads are parameterized (read-only `DatabaseSync` connections). No new write paths.
- Do NOT modify the `model_snapshots` schema — it is already correct and populated by `recordModelSnapshot()`.
- Do NOT break the existing cost card rendering — additive only.
- CSS + HTML changes only in the dashboard HTML string (`dashboardHtml()`).

---

## PROBLEM STATEMENT

Today's dashboard `💰 Model & Cost Savings` card (delivered in `RELEASE_NOTES §0.5.0`) shows a single aggregated number: `≈ $X.XX saved` based on `tokensSaved × inputRate`. While accurate, it is **one-dimensional**:

**[V]** The card shows only one cost figure — there is no breakdown of *when* savings accrued, *which model* produced them, or how the cost profile shifted over time.
**[V]** The `model_snapshots` table already records a **time series** of model changes (provider, name, input/output rates, context window, reasoning flag, `captured_at`), and the per-repo SQLite tracks per-checkpoint `token_estimate` — but the dashboard collapses this into a single point.
**[V]** Users running multiple models or switching providers mid-session have no visibility into per-model cost attribution.
**[V]** The existing "Summary > By Model" table in the cross-repo tab aggregates at the machine level — it does not drill into a single repo's model history.

**Root cause:** the cost card was shipped as an MVP single-value widget. The underlying data (per-checkpoint token estimates + model snapshot time series) already supports a richer UX but no UI was built to surface it.

---

## SCOPE BOUNDARY

**IN SCOPE (may modify):**
- `extensions/dashboard-server.ts` — `dashboardHtml()` template (HTML + CSS + JS) for the cost card section; `readSnapshot()`/`Snapshot` interface if new fields needed; JS render logic in the `refreshUI()` or `renderByModel()` path.
- `src/store/sqlite.ts` — new read-only query: `listModelSnapshots(stateDir)` returns ALL snapshots for a repo (not just latest); `costTimeline(stateDir)` computes checkpoints-bucketed-by-model for the timeline.

**OUT OF SCOPE:**
- Any change to the `model_snapshots` schema or write path.
- New CLI commands (`/mega-cost` etc.) — dashboard-only.
- Charts library / npm dependency — all rendering is vanilla HTML/CSS/JS.
- Real-time SSE for cost updates (existing snapshot poll interval is sufficient).

---

## EXECUTION DIRECTIONS

```
1. QUERY     src/store/sqlite.ts: add listModelSnapshots(stateDir) → ModelSnapshot[]
             (all rows, ordered by captured_at ASC). Add costTimeline(stateDir)
             → { modelName, provider, inputRate, outputRate, totalTokensSaved,
             estimatedCost, firstSeen, lastSeen }[] by joining model_snapshots
             (time-ranges) with context_chunks.token_estimate grouped by
             the snapshot's captured_at window.
2. TEMPLATE  extensions/dashboard-server.ts: redesign the cost card HTML in
             dashboardHtml() — add three sub-sections within the card.
3. RENDER    refreshUI() populates the new sub-sections from snapshot + SQL.
4. TEST      Add a dashboard handler test: mock model_snapshots rows, verify
             cost card renders all sub-sections; verify "No history" fallback.
5. REGRESSION Existing model info + cost-usd elements must still render
             identically to current production.
```

### Card Design (three sub-sections replacing the single cost line)

```
┌──────────────────────────────────────────────────────┐
│ 💰 Model & Cost Savings                              │
│                                                      │
│  ACTIVE MODEL ▸ claude-sonnet-4-20250514             │
│  Provider: Anthropic  │  Input: $3.000000/M tok      │
│  Output: $15.000000/M tok  │  Context: 200K          │
│                                                      │
│  ── SAVINGS BREAKDOWN ─────────────────────────────  │
│  Total saved .................. ≈ $0.4231             │
│  Context-windows extended ........ 17.4              │
│  Input cost avoided ......... ≈ $0.3800 (90%)        │
│  Output cost avoided ........ ≈ $0.0431 (10%)        │
│                                                      │
│  ── MODEL HISTORY ────────────────────────────────   │
│  Model                    When           Saved       │
│  claude-sonnet-4          Jul 14–now     312K tok    │
│  claude-opus-4            Jul 12–14       89K tok    │
│  (none recorded)          before Jul 12    —         │
│                                                      │
│  ── RATE COMPARISON ──────────────────────────────   │
│  Model                 Input/1M tok   Output/1M tok  │
│  claude-sonnet-4       $3.00          $15.00  ◀ now  │
│  claude-opus-4         $15.00         $75.00         │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### Sub-section details

**1. Active Model** (already exists, keep but refresh):
- Model name, provider, input/output rates, context window, reasoning badge.
- Already rendered at `#md-name`, `#md-provider`, `#md-input`, `#md-output` — no changes needed here beyond visual polish (compact layout).

**2. Savings Breakdown** (new):
- Total saved = `tokensSaved × inputRate` (existing calc).
- Context-windows extended = `tokensSaved / contextWindow` (existing calc).
- **Input vs Output split**: estimate output tokens saved as `tokensSaved × 0.15` (15% heuristic — models produce far fewer output tokens in the context being compacted) and input tokens as `tokensSaved × 0.85`. Then `inputCost = inputTokens × inputRate`, `outputCost = outputTokens × outputRate`. Show as a stacked bar + percentages.
- If `outputRate` is zero or missing, omit the output row.

**3. Model History** (new):
- Reads `listModelSnapshots(stateDir)` — all snapshots for this repo, sorted by `captured_at` ASC.
- For each snapshot, computes the **window of checkpoints** that fell within its active period (from `captured_at` to next snapshot's `captured_at`, or `now` for the latest).
- Aggregates `SUM(token_estimate)` from `context_chunks` whose `timestamp` falls in that window.
- Renders a mini-table: model name, date range, tokens saved in that window.
- If zero snapshots exist (no model captured yet), show "(none recorded)" row.

**4. Rate Comparison** (new):
- From `listModelSnapshots(stateDir)`, dedupe by `(modelId, provider)` showing the latest rate for each.
- Highlight the currently-active model with a `◀ now` marker.
- Show effective savings rate: `savingsRate = tokensSaved / elapsedDays` for each model.

### SQL query design (read-only)

```sql
-- listModelSnapshots: all snapshots for a repo, chronological
SELECT * FROM model_snapshots WHERE repo_root = @repoRoot ORDER BY captured_at ASC;

-- costTimeline: per-model windows with token aggregates
-- (computed in JS: for each snapshot i, window = [cati, cati+1 or now))
SELECT SUM(token_estimate) AS tok, COUNT(*) AS n
  FROM context_chunks
 WHERE repo_root = @repoRoot AND timestamp >= @winStart AND timestamp < @winEnd;
```

No schema changes. The windowing logic is JS — SQL just does the aggregate query per window.

### Key details

- **Input/output split heuristic (15% output)**: The context being compacted is dominated by LLM input (tool results, file reads, agent logs). Output tokens are mostly the assistant's own messages which are shorter. 15% matches observed ratios in mega-compact traces. Make the ratio a named constant `OUTPUT_TOKEN_FRACTION = 0.15` so it's easy to adjust.
- **Zero state**: if no `model_snapshots` rows exist for a repo, collapse the Model History and Rate Comparison sections into a single line "No model history captured yet — run a compaction to record it."
- **Dashboard server reads index.sqlite read-only** — already uses `{ readOnly: true }`. Per-repo reads also read-only.
- **No new HTML templates** — all rendering is inline JS string construction (consistent with existing dashboard style).

---

## ACCEPTANCE CRITERIA

- [ ] `npm test` green (existing tests pass; new dashboard handler test added).
- [ ] `npm run lint` green.
- [ ] `guardrails-scan` clean (no new network calls, no schema changes).
- [ ] Dashboard cost card renders three sub-sections when model data exists: Savings Breakdown, Model History, Rate Comparison.
- [ ] Dashboard cost card shows "No model history captured yet" fallback when `model_snapshots` is empty.
- [ ] Existing `cost-usd` and `cost-windows` elements render identically (no regression).
- [ ] Model History table shows correct date ranges derived from `captured_at` windows.
- [ ] Input/output cost split shows percentages summing to 100% (±1% rounding).
- [ ] Rate Comparison highlights the active model with a `◀ now` marker.
- [ ] Manual validation: open dashboard on a repo with ≥2 model changes, verify all sub-sections populate.

---

## ROLLBACK PROCEDURE

```bash
git revert <this-commit-sha>   # restores the single-value cost card
# No data migration — model_snapshots table is unchanged.
# The old cost-usd rendering path is preserved as a fallback in the code.
```
