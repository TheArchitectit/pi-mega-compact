# DASH-0C Evidence — Merge Cache+Metrics and combine the Admin surface

Status: **reviewer-accepted** — the second execution sprint of the DASH plan.
Two delegate-shell merges: (1) the Cache surface absorbs MetricsTab as a
`Performance` section via `CacheTab/MetricsCards.tsx` (label "Cache+Performance");
(2) MaintenanceTab + ConfigTab combine under a new `tabs/AdminTab.tsx`
delegate-shell with an `AdminViews` toggle, and SetupTab hides its Config sub-tab.
`MetricsTab.tsx` is reduced to a shell re-exporting `MetricsCards` (kept for the
`#metrics` deep-link + rollback symmetry; a DASH-0d cleanup retires it after a
deep-link audit). No card component render logic is edited; `MaintenanceTab.tsx`,
`ConfigTab.tsx`, `TopicsTab.tsx`, `AchievementsTab.tsx`, `GameTab.tsx` and
`TurnsTab.tsx` stay untouched this sprint.

## Sprint meta

- **Spec:** docs/vector-cortex/sprints/DASH-0c-merge-cache-metrics-and-admin-combine.md
- **Sprint ID string:** `DASH-0C` (owner CSV + manifest registration)
- **Flag:** `MEGACOMPACT_DASH_0C` — boolDirect, default ON, `=0` byte-identical
  predecessor (CacheTab and MetricsTab render as two independent top-level
  surfaces; MaintenanceTab and ConfigTab render exactly as today; SetupTab keeps
  its Config sub-tab). Registered as a visible `VECTOR_CORTEX_SETTINGS` toggle,
  never in `EXCLUDED_SETTINGS`.

## Production ownership files (final state)

- `src/config/vector-cortex-dash-0c.ts` (25) — `DASH_0C_ENABLED()` positive sprint
  flag sibling, default ON; `=0` disables.
- `src/config/vector-cortex.ts` (108) — additive re-export (+2 lines)
- `src/config.ts` (224) — additive re-export (+1 line)
- `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts` (352) —
  boolDirect `MEGACOMPACT_DASH_0C` toggle "Dashboard Consolidation —
  Cache+Performance / Admin"
- `extensions/dashboard-client/src/tabs/CacheTab/MetricsCards.tsx` (66) — the
  MetricsTab render body moved VERBATIM (export renamed `MetricsTab` →
  `MetricsCards`); import depth adjusted to `../../` for the `CacheTab/` subdir.
- `extensions/dashboard-client/src/tabs/CacheTab.tsx` (274) — delegate-shell:
  label context + a Performance `<section aria-labelledby="cache-perf-cards">`
  that mounts `MetricsCards` when flag-ON; flag-OFF skips that section entirely
  (cache-only body byte-identical to predecessor).
- `extensions/dashboard-client/src/tabs/MetricsTab.tsx` (17) — shell re-exporting
  `MetricsCards` (kept for `#metrics` deep-link + rollback symmetry).
- `extensions/dashboard-client/src/tabs/AdminTab.tsx` (81) — new Admin
  delegate-shell: an `AdminViews` toggle ("maintenance" / "config") mounting
  `MaintenanceTab` and `ConfigTab`. Flag-ON renders the toggle + both views;
  flag-OFF renders only `MaintenanceTab` (predecessor `admin → MaintenanceTab`
  mapping).
- `extensions/dashboard-client/src/tabs/MaintenanceTab.tsx` (63) — unchanged body
  (re-hosted under AdminTab; still importable from its original host).
- `extensions/dashboard-client/src/tabs/ConfigTab.tsx` (271) — unchanged body
  (re-hosted under AdminTab; dual-host — still importable from SetupTab).
- `extensions/dashboard-client/src/tabs/SetupTab.tsx` (106) — edited-additive:
  flag-ON filters the `config` sub-tab member from `BASE_SUB_TABS` and skips its
  render branch (config reachable only via Admin); flag-OFF renders config exactly
  as today.
- `extensions/dashboard-client/src/tabs/registry.ts` (94) — additive
  `DASH_SURFACE_IDS` unchanged (7 ids) + additive `DASH_SURFACE_LABELS` mapping
  `cache-perf → "Cache+Performance"` and `admin → "Admin"`; the existent 13-TabId
  union is unchanged.
- `extensions/dashboard-client/src/tabs/index.ts` (31) — additive re-exports;
  `admin` now maps to the real `AdminTab` (was reserved alias → MaintenanceTab).
- `src/vector-cortex/dash0c-acceptance.test.ts` (195) — fixture registration +
  envelope posture + flag invariants + settings toggle + client source scan
  assertions; flag-agnostic.
- `conformance/vector-cortex/v2/dashboard-consolidation/DASH-0C-{001,002,003}.json`
  — fixtures; `conformance/vector-cortex/v2/manifest.json` owner CSV +DASH-0C, 940
  fixtures canonical.

