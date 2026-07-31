# Sprint — Prompt Cache Stats: Surface Provider Cache Metrics + Cheap Cache-Stability Wins

**Date:** 2026-08-01 (respec v3: add Sub-Sprint E for PLAN_V2 1.5/1.6/1.7 gap closure)
**Branch:** `feature/promptcache-stats`
**Priority:** P0 (cost visibility — every competitor surfaces this; three confirmed cache-breakers are one-line/contained fixes)
**Status:** Ready
**Effort:** M (≈2 days across 5 gated sub-sprints A–E)
**Depends on:** v0.11.0 (S49-S52 per-turn memory platform, perf_samples table, dashboard)
**Parent docs:** `docs/PROMPTCACHE_FINDINGS.md`, `docs/PROMPTCACHE_FULL_GAP_ANALYSIS.md`, `docs/PROMPTCACHE_PLAN_V2.md`

---

## SAFETY PROTOCOLS

- Read `docs/AGENT_GUARDRAILS.md` + `skills/shared-prompts/four-laws.md` first.
- **PREVENT-PI-001 / 002** (anchor floor / tool pairs): sub-sprint D replays the *cached, pre-sanitized* trim cut — the existing `runtime.trimCache.cut` was sanitized once by `computeLiveTrimCut` (src/boundary.ts) and is only valid while the transcript grows within the epoch (cleared on durable truncation). Reordering the replay check must NOT move it before the validity guards (`checkpointId === lastCheckpointId`, `cut <= messages.length`).
- **PREVENT-PI-003** (no system role): unchanged — recall injection still uses the sanctioned `before_agent_start` systemPrompt prepend this sprint. (Moving recall to a tail user-role message is flagged as future work; it changes injection semantics and needs its own sprint.)
- **PREVENT-PI-004** (no network): local SQLite reads only; loopback dashboard server. The scanner walks `.ts`/`.js` only — `.tsx` client code escapes it, which makes discipline (not tooling) the enforcement layer for client fetches.
- **PREVENT-002** (parameterized SQL): all queries parameterized or code-controlled literals only.
- **Non-fatal**: every store read in the dashboard/TUI path is try/catch — instrumentation never blocks the agent loop.
- **Gate (every sub-sprint)**: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all` **plus, for any sub-sprint touching `extensions/dashboard-client/`, `cd extensions/dashboard-client && npm run typecheck`** (the root tsconfig excludes the dashboard client — without this, the gate cannot see broken `.tsx`).

---

## PLAN_V2 Phase 1 Traceability

Every item in `docs/PROMPTCACHE_PLAN_V2.md` Phase 1 is covered by exactly one sub-sprint:

| PLAN_V2 | Sprint | File(s) |
| --------- | -------- | --------- |
| 1.1 `readProviderCacheStats()` | A.1 | `src/store/sqlite/perf-samples.ts` |
| 1.2 `/api/provider-cache` endpoint | A.3 | `extensions/dashboard-server/routes-cache.ts` |
| 1.3 ProviderCacheCard in CacheTab | B.1–B.3 | `ProviderCacheCard.tsx` + `CacheTab.tsx` |
| 1.4 `cachePct` swap (dedup→provider) | C.1–C.3 | `snapshot.ts` + `runtime-snapshot.ts` + `widget.ts` |
| 1.5 Active Repos provider cache columns | **E.2** | `perf-samples.ts` + `routes-repo.ts` + `ActiveReposTable.tsx` |
| 1.6 Savings by Model cache columns | **E.3** | `routes-repo.ts` + `multi-repo.ts` + `SavingsByModelTable.tsx` |
| 1.7 `src/pricing.ts` + $ saved calc | **E.1** | `src/pricing.ts` (new) + refactor `routes-cache.ts` |

---

---

## Problem Statement

Provider prompt caching is the single biggest cost/latency lever for long-running coding agents
(Anthropic: cache reads cost 10% of full input, cache writes 125%; 80% hit rate ≈ 72% input cost
reduction). **Our current hit rate: 55-60%. The data IS captured but never displayed**, and three
confirmed bugs actively suppress the hit rate.

### Display bugs (sub-sprints A–C)

1. **Dashboard `CacheTab.tsx`** reads `/api/snapshot` (mega-compact **dedup** stats: 287 hits),
   not the provider's prompt cache. Shows zeros when no compaction has fired.
2. **TUI `cachePct`** at `extensions/mega-runtime/snapshot.ts:180` is `st.dedupHitRate * 100` —
   the dedup hit rate, not the provider cache hit rate.
3. **`/api/perf`** uses a 30-min rolling window (`routes-game.ts:233-237`); samples outside the
   window aggregate to 0.

### Cache-stability bugs (sub-sprint D) — from external source audit, verified against code

1. **Doc/code drift on the re-compact threshold.** `docs/cache-stabilization-design.md:17` states
   the 10% threshold "caused unnecessary invalidations" and "has been corrected by the 50% shift" —
   but `context-handler.ts:236` still hardcodes `RECOMPACT_PCT_DELTA = 10`. Every re-compact
   regenerates the summary and moves the cut: a full prefix rebuild every 10% of window growth.
2. **Debounce sits before the replay check.** `context-handler.ts:219-223` returns (full transcript
   for that call) when `now < runtime.debounceUntil` — *before* the trimCache replay check at
   `:237`. In fast tool loops (two LLM calls under 2s apart) the debounce itself causes the thrash:
   the prefix flip-flops between trimmed view and full transcript, a full cache miss both ways.
3. **Skip paths revert to the full transcript.** When compaction runs but is skipped
   (`ran.skipped`, `:272-275`), the handler returns nothing even when a valid `trimCache` exists —
   pi sends the untrimmed transcript for that call.

### Verified out of scope this sprint (future sprints — see §Future Work)

- **Recall injection via systemPrompt** (`session-handlers.ts:149-179`): staged recall blocks are
  prepended to the system prompt for exactly one agent run, then reverted — two full-prefix cache
  misses per recall (inject + revert). Fix (tail user-role message) changes injection semantics;
  needs its own sprint.
- **DB-mirror hot path is O(n²)**: every context event re-canonicalizes + re-hashes every message
  and attempts an insert per message (`context-handler.ts:172-183`). Needs a high-water mark so
  only new messages are processed.

---

## SCOPE

### IN SCOPE (new files)

| File | Responsibility | Est. lines |
| ---- | -------------- | ---------- |
| `extensions/dashboard-server/api-contracts/provider-cache.ts` | `ProviderCacheResponse` contract type. New file: `infrastructure.ts` is already 465 lines (500 hard) — do NOT grow it. | ~50 |
| `extensions/dashboard-server/routes-cache.ts` | `handleProviderCache` route. New file: `routes-game.ts` is 385 lines (400 soft) — do NOT grow it. Follows the `routes-game.ts` handler pattern (createRequire + typed cast, try/catch, 405). | ~90 |
| `extensions/dashboard-client/src/components/ProviderCacheCard.tsx` | Provider cache metrics card (hit %, token totals, $ saved, model, time range). | ~90 |

### IN SCOPE (modified files)

| File | Change |
| ---- | ------ |
| `src/store/sqlite/perf-samples.ts` | Add `readProviderCacheLifetime()` + `readLatestCacheHitPct()` (+~55 lines; file is 126 → ~181, well under 300). |
| `src/store/sqlite.ts` (barrel) | Re-export the two new functions. |
| `src/store/sqlite/perf-samples.test.ts` | Tests: empty table, NULL meta, mixed NULL/present meta, latest-pct ordering. |
| `extensions/dashboard-server/api-contracts/index.ts` (barrel) | Re-export `ProviderCacheResponse`. |
| `extensions/dashboard-server/api-contracts/endpoints.ts` | Add `providerCache: { method: "GET", path: "/api/provider-cache", ... }` to the `ENDPOINTS` registry (single source of truth for paths; the client consumes it). |
| `extensions/dashboard-server/routes.ts` (barrel) | Export `handleProviderCache` from `routes-cache.js`. |
| `extensions/dashboard-server/server.ts` | Import `handleProviderCache` (add to the import block ~:33-40) + add `if (handleProviderCache(req, res, ctx)) return;` to the dispatch chain (~:221). |
| `extensions/dashboard-server/routes-cache.test.ts` (new, or extend `perf-server.test.ts`) | Route tests: 200 happy path, 405 non-GET, 500 on store failure, savings null when no model snapshot, savings priced when present. |
| `extensions/dashboard-client/src/api/client.ts` | Add `fetchProviderCache()` using the internal `getJson<T>` helper + `ENDPOINTS.providerCache.path` (mirrors `fetchPerf` at :163). |
| `extensions/dashboard-client/src/tabs/CacheTab.tsx` | Fetch provider cache alongside snapshot; render `ProviderCacheCard` + existing dedup cards; keep existing loading/error `tab-stub` handling; keep 5s poll. |
| `extensions/mega-runtime/snapshot.ts` | Add `providerCachePct: number` to `SnapshotInput` (~:52); `cachePct` reads it instead of `st.dedupHitRate * 100` (:180). |
| `extensions/mega-runtime/runtime-snapshot.ts` | Read latest provider hit pct via **direct ESM import** (this file imports from `../../src/store/sqlite.js` at :22-34 — it does NOT use createRequire; that pattern is dashboard-server-only) and pass into `computeMegaSnapshot({...})` (:220). |
| `extensions/mega-runtime/widget.ts` | MEGA CACHE flare gate: render on `wd.megaCacheFlarePct >= 100` (the armed value travels with the flare) instead of `wd.cachePct >= 100` (:79, :103). |
| `extensions/mega-events/context-handler.ts` | Sub-sprint D: `RECOMPACT_PCT_DELTA` 10 → 50 (env-overridable); replay check above debounce; skip paths fall back to replay when trimCache valid. |
| `extensions/mega-config.ts` | Add `recompactPctDelta` (env `MEGACOMPACT_RECOMPACT_PCT_DELTA`, default 50) to `MegaConfig` + `loadConfig()`. |

### OUT OF SCOPE

- **PLAN_V2 Phase 2** (message separation: split conversation thread from tool results)
- **PLAN_V2 Phase 3** (vector-aware cache striping via pgvector stability scores)
- **PLAN_V2 Phase 4** (slot-aware pre-compaction layout)
- **Recall injection relocation** (systemPrompt → tail user-role message) — see §Future Work
- **DB-mirror high-water mark** (O(n²) hot path) — see §Future Work
- Per-model cache breakdown (perf-handler would need to tag model per sample)
- Cache hit rate trend charts
- ~~`src/pricing.ts`~~ — struck: pricing comes from the already-captured `model_snapshots.inputRate`
  (D3). No new pricing module is created this sprint.

---

## Design Decisions

### D1: New `/api/provider-cache` endpoint vs. enriching `/api/perf`

New endpoint. `/api/perf` returns rolling-window percentiles for 10 kinds; provider cache needs
**lifetime** aggregates (token totals, $ saved). Mixing the two semantics bloats the existing
endpoint. Follows the established one-handler-per-route pattern.

### D2: Lifetime scope (not session-scoped)

Aggregate ALL `cache_hit_pct` samples. `perf_samples` has no `session_id` column; provider cache
is a cost metric where users care about totals. Schema migration is out of scope and would break
the append-only invariant.

### D3: $ Saved formula and pricing source

`cacheReadSaved = totalCacheRead × inputRate × 0.9` (reads cost 10% of input → save 90%).
`cacheWriteCost = totalCacheWrite × inputRate × 0.25` (writes cost 125% → 25% premium over input).
Pricing source: `latestModelSnapshot(stateDir)` (`src/store/sqlite/model-snapshots.ts:50`, exported
via the `src/store/sqlite.ts` barrel) — per-model `inputRate` (USD/token) is already captured per
session. When no snapshot or zero rate, `savings` is `null` and the UI shows "—" (not $0).
**The function is `latestModelSnapshot`, not `readLatestModelSnapshot`** (that name does not exist).
**`ModelSnapshot` fields are `modelId` / `modelName`** — there is no `snap.model`.

### D4: Keep CacheHitsCard for dedup stats

Both metrics are valuable and orthogonal: dedup = mega-compact's own compression savings; provider
cache = Anthropic's prompt cache savings. Add `ProviderCacheCard` alongside, with explicit section
headers. Do not remove or repurpose the dedup cards.

### D5: MEGA CACHE flare semantics

The flare is armed from dedup stats (`st.dedupHitRate * 100` can legitimately exceed 100%) but the
render gate reads `wd.cachePct` — which after sub-sprint C is provider hit pct (bounded 0–100,
practically never 100), silently killing the flare. Fix: gate the render on
`wd.megaCacheFlare && wd.megaCacheFlarePct >= 100` (both fields already exist on WidgetData and are
threaded from runtime). One-line change at `widget.ts:79` and `:103`. Provider cache keeps `cachePct`;
dedup flare keeps its own value.

### D6: NULL handling — one story

`perf-handler.ts:76` writes `{input, cacheRead, cacheWrite}` on every `cache_hit_pct` sample, so
all rows written by the current code have complete meta. Older/foreign rows may have NULL or
partial meta. SQL-side: wrap every `json_extract` in `COALESCE(..., 0)` so the SUM never returns
NULL even on an all-NULL set. No `?? 0` belt-and-braces in TS — COALESCE is the single story.
(Note: a bare aggregate without GROUP BY always returns exactly one row — no `| undefined` row
guard; check `row.n === 0` only.)

### D7: Debounce protects compaction, not replay

Replay of a valid cached trim view is the *cache-stable* answer — it is always correct to return
it, and returning it in a fast loop is precisely what prevents prefix thrash. Debounce therefore
moves below the replay check: it throttles fresh compaction work, not replay. All other skip paths
(`ran.skipped`, cut-unsafe) fall back to replay when `trimCache` passes its existing validity
guards — never to the full transcript. This is the v0.8.6 design intent (the replay cache exists
to stabilize the KV prefix); the current ordering defeats it.

---

## Sub-Sprint A: Query + API Layer

**Goal:** expose provider cache lifetime aggregates via `/api/provider-cache`.

### A.1 — `readProviderCacheLifetime()` + `readLatestCacheHitPct()`

**File:** `src/store/sqlite/perf-samples.ts` (append, ~55 lines)

```typescript
/** Lifetime provider prompt cache aggregates from perf_samples. */
export interface ProviderCacheLifetime {
  /** Total samples (turns) recorded. */
  sampleCount: number;
  /** Average cache hit rate across all samples (0-100). */
  avgHitPct: number;
  /** Sum of cacheRead tokens across all samples. */
  totalCacheRead: number;
  /** Sum of cacheWrite tokens across all samples. */
  totalCacheWrite: number;
  /** Sum of input (non-cached) tokens across all samples. */
  totalInput: number;
  /** ISO timestamp of the first sample, or null if no samples. */
  firstSampleAt: string | null;
  /** ISO timestamp of the most recent sample, or null if no samples. */
  latestSampleAt: string | null;
}

