# DASH-0c — Merge Cache+Metrics and combine the Admin surface

**Status:** planned | **Depends on:** DASH-0a, DASH-0b | **Phase:** DASH
**Flag:** `MEGACOMPACT_DASH_0C`, defined in `src/config/vector-cortex-dash-0c.ts` (sibling per the vc9d precedent; `src/config/vector-cortex.ts` is at the 300-line soft limit), re-exported by `src/config/vector-cortex.ts` + root `src/config.ts`, default ON; `MEGACOMPACT_DASH_0C=0` disables and must be byte-identical to the predecessor (CacheTab and MetricsTab render as two independent top-level surfaces; MaintenanceTab and ConfigTab render exactly as today). Registered in `VECTOR_CORTEX_SETTINGS` as a visible boolDirect toggle, never in `EXCLUDED_SETTINGS`.

## Goal and inputs/outputs

Second execution sprint of the DASH plan. Two merges, both **delegate-shell**.

**(1) Cache+Performance ← CacheTab + MetricsTab.** `CacheTab.tsx` remains the top-level surface (label becomes "Cache+Performance") and absorbs MetricsTab as a card section. MetricsTab's body (ModelBadge + PerfChart + PerfCards + the `RagDashboard` gated behind `NEW_UI`) is extracted VERBATIM into `tabs/CacheTab/MetricsCards.tsx` and rendered as a **Performance** `<section>` inside CacheTab. `CacheTab.tsx` stays a delegate-shell (currently 8.3KB/≈210 lines, well under the `extensions/` 400 soft) importing the new section. `MetricsTab.tsx` is reduced to a shell that re-exports `MetricsCards` (kept as a deep-link anchor for `#metrics`; cleaned up in DASH-0d after the deep-link audit). Flag-off: CacheTab renders only its existent cache sections (no Performance section), MetricsTab standalone is untouched.

**(2) Admin ← MaintenanceTab + ConfigTab** (plus the leftover surveillance sections). The new top-level **Admin** surface combines the maintenance actions with the config editor. `MaintenanceTab.tsx` (a delegate-shell already, rendering `MaintenanceTab/*` cards: ActionsCard, DbStatsCard, DebugBundleCard, HealthMitigationCard, SchemaHealthCard) is relocated as the core of the Admin surface; the Config surface (`ConfigTab.tsx`) is added as a second sub-view. A `AdminViews` toggle (`"maintenance" | "config"`) switches between the two — `MaintenanceTab.tsx` stays the maintenance sub-view shell and `ConfigTab.tsx` stays the config sub-view shell, both unchanged in body (only their hosting changes to a new `tabs/AdminTab.tsx` delegate-shell). The leftover **TopicsTab / AchievementsTab / GameTab** top-level files keep existing but are EXPLICITLY LISTED under the Admin section in the plan (`legacy_sections` with disposition `keep_but_listed_under:"admin"`); no new host is built for them this sprint — DASH-0d gates whether they get an Admin sub-tab or are retired.

These files are the ONLY Administrator-facing surfaces; the merge is additive to registry semantics (see DASH-0a `DASH_TAB_PLAN` admin row: `sources:["maintenance","config"]`).

Production ownership: `extensions/dashboard-client/src/tabs/CacheTab.tsx (delegate-shell — Performance section added, stays ≤400 soft), extensions/dashboard-client/src/tabs/CacheTab/MetricsCards.tsx (new — moved MetricsTab body verbatim), extensions/dashboard-client/src/tabs/MetricsTab.tsx (reduced to a shell re-exporting MetricsCards — kept for #metrics deep-link + rollback symmetry), extensions/dashboard-client/src/tabs/AdminTab.tsx (new — Admin delegate-shell with AdminViews toggle), extensions/dashboard-client/src/tabs/MaintenanceTab.tsx (unchanged body, re-hosted under AdminTab — listed as OWNED for hosting wiring only), extensions/dashboard-client/src/tabs/ConfigTab.tsx (unchanged body, re-hosted under AdminTab — listed as OWNED for hosting wiring only; stays importable from SetupTab per the dual-host note in task 5), extensions/dashboard-client/src/tabs/SetupTab.tsx (edited-additive — flag-ON hides the config sub-tab member; stays ≤400 soft), src/config/vector-cortex-dash-0c.ts (new), src/config/vector-cortex.ts (additive re-export, ≤300), src/config.ts (additive re-export, ≤205), extensions/dashboard-server/routes-rag-settings-vector-cortex.ts (additive boolDirect toggle), docs/vector-cortex/sprints/DASH-0c-merge-cache-metrics-and-admin-combine.md (this spec), scripts/vector-cortex-docs-check.mjs (EXPECTED_SPRINTS 47→48)`.

The ControlLegacy topic/achievements/game surfaces are untouched (owned by SetupTab/App routing, not this sprint); `TopicsTab.tsx` remains "kept, unused" exactly as its header documents.

## Numbered implementation tasks

