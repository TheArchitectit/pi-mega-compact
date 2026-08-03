# Spec 2 — HyDE / RAG Visibility Dashboard

## Overview

Make HyDE (Hypothetical Document Embeddings) and RAG recall quality visible to end users. Currently HyDE is invisible — no telemetry, no indicators, no dashboard view. Users can't tell if it's working or helping. This spec adds: HyDE telemetry in the recall pipeline, per-turn HyDE markers in the Turns tab, a full RAG metrics dashboard on the Metrics tab, a mini health summary card on Overview, and a live status line on the Setup tab.

## Architecture

### Data Flow

```
recall/sync.ts (HyDE fires or is skipped)
  → RecallInjectResult extended with hydeInfo  (src/ is pi-agnostic — NO runtime here)
  → extension layer (mega-pipeline/recall.ts or openclaw-mega-compact.ts)
      reads hydeInfo from result
      → runtime.dashboard.event("hyde_executed") → events.log → dashboard SSE
      → runtime.dashboard.event("recall_metrics") → events.log → dashboard SSE
      → turn store write (new columns)
  → GET /api/rag-metrics (aggregated)
  → GET /api/turns/conversation/:id (extended)
  → Dashboard tabs render HyDE/RAG data
```

### New Types

```typescript
// src/recall/types.ts — extend RecallInjectResult
// NOTE: toInject is SearchHit[] (not RecallBlock) — matches actual codebase
export interface RecallInjectResult {
  toInject: SearchHit[];
  report: RecallReport;
  block: RecallBlock | null;
  empty: boolean;
  hydeInfo: HydeInvocationInfo | null; // NEW
}

export interface HydeInvocationInfo {
  ran: boolean;                    // did HyDE fire?
  skipped: boolean;                // was it skipped (no http embedder)?
  reason: string;                  // why skipped ("no http embedder", "disabled", etc.)
  hypotheticalDoc: string;         // the generated doc text (empty if skipped)
  generationMs: number;            // time to generate hypothetical doc
  rawHitCount: number;             // hits from raw search before HyDE
  hydeHitCount: number;            // hits from HyDE search
  fusedHitCount: number;           // total after RRF fusion
  lift: number;                    // hydeHitCount / max(1, rawHitCount) — how many extra hits HyDE found
  rawHits: SearchHit[];            // raw search hits (for provenance)
  hydeHits: SearchHit[];           // HyDE-specific hits (for provenance)
  fusedHits: SearchHit[];          // final fused list (for provenance)
}
```

### SSE Events

```typescript
// api-contracts/core.ts — add to SseEvent union
| { type: "hyde_executed"; ts: string; sessionId: string; ran: boolean; skipped: boolean; reason: string; hypotheticalDoc: string; generationMs: number; rawHitCount: number; hydeHitCount: number; fusedHitCount: number; lift: number }
| { type: "recall_metrics"; ts: string; sessionId: string; hitCount: number; score: number; pass: boolean; relevance: number; coverage: number; diversity: number; specificity: number }
```

### Turn Store Schema Changes

New columns on the `turns` table (append-only, no UPDATE).

**Semantics note:** Recall injection is session-scoped — it fires once per `before_agent_start` (not per user turn). A turn row gets HyDE/recall columns populated only if a recall injection preceded it. Turns without a preceding recall have the defaults (all zeros). This means:
- Most turns will have `hyde_ran = 0` (no recall before them)
- Turns that follow a compaction + recall cycle will have the full telemetry
- The Turns tab HyDE column shows "—" for turns with no recall data

