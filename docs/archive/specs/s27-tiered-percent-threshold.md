# Tiered % compaction threshold (scale with model context window)

**Date:** 2026-07-17
**Focus:** make the compaction fire point a % of the model context window (not a static token amount) so live + durable trim fire BELOW pi's native ~80% auto-compaction for any model size (200k or 1M).
**Priority:** P1
**Effort:** M (multi-file: config + runtime + events + dashboard display)
**Status:** COMPLETE — implementation verified in working tree (tsc/build/guardrails green); docs authored by adaptive-05-writer.
**Depends on:** S24 (unified `pressure` signal), `pressureFromPct`/`pressureRatio` in `src/config.ts`.

---

## SAFETY PROTOCOLS

- PREVENT-PI-004: zero network at runtime. No new fetch/HTTP; the change is pure math over `ctx.getContextUsage()` (tokens/percent/contextWindow). Guardrails-scan must stay green.
- PREVENT-PI-002: never split a toolCall/toolResult pair at a compaction boundary. `effectiveThreshold` only changes WHEN the trim fires; the cut/anchor logic (`computeLiveTrimCut`, `computeDropRange`) is untouched.
- PREVENT-PI-003: recall still injects via `before_agent_start` systemPrompt prepend, never `role:"system"`. No recall change here.
- Verify gate (per commit): `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all` all green.
- NO FORCE PUSH; branch + PR only (user-permission gate for push).

---

## PROBLEM STATEMENT

The compaction threshold was a **static token amount** frozen at boot (`loadConfig()`): `low:50k, medium:100k, high:200k, ultra:1M, mega:10M`. That does not scale with the model's context window, so the live trim + durable trigger fire at the wrong point for every model that isn't exactly the size the preset was tuned for:

1. **200k-window model, `high` (200k).** `200k == 100%` of the window, so our trim only fires AT the limit — but pi's native auto-compaction fires at **~80% (160k)**. Result: pi's native compaction always wins; our live + durable trim are dead code for that model (the session never reaches 200k before pi trims at 160k).
2. **1M-window model, `high` (200k).** `200k == 20%` of the window — our trim fires far too early (over-aggressive). And `mega` (10M) is **larger than the window**, so it never fires at all. Static presets are wrong in BOTH directions depending on model size.

**Root cause:** the fire point is a static token amount (`config.thresholdTokens`, resolved once at `loadConfig()`) that never references the live `contextWindow`. So "high" means 200k whether the window is 200k or 1M. The BACKLOG finding "thresholdTokens fixed at boot" + the dual-basis pressure flicker (see `docs/specs/find-pressure-basis-oscillation.md`) share this root: the threshold was frozen and the band was computed against it on a moving basis.

**Intended behavior:** the compaction fire point should be `tierPct × contextWindow` — a **% of the model's context window** — so it always lands BELOW pi's native ~80% auto-compaction, for any window size:

- 200k window: low=100k (50%), high/ultra=140k (70%), mega=150k (75%) — all < pi native 160k.
- 1M window: low=500k (50%), high/ultra=700k (70%), mega=750k (75%) — all < pi native 800k.
- `custom` (explicit `MEGACOMPACT_THRESHOLD_TOKENS`) stays an **absolute** token count, never percent-scaled.

---

## SCOPE BOUNDARY

**IN SCOPE:**

- `mega-config.ts`: add `TIER_PCT` (fraction map), `MegaConfig.tierPct`, route threshold resolution through `effectiveThresholdTokens(...)`, default `fastGatePct` to `tierPct*100`.
- `mega-runtime.ts`: `effectiveThreshold` getter (fire point = `tierPct × window`), reconcile the `pressure` getter to a single percentage basis, emit `tierPct`/`effectiveThresholdPct` in the snapshot `armed`/`ready`/`config`/`trigger`.
- `mega-events.ts`: FAST GATE, `autoCompactCheck`, and `agent_end` durable-trigger must compare against `runtime.effectiveThreshold` (not the boot `config.thresholdTokens`).
- `mega-dashboard.ts`: add `tierPct`/`effectiveThresholdPct` to the `config` + `trigger` snapshot shapes.
- `dashboard-server.ts` + `mega-commands.ts`: display the effective threshold as `tokens (NN% of <window>)`.

**OUT OF SCOPE (do NOT touch):**

