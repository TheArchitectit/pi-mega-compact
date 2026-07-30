# Prompt Cache + Memory Program — Multi-Sprint Spec (S53–S55)

**Date:** 2026-07-29
**Owner:** pi-mega-compact
**Status:** IN PROGRESS — S53A (provider cache visibility: `readProviderCacheStats`, `GET /api/provider-cache`, Cache tab Provider Prompt Cache card) and S53C-core (TUI `cachePct` source swap behind `MEGACOMPACT_TUI_CACHE_SOURCE`, `src/pricing.ts`) implemented 2026-07-29, gate green (872 tests). Supersedes `docs/PROMPTCACHE_PLAN_V2.md` Phases 2–4 (see [BRANCH_GAP_ANALYSIS](../BRANCH_GAP_ANALYSIS.md) §3.2 for the four blocking issues this spec corrects)
**Branch slots:** S53A/S53C on a `feature/promptcache-stats` follow-up; S53B on `feat/memory-system-enhancements` (currently an empty placeholder)
**Reuse target:** all aggregation/scoring logic lives in `src/` (pi-agnostic, sync, parameterized SQL); `extensions/` holds wiring only.

---

## 1. Problem Statement

1. **The dashboard Cache tab is empty in normal operation.** It renders only mega-compact's internal dedup cache (`/api/snapshot`), which reads zeros until compaction fires (threshold ≈ tier % of window). The provider prompt cache — the user's single biggest cost lever (cache reads ≈ 10% of input price; observed 60–98% hit rates in `perf_samples`) — is captured but displayed nowhere on that tab, and everywhere else only inside a ≤24 h rolling window.
2. **The TUI footer cache % is mislabeled**: `mega-runtime/snapshot.ts:180` sets `cachePct = st.dedupHitRate * 100` (internal dedup rate), not the provider cache hit rate.
3. **No lifetime/token aggregates**: `/api/perf` returns `{avg, latest, n}` over a rolling window. There is no total `cacheRead` / `cacheWrite` / `input`, no per-model breakdown, no "$ saved by caching".
4. **Memory effectiveness is invisible** and `feat/memory-system-enhancements` shipped **zero commits**: memory is stored and recalled, but there is no recall hit-rate, stability, or promotion signal surfaced anywhere — so memory cannot feed prompt-cache stability.
5. **No prefix-stability telemetry**: we cannot say *why* hit rate is 56% instead of 85%+ (tool-result insertion, epoch re-compaction, recall injection position) because no boundary-prefix hash is recorded.

## 2. Why a program (not one sprint)

| Sprint | Capability | Depends on | Risk profile |
| ------ | ---------- | ---------- | ------------- |
| **S53A — Provider cache visibility** | Lifetime + per-model provider cache aggregates → API → Cache tab | none | read-only queries + UI; zero runtime behavior change |
| **S53B — Memory enhancements** (fills the empty branch) | Memory recall hit-rate/stability surfaced; embedding reuse for memory ops | S53A (shares aggregate-query pattern) | read-only + flags |
| **S53C — TUI + cost accounting** | `cachePct` source swap, per-turn TUI cache line, pricing module, "$ saved" | S53A | widget-only; pricing is pure math |
| **S54 — Prefix-stability telemetry** | Boundary-prefix hashing over `raw_transcript`; break-cause classification; dashboard readout | none (parallel with S53) | measurement only; no prompt surgery |
| **S55 — Cache-stable prompt layout** *(contingent on S54 data)* | Pair-atomic segment layout inside the LIVE trimmed view | S54 metrics proving the lever | touches the `context` event return — highest scrutiny |

Ship order: **S53A → S53C → S53B → S54**. S55 starts only if S54 shows prefix breaks from volatile insertion dominate (§7.2).

## 3. S53A — Provider Cache Visibility (P0)

### 3.1 Data path (all local; PREVENT-PI-004 unaffected)