/**
 * NOTE: first use of json_extract in this codebase. Available in node:sqlite
 * (Node ≥22.13 bundles SQLite ≥3.38, where json_extract is built-in) — verified
 * empirically on Node 26. Every extract is COALESCE'd so all-NULL meta sets
 * sum to 0 rather than NULL (D6).
 */
export function readProviderCacheLifetime(
  stateDir: string = getStateDir(),
): ProviderCacheLifetime {
  const db = openStore(stateDir);
  // kind is a code-controlled literal — no user input (PREVENT-002 safe).
  // Bare aggregate (no GROUP BY) always returns exactly one row.
  const row = db.prepare(`
    SELECT
      COUNT(*)                                          AS n,
      COALESCE(SUM(value), 0)                           AS sumPct,
      COALESCE(SUM(COALESCE(json_extract(meta, '$.cacheRead'), 0)), 0)  AS sumRead,
      COALESCE(SUM(COALESCE(json_extract(meta, '$.cacheWrite'), 0)), 0) AS sumWrite,
      COALESCE(SUM(COALESCE(json_extract(meta, '$.input'), 0)), 0)      AS sumInput,
      MIN(ts) AS firstTs,
      MAX(ts) AS latestTs
    FROM perf_samples
    WHERE kind = 'cache_hit_pct'
  `).get() as {
    n: number; sumPct: number;
    sumRead: number; sumWrite: number; sumInput: number;
    firstTs: number | null; latestTs: number | null;
  };

  if (row.n === 0) {
    return {
      sampleCount: 0, avgHitPct: 0,
      totalCacheRead: 0, totalCacheWrite: 0, totalInput: 0,
      firstSampleAt: null, latestSampleAt: null,
    };
  }
  return {
    sampleCount: row.n,
    avgHitPct: row.sumPct / row.n,
    totalCacheRead: row.sumRead,
    totalCacheWrite: row.sumWrite,
    totalInput: row.sumInput,
    firstSampleAt: row.firstTs != null ? new Date(row.firstTs).toISOString() : null,
    latestSampleAt: row.latestTs != null ? new Date(row.latestTs).toISOString() : null,
  };
}

