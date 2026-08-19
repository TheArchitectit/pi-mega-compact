# Sprint — Threshold Percent Normalization + Output-Error Catch

**Date:** 2026-08-13
**Branch:** `fix/threshold-percent-normalization`
**Priority:** P0 (correctness — small-context models truncate to death before compaction ever fires; this is LTS-justified bug-fix work, not new feature dev)
**Status:** SPEC — pending implementation. Tasks created, gate baseline green (`npm run build` rc=0, v0.21.4).
**Effort:** M (≈1.5 days across 8 gated sub-sprints A–H)
**Depends on:** v0.21.4 baseline; clamps onto the S27/S29 `effectiveThresholdTokens` + `effectiveThresholdImpl` path.
**Parent docs:** `docs/AGENT_GUARDRAILS.md`, `docs/INDEX_MAP.md`, recalled memory ("focus on catching the output errors + all additional error handling; skip the cache problem").

---

## SAFETY PROTOCOLS

- Read `docs/AGENT_GUARDRAILS.md` + `skills/shared-prompts/four-laws.md` first. The Four Laws (Read First / Stay in Scope / Verify Before Commit / Halt When Uncertain) are non-negotiable.
- **PREVENT-PI-001 / 002** (anchor floor / tool pairs): untouched this sprint — sub-sprint H only *detects* a truncated response and trips compaction; it does not alter the trim cut or boundary guards.
- **PREVENT-PI-003** (no system role): unchanged — any compaction still injects via the sanctioned `before_agent_start` systemPrompt prepend.
- **PREVENT-PI-004** (no network by default): local only; H reads `finish_reason`/stop metadata already emitted by pi into the context event — no fetch.
- **LTS scope (CLAUDE.md §0):** this is patches-only correctness work — the umbrella-OFF path currently misfires on small-context models (uses the `200k` boot fallback, which is unreachable on a 32k window → model truncates before the gate ever fires). Breaking the v0.20.83 byte-identical guarantee is **authorized** as a correctness fix (user: "it wasn't working correctly so this is LTS work").
- **Gate (every sub-sprint):** `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`. Run after each file, not in a batch. The full `scripts/deploy.sh` gate runs once at the end (Phase H → release).
- **File soft limits (ENGINEERING_PRACTICES):** `src/` 300, `extensions/` 400. Every changed file must stay under its soft limit — extract a sibling rather than squeeze.

---

## Problem Statement

### Symptoms (the sibling GLM-4.7 32k session)

Status bar at truncation: `mem Trigram · 0 chunks · comp — │ comp lag warn │ compact never`. The model reported `Response was truncated before completion` at 76.6% context (25k/32k). Compaction never fired.

### Root cause 1 — the firing path is %-based ONLY when umbrella ON; umbrella-OFF substitutes a guessed 200k window

The firing path (`effectiveThresholdImpl`, `extensions/mega-runtime/pressure-getters.ts:83`) is correctly %-based **only under `MEGACOMPACT_THREE_WAY_FAILBACK=true`** (the default): when the window is unknown it returns `+Infinity` (DEFER — never substitutes a guessed window). But the DEFER branch is gated by `self.config.threeWayFailback && self.config.tierPct != null && self.lastCtxWindow <= 0`. Under umbrella-OFF the code falls through to `effectiveThresholdTokens`, which returns `fallbackThreshold` = `round(tierPct × 200_000)` — a guessed absolute window. For a 32k model that fallback (100k at tier low 0.5, or 160k at the default 0.8 umbrella pct) is unreachable: **the model truncates its output before the gate ever fires** → `compact never` → every long response truncates.

### Root cause 2 — no handler for `Response was truncated before completion`

Even under umbrella-ON, the 32k model truncates at ~76% — *below* the 80% fire point. The truncation is a model **output** ceiling (mid-response token exhaustion), not an input-context ceiling. `grep -rni "truncat\|finish_reason\|stop_reason\|response was truncated"` across `src/` + `extensions/` returns only `src/vector-cortex/**` internals (RUST_FRAME_TRUNCATED, HEAL_PROOF_INCOMPLETE, etc.) — **nothing catches the model's own truncated-ouput signal** to trip an immediate compaction. This is the "catching the output errors + all additional error handling" gap in recalled memory.

### Root cause 3 — hardcoded values violate the "% of total context, no shortcuts" invariant