Untouched this sprint: `TopicsTab.tsx`, `AchievementsTab.tsx`, `GameTab.tsx`
(legacy sections listed under Admin with `keep_but_listed_under:"admin"`), and
`TurnsTab.tsx` (untouched since DASH-0B).

## Behavior enforced (the sprint's hard guarantees)

1. **Cache+Performance merge** — flag-ON, the Cache surface exposes both its
   existent cache sections AND the Performance cards via `MetricsCards`
   (fixture DASH-0C-001 + the `<section aria-labelledby="cache-perf-cards">`
   source-scan assertion).
2. **Admin combine** — flag-ON, the Admin surface exposes both the maintenance
   actions and the config editor via the `AdminViews` toggle (fixture
   DASH-0C-002 + the `AdminViews` / `aria-label="Admin views"` source-scan
   assertion).
3. **Flag-off byte-identical** — `MEGACOMPACT_DASH_0C=0`: CacheTab renders
   cache-only (Performance section skipped), the standalone
   MetricsTab/MaintenanceTab/ConfigTab surfaces hold, and SetupTab keeps its
   Config sub-tab (fixture DASH-0C-003).

## Conformance fixtures

- `DASH-0C-001` — `{ surface:"cache-perf", cache_sections:true, perf_cards:true }`.
- `DASH-0C-002` — `{ surface:"admin", maintenance_present:true, config_present:true }`.
- `DASH-0C-003` — `{ flag_enabled:false, cache_only:true, standalone_surfaces_intact:true }`.
- All canonical (UTF-8 NFC, sorted keys, LF-final) + sha256-pinned. `kind` =
  `dashboard-tab-plan`; schema `schemas/dashboard-consolidation-fixture.schema.json`.
  Owner CSV +DASH-0C; fixture count grows by 3 (937 → 940).

## Test outcomes (HEAD, flag-agnostic)

- [x] `npm run build` → clean (tsc -p tsconfig.json + publish-acceptance)
- [x] `node --test dist/vector-cortex/dash0c-acceptance.test.js` → **12 pass / 0 fail**
- [x] `MEGACOMPACT_DASH_0C=0 node --test dist/vector-cortex/dash0c-acceptance.test.js`
  → **12 pass / 0 fail** (flag-off same-pass parity)
- [x] `npm test` → **4093 passed, 0 failed across 412 files** (full suite, clean run)
- [x] `npm run lint` → clean (tsc --noEmit + guardrails-scan + semantic-scan clean)
- [x] `python3 scripts/regression_check.py --all` → **0 blocking** (7 dev-only/moderate
  npm audit warnings unchanged; all MEGACOMPACT_* env vars have dashboard settings
  entries; all training/vector-cortex python files compile)
- [x] `node scripts/guardrails-scan.mjs` → clean
- [x] `node scripts/vector-cortex-conformance.mjs --check` → **940 fixtures canonical**
- [x] `node scripts/vector-cortex-docs-check.mjs` → **65 sprints / 16 phases clean**
- [x] `python3 scripts/log_failure.py --list` → no active failures in scope
- [x] `git diff --check` → clean
- [x] `cd extensions/dashboard-client && npm run typecheck && npm run build` → clean
  (CacheTab + MetricsCards + MetricsTab + AdminTab + SetupTab + registry + index
  all typecheck under the dashboard-client tsconfig; `noUnusedLocals` clean; bundle
  built — `MetricsCards` and `AdminTab` split into their own chunks, lazy-load
  smoke passes with no Suspense error)

## Migration and rollback

**Migration:** pure — no store schema/state change, no events.log format change.
UI-only: component files moved/re-grouped, no endpoint change (merged views reuse
the same localhost `GET /api/snapshot`, `/api/perf`, `/api/provider-cache` and
admin/mutation endpoints the prior standalone surfaces used; reader surfaces stay
reader-only, mutation surfaces stay admin+audit gated).

**Rollback:** set `MEGACOMPACT_DASH_0C=0`. CacheTab collapses to its cache-only
body; the Performance section and AdminTab/SetupTab config-hiding collapse; the
standalone MetricsTab/MaintenanceTab/ConfigTab surfaces return. Predecessor bytes
hold, evidence not deleted. No operator migration.

## Failure triad (A/B/C)

- **A (cache+performance)** — the merged Cache surface renders both the cache
  sections and the Performance card section → fixture DASH-0C-001 + the
  `<section aria-labelledby="cache-perf-cards">` source-scan assertion.
- **B (admin combine)** — the Admin surface renders both the maintenance actions
  and the config editor → fixture DASH-0C-002 + the `AdminViews` toggle source-scan
  assertion.
- **C (flag-off)** — CacheTab renders cache-only and the standalone
  MetricsTab/MaintenanceTab/ConfigTab surfaces hold → fixture DASH-0C-003 + the
  flag gate.
