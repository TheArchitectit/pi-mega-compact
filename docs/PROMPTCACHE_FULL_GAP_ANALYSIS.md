# Prompt Cache Stats — Full Gap Analysis

**Date**: 2026-07-29
**Branch**: `feature/promptcache-stats`

---

## 1. Executive Summary

Provider prompt caching is **the single biggest cost/latency lever** for long-running coding agents. Anthropic's pricing: cache reads cost **10% of full input**, cache writes cost **125%**. For a typical session with 80% cache hit rate, that's **~72% input cost reduction**.

pi-megacompact already captures the raw data (43 samples, 60-99% hit rates) but **never displays it**. The dashboard shows mega-compact's own dedup cache (287 hits), not the provider's prompt cache. Every competitor now surfaces this.

---

## 2. Competitive Landscape

### Tier 1: Native IDE/Agent Tools

| Tool | Cache Visibility | Metrics Shown | Where |
| ------ | ----------------- | --------------- | ------- |
| **Claude Code** | ✅ Full | Cache read/write tokens per turn, hit rate %, cache creation indicator (↓), cost savings | `/usage` command, terminal footer |
| **VS Code Copilot** | ✅ Full | Per-turn cache read/write tokens, diff highlighting of cacheable vs non-cacheable prefix | Cache Explorer panel (Agent Debug Logs) |
| **Cursor** | ✅ Basic | Usage events with token breakdown, cost per model | Settings → Usage, web dashboard |
| **GitHub Copilot** | ✅ Basic | Token usage per model | VS Code status bar |

### Tier 2: CLI/Agent Tools

| Tool | Cache Visibility | Metrics Shown | Where |
| ------ | ----------------- | --------------- | ------- |
| **Aider** | ⚠️ Conditional | Cache create/read tokens per turn (requires `--no-stream`) | Terminal output after each turn |
| **Cline** | ⚠️ Limited | Token counts per request | Extension logs |
| **Continue** | ❌ None | No cache-specific metrics | — |
| **Roo Code** | ⚠️ Limited | Token usage | Status bar |

### Tier 3: Dashboards/Observability

| Tool | Cache Visibility | Metrics Shown | Where |
| ------ | ----------------- | --------------- | ------- |
| **LangSmith** | ✅ Full | Cache hit rate, read/write tokens, cost per trace | Trace detail view |
| **Helicone** | ✅ Full | Cache hit %, cache savings $, read/write breakdown | Dashboard + API |
| **Portkey** | ✅ Full | Cache analytics, hit rate trends, cost savings | Analytics panel |
| **LiteLLM** | ✅ Full | Cache hit rate, latency savings, cost reduction | Proxy dashboard |

### VS Code Cache Explorer (Gold Standard)

The VS Code Cache Explorer shows:

- **Side-by-side diff** of consecutive requests
- **Cacheable prefix** (green) vs **new content** (red)
- **Per-turn**: cache read tokens, cache write tokens, new input tokens
- **Cache hit rate** as a percentage
- **Guidance**: "If cacheable prefix is smaller than expected, consider reordering content"

This is the diagnostic gold standard — it helps users **optimize** their cache usage, not just observe it.

---

## 3. What We Have (Existing Infrastructure)

### 3.1 Capture Layer ✅ Working

**File**: `extensions/perf-handler.ts`

```typescript
// Already extracts from provider usage:
cacheRead: usage.cacheReadTokens ?? 0,
cacheWrite: usage.cacheWriteTokens ?? 0,
input: usage.inputTokens ?? usage.totalTokens ?? 0,
// Stores as cache_hit_pct with meta {input, cacheRead, cacheWrite}
```

**Proof**: 43 samples in `perf_samples` table:

- Total cacheRead: 850,886 tokens
- Total cacheWrite: 0 tokens
- Total input: 559,217 tokens
- Hit rate: 55.95% avg (range: 0% – 99.96%)

