# Phase DASH — Dashboard Tab Consolidation (13 → 7 surfaces)

**Status:** planned | **Depends on:** external-audit #9 (dashboard tab count) | **Phase:** DASH
**Flag scope:** per-sprint `MEGACOMPACT_DASH_0A..0D`, default ON, `=0` byte-identical to the predecessor. All four flags are additive re-exports in `src/config/vector-cortex.ts` + `src/config.ts` and registered in `VECTOR_CORTEX_SETTINGS` as boolDirect toggles, never in `EXCLUDED_SETTINGS`.

## Premise

External-audit item #9 records 13 top-level dashboard tab surfaces and mandates a collapse to **7 navigational surfaces** without losing any delegated card body, any deep-link, or any flag-off byte-parity. DASH-0a audits the existing 13 surfaces and ships the plan (`DASH_TAB_PLAN`, `DASH_TAB_COUNT = 7`, `DEEP_LINK_TARGETS`, `DASH_NAV_MAP`); DASH-0b and DASH-0c execute the merges as delegate-shells (Sessions+Turns, Cache+Metrics, Admin=Maintenance+Config); DASH-0d rolls up the consolidated App.tsx lazy list, the hash router, the a11y audit, the legacy-section disposition, and the tab-count verifier.

The fixed 7 are: **Overview, Sessions, Cache+Performance, Memory Graph, Diagnostics, Setup, Admin**.

## Architectural invariants (do not violate)

1. **No new runtime network calls** — DASH is UI-only. Every surface consumes the already-registered reader endpoints (`/api/sessions`, `/api/turns`, `/api/cache`, `/api/events`, `/api/vector-cortex/*`, `/api/setup-cortex-status`, `/api/repo-corpus`, etc.) and adds none. PREVENT-PI-004 stays green.
2. **Flag-on ≠ behavior change for unsplit components** — when a merge flag is OFF, the predecessor `App.tsx` lazy list + `TabContent` + `TabBar` render the byte-identical 13-tab surface set. Components that live in two surfaces during the transition (e.g. ConfigTab as both a Setup sub-tab and an Admin sub-view) are imported in both hosts under flag control; no double-render branch leaks when the flag is OFF.
3. **Delegate-shell + sibling** — any file crossing the 400-line `extensions/` soft cap is split by delegate-shell + sibling before the new directive lands. CacheTab/SessionsTab/VectorCortexTab stay delegate-shells; the moved bodies live in `CacheTab/MetricsCards.tsx`, `SessionsTab/TurnMemoryView.tsx`, `VectorCortexTab/sections.tsx`, `tabs/index.ts`.
4. **Deep-link preservation** — every pre-DASH hash lands on a live consolidated surface (14-hash matrix asserted in `DASH-0D-002`); no dead link is permitted. Flag-off rollback restores the 13-surface lazy list byte-identically.
5. **A11y contract** — every consolidated surface gets one landmark `<nav aria-label>` per the DASH-0a `DASH_NAV_MAP`; sections carry `aria-labelledby` heading ids; tablist/tab roles match the existing `TabBar`/`SetupTab` patterns. The audit script fails on serious/critical violations.
6. **Plan module is inert until DASH-0d** — `dash-consolidation/plan.ts` is a static constant module with no consumer until the rollup; flag-off does not depend on the plan's correctness.

## Sprint chain (DASH-0a → DASH-0d)

| Sprint | Title | Surface reached |
|--------|-------|-----------------|
| DASH-0a | Tab audit + merge plan (plan.ts + audit fixtures) | (planning only — 13 surfaces live) |
| DASH-0b | Merge Sessions+Turns; VectorCortex sections | 12 (13 − 1 merged pair, cortex flat→4 sections) |
| DASH-0c | Merge Cache+Metrics; Admin ← Maintenance+Config | 9 (Sessions/Cortex already merged; Cache+Metrics merge; Admin collapses two) |
| DASH-0d | Rollup: a11y, lazy load, flag cleanup, 7-surface verifier | **7** (the fixed set) |

### DASH-0a — Audit + plan (planning-only)

Ships a typed `DASH_TAB_PLAN` in `extensions/dashboard-client/src/dash-consolidation/plan.ts` naming every current `TabId` → consolidated surface + the `legacy_sections` disposition of the three non-routable keeps (`TopicsTab`, `AchievementsTab`, `GameTab` — "kept, listed under admin, not in the tab bar"). No `App.tsx`/component touch; no route change.

**Ownership:** `extensions/dashboard-client/src/dash-consolidation/{plan.ts,plan.test.ts}; src/config/{vector-cortex-dash-0a.ts,vector-cortex.ts,config.ts}; extensions/dashboard-server/routes-rag-settings-vector-cortex.ts; conformance/vector-cortex/v2/dashboard-consolidation/ (DASH-0A-001..003); scripts/vector-cortex-docs-check.mjs (integration bump)`. Collateral: comment-only fix at `extensions/mega-runtime/widget-types.ts:58` (S33 reference).

### DASH-0b — Merge Sessions+Turns; VectorCortex sectioned

`SessionsTab.tsx` stays the top-level surface and absorbs TurnsTab as a drill-down toggle (verbatim body move into `tabs/SessionsTab/TurnMemoryView.tsx`; `TurnsTab.tsx` left untouched until DASH-0d to preserve flag-off parity). `VectorCortexTab.tsx` groups its 18 delegate cards under 4 `<section aria-labelledby>` headers via new `tabs/VectorCortexTab/sections.tsx`. `src/tabs/index.ts` barrel and `registry.ts` `DASH_SURFACE_IDS` are additively introduced without removing the `TabId` union.

