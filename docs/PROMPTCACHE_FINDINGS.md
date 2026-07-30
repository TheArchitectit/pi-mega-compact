# Prompt Cache Stats — Bug Investigation

**Date**: 2026-07-29  
**Branch**: `feature/promptcache-stats`

## Problem

The Cache tab in the dashboard shows all zeros for provider prompt cache stats, even though the data IS being captured correctly.

## Root Cause

1. **Data IS captured**: 43 `cache_hit_pct` samples in `perf_samples` table with `cacheRead`/`cacheWrite`/`input` per turn (60-98% hit rates).

2. **Cache tab reads wrong source**: `CacheTab.tsx` reads from `/api/snapshot` which returns mega-compact's **dedup/compaction stats** (not provider cache). These are 0 because no compaction has fired (context at 20.7%, below 50% threshold).

3. **`/api/perf` exists but has 30-min rolling window**: The perf endpoint returns 0 because the latest cache_hit_pct sample is ~68 minutes old, outside the window.

## Provider Cache Data (proof it's working)

```sql
-- 43 samples with 60-98% cache hit rates
SELECT ts, value, meta FROM perf_samples WHERE kind='cache_hit_pct' ORDER BY ts DESC LIMIT 3;

-- Latest samples:
-- 1785369041484 | 60.34% | {"input":16282,"cacheRead":24768,"cacheWrite":0}
-- 1785369031211 | 60.16% | {"input":16277,"cacheRead":24576,"cacheWrite":0}
-- 1785369024391 | 97.76% | {"input":939,"cacheRead":41024,"cacheWrite":0}
```

## Fix Plan

1. **Add `readProviderCacheStats()`** to `src/store/sqlite/perf-samples.ts`
   - Aggregate ALL `cache_hit_pct` samples (no time window filter)
   - Return: total `cacheRead`, `cacheWrite`, `input`, count, avg hit %

2. **Add `/api/cache-stats` endpoint** in `extensions/dashboard-server/routes-game.ts`
   - Call `readProviderCacheStats()` and return aggregate stats

3. **Add contract type** `ProviderCacheStatsResponse` in `extensions/dashboard-server/api-contracts/`

4. **Update `CacheTab.tsx`** to fetch from `/api/cache-stats` and display provider cache stats alongside existing dedup stats

5. **Update `CacheHitsCard.tsx`** to show provider cache fields:
   - Provider Cache Hit % (avg)
   - Tokens Read from Cache (total)
   - Tokens Written to Cache (total)
   - Total Input Tokens

## Files to Modify

- `src/store/sqlite/perf-samples.ts` — add `readProviderCacheStats()`
- `extensions/dashboard-server/routes-game.ts` — add `/api/cache-stats` handler
- `extensions/dashboard-server/api-contracts/endpoints.ts` — add endpoint + types
- `extensions/dashboard-client/src/api/client.ts` — add `fetchProviderCacheStats()`
- `extensions/dashboard-client/src/tabs/CacheTab.tsx` — fetch + display provider cache
- `extensions/dashboard-client/src/components/CacheHitsCard.tsx` — add provider cache fields