A full audit (see Appendix A) found six hardcoded sites in the threshold/gate path, plus the sibling issue that stray absolute literals tempt future regressions. The firing path is already correct under umbrella-ON; the remaining magic numbers are boot-fallbacks + display seeds + a frozen test invariant — but they are exactly what made root cause 1 possible (the `200_000` boot fallback).

---

## DECISIONS (locked with user, 2026-08-13)

> User directive: *"we need to move it all to % based to match, we must do this correctly no shortcuts"* + *"yes it's lts but it wasn't working correctly so this is LTS work"* + *"we should plan all work. write out full openspec specs for each phase"*. Implementation order: phases with code first ("1 + 2 + 4 first" = convert the safe set + break invariant 6 + show diffs per phase).

### D1 — `COMPACT_TIERS` becomes the single %-fraction source of truth (Phase A)
The absolute token values in `COMPACT_TIERS` (`50_000 / 100_000 / 200_000 / 1_000_000 / 10_000_000`) are **unused for firing** — only `raw in COMPACT_TIERS` (tier-name validation) and `keyof typeof COMPACT_TIERS` (the type) read them. The real fire fractions live in `TIER_PCT` (`0.5 / 0.6 / 0.7 / 0.7 / 0.75`). Fold: `COMPACT_TIERS` becomes `Record<CompactTier, number>` of fractions (merge TIER_PCT); delete `TIER_PCT`. The `raw in COMPACT_TIERS` + `keyof` checks keep working unchanged.

### D2 — Replace the `200_000` boot-fallback magic number with a named env-overridable constant (Phase B)
`MEGACOMPACT_DEFAULT_CONTEXT_WINDOW` (default `200_000`, so under umbrella-ON it is display-only — the live path still defers via `+Infinity`). It is now a *named, documented, overridable* default rather than a silent literal.

### D3 — umbrella-OFF also DEFERS (Phase C) — breaks the v0.20.83 byte-identical guarantee
Drop the `threeWayFailback &&` gate on the DEFER branch in `effectiveThresholdImpl`, so umbrella-OFF *also* returns `+Infinity` when a tiered config has an unknown window. This is the core correctness fix for small-context models under any umbrella state: **no guessed window, ever**. `custom` (tierPct null, explicit absolute) is unaffected — it keeps its explicit token gate. This is the one behavior change authorized as LTS-correctness work; invariant 6 in `threshold-invariant.test.ts` is rewritten (Phase G) to assert DEFER instead of `100_000`.

### D4 — `autoCompactCheck(threshold)` becomes a required param (Phase D)
Remove the `= 50000` default. The sole non-test caller (`gateCheck.ts:135`) already passes `gateThreshold` explicitly; tests pass 2 args explicitly (`compact.test.ts:88,91`). No behavior change — just closes the footgun.

### D5 — `savedGoal` seeded from `effectiveThreshold` (Phase E)
Replace the `50_000` literals in `reset-runtime.ts:93` + `runtime-instrumentation.ts:140` with `Number.isFinite(self.effectiveThreshold) ? self.effectiveThreshold : DEFAULT_SAVED_GOAL`. The dynamic grow path (`run.ts:135`) is unchanged. `DEFAULT_SAVED_GOAL` (= the `MEGACOMPACT_DEFAULT_CONTEXT_WINDOW × tierPct` boot value) is the named display seed.

### D6 — `resolveFastGatePct` `70` literal → named constant (Phase F)
The env IS read first (`MEGACOMPACT_FAST_GATE_PCT`); only the `: 70` custom-tier fallback remains. Extract `DEFAULT_FAST_GATE_PCT_CUSTOM = 70` as an exported, documented constant. This is `custom`'s explicit opt-out of percent scaling — there is no % base to derive from by design, so a named constant is the correct (non-shortcut) form here.

### D7 — Rewrite `threshold-invariant.test.ts` invariant 6 + docstring + `tieredConfig` helper (Phase G)
- docstring: drop "byte-identical to v0.20.83"; document the new DEFER-under-umbrella-OFF guarantee (LTS-correctness fix D3).
- `tieredConfig`: keep `thresholdTokens: Math.round(tierPct × MEGACOMPACT_DEFAULT_CONTEXT_WINDOW)` as the display seed.
- invariant 6: assert `Number.isFinite(t) === false` (DEFER) for umbrella-OFF + tiered + window unknown — matching invariants 1–3.