1. Add the `MEGACOMPACT_DASH_0C` flag (default ON, `=0` byte-identical) in the sibling config, re-exports, and the `VECTOR_CORTEX_SETTINGS` boolDirect toggle ("Dashboard Consolidation — Cache+Performance / Admin").
2. Move the existent `MetricsTab.tsx` render body VERBATIM into `tabs/CacheTab/MetricsCards.tsx` (export as `MetricsCards`). Rewrite `tabs/MetricsTab.tsx` as a shell re-exporting `MetricsCards`. STORE `MetricsTab.tsx`'s original body as the flag-off source (it is byte-identical because the shell's flag-off body is the moved copy — both render `MetricsCards`; the standalone MetricsTab surface stays a valid deep-link target).
3. Patch `tabs/CacheTab.tsx` additively: label "Cache+Performance"; render a Performance `<section aria-labelledby="cache-perf-cards">` that mounts `MetricsCards` when flag-ON, and skip it when flag-OFF (byte-identical cache-only body).
4. Create `tabs/AdminTab.tsx` (delegate-shell): an `AdminViews` toggle (`"maintenance" | "config"`) mounting `MaintenanceTab` and `ConfigTab` respectively. Flag-ON = the toggle + both; flag-OFF = not mounted as a surface (the prior registry order holds; see task 6 note).
5. Re-host `MaintenanceTab.tsx` and `ConfigTab.tsx` bodies as sub-view components WITHOUT editing their render bodies: `MaintenanceTab` stays a shell over `MaintenanceTab/*`, `ConfigTab` stays its existent single-file body — both imported by `AdminTab.tsx`. This is the only "ownership" the sprint claims over them (hosting wiring, not content mutation). **Dual-host note (SetupTab stays wired):** `ConfigTab.tsx` must remain importable both from `SetupTab.tsx:16` (the existent `config` Setup sub-tab) AND from the new `AdminTab.tsx`. Flag-ON: `SetupTab.tsx` hides the `config` sub-tab member (BASE_SUB_TABS filter) so the config editor is reachable only via Admin; `SetupTab`'s import of ConfigTab remains in-file but its render branch is skipped. Flag-OFF: SetupTab renders the config sub-tab exactly as today and AdminTab is not mounted — the existent `config` Setup sub-tab keeps full reachability. This is the only SetupTab edit the sprint makes; the file must stay under the `extensions/` 400 soft cap.
6. Register `AdminTab` and the consolidated `CacheTab` label in `src/tabs/index.ts` + `registry.ts` (additive `DASH_SURFACE_ID` entries; do NOT remove existent `TabId` values — DASH-0d compacts the registry). Flag-off keeps `App.tsx`'s current `TabId` routing (this sprint does not rewrite the lazy list).
7. Add `src/vector-cortex/dash0c-acceptance.test.ts`. The `EXPECTED_SPRINTS` reconciliation is owned by the single integration step (45→60 at program commit) — this spec performs no per-sprint bump.

## Failure triad and independence

A: the Cache+Performance surface renders both the cache sections and the Performance card section (DASH-0C-001). B: the Admin surface renders both the maintenance actions and the config editor (DASH-0C-002). C: flag-off — CacheTab cache-only and the prior standalone MetricsTab/ConfigTab/MaintenanceTab surfaces hold (byte-identical predecessor) (DASH-0C-003). A uses the additive Performance section; B uses the additive AdminTab toggle; C uses the flag gate with untouched standalone files. Legacy sections (Topics/Achievements/Game) are explicit, independent inputs with the documented `keep_but_listed_under:"admin"` disposition.

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/dashboard-consolidation/` (shared family).

- `DASH-0C-001: cache surface exposes cache sections AND the performance cards` — `{ surface:"cache-perf", cache_sections:true, perf_cards:true }`.
- `DASH-0C-002: admin surface exposes maintenance AND config` — `{ surface:"admin", maintenance_present:true, config_present:true }`.
- `DASH-0C-003: flag-off keeps cache-only + independent metrics/maintenance/config surfaces` — `{ flag_enabled:false, cache_only:true, standalone_surfaces_intact:true }`.

Sprint acceptance aggregator: `src/vector-cortex/dash0c-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/dash0c-acceptance.test.js
```

Expected assertions: all DASH-0C-001..003 registered with algorithm `dashboard-consolidation` against the `dashboard-consolidation-fixture` schema; 001 asserts the dual-section cache surface; 002 asserts the dual-view admin surface; 003 asserts flag-off preserves the standalone surfaces. Client-dimension checks: `cd extensions/dashboard-client && npm run typecheck && npm run build` (client touched — MANDATORY) + lazy-load smoke that CacheTab (new Performance weight) and AdminTab load without Suspense error; `npm run typecheck` is the exact client gate. Exact flag-off comparison: `MEGACOMPACT_DASH_0C=0 node --test dist/vector-cortex/dash0c-acceptance.test.js`; the aggregator is flag-agnostic. Apply [EVALUATION](../EVALUATION.md) rules; hard causal/tool/anchor/exact failures are zero-tolerance. Unique failure injection: a performance card import removed from `MetricsCards.tsx`; the 001 "perf_cards:true" assert must fail.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure — no schema/state migration; UI-only**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md) — no new payload surface; merged views consume the same localhost `GET /api/snapshot`, `/api/perf`, `/api/provider-cache`, and admin/mutation endpoints the prior standalone surfaces used (no added capability; reader surfaces stay reader-only, mutation surfaces stay admin+audit gated). Dashboard: Cache+Performance merge + AdminTab combine + additive registry entries; no endpoint registry change. Run `cd extensions/dashboard-client && npm run typecheck && npm run build` + lazy-load smoke (packaging surface unchanged — no new bundle, so asset-gate not triggered).

Rollback sets `MEGACOMPACT_DASH_0C=0`; the Performance section and AdminTab collapse and the standalone MetricsTab/MaintenanceTab/ConfigTab surfaces return — predecessor bytes hold, evidence not deleted. No operator migration.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/dash0c-acceptance.test.js`, `MEGACOMPACT_DASH_0C=0 node --test dist/vector-cortex/dash0c-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all --soft-as-hard --soft-as-hard-base v0.20.29 --pre-commit`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, `node scripts/vector-cortex-scope-check.mjs DASH-0C <COMMIT_SHA>`, `node scripts/vector-cortex-evidence-check.mjs DASH-0C`, `git diff --check`, `cd extensions/dashboard-client && npm run typecheck && npm run build`. No permissive globs or warning-only scans count.