```sql
-- Add to turns table (migration in src/store/turns/schema.ts)
-- All columns DEFAULT so existing rows are unaffected (backward-compatible)
ALTER TABLE turns ADD COLUMN hyde_ran INTEGER DEFAULT 0;
ALTER TABLE turns ADD COLUMN hyde_doc TEXT DEFAULT '';
ALTER TABLE turns ADD COLUMN hyde_raw_count INTEGER DEFAULT 0;
ALTER TABLE turns ADD COLUMN hyde_hyde_count INTEGER DEFAULT 0;
ALTER TABLE turns ADD COLUMN hyde_fused_count INTEGER DEFAULT 0;
ALTER TABLE turns ADD COLUMN hyde_lift REAL DEFAULT 0;
ALTER TABLE turns ADD COLUMN hyde_generation_ms INTEGER DEFAULT 0;
ALTER TABLE turns ADD COLUMN recall_score REAL DEFAULT 0;
ALTER TABLE turns ADD COLUMN recall_pass INTEGER DEFAULT 0;
ALTER TABLE turns ADD COLUMN recall_relevance REAL DEFAULT 0;
ALTER TABLE turns ADD COLUMN recall_coverage REAL DEFAULT 0;
ALTER TABLE turns ADD COLUMN recall_diversity REAL DEFAULT 0;
ALTER TABLE turns ADD COLUMN recall_specificity REAL DEFAULT 0;
```

### New API Endpoints

```
GET /api/rag-metrics
  Response: {
    windowHours: number;
    turnCount: number;
    hydeStats: { ran: number; skipped: number; avgLift: number; avgGenerationMs: number; totalHydeHits: number; totalRawHits: number };
    recallStats: { avgScore: number; passRate: number; avgRelevance: number; avgCoverage: number; avgDiversity: number; avgSpecificity: number };
    flagStatus: { name: string; enabled: boolean; requiresLlm: boolean; llmActive: boolean }[];
    latencyBreakdown: { avgReformulationMs: number; avgHydeGenerationMs: number; avgSearchMs: number; avgFusionMs: number };
    hitRateTrend: { hour: number; hitRate: number; hydeRate: number }[];
    hydeLiftTrend: { hour: number; lift: number }[];
    cragTrend: { hour: number; relevance: number; coverage: number; diversity: number }[];
  }
  Query params: ?windowHours=24 (default), ?repo=<path>
```

```
GET /api/turns/conversation/:id — extend response
  Each turn row gets:
    hydeInfo: { ran, skipped, reason, hypotheticalDoc, generationMs, rawHitCount, hydeHitCount, fusedHitCount, lift } | null
    recallMetrics: { score, pass, relevance, coverage, diversity, specificity } | null
```

## Backend Telemetry Changes

### 1. Extend `RecallInjectResult` (`src/recall/types.ts`)

Add `hydeInfo: HydeInvocationInfo | null` field. Default `null`.

### 2. Build HyDE telemetry in `src/recall/sync.ts` (src/ is pi-agnostic)

After HyDE fusion block (sync.ts:~127-129), construct `HydeInvocationInfo` and include it in the `RecallInjectResult`. **No SSE emission here** — `src/` has no access to `runtime` (CLAUDE.md §3: keep `src/` pi-agnostic).

```typescript
// sync.ts — after fusion (~line 127-129)
const hydeInfo: HydeInvocationInfo = {
  ran: hydeHits.length > 0,
  skipped: !RAG_HYDE_ENABLED() || embedder.kind !== "http",
  reason: !RAG_HYDE_ENABLED() ? "disabled" : embedder.kind !== "http" ? "no http embedder" : "ok",
  hypotheticalDoc: hydeDoc || "",
  generationMs: hydeGenerationMs,
  rawHitCount: newHits.length,
  hydeHitCount: hydeHits.length,
  fusedHitCount: fusedHits.length,
  lift: hydeHits.length / Math.max(1, newHits.length),
  rawHits: newHits,
  hydeHits,
  fusedHits,
};
// hydeInfo is returned as part of RecallInjectResult — callers handle SSE
```

### 3. Emit SSE events from the extension layer (NOT from src/)

`recallAndInline()` is called from the extension layer (`extensions/mega-pipeline/recall.ts:49` and `extensions/openclaw-mega-compact.ts:331`), where `runtime` is in scope. The extension callers:

```typescript
// extensions/mega-pipeline/recall.ts — after recallAndInline returns
const result = recallAndInline(opts);
if (result.hydeInfo) {
  runtime.dashboard.event("hyde_executed", { ts: new Date().toISOString(), sessionId, ...result.hydeInfo });
}
if (result.hydeInfo || RAG_RECALL_METRICS()) {
  // recall_metrics already computed inside sync.ts via scoreAndLogRecallMetrics
  // extension layer emits it as SSE alongside existing mega-compact.log write
  runtime.dashboard.event("recall_metrics", { ts: new Date().toISOString(), sessionId, ...metricsPayload });
}
```