- The Trident pipeline (`compactSession`, `engine.ts`, `extractive.ts`, `supersede.ts`, `boundary.ts`) — cut/anchor logic unchanged.
- Dedup tiers (L0/L1/L2/RAPTOR) and the dedup config (`src/config/dedup.ts`).
- Recall/auto-inline (`recall.ts`, `memoryRecall.ts`) — PREVENT-PI-003 path untouched.
- The S24 `pressureFromPct`/`pressureRatio`/`pressureBand`/`memoryReviewCadence` math in `src/config.ts` — reused as-is.
- `preserveRecent`/`anchorUserMessages` defaults and the legacy `MEGACOMPACT_LEGACY_DURABLE_TRIM` path.

---

## EXECUTION

### `mega-config.ts` — percent map + pure fire-point helper

- Add `TIER_PCT: Record<CompactTier, number>` = `{ low:0.5, medium:0.6, high:0.7, ultra:0.7, mega:0.75 }` (fraction of the model context window).
- `MegaConfig.tierPct: number | null` — the compaction threshold as a fraction of the window; `null` for `custom` (absolute token threshold).
- `resolveThreshold()` now returns `{ tier, tierPct, thresholdTokens }` where `thresholdTokens` is a **boot fallback** `Math.round(tierPct * 200_000)` — sane because 200k is the canonical window, and equal to the correct tiered % for a 200k model. `COMPACT_TIERS` is retained only as the valid-tier set (`raw in COMPACT_TIERS ? raw : "low"`) + historical token reference; the live fire point no longer reads its token values.
- New **pure** helper `effectiveThresholdTokens({ tierPct, fallbackThreshold, window, explicitThreshold? })`:
  - `tierPct == null` (custom) → `explicitThreshold ?? fallbackThreshold` (ABSOLUTE, never percent-scaled).
  - `tierPct != null && window > 0` → `Math.round(tierPct * window)` (THE fire point).
  - `tierPct != null && window <= 0` → `fallbackThreshold` (boot fallback; no window known yet).
  This is the single source of truth consumed by the runtime gates + pressure/armed/ready. Kept pure so it is trivially unit-testable without the pi runtime.