### 3.2 Storage Layer ✅ Working

**File**: `src/store/sqlite/perf-samples.ts`

- `perf_samples` table with `kind`, `value`, `meta` (JSON), `ts`
- `readPerfSamples(kind, since?, stateDir?)` query function works

### 3.3 API Layer ⚠️ Partial

**File**: `extensions/dashboard-server/routes-game.ts`

- `/api/perf` endpoint exists with rolling window (default 30 min)
- Returns aggregated `cache_hit_pct` with `avg`, `latest`, `min`, `max`, `n`
- **Missing**: No aggregate endpoint for total/lifetime stats
- **Missing**: No raw token count totals (cacheRead/cacheWrite/input)

### 3.4 Dashboard Client ❌ Not Connected

**File**: `extensions/dashboard-client/src/tabs/CacheTab.tsx`

- Reads from `/api/snapshot` only (mega-compact dedup stats)
- Shows: dedup hits (287), dedup tokens saved (38.5M)
- **Missing**: Provider prompt cache hit rate
- **Missing**: Provider cache read/write token counts
- **Missing**: Provider cache cost savings

### 3.5 TUI Widget ❌ Wrong Source

**File**: `extensions/mega-runtime/snapshot.ts`

```typescript
// Currently:
const cachePct = st.dedupHitRate * 100;  // ← dedup hit rate, NOT provider cache

// Should be:
const cachePct = providerCacheAvgHitPct;  // ← from perf_samples
```