### D8 — Output-error catch: trip compaction on `Response was truncated` / `finish_reason=length` (Phase H)
The actual root-cause fix. Detect the truncated-output signal in the context-event path, and when seen, force the next gate to proceed (lowers effective pressure requirement for one turn) so compaction runs immediately and the *next* response has headroom. This is the missing "catching the output errors" handler from recalled memory. Non-fatal, best-effort, flag-gated (`MEGACOMPACT_OUTPUT_ERROR_COMPACT`, default ON; OFF = byte-identical pre-D8).

---

## Sub-Sprint Plan (A–H)

Each sub-sprint: implement → `npm run build` → `npm test` → `npm run lint` → `python3 scripts/regression_check.py --all`. Commit per sub-sprint (one focused commit, AI-attribution via pre-commit hook). Order respects dependencies.

### Phase A — Consolidate `COMPACT_TIERS` + `TIER_PCT` (D1)
**Files:** `extensions/mega-config.ts`
- Replace `COMPACT_TIERS` absolute-token map with the fraction map (values from `TIER_PCT`).
- Delete `TIER_PCT`; update `resolveThreshold` to read `COMPACT_TIERS[tier]`.
- Keep `raw in COMPACT_TIERS` + `keyof typeof COMPACT_TIERS` working.
- **Verify:** `grep -rn "TIER_PCT" src/ extensions/` returns only the test file (Phase G updates it). No non-test importer (confirmed: only `mega-config.ts` itself).
**Gate:** build + test + lint + regression_check.

### Phase B — Named `MEGACOMPACT_DEFAULT_CONTEXT_WINDOW` (D2)
**Files:** `extensions/mega-config.ts`
- Add exported `DEFAULT_CONTEXT_WINDOW = envFlag("MEGACOMPACT_DEFAULT_CONTEXT_WINDOW", 200_000)`.
- Replace `Math.round(tierPct * 200_000)` → `Math.round(tierPct * DEFAULT_CONTEXT_WINDOW)`.
- Update the two doc comments referencing `200_000`.
- **Verify:** unchanged firing under umbrella-ON (DEFER); the constant is display/seed only.
**Gate:** build + test + lint + regression_check.

### Phase C — umbrella-OFF also DEFERS (D3) — the core fix
**Files:** `extensions/mega-runtime/pressure-getters.ts`
- `effectiveThresholdImpl`: drop `self.config.threeWayFailback &&` from the DEFER condition → `self.config.tierPct != null && self.lastCtxWindow <= 0`.
- Update the comment block to reflect "DEFER under any umbrella state".
- **Verify:** Phase G invariant 6 will pass; under umbrella-OFF + tiered + window unknown the gate no longer substitutes a guessed window → small-context models get real protection.
**Gate:** build + test + lint + regression_check. (Tests will RED until Phase G — run G immediately after.)

### Phase D — `autoCompactCheck` required param (D4)
**Files:** `src/compact.ts`; tests `src/compact.test.ts`, `src/dedup-engine.test/compaction-levels.test.ts`, `src/ratio.bench.test/collapsible-detection.test.ts`
- Remove `threshold = 50000` → `threshold: number`.
- Tests already pass 2 args — no test change needed (just confirm compilation).
**Gate:** build + test + lint + regression_check.

### Phase E — `savedGoal` from `effectiveThreshold` (D5)
**Files:** `extensions/mega-runtime/reset-runtime.ts`, `extensions/mega-runtime/runtime-instrumentation.ts`
- Add exported `DEFAULT_SAVED_GOAL = envFlag("MEGACOMPACT_DEFAULT_CONTEXT_WINDOW", 200_000) * 0.25` (or a dedicated `MEGACOMPACT_SAVED_GOAL_SEED`).
- Replace `self.savedGoal = 50_000` → `Number.isFinite(self.effectiveThreshold) ? self.effectiveThreshold : DEFAULT_SAVED_GOAL` (both sites; mirror both writers).
- `run.ts:135` grow path untouched.
- **Verify:** progress-bar denominator now scales with the model window, not a fixed 50k.
**Gate:** build + test + lint + regression_check.

### Phase F — `resolveFastGatePct` named constant (D6)
**Files:** `extensions/mega-config.ts`
- Add `export const DEFAULT_FAST_GATE_PCT_CUSTOM = 70`; replace the `: 70` literal.
**Gate:** build + test + lint + regression_check.