- `resolveFastGatePct(tierPct)` — defaults to `Math.round(tierPct * 100)` (the tier's %), falling back to `70` for `custom` (tierPct null); `MEGACOMPACT_FAST_GATE_PCT` still overrides.
- `loadConfig()` sets `tierPct` + `thresholdTokens` (boot fallback) from `resolveThreshold()`.

### `mega-runtime.ts` — fire point + reconciled pressure

- New getter `effectiveThreshold` → `effectiveThresholdTokens({ tierPct: config.tierPct, fallbackThreshold: config.thresholdTokens, window: this.lastCtxWindow })`. This is what the FAST GATE / `autoCompactCheck` / `agent_end` durable-trigger compare against.
- Reconcile the `pressure` getter (kills the dual-basis flicker): when `lastCtxWindow > 0 && config.tierPct != null && lastCtxPercent != null` → `pressureFromPct(lastCtxPercent / config.tierPct)` (i.e. `lastCtxPercent / (tierPct*100)`, the consistent percentage basis); falls back to the token-basis `pressureRatio(lastCtxTokens, config.thresholdTokens)` ONLY when the window is unknown (pre-first-context-event or `custom`). Always finite + in [0,1].
- `snapshot()`:
  - `effectiveThresholdPct = config.tierPct != null ? config.tierPct * 100 : null`.
  - `armed = lastCtxPercent != null && lastCtxPercent >= Math.max(effectiveThresholdPct ?? 0, config.fastGatePct)`.
  - `ready = armed && (lastCtxTokens ?? 0) >= effectiveThreshold`.
  - `config.thresholdTokens` / `trigger.thresholdTokens` are set to `effectiveThreshold` (live, window-scaled); `config`/`trigger` also emit `tierPct` + `effectiveThresholdPct`.

### `mega-events.ts` — gates key off `runtime.effectiveThreshold`

- Context handler **FAST GATE**: `if (currentTokens < runtime.effectiveThreshold) return;` (token-based at tier% of the window, not a static amount).
- `autoCompactCheck(currentTokens, runtime.effectiveThreshold)` — confirm the trimmed region is non-trivial before firing.
- `agent_end` durable-trigger: `overThreshold = (runtime.lastCtxTokens ?? 0) >= runtime.effectiveThreshold`.
- (Informational only — two diagnostic `logger.info` lines at `agent-end-idle` / `agent-end-durable-trigger` still print `thresholdTokens: config.thresholdTokens`, the boot fallback. Not the gate; flagged for future alignment but out of strict scope.)

### `mega-dashboard.ts` — snapshot types

- `DashboardSnapshot.config`: add `tierPct: number | null` + `effectiveThresholdPct: number | null`.
- `DashboardSnapshot.trigger`: add `tierPct: number | null` + `effectiveThresholdPct: number | null`.

### `dashboard-server.ts` — display

- Seed fallback snapshot: add `tierPct: null, effectiveThresholdPct: null` to `config` + `trigger` (mirrors the live shape); add a zeroed `compression` field so the seed compiles against the current `Snapshot` interface.
- HTML config-card tooltips: clarify **Pressure** ("% of the model context window — threshold fires at the tier's % of window"), add **Threshold** ("tierPct × model context window — trims BELOW pi's native ~80% auto-compact"), clarify **Fast Gate** ("arming floor").
- `renderSnapshot` live update: `cf-threshold` renders `thresholdTokens (NN% of <window>)` when `tierPct` + `contextWindow` are known; falls back to bare `thresholdTokens` otherwise (no crash).

### `mega-commands.ts` — `/mega-status`

- Compute `effThreshold = config.tierPct != null && ctxWindow > 0 ? Math.round(config.tierPct * ctxWindow) : config.thresholdTokens` and render `threshold=<eff> (<pct>% of <win> window) tierPct=<0.50|n/a>`. Matches the dashboard's percentage-based view.

---

## FILES TO CHANGE

| File | Change | Status |
|------|---------|--------|
| `extensions/mega-config.ts` | `TIER_PCT` + `tierPct` + `effectiveThresholdTokens` + `resolveFastGatePct` default + `loadConfig` | ✅ in working tree |
| `extensions/mega-runtime.ts` | `effectiveThreshold` getter + reconciled `pressure` + `snapshot` armed/ready/tierPct/effectiveThresholdPct | ✅ in working tree |
| `extensions/mega-events.ts` | FAST GATE / `autoCompactCheck` / `agent_end` key off `runtime.effectiveThreshold` | ✅ in working tree |
| `extensions/mega-dashboard.ts` | `config.tierPct`/`effectiveThresholdPct`, `trigger.tierPct`/`effectiveThresholdPct` types | ✅ in working tree |
| `extensions/dashboard-server.ts` | seed fallback + tooltips + `cf-threshold` %-of-window | ✅ in working tree |
| `extensions/mega-commands.ts` | `/mega-status` `effThreshold` display | ✅ in working tree |

---

## ACCEPTANCE

1. **Fires below pi native for any model size.** For a 200k window, live + durable trim fire at low=100k (50%) / high=140k (70%) / mega=150k (75%) — all < pi native ~160k (80%). For a 1M window, low=500k / high=700k / mega=750k — all < pi native ~800k.
2. **Custom stays absolute.** With `MEGACOMPACT_THRESHOLD_TOKENS` set (tierPct null), the fire point is the explicit token count regardless of window; `TIER_PCT` is not applied.
3. **No dual-basis flicker.** When the window is known, `pressure` uses the single percentage basis (`lastCtxPercent / (tierPct*100)`), so the band holds a monotonic-ish climb and drops only on real compaction — it no longer snaps between 30% and high-70s% on alternating token/percent context events.
4. **Boot fallback is safe.** With `window == 0` (pre-first-context-event) or a `custom` tier, the fire point falls back to the boot `thresholdTokens` (`round(tierPct*200_000)` or the explicit custom value) — no collapse-to-0 / unconditional fire.
5. **Display reflects the live fire point.** `/mega-status` prints `threshold=<eff> (<pct>% of <win> window) tierPct=<…>`; the dashboard Threshold card shows `thresholdTokens (NN% of <window>)`.
6. `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all` all green. PREVENT-PI-004 stays green.

---

## ROLLBACK

- Per-file revert to the boot-`thresholdTokens` comparison: replace `runtime.effectiveThreshold` usages in `mega-events.ts` (FAST GATE, `autoCompactCheck`, `agent_end`) back to `config.thresholdTokens`; remove the `effectiveThreshold` getter + `TIER_PCT` + `effectiveThresholdTokens` from `mega-config.ts`/`mega-runtime.ts`; drop `tierPct`/`effectiveThresholdPct` from the snapshot types + display. The S24 `pressureFromPct`/`pressureRatio` math is unchanged and stays.
- The change is additive + backward-shaped: `MEGACOMPACT_THRESHOLD_TOKENS` (custom) behaves exactly as before (absolute). NO FORCE PUSH; revert/reset via PR only.