/** Most recent cache_hit_pct value (TUI widget). Returns 0 if none. */
export function readLatestCacheHitPct(stateDir: string = getStateDir()): number {
  const db = openStore(stateDir);
  const row = db.prepare(`
    SELECT value FROM perf_samples
    WHERE kind = 'cache_hit_pct'
    ORDER BY ts DESC, id DESC LIMIT 1
  `).get() as { value: number } | undefined;
  return row?.value ?? 0;
}
```

Add both to the `src/store/sqlite.ts` barrel re-exports.

### A.2 — Contract

**File:** `extensions/dashboard-server/api-contracts/provider-cache.ts` (new, ~50 lines)

```typescript
/** Response body for GET /api/provider-cache. Lifetime provider prompt cache aggregates. */
export interface ProviderCacheResponse {
  cache: {
    avgHitPct: number;
    turnCount: number;
    totalCacheRead: number;
    totalCacheWrite: number;
    totalInput: number;
    firstTurnAt: string | null;
    latestTurnAt: string | null;
  };
  /** Null when no model pricing snapshot is available (UI shows "—"). */
  savings: {
    cacheReadSaved: number;
    cacheWriteCost: number;
    netSaved: number;
    model: string;
    inputRate: number;
  } | null;
  updatedAt: string;
}
```

Re-export from `api-contracts/index.ts`. Add to the `ENDPOINTS` registry in `endpoints.ts`:

```typescript
providerCache: {
  method: "GET",
  path: "/api/provider-cache",
  description: "Lifetime provider prompt cache aggregates + $ savings estimate.",
} as const satisfies EndpointDef<"GET", Record<string, never>, ProviderCacheResponse>,
```

### A.3 — Route handler

**File:** `extensions/dashboard-server/routes-cache.ts` (new, ~90 lines)

Follows the `handlePerf` pattern (createRequire + typed cast, try/catch, 405 for non-GET).
One destructure for both store functions (no duplicate requires):

```typescript
const pfReq = createRequire(import.meta.url);
const { readProviderCacheLifetime, latestModelSnapshot } = pfReq(
  "../../src/store/sqlite.js",
) as typeof import("../../src/store/sqlite.js");

