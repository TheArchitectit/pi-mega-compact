# Percent-based auto-compact trigger (gate on context %, not under-reported tokens)

**Date:** 2026-07-18
**Focus:** switch the context-handler auto-compact gate from a **token count** (which the model under-reports) to **context %** (the reliable signal the menu bar shows), so compaction fires at the tier's existing fire point *before* the context reaches 100% — preventing the max-output-token truncation that S28 recovers from.
**Priority:** P1
**Effort:** S (config flag + context-handler gate dispatch + dashboard `armed`/`ready` consistency + 4 tests).
**Status:** IMPLEMENTED — code landed + tests green (v0.7.8).
**Depends on:** S27 (tiered `tierPct` fire point, `effectiveThreshold`, unified `pressure`), S28 (length-stop recovery — the reactive fallback when prevention still misses).

---

## SAFETY PROTOCOLS

- **PREVENT-PI-001 (anchor floor / preserve recent N):** unchanged — enforced inside `runCompact` → `compactSession` via `preserveRecentForPressure`/`keepFrom` (`extensions/mega-pipeline.ts`). S29 only changes *when* the gate fires, not the cut/anchor logic.
- **PREVENT-PI-002 (no split toolCall/toolResult):** unchanged — enforced in `src/engine.ts` boundary logic. S29 touches the gate, not the boundary.
- **PREVENT-PI-003 (no `role:"system"` injection):** unchanged — S29 adds no recall/restart change.
- **PREVENT-PI-004 (zero network at runtime):** S29 is pure math over `ctx.getContextUsage()` (tokens/percent/contextWindow). No new `fetch`/HTTP. Guardrails-scan stays green.
- **S27 boot-fallback guarantee preserved:** a percent-ONLY gate would skip compaction when `percent` is unavailable (window unknown / a model that doesn't report percent). S29 is percent-FIRST with a **token FALLBACK** when `pct == null`, so the S27 guarantee ("with window==0 or custom, the fire point falls back to the boot threshold — no collapse-to-0 / unconditional fire") survives. Regression-guarded by Test D.
- **Verify gate (per commit):** `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all` all green; `scripts/guardrails-scan.mjs` clean.
- NO FORCE PUSH; branch + merge only (user-permission gate for push).

---

## PROBLEM STATEMENT

When an assistant turn hit the model's max-output-token cap, the user observed the menu-bar context graph **over 100%** — yet no auto-compaction fired.

Root cause (confirmed by reading the code): the context-handler auto-trigger in `extensions/mega-events.ts` gated on a **token count** — `if (currentTokens < runtime.effectiveThreshold) return` — where `currentTokens` came from `ctx.getContextUsage().tokens`, which the model **under-reports** relative to what the API actually sees. Meanwhile pi's `usage.percent` (the same number the menu bar shows) is reliable, and the dashboard's `armed`/`ready` flags (`extensions/mega-runtime.ts`) already computed off **percent**. So when the model under-reported tokens, the dashboard showed "armed / >100%" while the gate stayed green and never compacted — the gate and the dashboard were inconsistent; percent was the truth.

The tier system (S27) already provides percent-based fire points (`TIER_PCT`: low=0.5, medium=0.6, high/ultra=0.7, mega=0.75). The bug was **not** "no percent trigger" — it was that the gate read the wrong *signal* (token counts instead of percent), so it missed the 50% mark and the context overshot to >100%.

**Intended behavior:** the context-handler gate fires on `pct/100 >= (autoPctTrigger ?? tierPct)` for tiered configs, with a token FALLBACK when `pct == null`. `custom` (absolute `MEGACOMPACT_THRESHOLD_TOKENS`, `tierPct null`) keeps the absolute token gate. `MEGACOMPACT_AUTO_PCT_TRIGGER` optionally overrides the tier fire point.

---

## SCOPE BOUNDARY

**IN SCOPE:**
- `extensions/mega-config.ts`: `MegaConfig.autoPctTrigger: number | null` + resolve in `loadConfig()` from `MEGACOMPACT_AUTO_PCT_TRIGGER` (clamped `[0.1, 1]`, null default = inherit `tierPct`).
- `extensions/mega-events.ts` context handler: replace the `if (pct == null) return` bail + token fast-gate with a percent-FIRST / token-FALLBACK dispatch; null-safe `pressure`.
- `extensions/mega-runtime.ts`: `effectiveThresholdPct` honors `autoPctTrigger ?? tierPct`; `ready` mirrors the gate's basis (percent for tiered, tokens for custom).
- Tests: 4 S29 tests (percent-fires-on-under-report, override knob, custom-keeps-token-gate, pct-null-token-fallback regression guard).
- Docs: this spec + `INDEX_MAP.md`/`HEADER_MAP.md` entries.

**OUT OF SCOPE (unchanged):**
- The tier fire points (`TIER_PCT`) and the `custom` absolute threshold — S29 changes the *signal*, not the *threshold*. Default behavior (no `MEGACOMPACT_AUTO_PCT_TRIGGER`) is byte-identical fire points to S27.
- The Trident pipeline, dedup tiers, recall/auto-inline, the S28 length-stop path, and the `agent_end` durable-trim (which keeps its token-based `overThreshold` gate as a backup relief path).
- `effectiveThreshold` getter (still `tierPct × window` for the dashboard's `thresholdTokens` display — the override is a separate percent knob on the gate, not a token-threshold change).

---

## EXECUTION

### `extensions/mega-config.ts` — new flag
- `MegaConfig.autoPctTrigger: number | null` (near `autoContinueLengthStop`).
- In `loadConfig()`:
  ```ts
  const aptRaw = process.env.MEGACOMPACT_AUTO_PCT_TRIGGER;
  const autoPctTrigger =
    aptRaw && aptRaw !== "" && Number.isFinite(Number(aptRaw))
      ? Math.min(1, Math.max(0.1, Number(aptRaw)))
      : null;
  ```

### `extensions/mega-events.ts` — context handler gate
Removed the unconditional `if (pct == null) return;` (it would skip compaction when percent is unreported). Replaced the token fast-gate with:
```ts
let gatePassed = false;
if (config.tierPct != null && pct != null) {
  const firePct = config.autoPctTrigger ?? config.tierPct;
  gatePassed = pct / 100 >= firePct;
} else {
  // custom OR tiered-but-pct-unavailable → token gate (S27 fallback).
  if (currentTokens < runtime.effectiveThreshold) { runtime.diagCtxFastGate++; return; }
  const check = autoCompactCheck(currentTokens, runtime.effectiveThreshold);
  if (!check.shouldCompact) { runtime.diagCtxNoCompact++; return; }
  gatePassed = true;
}
if (!gatePassed) { runtime.diagCtxFastGate++; return; }
```
And null-safe pressure (the `pct==null` bail is gone, so `pressureFromPct(pct)` could receive null on the token-fallback path):
```ts
const pressure = pct != null ? pressureFromPct(pct) : pressureRatio(currentTokens, runtime.effectiveThreshold);
```
(`pressureRatio` clamps via `clamp01`; same basis S27's `pressure` getter uses for the token path.) `currentTokens` was made null-safe in the `Math.round((pct ?? 0)/100 * window)` fallback term.

### `extensions/mega-runtime.ts` — dashboard `armed`/`ready`
- `effectiveThresholdPct`: `(config.autoPctTrigger ?? config.tierPct) * 100` for tiered, `null` for custom.
- `ready`: `tierPct != null ? armed && (lastCtxPercent ?? 0) >= (effectiveThresholdPct ?? 0) : armed && (lastCtxTokens ?? 0) >= effectiveThreshold`. Previously `ready` always required tokens, so the dashboard could show "armed" (percent high) but never "ready" when tokens were under-reported — the same inconsistency the S29 gate fix removes.

---

## ACCEPTANCE

1. **Percent gate fires on under-reported tokens.** Tiered `low` (tierPct 0.5), `tokens: 10, percent: 55` → live trim fires (token-only gate would have returned `10 < 5000`). `percent: 40` → no trim. (Test A.)
2. **Override knob.** `MEGACOMPACT_AUTO_PCT_TRIGGER=0.85` with tier `low`: `percent: 80` → no trim; `percent: 90` → trim. (Test B.)
3. **Custom keeps the token gate.** `MEGACOMPACT_THRESHOLD_TOKENS=50`, `tokens: 100, percent: 40` → trim fires (token gate, percent ignored). (Test C.)
4. **pct==null token fallback (S27 guarantee).** Tiered `low`, `tokens: 6000, percent: null`, window 10000 → trim fires via the token fallback (NOT skipped). (Test D — the regression guard.)
5. **Default unchanged.** With no `MEGACOMPACT_AUTO_PCT_TRIGGER`, `autoPctTrigger ?? tierPct === tierPct`, so the fire point and the dashboard's `effectiveThresholdPct`/`armed`/`ready` are identical to S27. The 5 `/mega-status` tier tests stay green.
6. **Guardrails + build.** `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all` green; `scripts/guardrails-scan.mjs` clean (no PREVENT-PI-001/002/003/004 violation); no new `fetch`.

---

## ROLLBACK

- **Soft (config):** `MEGACOMPACT_AUTO_PCT_TRIGGER` unset = inherit `tierPct` = S27 behavior. The percent signal is the new default; there is no env to force the token gate for tiered configs (percent is the reliable signal by design).
- **Hard (code revert):** restore the `if (pct == null) return;` bail + the token fast-gate `if (currentTokens < runtime.effectiveThreshold) return` + `autoCompactCheck`; revert `effectiveThresholdPct` to `tierPct * 100` and `ready` to `armed && (lastCtxTokens ?? 0) >= effectiveThreshold`; drop `autoPctTrigger` from `MegaConfig` + `loadConfig()`. All changes are small and additive — revert is mechanical.
- The change is **signal-only**: the fire point (tierPct) is unchanged by default, so the default is a reliability fix (compaction that previously got missed now fires), not a threshold change. S28 remains as the reactive fallback.

---

## Relationship to S28

S29 is the **preventive** fix (compact before the context reaches 100% so the length stop becomes rare). S28 is the **reactive** recovery (nudge the agent to continue if a length stop still occurs). The two compose: S29 shrinks the working set on pressure; S28 nudges the agent to finish a truncated turn. Shipped together as v0.7.8.
