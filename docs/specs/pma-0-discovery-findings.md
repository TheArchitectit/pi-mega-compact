# PMA-0 Discovery Findings — Provider/Model Analytics

**Date:** 2026-08-11
**Branch:** `pma-0-discovery` (off `feat/provider-model-analytics-spec`, master `a02ff5fc`)
**Status:** Read-only research; no production behavior change. Resolves every open question in the PMA spec (§18) with proven evidence.
**Parent spec:** `docs/specs/provider-model-analytics-program.md`

---

## TL;DR — spec open questions resolved

| Spec OQ (§18) | Decision | Evidence |
|---|---|---|
| **#1 Which pi events expose request start/provider select/terminal/first-token?** | **All measurable.** `turn_start`/`turn_end` (request lifecycle), `model_select` + `ctx.model` (provider identity), `message_update` (TTFT). | §2, §3, §4 below |
| **#2 Is provider identity independent of model?** | **Yes — explicit field.** `Model.provider: ProviderId` on every model-bearing event; never infer from model string. | §5 |
| **#3 Actual backfill source + DB ownership?** | **`perf_samples` table inside `sqlite.db`** (NOT a separate `provider-cache.db` — that file does not exist). Token counts are JSON inside the `meta` column, not stored columns. | §1.3 |
| **#4 Retention defaults?** | Baseline ~3-4 rows/turn + ~4 rows/5s background cpu/mem. Per-turn analytics volume is small; background dominates. Proposal: 90d request events, 30d measurements stands. | §1.5 |
| **#5 DnD/layout utility present?** | **Yes — `@dnd-kit` is a dependency** + `useCardPositions` hook + `SortableCard` + `DndContext` pattern (Overview surface). Reuse directly; no speculative package. | §6.3 |
| **#6 Per-stateDir or machine-wide?** | Per-stateDir (matches all other per-repo stores); `repo_id` retained in facts for a later approved global reader. | §1.1 |
| **#7 Metrics/Alerts cards (Matt Cowger)?** | Out of scope (separate follow-up, unchanged). | spec §12 |

**No spec metric is forced to N/A.** TTFT is measurable (the spec hedged it N/A — that hedge is now resolved).

---

## 1. Database / storage reality

### 1.1 Databases the extension opens (5 SQLite + 1 PGlite)

| DB file | Owner | Scope | Path |
|---|---|---|---|
| `sqlite.db` | `src/store/sqlite/utils.ts:60-88` `openStore` | per-stateDir | `<stateDir>/sqlite.db` |
| `turns.db` | `src/store/turns/connection.ts:41-78` | per-stateDir | `<stateDir>/turns.db` |
| `index.sqlite` | `src/store/sqlite/global-index.ts:52-57` | machine-wide | `~/.mega-compact-index/index.sqlite` |
| `cortex.db` | `src/vector-cortex/cortex/sqlite.ts:98` | per-stateDir (flag-gated) | `<stateDir>/vector-cortex/cortex.db` |
| `occurrence-v2.db` | `src/vector-cortex/ledger/sqlite.ts:73` | per-stateDir (flag-gated) | `<stateDir>/vector-cortex/occurrence-v2.db` |
| (PGlite) `vector_index` | `src/store/vectorIndex.ts:128-146` | machine-wide | `~/.pi/mega-compact-vector` |

**There is NO `provider-cache.db`.** Grep for `provider-cache\.db|provider_cache\.db` in `src/`+`extensions/` = zero matches. Provider-cache data lives in `perf_samples` rows (see §1.3). The PMA spec's reference to a "`provider-cache.db`" is **false** — §1.3 is the authoritative backfill source.