const lifetime = readProviderCacheLifetime(stateDir);
// D3: pricing from the already-captured model snapshot (latestModelSnapshot,
// NOT readLatestModelSnapshot; ModelSnapshot fields are modelId/modelName).
let savings: ProviderCacheResponse["savings"] = null;
try {
  const snap = latestModelSnapshot(stateDir);
  if (snap && snap.inputRate > 0) {
    const cacheReadSaved = lifetime.totalCacheRead * snap.inputRate * 0.9;
    const cacheWriteCost = lifetime.totalCacheWrite * snap.inputRate * 0.25;
    savings = {
      cacheReadSaved,
      cacheWriteCost,
      netSaved: cacheReadSaved - cacheWriteCost,
      model: snap.modelName ?? snap.modelId,
      inputRate: snap.inputRate,
    };
  }
} catch { /* pricing unavailable — savings stays null */ }

res.writeHead(200, { "Content-Type": "application/json" });
res.end(JSON.stringify({
  cache: {
    avgHitPct: lifetime.avgHitPct,
    turnCount: lifetime.sampleCount,
    totalCacheRead: lifetime.totalCacheRead,
    totalCacheWrite: lifetime.totalCacheWrite,
    totalInput: lifetime.totalInput,
    firstTurnAt: lifetime.firstSampleAt,
    latestTurnAt: lifetime.latestSampleAt,
  },
  savings,
  updatedAt: new Date().toISOString(),
}));
```

**Registration:** export from `routes-cache.ts`; re-export via `routes.ts` barrel; add to the
`server.ts` import block and dispatch chain (`if (handleProviderCache(req, res, ctx)) return;`
next to `handlePerf` ~:221).

### A.4 — Tests

**`src/store/sqlite/perf-samples.test.ts`** (extend): seed fixtures covering —
empty table → zeros/nulls; rows with NULL meta → counted in `n`, contribute 0 tokens;
rows with partial meta (`{"input":N}` only) → missing keys treated as 0; full rows → correct
sums and avg. `readLatestCacheHitPct`: empty → 0; multiple rows → most recent by ts (tie → id).

**`extensions/dashboard-server/routes-cache.test.ts`** (new): boot the real server on an
ephemeral port against a temp stateDir (same harness as `perf-server.test.ts`) —
GET 200 shape matches `ProviderCacheResponse`; POST → 405; store throws → 500 with
`{error}`; no model snapshot → `savings: null`; with snapshot → priced savings fields.

**Gate:** `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`

**Acceptance:** seeded fixture of 3 samples (e.g. 1000/500/100 tokens) returns
`avgHitPct`, `totalCacheRead`, `totalCacheWrite`, `totalInput` matching arithmetic;
route returns that shape over HTTP.

---

## Sub-Sprint B: Dashboard Display

**Goal:** CacheTab shows provider prompt cache metrics next to (not instead of) dedup stats.

### B.1 — `fetchProviderCache()` in the API client

**File:** `extensions/dashboard-client/src/api/client.ts` (~4 lines, next to `fetchPerf` at :163)

```typescript
export function fetchProviderCache(): Promise<ProviderCacheResponse> {
  return getJson<ProviderCacheResponse>(ENDPOINTS.providerCache.path);
}
```

The internal helper is **`getJson<T>`** (:51) — there is no `fetchJSON`. All paths come from the
`ENDPOINTS` registry (B4 fix). Import `ProviderCacheResponse` from `@contracts`.

### B.2 — `ProviderCacheCard.tsx`

**File:** `extensions/dashboard-client/src/components/ProviderCacheCard.tsx` (new, ~90 lines)

Props = flattened `ProviderCacheResponse` fields. Display rows:

| Field | Format |
| ----- | ------ |
| Cache Hit Rate | `56.2%` — class: green ≥80, yellow ≥50, red <50 |
| Turns Recorded | `43` |
| Cache Read Tokens | humanized `1.2M` |
| Cache Write Tokens | humanized `340K` |
| Input Tokens | humanized `890K` |
| $ Saved (reads) | `$0.0432` or `—` when savings null |
| Write Investment | `$0.0108` or `—` |
| Net Saved | green `$0.0324` / red `-$0.0108` / `—` |
| Model | `claude-sonnet-4-6` |
| Tracked Since | locale date from `firstTurnAt` |
| Last Updated | relative time from `latestTurnAt` |

Reuse the existing `ov-stat-row` / `StatRow` pattern from `CacheHitsCard.tsx` and the
humanize/relative-time helpers if present in the client (check `src/utils` / existing cards
before writing new formatters).

### B.3 — Update `CacheTab.tsx`

**File:** `extensions/dashboard-client/src/tabs/CacheTab.tsx` (modify, ~+35 lines)

- Add a second `useApi<ProviderCacheResponse>` hook calling `fetchProviderCache()`,
  **same 5000ms poll** as the existing snapshot fetch (no interval change).
- Keep the existing loading/error `tab-stub` handling (:22-26) — extend it to cover both fetches.
- Render order: `## Provider Prompt Cache` → `ProviderCacheCard`, then
  `## Mega-Compact Dedup Cache` → existing `CacheHitsCard` + `TimeSavedCard` unchanged.