```
turn_end → perf-handler (already captures cache_hit_pct + meta{input,cacheRead,cacheWrite})
        → perf_samples(kind,value,meta,ts)            [exists]
        → readProviderCacheStats()  NEW in src/store/sqlite/perf-samples.ts
        → GET /api/provider-cache   NEW in extensions/dashboard-server/routes-cache.ts (new file)
        → api-client fetchProviderCacheStats() NEW
        → CacheTab "Provider Prompt Cache" card + CacheStatusPerModel columns + SavingsByModel columns
```

### 3.2 `readProviderCacheStats(stateDir?, sinceTs?)` — `src/store/sqlite/perf-samples.ts` (125 lines today; grows ~60)

Scan `kind='cache_hit_pct'` rows (no time window by default); `meta` is JSON — **parse with null check** (PREVENT-001). Return:

```ts
export interface ProviderCacheStats {
  readonly sampleCount: number;
  readonly totalInput: number;        // Σ meta.input
  readonly totalCacheRead: number;    // Σ meta.cacheRead
  readonly totalCacheWrite: number;   // Σ meta.cacheWrite
  readonly avgHitPct: number;         // Σ value / n  (value already 0–100)
  readonly latestHitPct: number;      // value of max(ts) row
  readonly oldestTs: number | null;
  readonly newestTs: number | null;
}
```

Per-model variant `readProviderCacheStatsByModel(stateDir?)`: joins nothing — model is **not** in `perf_samples` today. S53A adds an optional `model` column? **No** — schema change deferred (§8, Q3). S53A groups by nothing; per-model arrives with S53C pricing by re-deriving model from the turn rows the dashboard already has.

Query stays parameterized; no string concatenation (PREVENT-002). FTS/FTS5 not involved. Linear scan is fine — same scale argument as vector store.

### 3.3 `GET /api/provider-cache` — new `extensions/dashboard-server/routes-cache.ts`

- `routes-game.ts` is at 385 lines (400 soft cap) → new file, registered beside it, same `POST→405` / loopback posture as `handlePerf`. Query params: `minutes` (optional; omit = all-time).
- Contract: add `api-contracts/cache.ts` (`ProviderCacheStatsResponse` + `EndpointDef` entry) — `endpoints.ts` is at 556 lines (over hard cap), do not grow it. Re-export from the `api-contracts/index.ts` barrel; extend `api-contracts.test.ts` field assertions.
- Response = `ProviderCacheStats` + `windowMinutes: null | number`.

### 3.4 Client

- `api/client.ts`: `fetchProviderCacheStats(minutes?)`.
- `tabs/CacheTab.tsx`: keep dedup card, add **Provider Prompt Cache** card on top: Avg hit % / Latest hit % / Tokens read from cache / Tokens written / Total input / Window label ("all-time" or "last N min"). Loading/empty states mirror existing `tab-stub` pattern.
- `CacheHitsCard.tsx`: unchanged (dedup). New `ProviderCacheCard.tsx`.
- `SavingsByModelTable.tsx` + `CacheStatusPerModel.tsx`: add Cache Read / Cache Write / Hit % columns fed from the same fetch (S53C adds the $ column).

### 3.5 Acceptance

- `readProviderCacheStats` unit tests: empty table → zeros; meta null/garbage → skipped rows; window filter; totals math.
- Contract test: response shape asserted; 405 on POST.
- Client smoke: CacheTab renders provider card with fixture data; dedup card unchanged (byte-identical props path).
- Gate: build + test + lint + regression_check green; guardrails-scan green.

## 4. S53C — TUI + Cost Accounting

1. **Source swap** — `mega-runtime/snapshot.ts:180`: `cachePct` reads the latest `cache_hit_pct` sample (last-value cache refreshed by perf-handler cadence, **not** a new DB read in the hot path), falling back to `dedupHitRate` when no provider samples exist. Flag `MEGACOMPACT_TUI_CACHE_SOURCE=dedup|provider` (default `provider`; env-OFF restores old behavior byte-identically per feature-flag rule).
2. **Per-turn TUI line** (game/modeline): `↓ 41.0K cache · 96.0% · +939 new` from the same last-value cache.
3. **Pricing** — new `src/pricing.ts` (~80 lines, pure): per-model `{input, output, cacheReadMult: 0.1, cacheWriteMult: 1.25}` constants for the Anthropic + OpenRouter families pi actually serves; `MEGACOMPACT_PRICING_JSON` (path to JSON) overrides. `estimateSavings(stats, model)`:
   `withoutCache = totalInput * rate`;
   `withCache = (totalInput − totalCacheRead) * rate + totalCacheRead * rate * 0.1 + totalCacheWrite * rate * 1.25`;
   `saved = withoutCache − withCache` (floor 0). Unknown model → `null` and UI keeps "—" (no invented numbers).