**`analytics.db` (the PMA-1 target) must be a 6th per-stateDir SQLite file** at `<stateDir>/analytics.db`, with its own module-private connection cache (mirroring `turns.db`'s isolation at `connection.ts:27`).

### 1.2 `perf_samples` schema (`src/store/sqlite/schema/game.ts:57-65`)
```sql
CREATE TABLE IF NOT EXISTS perf_samples (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  ts    INTEGER NOT NULL,         -- epoch ms (Date.now())
  kind  TEXT NOT NULL,
  value REAL NOT NULL,
  meta  TEXT                      -- nullable JSON blob
);
```
Lives inside `sqlite.db`. `kind` is allowlisted (`PERF_KINDS`, `perf-samples.ts:36-49`): `turn_latency_ms`, `provider_latency_ms`, `tps`, `cache_hit_pct`, `prefix_break`, `rss_mb`, `heap_mb`, `cpu_user_ms`, `cpu_sys_ms`, `db_recompute_ms`, `disk_write_ms`, `cache_health`.

### 1.3 The provider/cache data path (backfill source)
**All provider-cache data is `kind='cache_hit_pct'` rows in `perf_samples`.** End-to-end:
- **Capture:** `perf-handler.ts:214-243` reads the assistant message `usage` block (`{input, output, cacheRead, cacheWrite}`), computes `hitPct`, calls `recordPerfSample(..., "cache_hit_pct", hitPct, { input, cacheRead, cacheWrite, modelName, modelId })`.
- **Storage:** token counts are serialized into the `meta` JSON column — **they are NOT stored as columns**. Re-parsed via `JSON_EXTRACT`/JS at read time (`perf-samples.ts:245-260`).
- **Read:** `aggregateCacheRows` (`perf-samples.ts:205-305`) → `readProviderCacheLifetime`/`readProviderCacheWindow`/`readProviderCacheForRepo`.
- **HTTP:** `routes-cache.ts:23-149` `handleProviderCache` (GET `/api/provider-cache`).

**Migration implication for PMA-1/2:** backfill reads `perf_samples WHERE kind='cache_hit_pct'`, `JSON_EXTRACT(meta, '$.input')` etc., and inserts normalized facts into `analytics.db`. Copy-only, lossless for available fields, null-honest for missing ones.

### 1.4 The turns store isolation pattern (reference for `analytics.db`)
`src/store/turns/` is the established template (already mirrored by cortex/ledger):
- Own DB file + **module-private connection cache** (`connection.ts:27`, separate from `openStore`'s cache — `connection.ts:11-13` documents why).
- Capability gates: `asReader()`/`asWriter()`/`asAdmin()` returning branded handles (`types.ts`, `sqlite-store.ts`). The cortex store (`vector-cortex/cortex/store.ts:120-170`) uses the identical shape.
- Path resolution: stateDir-anchored default + env override (`MEGACOMPACT_TURNS_DB_PATH`) + `:memory:` test mode.
- PRAGMAs: `busy_timeout=5000`, `journal_mode=WAL`, `foreign_keys=ON`.
- Self-contained `withTx` using a distinct SAVEPOINT name (`turns_tx`) to avoid nesting collisions.
- Closed-handle eviction + graceful `closeTurnDb`/`closeAllTurnDbs`.

**PMA-1 should mirror `src/store/turns/connection.ts` + `types.ts` directly.**

### 1.5 Volume signal
- **Per turn_end:** ~3-4 rows (`turn_latency_ms`, `tps`, `cache_hit_pct`, `provider_latency_ms`) + rare conditional rows (`prefix_break`, `cache_health`).
- **Background:** ~4 rows / 5s (`cpu_user_ms`, `cpu_sys_ms`, `rss_mb`, `heap_mb`) — dominates row count (~2880/hr).
- **Per compaction:** zero direct perf_samples writes (compaction cost only observed indirectly via snapshot-recompute `db_recompute_ms`/`disk_write_ms`).
- **Retention proposal stands:** 90d request events, 30d high-frequency measurements. Per-turn analytics volume is small and clean (kind-tagged).

---

## 2. pi lifecycle event inventory (17 registered)

Full inventory at `extensions/mega-events/`. The analytics-relevant events:

| Event | Signals | Analytics use |
|---|---|---|
| `turn_start` (`agent-handlers.ts:42`) | One model request begins | `request_started` fact (start timestamp) |
| `turn_end` (`agent-handlers.ts:59`) | One model request ends; carries finalized `AssistantMessage` with `usage`, `stopReason`, `provider`, `model` | `request_completed`/`request_failed` terminal fact |
| `model_select` (`session-handlers.ts:29`) | Active model changed (set/cycle/restore); carries full `Model` incl. `provider` + `cost` | `identity_observations` row (NOT per-request) |
| `before_agent_start` (`session-handlers.ts:149`) | After user submits, before agent loop; `ctx.model` reliably populated | per-request `provider_selected` (read `ctx.model`) |
| `before_provider_request` (`perf-handler.ts:271`) | Just before HTTP send | tighter latency start (HTTP RTT basis) |
| `after_provider_response` (`perf-handler.ts:278`) | Response headers received; `status: number` | HTTP success/failure/retry signal |
| `message_update` (`types.d.ts:562`) | **NOT registered today** — per-token streaming delta; `assistantMessageEvent.type === "text_start"` is the **TTFT seam** | `first_token` fact (TTFT) |

**Events available but unregistered** (PMA adapter candidates): `message_start`, `message_update`, `message_end` (the streaming lifecycle), `agent_settled` (true session-settle boundary), `before_provider_headers`.

---

## 3. Request lifecycle correlation — MEASURABLE

**One turn == one model HTTP request.** Proven in `pi-agent-core/dist/agent-loop.js:77-130`: `runLoop` emits `turn_start` → calls `streamAssistantResponse` once → emits `turn_end`.

**Correlation id:** `(sessionId, turnIndex)` — `turnIndex` flows `turn_start → turn_end` (same field). Supplemental: `AssistantMessage.responseId` (provider-side request id).

**Synthesizing the spec's `event_kind` taxonomy from host events:**
- `request_started` ← `turn_start` (or `before_provider_request` for tighter HTTP basis)
- `provider_selected` ← `ctx.model` at `turn_start`/`before_provider_request` (NOT `model_select`, which fires only on change)
- `request_completed` ← `turn_end` with `stopReason ∈ {stop, length, toolUse}`
- `request_failed` ← `turn_end` with `stopReason ∈ {error, aborted}`, OR `after_provider_response` with `status >= 400`
- `first_token` ← `message_update` with `assistantMessageEvent.type === "text_start"` (fallback `text_delta`)

**Crash/timeout edge:** a process crash mid-turn leaves `turn_start` with no `turn_end` → handled as "incomplete" per spec §6.

---

## 4. TTFT — MEASURABLE (spec N/A hedge resolved)

The spec hedged TTFT as "N/A unless the host exposes that event." **The host exposes it.**

**Proof:** `pi-agent-core/dist/agent-loop.js:201-227` emits a `message_update` extension event for every stream chunk, including `text_start` (the first text token). The `MessageUpdateEvent.assistantMessageEvent.type` discriminator (`types.d.ts:557-561`) is exactly this signal.

**Measurement recipe (ready for PMA-2):**
1. Stamp `t0` at `before_provider_request`.
2. Register `message_update`; on the first `assistantMessageEvent.type === "text_start"`, stamp `t1`.
3. TTFT = `t1 - t0`. Fallback for providers that skip `text_start`: first `text_delta`.

**Quality note to record:** TTFT from `before_provider_request` = "HTTP-send to first token"; from `turn_start` = "turn-start to first token" (includes pre-HTTP transform). Pick one + label it. No extension registers `message_update` today, so this is a net-new seam (non-fatal by nature).

---

## 5. Provider identity — explicit, independent

`Model.provider: ProviderId` (`pi-ai/dist/types.d.ts:585`) — present on every model-bearing event (`AssistantMessage.provider` at `:280`, `ModelSelectEvent.model.provider` at `types.d.ts:594`, `ctx.model.provider`). `ProviderId = KnownProvider | string` (35 known providers). Display via `ctx.modelRegistry.getProviderDisplayName(provider)` (`model-registry.d.ts:84`).

**Never infer provider from model text.** The existing capture reference is `extensions/mega-runtime/capture-model.ts:28-116` (extracts `{ provider, providerName, modelId, modelName, inputRate, ... }` from `ctx.model`).

---

## 6. Dashboard surface + layout reality

### 6.1 CacheTab.tsx — 274 lines (spec holds)
6 `useApi` fetches (`/api/provider-cache`, `/api/cache-stripes`, `/api/perf`, `/api/prefix-stability`, `/api/snapshot`, `/api/rag-settings`). 5 sections inline. The `./CacheTab/` subdirectory + `CacheTab/MetricsCards.tsx` already establish the split-out convention. **Overview-preservation goal is achievable** the same way MetricsCards was byte-preserved.

### 6.2 Sub-tab shell precedent
`MemoryMapTab.tsx:14-44` (minimal: `useState` + `<Toggle>` nav + conditional mounts) and `SetupTab.tsx:42-106` (dynamic list). Both use shadcn `<Toggle>`, not Radix Tabs. PMA-4 mirrors this exactly.

### 6.3 DnD exists — `@dnd-kit` is a dependency
`@dnd-kit/core ^6.3.1` + `sortable` + `utilities` (package.json:14-16). Reorderable card grid in `OverviewTab.tsx:386-397` via `DndContext`/`SortableContext`; per-card drag handle in `components/ui/SortableCard.tsx`. Persistence: `useCardPositions` hook (localStorage key `mega-compact-card-order`, validated permutation). **Reuse directly; a per-surface analytics card-order key (e.g. `mega-compact-analytics-card-order`) mirrors the convention.**

### 6.4 useApi — NO stale detection / NO visibility pause (spec assumption false)
`useApi` (`hooks/useApi.ts`) provides polling + retry + `lastFetchedAt`, but the doc-comment's "stale detection" is **vaporware** — no `isStale` flag, no `staleAfterMs`, no `visibilitychange` listener. **PMA Live/Detailed sub-tabs that need either must extend the hook or build the layer at the call site.** SSE is available separately (`hooks/useSSE.ts`) and could feed the Live sub-tab.

### 6.5 File-size flags (governed by 400-line soft limit)
| File | Lines | Status |
|---|---|---|
| `CacheTab.tsx` | 274 | OK (126 headroom) |
| `routes-cache.ts` | 246 | OK |
| `route-dispatch.ts` | 168 | OK |
| `server.ts` | 354 | OK (tight, 46 headroom) |
| `api-contracts/endpoints/registry.ts` | **496** | **OVER — extend `registry-ext.ts` instead** |
| `api/client.ts` | **398** | **AT LIMIT — extend `client-extra.ts` instead** |

**New PMA endpoint definitions → `registry-ext.ts`; new fetch helpers → `client-extra.ts`.**

### 6.6 Route-dispatch pattern (3-touch for routes-analytics.ts)
1. Create `routes-analytics.ts` (mirror `routes-cache.ts`).
2. Re-export from `routes.ts` barrel.
3. Import into `route-dispatch.ts` + add `if (handleAnalytics(req, res, ctx)) return true;` to the `dispatchRoutes` chain.

---

## 7. Measurable-vs-N/A truth table (resolves spec §7)

| Metric | Decision | Seam |
|---|---|---|
| Provider identity | **MEASURABLE** | `ctx.model.provider` / `AssistantMessage.provider` |
| Model identity | **MEASURABLE** | `Model.id`/`.name`, `AssistantMessage.model`/`responseModel` |
| Tokens (in/out/cacheRead/cacheWrite) | **MEASURABLE** | `Usage` on `turn_end` (`pi-ai/types.d.ts:248-269`) |
| stopReason / status | **MEASURABLE** | `AssistantMessage.stopReason`; `after_provider_response.status` |
| End-to-end latency | **MEASURABLE** | `turn_start` → `turn_end` (already in `turn_latency_ms`) |
| Provider RTT | **MEASURABLE** | `before_provider_request` → `after_provider_response` (already `provider_latency_ms`) |
| **TTFT** | **MEASURABLE** (was N/A) | `message_update` `text_start` vs `before_provider_request` |
| TPS | **MEASURABLE** (estimated) | `usage.output / latency` (already `tps`; label "Estimated") |
| Concurrency | **MEASURABLE** (crash caveat) | `(sessionId, turnIndex)` start/terminal correlation |

**No metric is N/A.** Single residual: crash mid-turn → unterminated fact (handled as "incomplete").

---

## 8. PMA-1 readiness checklist (unblocked by this discovery)

- [ ] `analytics.db` at `<stateDir>/analytics.db`, own connection cache (mirror `turns`).
- [ ] Capability gates `AnalyticsReader`/`Writer`/`Admin` (mirror `turns/types.ts` + cortex `store.ts:120-170`).
- [ ] Schema: `analytics_schema`, `analytics_migrations`, `request_events`, `measurement_samples`, `identity_observations` + indexes (spec §6).
- [ ] Feature flag `MEGACOMPACT_PROVIDER_MODEL_ANALYTICS` (default ON) + dashboard Settings registration + `EXCLUDED_SETTINGS` path exclusion.
- [ ] Backfill source verified: `perf_samples WHERE kind='cache_hit_pct'`, `JSON_EXTRACT(meta,...)`.
- [ ] New endpoints → `registry-ext.ts`; new fetch helpers → `client-extra.ts`.
- [ ] `routes-analytics.ts` via the 3-touch dispatch pattern.
- [ ] TTFT adapter registers `message_update` (net-new seam).
- [ ] `useApi` extended with `staleAfterMs` + visibility-aware pause (or SSE for Live).

---

**Authored:** 2026-08-11 · **Evidence:** all claims cite file:line (verified in source + `node_modules/@earendil-works/{pi-coding-agent,pi-ai,pi-agent-core}/dist/`) · **Gate:** read-only; baseline builds clean.