- No `mapProviderProps`-style helper indirection — destructure the response inline
  (`provider?.cache.avgHitPct ?? 0`), matching how the existing code destructures `snapshot`.

### B.4 — Gate addition (B5 fix)

The root `tsconfig.json` excludes `extensions/dashboard-client`; `npm run build`/`lint`/`test`
never typecheck `.tsx`. This sub-sprint's gate is therefore:

```bash
npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all \
  && cd extensions/dashboard-client && npm run typecheck
```

**Acceptance:** with a seeded perf_samples fixture, the Cache tab renders the provider hit rate
and token totals; with no model snapshot, $ fields render "—"; dedup cards unchanged.

---

## Sub-Sprint C: TUI Widget Fix

**Goal:** `C:xx%` in the widget shows provider cache hit rate, not dedup hit rate — without
breaking the MEGA CACHE flare.

### C.1 — `SnapshotInput` + `computeMegaSnapshot`

**File:** `extensions/mega-runtime/snapshot.ts`

- Add to `SnapshotInput` (the interface starts at :52): `providerCachePct: number;` (required —
  only `runtime-snapshot.ts:220` constructs it, so this compiles safely).
- Line 180: `const cachePct = st.dedupHitRate * 100;` → `const cachePct = p.providerCachePct;`

### C.2 — Feed it from `runtime-snapshot.ts`

**File:** `extensions/mega-runtime/runtime-snapshot.ts`

This file uses **direct ESM imports** (`:22-34` imports from `../../src/store/sqlite.js`) — it
does NOT use `createRequire` (that pattern is dashboard-server-only). Add
`readLatestCacheHitPct` to the existing import block, then near the existing
`latestModelSnapshot(self.currentStateDir)` call (:219):

```typescript
// Provider prompt cache hit % for the widget (B/C): latest cache_hit_pct sample.
// Non-fatal, matches the instrumentation-never-blocks convention. One extra sync
// open per material-change-gated recompute — acceptable (recompute already runs
// every turn; this path is NOT per-context-event).
let providerCachePct = 0;
try {
  providerCachePct = readLatestCacheHitPct(self.currentStateDir);
} catch { /* non-fatal: defaults to 0 */ }
```

Pass `providerCachePct` into the `computeMegaSnapshot({...})` call at :220.

### C.3 — MEGA CACHE flare gate fix (D5)

**File:** `extensions/mega-runtime/widget.ts` (:79 and :103)

`wd.gameMode && wd.megaCacheFlare && cachePct >= 100` →
`wd.gameMode && wd.megaCacheFlare && (wd.megaCacheFlarePct ?? 0) >= 100`