- `cachePct` in WidgetData is populated from `st.dedupHitRate` (mega-compact's own dedup)
- `megaCacheFlare` fires at 100%+ but checks dedup rate, not provider cache
- **Fix**: Read from `perf_samples.cache_hit_pct` or a new aggregate query

### 3.6 Dashboard "Active Repos" Section

Current display:

```
Cache Hits (s/t): 0 / 287        ← mega-compact dedup hits, NOT provider cache
CacheHit s/t (s): 0ms / 28.7s    ← time saved from dedup, NOT provider cache
```

**Missing**: Provider cache columns:

- Provider Cache Hit % (avg)
- Provider Cache Read Tokens (total)
- Provider Cache Write Tokens (total)
- Provider Cache $ Saved (estimated)

### 3.7 "Savings by Model" Section

Current display:

```
Model       Tokens In    Tokens Out    Freed     $ Saved
claude-...  721,970      1,459         720,511   —
```

**Missing**: Provider cache columns:

- Cache Read Tokens
- Cache Write Tokens
- Cache Hit %
- Cache $ Saved (calculated from read/write token pricing)

---

## 4. What Competitors Show That We Don't

### 4.1 Per-Turn Visibility (Claude Code, VS Code Cache Explorer)

| Metric | Claude Code | VS Code Cache Explorer | pi-megacompact |
| -------- | ------------- | ---------------------- | ---------------- |
| Cache read tokens per turn | ✅ | ✅ | ❌ Not displayed |
| Cache write tokens per turn | ✅ | ✅ | ❌ Not displayed |
| Cache hit rate per turn | ✅ | ✅ | ❌ Not displayed |
| Cache creation indicator | ✅ (↓ icon) | ✅ (color-coded) | ❌ |
| Cacheable prefix diff | ❌ | ✅ Side-by-side diff | ❌ |
| Cumulative session savings | ✅ In `/usage` | ✅ In summary | ❌ |

### 4.2 Aggregate/Session-Level (Dashboards)

| Metric | Helicone/LangSmith | pi-megacompact Dashboard |
| -------- | ------------------- | ------------------------- |
| Total cache read tokens | ✅ | ❌ |
| Total cache write tokens | ✅ | ❌ |
| Cache hit rate (avg/trend) | ✅ | ❌ |
| Cost with caching | ✅ | ❌ Shows — for $ columns |
| Cost without caching (hypothetical) | ✅ | ❌ |
| $ saved from caching | ✅ | ❌ |
| Cache hit rate over time (chart) | ✅ | ❌ |

### 4.3 Optimization Guidance (VS Code Cache Explorer)

| Feature | VS Code | pi-megacompact |
| --------- | --------- | ---------------- |
| Identify cache-unfriendly patterns | ✅ Diff view | ❌ |
| Suggest reordering for better cache | ✅ | ❌ |
| Show which content breaks cache | ✅ | ❌ |

---

## 5. Specific Gaps (Prioritized)

### P0: Data Already Captured, Just Not Displayed

| Gap | Impact | Effort |
| ----- | -------- | -------- |
| Dashboard CacheTab doesn't show provider cache | Users can't see their #1 cost lever | Low — data exists in perf_samples |
| TUI `cachePct` uses dedup rate instead of provider cache | Misleading metric in footer widget | Low — swap data source |
| $ Saved column shows "—" everywhere | No cost visibility at all | Medium — need pricing constants |
| Active Repos has no provider cache columns | Can't compare cache effectiveness across repos | Medium — need per-repo aggregation |

### P1: Missing Aggregation/Query Layer

| Gap | Impact | Effort |
| ----- | -------- | -------- |
| No aggregate query for total provider cache stats | API can't serve totals | Low — add readProviderCacheStats() |
| No per-model provider cache breakdown | Can't see which model benefits most | Medium — group by model |
| No per-repo provider cache isolation | All repos share one perf_samples table | Medium — filter by repo_id |

### P2: Missing Diagnostic Features

| Gap | Impact | Effort |
| ----- | -------- | -------- |
| No per-turn cache visibility in TUI | Can't diagnose cache misses in real-time | Medium — need turn-level capture |
| No cache-friendly prompt ordering guidance | Users can't optimize their workflow | High — needs analysis logic |
| No cache trend chart | Can't see if cache health is improving | Medium — need chart component |
| No hypothetical cost comparison | Can't see "what if no cache" savings | Low — calculation only |

### P3: Advanced/Differentiation

| Gap | Impact | Effort |
| ----- | -------- | -------- |
| No cache prefix diff view (VS Code style) | Can't see exactly what's cached vs new | High — needs prompt diffing |
| No cache-aware compaction optimization | Compaction may break cache prefix | High — architectural |
| No cache warming strategies | Cold starts waste cache writes | High — needs prefix analysis |
| No alerting on cache degradation | Users don't know when cache health drops | Medium — threshold alerts |

---

## 6. Recommended Implementation Plan

### Phase 1: Display What We Have (1-2 days)

1. **`src/store/sqlite/perf-samples.ts`**: Add `readProviderCacheStats(stateDir?)`
   - Aggregate ALL `cache_hit_pct` samples: total cacheRead, cacheWrite, input, count, avgHitPct
   - Return `{ totalCacheRead, totalCacheWrite, totalInput, sampleCount, avgHitPct, latestHitPct }`

2. **`extensions/dashboard-server/routes-game.ts`**: Add `/api/provider-cache`
   - Call `readProviderCacheStats()` and return aggregated stats

3. **`extensions/dashboard-client/src/tabs/CacheTab.tsx`**: Fetch + display
   - Add "Provider Prompt Cache" section above existing dedup stats
   - Show: Hit Rate %, Cache Read Tokens, Cache Write Tokens, Total Input

4. **`extensions/mega-runtime/snapshot.ts`**: Fix `cachePct`
   - Read from perf_samples instead of `st.dedupHitRate`

5. **Dashboard "Savings by Model"**: Add cache columns
   - Cache Read Tokens, Cache Write Tokens, Cache Hit %

### Phase 2: Cost Calculations (1 day)

1. **Add pricing constants** (`src/config.ts` or new `src/pricing.ts`):
   - Anthropic: cache read = 10% of input, cache write = 125% of input
   - Per-model rates (Sonnet, Opus, Haiku)

2. **Calculate $ Saved**:
   - `hypotheticalCost = totalInput * fullInputRate`
   - `actualCost = (totalInput - totalCacheRead) * fullInputRate + totalCacheRead * cachedRate`
   - `saved = hypotheticalCost - actualCost`

3. **Display in dashboard**: Replace "—" with calculated values

### Phase 3: Per-Turn Visibility (2-3 days)

1. **TUI widget**: Show per-turn cache stats in a new line
   - `↓ 41K cached (98%) | 939 new` format

2. **Dashboard**: Add per-turn table/chart
    - Turn number, cache read, cache write, new input, hit %

### Phase 4: Optimization Guidance (1 week)

1. **Cache health scoring**: Rate cache effectiveness per session
2. **Trend chart**: Cache hit rate over time
3. **Alerting**: Warn when cache health drops below threshold
4. **Prefix analysis**: Identify what's breaking cache (future)

---

## 7. Key Metrics to Surface

### Must-Have (Phase 1)

| Metric | Source | Display Location |
| -------- | -------- | ----------------- |
| Provider Cache Hit % (avg) | perf_samples | CacheTab, TUI footer, Active Repos |
| Cache Read Tokens (total) | perf_samples | CacheTab, Savings by Model |
| Cache Write Tokens (total) | perf_samples | CacheTab, Savings by Model |
| New Input Tokens (total) | perf_samples | CacheTab, Savings by Model |

### Should-Have (Phase 2)

| Metric | Source | Display Location |
| -------- | -------- | ----------------- |
| $ Saved from Caching | Calculated | CacheTab, Savings by Model |
| Hypothetical Cost (no cache) | Calculated | CacheTab |
| Actual Cost (with cache) | Calculated | CacheTab |
| Cache Hit Rate Trend | perf_samples over time | CacheTab chart |

### Nice-to-Have (Phase 3+)

| Metric | Source | Display Location |
| -------- | -------- | ----------------- |
| Per-turn cache breakdown | perf_samples per turn | TUI widget, CacheTab table |
| Cache-friendly score | Analysis | Dashboard |
| Prefix stability indicator | Prompt diffing | CacheTab, TUI |

---

## 8. Cost Impact Estimate

Based on current data (43 samples):

- Total input: 559,217 tokens
- Total cache read: 850,886 tokens
- Cache hit rate: ~60%

**Estimated savings** (using Claude Sonnet pricing):

- Full input rate: $3/MTok
- Cache read rate: $0.30/MTok (10%)
- Without cache: 559,217 × $3/MTok = $1.68
- With cache: (559,217 - 850,886 × 0.6) × $3 + 850,886 × 0.6 × $0.30 = ~$0.50
- **Savings: ~$1.18 per session (~70% reduction)**

Over a full day of coding (20+ sessions), this compounds to significant savings.

---

## 9. Summary

| Category | We Have | Competitors Have | Gap |
| ---------- | --------- | ----------------- | ----- |
| Data capture | ✅ Full | ✅ Full | None |
| Data storage | ✅ Full | ✅ Full | None |
| API endpoint | ⚠️ Partial | ✅ Full | Aggregate endpoint |
| Dashboard display | ❌ Missing | ✅ Full | All provider cache metrics |
| TUI display | ❌ Wrong source | ✅ Basic | Need to swap data source |
| Cost calculation | ❌ Missing | ✅ Full | Pricing constants + math |
| Per-turn visibility | ❌ Missing | ✅ Claude Code, VS Code | Turn-level display |
| Optimization guidance | ❌ Missing | ✅ VS Code Cache Explorer | Diagnostic features |

**Bottom line**: We're sitting on gold (43 samples of real provider cache data) but displaying dirt (dedup stats that show 0/287). Phase 1 is a 1-2 day fix that puts us on par with Helicone/LangSmith-level visibility.