### Phase G — Rewrite `threshold-invariant.test.ts` (D7)
**Files:** `extensions/mega-runtime/threshold-invariant.test.ts`
- Docstring: drop "byte-identical to v0.20.83"; add the LTS-correctness note.
- `tieredConfig`: seed `thresholdTokens` from the Phase B constant.
- invariant 6: rewrite to assert DEFER (non-finite) for umbrella-OFF + tiered + window unknown.
- Add invariant 6b: `custom` + window unknown still fires the explicit absolute (regression guard).
**Gate:** build + test + lint + regression_check. **C + G must land together** (C reds the old invariant 6).

### Phase H — Output-error catch (D8) — root cause fix
**Files:** `extensions/mega-events/context-handler/` (new `output-error-catch.ts` + shell re-export if needed to stay under the soft limit), `extensions/mega-config.ts` (flag), `extensions/mega-config-types.ts`.
- Detect `Response was truncated` / `finish_reason: "length"` / `stop_reason: "max_tokens"` in the context event payload (read-only — no new network).
- On detection: set a one-shot `runtime.forceCompactNextGate = true` (best-effort, try/catch, non-fatal).
- `gateCheck.ts`: when `forceCompactNextGate`, bypass the FAST-GATE return and proceed to compaction once, then clear the flag.
- Flag `MEGACOMPACT_OUTPUT_ERROR_COMPACT` (default ON; OFF = byte-identical pre-H).
- **Verify:** a truncated response trips compaction on the immediately following gate, giving the next response headroom.
**Gate:** full deploy gate: `./scripts/deploy.sh <new-version>` (build + test + lint + regression_check + guardrails-scan + dashboard-client bundle check + npm publish). This is the release sub-sprint.

---

## Appendix A — Audit: all hardcoded values in the threshold/gate path

| # | Site | File:line | Value | Role | Phase / status |
|---|------|-----------|-------|------|-----------------|
| 1 | `COMPACT_TIERS` absolutes | `extensions/mega-config.ts:20-26` | `50k/100k/200k/1M/10M` | tier-name validation only (unused for firing) | **A** (→ fractions) |
| 2 | boot-fallback window | `extensions/mega-config.ts:96` | `200_000` | display seed + custom companion | **B** (→ named env const) |
| 3 | umbrella-OFF guessed window | `pressure-getters.ts:83` DEFER gate | `threeWayFailback &&` | gates whether DEFER applies | **C** (→ drop the gate) |
| 4 | `autoCompactCheck` default | `src/compact.ts:281` | `= 50000` | default param (footgun) | **D** (→ required) |
| 5 | `savedGoal` seed (×2) | `reset-runtime.ts:93`, `runtime-instrumentation.ts:140` | `50_000` | progress-bar denominator | **E** (→ effectiveThreshold) |
| 6 | `resolveFastGatePct` custom fallback | `extensions/mega-config.ts:145` | `70` | custom-tier arming floor | **F** (→ named const) |
| 7 | invariant 6 frozen fallback | `threshold-invariant.test.ts:~114` | `100_000` | test assertion | **G** (→ DEFER) |

### Verified NON-bugs (by-design, untouched)
- `src/config.ts:72-99` pressure bands `0.5/0.75/0.9/1.0` — define the bands themselves.
- `mega-config.ts:~82` `clamp(MEGACOMPACT_THRESHOLD_PCT, 0.1, 0.95)` — safety bounds on the env override.
- `mega-config.ts:231` `recallMaxTokens: envFlag(..., 1500)` — separate concern, env-overridable.
- `compact.ts:292` `utilizationPct` `1000/10` — rounding multiplier (not a threshold).

### Verified out of scope (radcode)
- Anything in `src/vector-cortex/**` (RUST_FRAME_TRUNCATED, HEAL_PROOF_INCOMPLETE, etc.) — these are vector-index internals, not the agent output path. Truncation-named symbols there are unrelated to the model's truncated response.
- New feature sprints generally — directed to radcode per CLAUDE.md §0 LTS note.

---

## Future Work (out of scope this sprint)
- **Recall injection via tail user-role message** (still `before_agent_start` systemPrompt prepend) — changes injection semantics, separate sprint.
- **Per-model output-ceiling awareness** — once Phase H lands, extend the dashboard to surface "model truncates output at N% of window" so users can pick a fire point below it. Belongs in radcode.
- **Retrofitting umbrella-OFF entirely** — D3 makes umbrella-OFF behave like umbrella-ON for the DEFER case. The umbrella flag itself could eventually be retired; deferred (radcode).