4. Dashboard "$ Saved" columns consume §3 + §4.3; widget game `megaCacheFlare` semantics unchanged (still dedup-driven) — documented in widget header to avoid re-confusing the two caches.

## 5. S53B — Memory Enhancements (fills `feat/memory-system-enhancements`)

Scope kept deliberately tight; reuses S44's latent design where possible.

1. **Memory effectiveness aggregates** — `src/memoryStats.ts` (new, ~100 lines): recall events with source=`memory` from `turn_recall` (S48) → per-repo **memory recall count, distinct memories recalled, avg score, injected-vs-ignored ratio** (join `markInjectedGlobal`). Served at `GET /api/memory-status`; extend `MemoryStatusCard` to render them.
2. **Memory stability score**(feeds S54/S55 and wiki ranking): per memory `stability = 0.5*recallFrequency(30d) + 0.3*recency + 0.2*avgScore`; persisted as a **derived** view (query-time, no new table) behind `MEGACOMPACT_MEMORY_STABILITY=1` default ON.
3. **Embedding reuse for memory ops** — in-process `Map<contentHash, embedding>` LRU (256 entries) in `src/embedder.ts` wrapper for TrigramEmbedder (deterministic → cache is exact); cuts re-embedding cost on consolidate/review cycles. No PGlite dependency; pure `src/`.
4. **Wiki/Topics tab** surfaces stability column (S51 UI exists).

Non-goals for S53B: memory editing UI, cross-repo memory promotion policy, LLM-authored wiki text.

## 6. S54 — Prefix-Stability Telemetry (measurement only)

Goal: decide S55 with data, not vibes.

1. **Boundary-prefix hash** — in the `context` event (handler already computes `view`): hash the ordered `content_hash` chain (S27 `raw_transcript` already stores per-message `content_hash` + `seq`) at breakpoints `[systemPrepend, summary, stable-prefix end]`; on change vs previous sample, classify: `epoch-change` | `tool-insertion` | `recall-injection` | `other`. Record `perf_samples(kind='cache_prefix_break', value=breakPositionTokens, meta={cause, epochId})`. Flag `MEGACOMPACT_PREFIX_TELEMETRY=1` default ON; OFF removes >handful of branch instructions — OFF path byte-identical.
2. **Readout** — extend `/api/provider-cache` with `prefixBreaks: {cause, count}[]` (same routes-cache.ts file).
3. **Acceptance** — unit: synthetic hash-chain fixtures per cause; handler-level: break logged exactly once per boundary change; zero-log steady state.

## 7. S55 — Cache-Stable Prompt Layout (contingent)

### 7.1 Hard constraints (non-negotiable, scanner-enforced)

- **PREVENT-PI-002**: `tool_use`/`tool_result` pairs are atomic segments; layout code may only reorder **whole segments**, never split a pair, never move a `tool_result` away from its `tool_use`.
- **PREVENT-PI-001**: anchor floor (recent N messages) is never reordered/dropped.
- **PREVENT-PI-003**: summary stays where S16/v0.8.6 trimCache puts it; system-prompt prepend untouched.
- Only the **LIVE trimmed view** returned from the `context` event (`context-handler.ts:487` path and `:255` replay path) may be re-laid-out; the durable transcript pi owns is never rewritten.
- Flat-array fallback on any scoring failure (PLAN_V2 open Q1 — adopted).

### 7.2 Entry criteria (from S54)

Start only if `cache_prefix_break` attributes ≥40% of breaks to `tool-insertion`/`recall-injection` over a 7-day sample. If `epoch-change` dominates, fix epoch churn instead (S27 sentinel stability), do not build S55.