(`cachePct` is optional on WidgetData — `cachePct?: number` — and after C.1 it's provider
bounded 0–100; the flare's armed percentage already travels in `megaCacheFlarePct`.)

### C.4 — Test

Extend the snapshot/widget test (or add a small unit test): `computeMegaSnapshot` with
`providerCachePct: 56.2` yields `widgetData.cachePct === 56.2` regardless of
`st.dedupHitRate`. Flare: `megaCacheFlarePct: 287` + `providerCachePct: 56` still renders
the flare string.

**Gate:** base gate (no dashboard-client changes here).

**Acceptance:** widget shows the latest provider sample's pct; flare still fires on dedup ≥100%.

---

## Sub-Sprint D: Cache-Stability Quick Wins (external-audit fixes)

**Goal:** stop the confirmed prefix-thrash bugs. All changes in `context-handler.ts` + config.
This sub-sprint is what actually moves the hit rate; A–C make it visible.

### D.1 — `RECOMPACT_PCT_DELTA` 10 → 50, env-overridable

`docs/cache-stabilization-design.md:17` documents the 50% shift as shipped; the code at
`context-handler.ts:236` still hardcodes 10. Ship what the doc promises:

- `extensions/mega-config.ts`: add `recompactPctDelta: number` to `MegaConfig`;
  `loadConfig()` reads `MEGACOMPACT_RECOMPACT_PCT_DELTA` (default 50), following the existing
  envNum pattern in `src/config/dedup.ts` style.
- `context-handler.ts:236`: `const RECOMPACT_PCT_DELTA = config.recompactPctDelta;`
  (config is already in scope in this handler).

### D.2 — Replay exempt from debounce

Current order (`context-handler.ts:217-258`): debounce → return nothing; then replay check.
**Reorder:** validity-guarded replay check FIRST (return cached view immediately), THEN debounce
(guarding fresh compaction only):

```typescript
// 1. Replay check (was :237-258) — unchanged conditions:
//    trimCache exists && checkpointId === lastCheckpointId && cut <= messages.length
//    && !grewEnough  →  return replayed view. (PREVENT-PI-001/002: validity guards
//    stay BEFORE the slice, exactly as today.)

// 2. Debounce (was :219-223) — now only reached when replay did NOT apply:
if (now < runtime.debounceUntil) {
  runtime.diagCtxDebounce++;
  return;
}
runtime.debounceUntil = now + 2000;
```

Consequence: in a fast tool loop with a valid cached view, every context event returns the same
trimmed view — the provider prefix is byte-identical across those calls (a cache hit), instead of
alternating trimmed/full (a miss both ways).

### D.3 — Skip paths fall back to replay

At `ran.skipped` (`:272-275`): if `runtime.trimCache` passes the same validity guards as D.2's
replay check, return the replayed view instead of nothing. Same for any other early-return
between the fast gate and `runCompact` where a valid cached view exists. The invariant is:
**once a trim view exists for the epoch, no code path returns the full transcript.**

### D.4 — Tests

Extend the context-handler tests:

- **Debounce exemption:** fire two context events <2s apart with a valid `trimCache` and
  un-grown context → the second returns the replayed view (assert `diagLiveTrimReplays` increments,
  `diagCtxDebounce` does not).
- **Skip fallback:** force `ran.skipped` with a valid `trimCache` → returns replayed view,
  not `undefined`.
- **Recompact delta:** context grown by 9% since cached cut → replays; grown by 51% → fresh
  compaction path (`diagLiveTrimFires` increments without replay increment).
- **Epoch invalidation unchanged:** after durable truncation (checkpointId mismatch), replay does
  NOT fire even with fresh context (PREVENT-PI-001/002 regression guard).

**Gate:** base gate.

**Acceptance:** in a scripted fast-loop session (tool call → immediate next turn), provider
`cache_hit_pct` samples stay in the replay band (e.g. >90%) instead of alternating ~60%/99%;
`RECOMPACT_PCT_DELTA` honored from env override in a test.

---

## Sub-Sprint E: PLAN_V2 Table Coverage + Pricing Module

**Goal:** close the 3 remaining PLAN_V2 Phase 1 gaps: provider cache columns in Active Repos
and Savings by Model tables, plus a reusable pricing module.

**Note:** PLAN_V2 calls these items 1.5, 1.6, 1.7. They were omitted from the original
A–D sprint boundary because A–D scoped to one surface (CacheTab + ProviderCacheCard).
This sub-sprint extends coverage to the two remaining dashboard tables and extracts the
pricing constants the endpoint already uses inline.

### E.1 — `src/pricing.ts` (extract first, consume second)

**Files:** `src/pricing.ts` (new, ≈50 lines)

The `/api/provider-cache` endpoint already computes dollar savings with hardcoded
constants (0.9 = cache read discount, 0.25 = cache write premium). Extract these into
a single-source-of-truth module consumed by every dashboard savings display:

```typescript
// src/pricing.ts

/** Anthropic prompt-caching price multipliers (public pricing page). */
export const CACHE_READ_MULTIPLIER = 0.10;   // reads cost 10% of base input
// CACHE_READ_DISCOUNT = 0.90 → derived: 1.0 - 0.10
export const CACHE_WRITE_MULTIPLIER = 1.25;  // writes cost 125% of base input

/** Known model pricing (USD per 1M input tokens). Source: Anthropic pricing page. */
export const MODEL_INPUT_RATES: Record<string, number> = {
  "claude-sonnet-4-20250514":  3.00,
  "claude-3.5-sonnet":          3.00,
  "claude-3.5-haiku":           0.80,
  "claude-3-opus":             15.00,
  "claude-3.5-opus":           15.00,
  "claude-haiku-4-20250514":    1.00,
};

/** Compute lifetime dollar savings from provider cache metrics. */
export function computeCacheSavings(
  totalCacheReadTokens: number,
  totalCacheWriteTokens: number,
  inputRate: number,   // USD per 1M input tokens
): { cacheReadSaved: number; cacheWriteCost: number; netSaved: number } {
  const readDiscount = 1.0 - CACHE_READ_MULTIPLIER; // 0.90
  const writePremium  = CACHE_WRITE_MULTIPLIER - 1.0; // 0.25
  const perToken = inputRate / 1_000_000;
  const cacheReadSaved = totalCacheReadTokens * perToken * readDiscount;
  const cacheWriteCost = totalCacheWriteTokens * perToken * writePremium;
  return {
    cacheReadSaved:  round4(cacheReadSaved),
    cacheWriteCost:  round4(cacheWriteCost),
    netSaved:        round4(cacheReadSaved - cacheWriteCost),
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Look up the input rate for a model string (fuzzy match). */
export function lookupModelInputRate(model: string): number | undefined {
  // exact match first
  if (MODEL_INPUT_RATES[model] != null) return MODEL_INPUT_RATES[model];
  // prefix match (e.g. "claude-sonnet-4-20250514-vendor" → "claude-sonnet-4-20250514")
  for (const [key, rate] of Object.entries(MODEL_INPUT_RATES)) {
    if (model.startsWith(key)) return rate;
  }
  return undefined;
}
```

**Refactor `routes-cache.ts`** to import `computeCacheSavings` instead of inline arithmetic.

**Gate:** `tsc --noEmit src/pricing.ts` clean; existing `/api/provider-cache` response
byte-identical.

### E.2 — Provider cache per-repo (Active Repos table)

**Files:** `src/store/sqlite/perf-samples.ts`, `extensions/dashboard-server/routes-repo.ts`,
`extensions/dashboard-server/api-contracts/endpoints.ts`,
`extensions/dashboard-client/src/components/ActiveReposTable.tsx`

**Backend (step 1):** Add `readProviderCacheForRepo(stateDir)` to perf-samples. Reads
`perf_samples` table (already has `stateDir` column) for the single repo — returns the
same aggregate shape as `readProviderCacheLifetime` scoped to one repo.

```typescript
export function readProviderCacheForRepo(
  stateDir: string,
): ProviderCacheLifetime | null;
```

**Backend (step 2):** In `/api/servers` handler (`routes-repo.ts`), call
`readProviderCacheForRepo(r.stateDir)` for each active repo and merge a
`providerCache` field into the output record.

**Contract (step 3):** Add to `ServerEntry`:

```typescript
readonly providerCache?: {
  readonly hitPct: number;
  readonly totalCacheRead: number;
  readonly totalCacheWrite: number;
} | null;
```

**Frontend (step 4):** Add 3 columns to `ActiveReposTable.tsx` after the existing
"CacheHit s/t (s)" column:

| Column | Source | Format |
| -------- | -------- | -------- |
| Prompt Hit % | `r.providerCache?.hitPct` | `56.2%` (same green/yellow/red as ProviderCacheCard) |
| Cache Read | `r.providerCache?.totalCacheRead` | humanized `1.2M` |
| Cache Write | `r.providerCache?.totalCacheWrite` | humanized `345K` |

When `providerCache` is null/absent → "—".

### E.3 — Provider cache per-model (Savings by Model table)

**Files:** `extensions/dashboard-server/routes-repo.ts`,
`extensions/dashboard-server/api-contracts/multi-repo.ts`,
`extensions/dashboard-client/src/components/SavingsByModelTable.tsx`

**Backend (step 1):** Extend `IndexesIndexRow` with an optional provider cache field:

```typescript
readonly providerCachePct: number | null;  // lifetime cache hit % for this repo
readonly providerCacheRead: number | null;  // lifetime cache read tokens
readonly providerCacheWrite: number | null; // lifetime cache write tokens
```

**Backend (step 2):** In `/api/index` handler (`routes-repo.ts`), populate these
fields from SQLite (`readProviderCacheForRepo`) for each repo row.

**Frontend (step 3):** `SavingsByModelTable.tsx` already groups repos by `modelName`
and accumulates `tokensSaved` (dedup tokens). Add 2 columns:

| Column | Source | Format |
|--------|--------|--------|
| Avg Cache Hit % | Weighted avg of `providerCachePct` across model group | `56.2%` |
| Est. $ Saved | Sum of `computeCacheSavings(...)` per repo, summed by model | `$1.23` (4 decimals) |

Clients aggregate client-side from `IndexesIndexRow[]` (no new endpoint).

**Gate:** base gate; dashboard-client typecheck pass.

---

## Success Criteria

| Criterion | Measurable (behavioral, CI-reproducible) |
| --------- | ---------------------------------------- |
| **A–C (existing)** | |
| CacheTab shows provider cache | Seeded fixture → rendered card matches fixture arithmetic |
| $ Saved displays | Priced model snapshot → non-\"—\" USD; no snapshot → \"—\" |
| TUI shows provider cache | `widgetData.cachePct` === latest seeded sample |
| Dedup flare intact | Flare renders when `megaCacheFlarePct >= 100` with `cachePct < 100` |
| **D (cache stability)** | |
| Replay exempt from debounce | Two events <2s apart → replay, no debounce increment |
| Skip fallback | `ran.skipped` + valid trimCache → replayed view returned |
| Recompact threshold | 9% growth replays, 51% re-compacts; env override honored |
| **E (table coverage + pricing)** | |
| ActiveRepos provider cache columns | Seeded fixture → 3 columns (Hit%, Read, Write) rendered per repo; null safety → "—" |
| SavingsByModel provider cache columns | Client-side aggregation → Avg Hit% + Est. $ Saved rendered per model group |
| `src/pricing.ts` reusable | `computeCacheSavings()` called from routes-cache; byte-identical response vs inline |
| **Gate** | |
| All tests pass | `npm test` green (incl. new tests) |
| Lint + regression + guardrails | all clean; dashboard-client typecheck clean |

---

### As-built notes (E, v0.11.4+)

**Pricing constants (E.1):** `src/pricing.ts` stores the **discount** and **premium**
fractions directly — `CACHE_READ_MULTIPLIER = 0.9` (90 % discount, i.e. pay 10 %
of full price) and `CACHE_WRITE_MULTIPLIER = 0.25` (25 % premium). The spec draft
wrote the raw multipliers (0.10 / 1.25); the arithmetic is byte-identical. The
module exports `computeCacheSavings(cacheRead, cacheWrite, inputRate)` and
`lookupModelInputRate(model)` (exact → prefix → `undefined`).

**providerCache field names (E.2):** The API contract (`ServerEntry.providerCache`)
uses `avgHitPct`, `cacheRead`, `cacheWrite`, `estimatedSaved` — not the spec
draft's `hitPct` / `totalCacheRead` / `totalCacheWrite`. The dashboard reads
these names as-is; `readProviderCacheForRepo` computes them from `meta`
sub-keys (`cacheRead` / `cacheWrite` / `input`) inside `perf_samples` rows.

**ActiveReposTable bonus column (E.2):** Beyond the spec's three columns
(Hit %, Cache Read, Cache Write) the table gained a fourth **Est. Saved** column
showing `computeCacheSavings` net-saved value with the same `@pricing` module
the backend routes use.

**SavingsByModelTable import (E.1):** `SavingsByModelTable.tsx` imports
`computeCacheSavings` via the `@pricing` Vite/tsconfig alias — same barrel as
`@contracts` — rather than duplicating the discount/premium constants inline.

---

## Risks and Mitigations

### R1: json_extract portability

First use of `json_extract` in the codebase. Mitigation: verified on Node 26 (bundled SQLite);
engines require ≥22.13 which bundles SQLite ≥3.38. Comment on the function notes this (A.1).

### R2: Per-turn SQLite read in the snapshot path

C.2 adds one sync read per material-change-gated recompute. The gate (`runtime-snapshot.ts:99-113`)
already skips recompute when nothing material changed, and turn boundaries change the signature —
so this costs one read per turn, same cadence as the existing `latestModelSnapshot` call beside it.

### R3: TUI meaning change surprises users

`C:68%` (dedup) becomes `C:56%` (provider). Mitigation: dedup stays visible in the dashboard
Cache tab; call out in release notes.

### R4: Rolling-window gap in `/api/perf` remains

The MetricsTab "Cache hit %" card still zeroes when samples age out of the 30-min window.
Pre-existing, not worsened; the new lifetime endpoint gives the always-populated view. Logged as
tech debt for a future `?minutes=` on `/api/provider-cache`.

### R5: D-ordering regression risk

Moving the replay check above debounce changes which diag counters fire in fast loops
(`diagLiveTrimReplays` up, `diagCtxDebounce` down). Any tooling keyed on debounce counts sees a
shift — checked: counters are dashboard diagnostics only, no behavioral coupling.

---

## External Audit Items — Full Disposition

Source: external source-code audit of the extension (2026-07-29). **Caveat from the auditor: this
was a read of the source, not a live test.** Each claimed line reference was re-verified against
the code before acceptance into a sprint:

| # | Audit finding | Verified at | Disposition |
| - | ------------- | ----------- | ----------- |
| 1 | Skip paths silently revert to full transcript; debounce precedes replay; fast tool loops thrash the prefix | `context-handler.ts:219-258, 272-275` | ✅ **This sprint, sub-sprint D** |
| 2 | Recall injection prepends to systemPrompt for exactly one run, then reverts — two full-prefix misses per recall | `session-handlers.ts:149-179` | ✅ **S53 spec written** — `docs/specs/s53-recall-tail-injection.md` |
| 3 | Doc/code drift: cache-stabilization doc claims 50% re-compact threshold shipped; code hardcodes 10 | `context-handler.ts:236` vs `docs/cache-stabilization-design.md:17` | ✅ **This sprint, sub-sprint D** |
| 4 | DB-mirror hot path is O(n²): every context event re-canonicalizes + re-hashes every message, n inserts per LLM call, synchronously | `context-handler.ts:172-183` | 📋 Future Work #2 (high-water mark) |
| 5 | Published package ships construction scaffolding: `PLAN.md`, `SPRINT_PLAN.md`, `tmp/audit-s27.mjs`, sprint-numbered test files (`sprint14.test.ts`, `run-s20-s23.mjs`), comments dense with S16/S38.5/PREVENT-PI-002 codes | repo root + `tmp/` + `tests/` | 📋 Future Work #6 (as-built pass) |
| 6 | Scope sprawl for a "compactor": React dashboard + SSE, gamification, k-means wiki, WASM Postgres + HNSW, turn store with fork/rewind — all surface area inside the user's agent process; PGlite singleton already caused one hang-on-exit (patched v0.8.5) | repo-wide | 📋 Strategic note below — not a sprint item |

**Strategic note (audit #6):** the core trim + checkpoint engine would be a stronger standalone
offering than the current everything-extension. Not actionable as a sprint; tracked here as a
packaging/extraction consideration for a future major version (e.g., split `pi-mega-compact-core`
from dashboard/game/wiki extras). No code change implied.

## Future Work (verified against code; each is its own sprint)

1. **Recall injection relocation → S53.** Designed: `docs/specs/s53-recall-tail-injection.md`.
   Move staged recall/memory blocks from the one-shot `before_agent_start` systemPrompt prepend
   to a tail user-role message in the context view (append-only, prefix-preserving).
2. **DB-mirror high-water mark** — `context-handler.ts:172-183` re-canonicalizes + re-hashes
   every message on every context event (O(n) hashing + n inserts per LLM call, O(n²) per
   session) synchronously on the request path. Persist a last-processed message count/hash per
   session and only process the tail.
3. **PLAN_V2 Phase 2** (message separation) and **Phase 3** (vector cache striping) — multi-sprint
   efforts; the 88–92% hit-rate target belongs to these, not to this sprint.
4. **`/api/provider-cache?minutes=`** — configurable window (R4).
5. **Per-model cache breakdown** — tag model in perf-handler meta; group aggregates by model.
6. **As-built pass (audit #5)** — remove/move construction scaffolding from the published package:
   exclude `tmp/audit-*.mjs` + sprint-runner scripts from the npm `files` list, rename
   sprint-numbered test files to behavior names, and rewrite S-code/PREVENT-PI-only comments into
   as-built descriptions (keep the codes where the scanner enforces them). Pure packaging/docs
   hygiene; no runtime behavior change.