### 4. Wire `scoreAndLogRecallMetrics` output to extension callers

Currently `scoreAndLogRecallMetrics` (in `src/recall/format.ts`) logs to `mega-compact.log` only and returns the metrics object. The extension layer already has the result — it emits the SSE event. No change needed inside `src/recall/format.ts` itself; the extension caller is responsible for the SSE bridge.

**Existing consumer note:** `extensions/mega-commands/helpers.ts:48` reads `parsed.relevanceScore` from the log line — the SSE event uses `relevance` as the field name. These are separate consumers (log file vs SSE) with different field names; no breaking change.

### 4. Store HyDE/recall data in turn store

In `src/store/turns/turnWriter.ts` (or wherever turns are persisted), write the new columns alongside existing turn data.

### 5. New `GET /api/rag-metrics` endpoint

In `extensions/dashboard-server/routes-rag-metrics.ts`:
- Query turn store for last N hours of turns with HyDE/recall data
- Aggregate into trends and stats
- Return the response shape defined above

## Dashboard Changes

### Turns Tab — HyDE Column + Expandable Detail

Add a "HyDE" column to the turn table:

| HyDE | Value | Clickable? |
|------|-------|-----------|
| `N hits` | `3 hits` — shows number of HyDE-sourced hits | Yes — expands |
| `skipped` | `—` — shows grey dash | Yes — shows reason |
| `+N` | `+2` — shows lift if >0 | Yes — expands |

Expandable detail panel shows:
- Generated hypothetical doc text (scrollable, monospace, truncated to 500 chars)
- Hit provenance table: each hit with `source` (raw / hyde / fused-boost), `beforeRank`, `afterRank`
- CRAG badge: `PASS` (green) or `FAIL` (red) with sub-scores

### Metrics Tab — RAG Pipeline Dashboard

New section below existing perf charts. 5 components:

1. **HyDE Recall Lift Chart** (recharts BarChart): X = time (hourly), Y = lift ratio. Bars split: raw hits (grey) + HyDE extra hits (electric blue). Shows "HyDE found X% more context."

2. **CRAG Quality Trend** (recharts LineChart): 4 lines — relevance, coverage, diversity, specificity. Dashed threshold line at 0.5 (pass cutoff).

3. **Per-Flag Status Row**: 5 dot indicators — one per RAG flag. Green = enabled+active, amber = enabled but no LLM (HyDE only), red = disabled. Tooltip on hover: flag name + reason.

4. **Recall Latency Breakdown** (recharts StackedBar): Per-turn stacked bars showing query reformulation / HyDE generation / search / fusion time. Only visible when HyDE ran.

5. **Hit-Rate Trend** (recharts AreaChart): % of turns with recall hits injected over time. Overlay: % with HyDE-assisted hits.

### Overview Tab — Mini RAG Health Card

Small card (same grid size as others):

```
┌─────────────────────────┐
│  RAG Health              │
│  ●●●●●  5/5 active      │
│  Last recall: 0.78 PASS  │
│  HyDE lift: +42% hits    │
│  Avg latency: 340ms      │
└─────────────────────────┘
```

Dots for each flag. "Last recall" shows score + pass/fail badge. "HyDE lift" shows average lift from last 24h. Clickable → navigates to Metrics tab RAG section.

### Setup Tab — HyDE Status Line

Under the HyDE toggle in `RagSettingsCard.tsx`:

```
[✓] HyDE (Hypothetical Document Embeddings)
     Active — 768-dim, Ollama    ← live status
     Requires LLM embedder        ← greyed when no LLM
```

Status values: `Active — {dims}-dim, {embedderName}` / `Standby — no LLM embedder` / `Disabled by user`

### Events Tab

Add `hyde_executed` and `recall_metrics` to the SSE event filter dropdown. Show in the event list with type badges.

## Feature Flags

- `MEGACOMPACT_RECALL_METRICS_DISABLED` — existing env var, checked by `RAG_RECALL_METRICS()` in `src/config.ts`. Gates `recall_metrics` SSE event AND the `/api/rag-metrics` endpoint.
- `MEGACOMPACT_HYDE_DISABLED` — existing env var, checked by `RAG_HYDE_ENABLED()`. Gates HyDE telemetry.
- `MEGACOMPACT_NEW_UI_DISABLED` — from Spec 1, gates new dashboard components.