**Ownership:** `extensions/dashboard-client/src/tabs/{SessionsTab.tsx,SessionsTab/TurnMemoryView.tsx,TurnsTab.tsx,VectorCortexTab.tsx,VectorCortexTab/sections.tsx,index.ts,registry.ts}; src/config/{vector-cortex-dash-0b.ts,vector-cortex.ts,config.ts}; extensions/dashboard-server/routes-rag-settings-vector-cortex.ts; conformance/vector-cortex/v2/dashboard-consolidation/ (DASH-0B-001..003)`.

### DASH-0c — Merge Cache+Metrics; Admin ← Maintenance+Config

`CacheTab.tsx` stays the top-level surface (label **"Cache+Performance"**) and absorbs MetricsTab as a card section (`tabs/CacheTab/MetricsCards.tsx`); the standalone `MetricsTab.tsx` shell is kept for the `#metrics` deep link until DASH-0d removes it. New `tabs/AdminTab.tsx` delegate-shell with an `AdminViews` toggle hosting the unchanged `MaintenanceTab` body and the unchanged `ConfigTab` body; `SetupTab.tsx` is edited additively to hide its `config` sub-tab in flag-ON (the config editor is re-hosted under Admin; flag-off keeps the Setup config sub-tab). Legacy sections (`TopicsTab`/`AchievementsTab`/`GameTab`) keep existing and are listed under Admin in the plan only — no host is built for them this sprint.

**Ownership:** `extensions/dashboard-client/src/tabs/{CacheTab.tsx,CacheTab/MetricsCards.tsx,MetricsTab.tsx,AdminTab.tsx,MaintenanceTab.tsx,ConfigTab.tsx,SetupTab.tsx}; src/config/{vector-cortex-dash-0c.ts,vector-cortex.ts,config.ts}; extensions/dashboard-server/routes-rag-settings-vector-cortex.ts; conformance/vector-cortex/v2/dashboard-consolidation/ (DASH-0C-001..003)`.

### DASH-0d — Rollup: a11y, lazy load, flag cleanup, 7-surface verifier

Rewrites `App.tsx`'s lazy list to the consolidated surfaces and the DASH-0a `DEEP_LINK_TARGETS` becomes a live hash→surface router via new `tabs/dashHashRouter.ts`; the registry compacts `TabId` to the 7 surfaces; the standalone `TurnsTab.tsx` and `MetricsTab.tsx` shells are removed; the legacy-section disposition is resolved (retained as Admin sub-tabs or retired per the audit). New scripts: `scripts/dash-tab-count.mjs` (assert exactly 7 surfaces flag-on; 13 flag-off — reads the flag) and `scripts/dashboard-audit.mjs` (axe/accesslint audit over the merged surfaces against the built client bundle; fails on serious/critical). New conformance fixtures DASH-0D-001..004. **Mandatory live Playwright validation** (see below).

**Ownership:** `extensions/dashboard-client/src/{App.tsx,tabs/registry.ts,tabs/TurnsTab.tsx,tabs/MetricsTab.tsx,tabs/AdminTab.tsx,tabs/TopicsTab.tsx,tabs/dashHashRouter.tsx}; scripts/{dashboard-audit.mjs,dash-tab-count.mjs,dash-consolidation/gen-fixtures.mjs}; src/config/{vector-cortex-dash-0d.ts,vector-cortex.ts,config.ts}; extensions/dashboard-server/routes-rag-settings-vector-cortex.ts; conformance/vector-cortex/v2/dashboard-consolidation/ (DASH-0D-001..004); docs/vector-cortex/evidence/DASH-0D.md (roll-up)`.

## Conformance fixtures — DASH reserved family

One algorithm family `dashboard-consolidation`, four sprint allocations (001..004 = DASH-0a, 001..003 = DASH-0b, 001..003 = DASH-0c, 001..004 = DASH-0d):

| Fixture range | Owner | Purpose |
|---------------|-------|---------|
| `DASH-0A-001..003` | DASH-0a | plan covers every TabId exactly once / no collision / flag-off byte-identity |
| `DASH-0B-001..003` | DASH-0b | Sessions dual render / 18→4 bijection / flag-off standalone surfaces hold |
| `DASH-0C-001..003` | DASH-0c | Cache+Performance dual render / Admin dual render / flag-off standalone surfaces hold |
| `DASH-0D-001..004` | DASH-0d | merged 7 surfaces / hash deep-link matrix / flag-off 13-surface parity / a11y pass |

Conformance root: `conformance/vector-cortex/v2/dashboard-consolidation/`; schema sibling at `schemas/dashboard-consolidation-fixture.schema.json`.

## Exit evidence

Every DASH sprint runs the mandatory gates (`npm run build`; acceptance aggregator; flag-off parity run; `npm test`; `npm run lint`; `python3 scripts/regression_check.py --all --soft-as-hard --soft-as-hard-base <PREV_TAG> --pre-commit`; guardrails; conformance; docs-check; scope-check; evidence-check; `git diff --check`) **plus** the dashboard-client gate (`cd extensions/dashboard-client && npm run typecheck && npm run build`) because every DASH sprint touches the client.

DASH-0d additionally runs the **mandatory live Playwright validation** of the merged dashboard: 7-surface render, 14-hash deep-link resolution, a11y audit pass, no console errors, and the flag-off reproduction of the 13-surface lazy list — driven by Playwright against the live loopback host (default `http://localhost:9320`) after `./scripts/deploy.sh <patch>`. If no reachable host exists the sprint pauses at implementer-complete until a live host is available; evidence names the host and the observed surface/hash matrix.