### 7.3 Design (replaces PLAN_V2 Phase 2/3)

- **No new message tables** (gap-doc issue #2). Sources: `raw_transcript` (segments + hashes + tool linkage), `turns`/`turn_recall` (per-turn), `context_chunks` (recall injections).
- **Segment classifier** `src/prompt/segments.ts`: walk view → `[stable* , anchor]` segment list; stable = every complete segment older than anchor floor whose `content_hash` chain was present in the previous sample (S54 gives us this diff cheaply).
- **Deterministic ordering** for recall injections: sort injected checkpoint/memory blocks by `(source, checkpointId)` and pin them to one fixed slot before the thread tail — removes recall-position churn, which needs no pair-unsafe moves at all and ships first as S55a.
- **Stability score** (from PLAN_V2, corrected): computed over **segments**, not chunks; reuses S53B memory stability for memory segments; pgvector HNSW used only for *topic-shift detection* (existing Slice-2 index), not for hot-path ordering.
- `cache_stripes` table is **dropped**; assignments derive from telemetry + hashes at view-build time (stateless, no migration).

## 8. Open Questions

1. `perf_samples` has no `repo_id`/`session_id` column → provider cache aggregates are machine-wide. Add nullable `repo_id` with backfill, or keep machine-wide for S53 and per-repo later? **Proposed:** machine-wide in S53; column add is a one-line migrations follow-up if the per-repo ask materializes.
2. Is 30-min `/api/perf` window plus all-time `/api/provider-cache` the right split, or should `/api/perf` grow `minutes=all`? **Proposed:** separate endpoint (window semantics stay honest; contract grows additively).
3. Pricing source-of-truth: hardcoded table vs pi's own model registry (pi exposes pricing for the active model — `CacheStatusPerModel` already receives rates). **Proposed:** prefer pi-provided rates at runtime; `src/pricing.ts` constants only as fallback table for historical models.
4. Cache-write cost: observed `cacheWrite=0` across 43 samples — confirm pi's adapters actually request caching ( breakpoints live in pi's provider layer, not the extension). S53C surfaces it; enabling writes is out of extension reach (pi-side).

## 9. Gates & Flags

- Every sub-sprint exit: `npm run build` + `npm test` + `npm run lint` + `python3 scripts/regression_check.py --all` + guardrails-scan + semantic-scan green (standing gate).
- Flags: `MEGACOMPACT_TUI_CACHE_SOURCE` (S53C), `MEGACOMPACT_MEMORY_STABILITY` (S53B), `MEGACOMPACT_PREFIX_TELEMETRY` (S54) — default ON, env OFF, OFF ≡ byte-identical pre-sprint behavior.
- Structured logging only (`src/log.ts`); no `console.log` in `src/`; no `any` (PREVENT-011); all SQL parameterized (PREVENT-002); all `JSON.parse` null-checked (PREVENT-001).
- `extensions/dashboard-server/routes-*` additions carry the standard `// guardrails-allow PREVENT-PI-004: <reason>` loopback annotations.

## 10. References

- [docs/PROMPTCACHE_FINDINGS.md](../PROMPTCACHE_FINDINGS.md), [PROMPTCACHE_FULL_GAP_ANALYSIS.md](../PROMPTCACHE_FULL_GAP_ANALYSIS.md) (branch `feature/promptcache-stats`, commit `b9a9519`)
- [docs/PROMPTCACHE_PLAN_V2.md](../PROMPTCACHE_PLAN_V2.md) — superseded in part; §3.1 of BRANCH_GAP_ANALYSIS lists corrections
- [docs/BRANCH_GAP_ANALYSIS.md](../BRANCH_GAP_ANALYSIS.md)
- [specs/s44-three-tier-latency-routing.md](s44-three-tier-latency-routing.md) (L0 cache + embedding-cache design reused by S53B)
- [specs/s49-program-per-turn-memory-platform.md](s49-program-per-turn-memory-platform.md) (turn_recall provenance used by S53B/S54)
- [specs/sprint-27-db-mirror-cache-stability.md](sprint-27-db-mirror-cache-stability.md) (raw_transcript content_hash + epoch sentinel)