When `MEGACOMPACT_RECALL_METRICS_DISABLED=true`: endpoint returns 404, dashboard shows "RAG metrics disabled", no `recall_metrics` SSE events.
When `MEGACOMPACT_HYDE_DISABLED=true`: no HyDE telemetry, HyDE column shows "disabled."

## Files

### Backend — New
| File | Lines | Purpose |
|------|-------|---------|
| `src/recall/hydeTelemetry.ts` | 120 | `HydeInvocationInfo` type, `buildHydeInfo()` (NO `emitHydeEvent` — SSE lives in extension layer) |
| `extensions/dashboard-server/routes-rag-metrics.ts` | 200 | `GET /api/rag-metrics` route handler |
| `extensions/dashboard-server/api-contracts/rag-metrics.ts` | 60 | Response types |
| `src/store/turns/hydeStore.ts` | 80 | HyDE/recall column helpers for turn store |

### Backend — Modified
| File | Change |
|------|--------|
| `src/recall/types.ts` | Add `hydeInfo` field to `RecallInjectResult` |
| `src/recall/sync.ts` | Import + use `buildHydeInfo()`, pass `hydeInfo` in result (NO SSE — src/ is pi-agnostic) |
| `src/recall/format.ts` | No changes — extension layer handles SSE from the returned metrics |
| `src/store/turns/turnWriter.ts` | Write new HyDE/recall columns on turn insert |
| `src/store/turns/schema.ts` | Add new columns to `turns` table migration |
| `extensions/dashboard-server/api-contracts/core.ts` | Add `hyde_executed` + `recall_metrics` to `SseEvent` union |
| `extensions/dashboard-server/api-contracts/index.ts` | Re-export new types |
| `extensions/dashboard-server/routes.ts` | Barrel export for rag-metrics route |
| `extensions/dashboard-server/server.ts` | Dispatch for `GET /api/rag-metrics` |
| `extensions/mega-pipeline/recall.ts` | SSE emission: `hyde_executed` + `recall_metrics` events from `RecallInjectResult.hydeInfo` (extension layer has `runtime` in scope) |

### Frontend — New
| File | Lines | Purpose |
|------|-------|---------|
| `src/components/HydeDetailPanel.tsx` | 120 | Expandable HyDE detail (doc text + provenance + CRAG) — used by TurnsTab |
| `src/components/RagDashboard.tsx` | 180 | Full RAG metrics section (5 components) — used by MetricsTab |
| `src/components/RagHealthCard.tsx` | 80 | Mini RAG health summary card — used by OverviewTab |
| `src/api/ragMetrics.ts` | 40 | `fetchRagMetrics()` client wrapper |

### Frontend — Modified
| File | Change |
|------|--------|
| `src/tabs/TurnsTab.tsx` | Add HyDE column, expandable rows with `<HydeDetailPanel>` |
| `src/tabs/MetricsTab.tsx` | Render `<RagDashboard>` below existing perf charts |
| `src/tabs/OverviewTab.tsx` | Add `<RagHealthCard>` to card grid |
| `src/tabs/SetupTab/RagSettingsCard.tsx` | Add live status line under HyDE toggle |
| `src/tabs/EventsTab.tsx` | Register `hyde_executed` + `recall_metrics` in event filter |
| `src/api/client.ts` | Add `fetchRagMetrics()`, extend conversation types |

## Sprint Breakdown

### Sprint H1 — Telemetry Pipeline
**Files:** `src/recall/hydeTelemetry.ts`, `src/recall/types.ts`, `src/recall/sync.ts`, `src/store/turns/schema.ts`, `src/store/turns/turnWriter.ts`, `src/store/turns/hydeStore.ts`, `extensions/mega-pipeline/recall.ts` (SSE emission from extension layer)
**Acceptance:**
- `RecallInjectResult` includes `hydeInfo`
- `hyde_executed` SSE event emitted on every recall
- `recall_metrics` SSE event emitted alongside CRAG scoring
- Turn store has new columns, populated on insert
- All existing tests pass
- New unit tests for `hydeTelemetry.ts`