- Legacy sections (Topics/Achievements/Game) are explicit, independent inputs with
  the documented `keep_but_listed_under:"admin"` disposition; untouched this sprint.

## Spec-staleness deviations (rationale)

- **Client flag read** — the spec referenced `dash0cEnabled(settingsData)` checking
  `settingsData["MEGACOMPACT_DASH_0C"]?.enabled ?? true`. The dashboard-client is a
  browser bundle with no `process` global and the `/api/rag-settings` contract does
  NOT expose a top-level `settingsData[key].enabled` map — it returns grouped
  `categories[].settings[]` entries with a boolean `value`. So the helper follows
  the exact DASH-0B pattern (`dash0bEnabled` in `SessionsTab.tsx`): iterate
  categories and return `s.value === true` for the `MEGACOMPACT_DASH_0C` key.
  Absent/not-yet-loaded => false (flag-off posture), so the Performance section /
  Admin toggle / Setup config-hiding never flash before settings confirm ON. The
  acceptance test (root `node --test`) still reads `DASH_0C_ENABLED()` directly
  from the config module (server-side), so the flag-invariant test is unaffected.
- **`src/config.ts` line count** — the spec's ownership said `≤205` but the file was
  already 223 lines before this sprint's +1 (24 new) — 224 total, still far under
  the `src/` 300 soft / 500 hard limits. The `≤205` figure in the spec was stale.
- **Consolidated "Cache+Performance" label** — the runtime 13-tab `PRIMARY_TABS`
  "Cache" label is not rendered inside `CacheTab.tsx`; changing it would alter the
  live 13-tab UI, which this sprint must not do (DASH-0d rewires App.tsx). So the
  consolidated label is recorded additively as `DASH_SURFACE_LABELS["cache-perf"] =
  "Cache+Performance"` in `registry.ts` and documented in the `index.ts` barrel
  comment, while the 13-tab labels stay untouched (rollback-safe).
- **AdminTab flag-off hosting** — the spec says "flag-OFF = not mounted as a
  surface". Since App.tsx does not switch to the barrel this sprint (DASH-0d
  rewires), no top-level route mounts AdminTab yet. To keep the new AdminTab a
  safe drop-in for the predecessor `admin → MaintenanceTab` alias regardless of
  flag, flag-OFF renders only `MaintenanceTab` (the full toggle + ConfigTab branch
  appears only flag-ON). This is strictly additive — the prior registry order and
  routing hold.
- **`EXPECTED_SPRINTS`** — the spec says "performs no per-sprint bump." The docs
  check counts the already-present DASH-0c spec file in its EXPECTED_SPRINTS=65;
  no change needed; docs-check passes.

## File sizes and baseline exceptions

Final line counts for every file this sprint created or modified (all under the
`extensions/` 400 soft / `src/` 300 soft / `tests/` 600 hard caps; no baseline
exceptions):

- `src/config/vector-cortex-dash-0c.ts` (25)
- `src/config/vector-cortex.ts` (108)
- `src/config.ts` (224)
- `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts` (352)
- `extensions/dashboard-client/src/tabs/CacheTab/MetricsCards.tsx` (66)
- `extensions/dashboard-client/src/tabs/CacheTab.tsx` (274)
- `extensions/dashboard-client/src/tabs/MetricsTab.tsx` (17)
- `extensions/dashboard-client/src/tabs/AdminTab.tsx` (81)
- `extensions/dashboard-client/src/tabs/MaintenanceTab.tsx` (63)
- `extensions/dashboard-client/src/tabs/ConfigTab.tsx` (271)
- `extensions/dashboard-client/src/tabs/SetupTab.tsx` (106)
- `extensions/dashboard-client/src/tabs/registry.ts` (94)
- `extensions/dashboard-client/src/tabs/index.ts` (31)
- `src/vector-cortex/dash0c-acceptance.test.ts` (195)

## Controller-run gates (require a commit SHA; run post-commit)

- `node scripts/vector-cortex-scope-check.mjs DASH-0C <COMMIT_SHA>` — every
  committed file must fall inside the declared ownership ∪ fixed cross-cutting
  seams. This sprint leaves all files uncommitted for controller review.
- `node scripts/vector-cortex-evidence-check.mjs DASH-0C` — re-derives the line
  counts / test counts / fixture count / flag parity claims in this record from
  the tree; must agree.
- `node scripts/log_failure.py --list` — done (see Test outcomes); no new failures.

Reviewer-accepted by controller (2026-08-07). Gates are green. Spec amended
to include tabs/index.ts + tabs/registry.ts in Production ownership (the
spec's task 6 explicitly requires additive registry/barrel changes but
omitted them from the file list — same pattern as DASH-0B). All 16 sprint
files verified against the amended Production ownership field.