### Sprint H2 — Backend API
**Files:** `routes-rag-metrics.ts`, `api-contracts/rag-metrics.ts`, `api-contracts/core.ts`, `api-contracts/index.ts`, `routes.ts`, `server.ts`
**Acceptance:**
- `GET /api/rag-metrics` returns aggregated stats
- `GET /api/turns/conversation/:id` includes `hydeInfo` + `recallMetrics` per turn
- SSE contract includes new event types
- Integration tests for new endpoint

### Sprint H3 — Dashboard UI
**Files:** All frontend files (new + modified)
**Acceptance:**
- Turns tab: HyDE column visible, expandable detail works, provenance table correct
- Metrics tab: RAG dashboard section renders, charts show data
- Overview tab: RAG health card visible, links to Metrics
- Setup tab: HyDE status line shows correct state
- Events tab: new event types in filter
- Mobile-responsive: all new components work at 375px
- Playwright tab-smoke passes

### Sprint H4 — Integration + QA
**Files:** Any fixes from QA review
**Acceptance:**
- Full gate: build + test + lint + regression_check + guardrails-scan
- Dashboard tab-smoke green
- SSE events visible in Events tab with real data
- Turn store migration backward-compatible (existing rows have null HyDE columns)

## QA Review Checklist

- [ ] `HydeInvocationInfo` type exported from `src/recall/types.ts`
- [ ] `hydeInfo` field optional on `RecallInjectResult` (backward compat)
- [ ] `hyde_executed` SSE event has all required fields
- [ ] `recall_metrics` SSE event has all required fields
- [ ] Turn store migration adds columns with `DEFAULT` values (no data loss)
- [ ] No `UPDATE` on turns table (append-only invariant)
- [ ] HyDE telemetry failures don't break agent loop (non-fatal)
- [ ] `GET /api/rag-metrics` handles empty turn store gracefully
- [ ] HyDE column renders for turns with no HyDE data (shows "—")
- [ ] Expandable detail shows hypothetical doc text
- [ ] Provenance table shows before/after fusion rank
- [ ] RAG health card dots match actual flag state
- [ ] Setup tab HyDE status updates on embedder change
- [ ] Mobile: HyDE column stacks vertically on small screens
- [ ] Mobile: RAG dashboard charts scroll horizontally if needed
- [ ] All new files <500 lines
- [ ] No new network calls at runtime (PREVENT-PI-004)
- [ ] All SQL parameterized (PREVENT-002) — routes-rag-metrics.ts queries use bound parameters
- [ ] Feature flag: `RAG_METRICS_DISABLED` → no endpoint, no UI
- [ ] Feature flag: `HYDE_DISABLED` → no HyDE telemetry, UI shows "disabled"
- [ ] `npm run build` passes
- [ ] `npm test` passes (new tests for telemetry + endpoint)
- [ ] `npm run lint` passes
- [ ] `python3 scripts/regression_check.py --all` passes

## Risks + Mitigations

| Risk | Mitigation |
|------|------------|
| HyDE telemetry adds latency to recall path | Telemetry is best-effort/non-fatal; wrap in try/catch; <1ms overhead for event construction |
| Turn store schema migration breaks existing data | New columns have `DEFAULT 0` / `DEFAULT ''`; existing rows unaffected; migration is additive-only |
| Dashboard SSE event volume increases | `hyde_executed` fires once per recall (same rate as `recall_inject`); `recall_metrics` same; no increase in frequency |
| HyDE doc text contains sensitive info | Doc is generated from the user's own query context — same data already in the store; no new exposure |
| Charts render poorly on mobile | Use recharts `ResponsiveContainer`; test at 375px; horizontal scroll for wide charts |
| `recall_metrics` event missing when CRAG disabled | Gate SSE emission behind `RAG_RECALL_METRICS()` check; dashboard shows "CRAG disabled" |

## Out of Scope

- HyDE model selection UI (model is env-var only)
- HyDE A/B testing framework
- Per-hit click-through to checkpoint detail
- Real-time HyDE generation streaming (shows final result only)
- RAG metrics export (CSV/JSON download)
- Custom alert thresholds for CRAG failures
- HyDE prompt customization UI
