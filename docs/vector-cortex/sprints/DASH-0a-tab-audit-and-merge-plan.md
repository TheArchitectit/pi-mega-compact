# DASH-0a — Tab inventory audit + consolidation merge plan

**Status:** planned | **Depends on:** external-audit #9 (dashboard tab count) | **Phase:** DASH
**Flag:** `MEGACOMPACT_DASH_0A`, defined in `src/config/vector-cortex-dash-0a.ts` (extracted sibling per the `vector-cortex-vc9d.ts` precedent because `src/config/vector-cortex.ts` is at the 300-line soft limit), re-exported by `src/config/vector-cortex.ts` + root `src/config.ts`, default ON; `MEGACOMPACT_DASH_0A=0` disables and must be byte-identical to the predecessor (all 13 tab/section top-level files render exactly as today — the shell and lazy list are untouched by this sprint). Registered in `VECTOR_CORTEX_SETTINGS` as a visible boolDirect toggle, never in `EXCLUDED_SETTINGS`.

## Goal and inputs/outputs

**Contract-planning sprint — no product behavior changes.** External-audit #9 counts 13 dashboard tab/section top-level surfaces (the canonical audit count; the App registry lists 13 `TabId` values — 5 primary + 8 advanced — while `TopicsTab.tsx` is "kept, unused" per its own header and `GameTab`/`AchievementsTab`/`ConfigTab` render as Setup sub-tabs). The user mandate is to collapse to **7 navigational surfaces**: Overview, Sessions, Cache+Performance, Memory Graph, Diagnostics, Setup, Admin. This sprint is the single source of truth for (a) the full route/feature inventory, (b) the per-card placement decision matrix mapping every current top-level component + delegate card to its 7-surface destination, (c) the deep-link strategy, (d) the accessibility nav-map, and (e) the responsive plan. It ships ONLY the inventory + plan as concrete data structures the later DASH-0b/0c/0d sprints consume.

Inputs are the existent dashboard tree and route registry. Outputs: `src/dash-consolidation/plan.ts` exposing typed `DASH_TAB_PLAN` (7 surfaces, each with its source `TabId[]` + merged delegate card ids), `DASH_TAB_COUNT = 7`, `DEEP_LINK_TARGETS` (old route → new surface/sub-tab map), and the a11y nav-map constant; plus the widget-types.ts comment fix (collateral, below). THE FIXED 7 ARE OUT OF SCOPE FOR CHANGE — this sprint only records the map; DASH-0b/0c move components.

Production ownership: `extensions/mega-runtime/widget-types.ts (comment-only — line 58), extensions/dashboard-client/src/dash-consolidation/plan.ts (new — the typed merge plan + deep-link map + a11y nav-map + tab-count constant), src/vector-cortex/dash0a-plan.test.ts (new — audit-derived invariants, root node --test; spec-staleness deviation: dashboard-client has no test runner, so this test ship as a root node --test file compiled by root tsc), src/vector-cortex/dash0a-acceptance.test.ts (new — acceptance aggregator, root node --test), src/config/vector-cortex-dash-0a.ts (new), src/config/vector-cortex.ts (additive re-export, stays ≤300), src/config.ts (additive re-export, stays ≤205/200 soft — exactly one line), extensions/dashboard-server/routes-rag-settings-vector-cortex.ts (additive boolDirect toggle), docs/vector-cortex/sprints/DASH-0a-tab-audit-and-merge-plan.md (this spec), scripts/vector-cortex-docs-check.mjs (EXPECTED_SPRINTS 45→46)`. The OWNER file is `extensions/dashboard-client/src/tabs/` **by declaration only** — this sprint performs NO delegate-shell moves; DASH-0b/0c execute them against this plan. No component files inside `src/tabs/` are edited here.

Collateral (zero-risk, explicitly requested): fix the stale comment at `extensions/mega-runtime/widget-types.ts:58` — the line `/** Player level (game-mode). Stub = 1 until S33 wires the real scoring. */` — because S33 already wired the real scoring: `getTurnLevelImpl` in `extensions/mega-runtime/runtime-helpers.ts:115-119` computes `floor(log2(turns+1))+1`. The fix is COMMENT-ONLY (no code token change): reword to reference the S33 live derivation. `widget-types.ts` is a pure-type module, so this is byte-safe on the emitted JS and is a documented ownership footgun under soft-as-hard only if the comment line count changes the file over its soft limit — verify it stays under (currently 84 lines, no risk).

## Numbered implementation tasks

1. Define `DASHSurface` / `DASH_TAB_PLAN` in `dash-consolidation/plan.ts`: the fixed 7 surfaces (`overview`, `sessions`, `cache-perf`, `memory-graph`, `diagnostics`, `setup`, `admin`), each with `sources: TabId[]` mapped from the current registry (`overview:["overview"]`, `sessions:["sessions","turns"]`, `cache-perf:["cache","metrics"]`, `memory-graph:["memory-map","repos","wiki"]`, `diagnostics:["vector-cortex","events","health"]`, `setup:["setup"]`, `admin:["maintenance"]`). TopicsTab/AchievementsTab/GameTab are recorded as `legacy_sections` with an explicit `keep_but_listed_under:"admin"` disposition. No `any`.
2. Add the `MEGACOMPACT_DASH_0A` flag (default ON, `=0` byte-identical) in `src/config/vector-cortex-dash-0a.ts` (sprintFlag pattern), the `vector-cortex.ts` + `config.ts` re-exports, and the `VECTOR_CORTEX_SETTINGS` boolDirect toggle ("Dashboard Consolidation — Tab Plan").
3. Define `DEEP_LINK_TARGETS` in `plan.ts`: a read-only map from every current `TabId` (`"sessions"`, `"turns"`, `"metrics"`, `"cache"`, `"repos"`, `"events"`, `"setup"`, `"wiki"`, `"maintenance"`, `"memory-map"`, `"health"`, `"vector-cortex"`, `"overview"`) to a canonical `{ surface, subTabHint }`. Turns → sessions drill-down; metrics → cache-perf perf-card; events/health/vector-cortex → diagnostics. It feeds the DASH-0d hash router; it does not change `App.tsx` routing here.
4. Define the a11y nav-map constant `DASH_NAV_MAP`: one landmark row per fixed surface with its primary `<nav aria-label>` + sub-tab `<nav aria-label>` (Sessions→"Session windows", Cache+Performance→"Performance cards", Diagnostics→"Diagnostics groups"), the tablist roles already established in `TabBar`/`SetupTab`, and focus-order note. No ARIA markup is emitted in this sprint — the constant is the contract DASH-0d's axe hooks validate.
5. Define the responsive plan constants `DASH_RESPONSIVE`: per-surface column strategy (all grids stay `grid-cols-1 md:grid-cols-3`, matching existent card grids) and the collapse of sub-tab toggles to a horizontal scroll region below `sm`. Document that merged surfaces reuse existent card grids verbatim (no new layout abstraction).
6. Add `dash-consolidation/plan.test.ts` pinning: exactly 7 surfaces; every current `TabId` appears in exactly one `sources` or `legacy_sections` bucket (audit-derived, total 13); every merged card id in the plan exists in the source file tree by filename regex `VectorCortex*(Card|Topology).tsx|MaintenanceTab/*|MemoryMapTab/*|WikiTab/*|SetupTab/*`; `DASH_TAB_COUNT === 7`; and the config sub-tab is recorded under the Setup surface as `setup_subtabs:["config"]` (the existent SetupTab SUB_TABS member), NOT under admin — `admin` is NOT a `TabId`.
7. Apply the `widget-types.ts:58` comment-only fix; verify the file stays under its soft limit.
8. Write the colonless evidence note (this is a pure-doc sprint — no E2E surface change). The `EXPECTED_SPRINTS` reconciliation is owned by the single integration step (45→60 at program commit) — this spec performs no per-sprint bump.

## Failure triad and independence

A: the merged 7-surface plan resolves every current TabId + every delegate card to exactly one destination (fixture DASH-0A-001). B: a plan row collides or a current TabId is dropped (an audit regression — internal cartesian error over the extracted source list) (fixture DASH-0A-002). C: flag-off — the plan module is present but unused; no routing/shell change, byte-identical predecessor (fixture DASH-0A-003). A and B are produced purely by the plan data being consistent/inconsistent with the pinned source list; C is produced by the flag gate (the plan type is inert until DASH-0d wires it). All three share no live component state.

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/dashboard-consolidation/` (new family; schema `schemas/dashboard-consolidation-fixture.schema.json`).

- `DASH-0A-001: the 7-surface plan covers every current TabId exactly once` — `{ kind:"dashboard-tab-plan", surfaces:7, source_tab_ids:13, each_mapped_once:true }`.
- `DASH-0A-002: no placement collision and no dropped source` — `{ collision:false, dropped_sources:[] }`. Blocks the "silently lose a surface on rollup" bug class.
- `DASH-0A-003: flag-off leaves the shell untouched (byte-identical predecessor)` — `{ flag_enabled:false, routing_changed:false, shell_touched:false }`.

Sprint acceptance aggregator: `src/vector-cortex/dash0a-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/dash0a-acceptance.test.js
```

Expected assertions: all DASH-0A-001..003 registered with algorithm `dashboard-tab-plan` against the `dashboard-consolidation-fixture` schema; 001 asserts `surfaces===7` and source coverage sums to 13 with no duplicates; 002 asserts zero collisions/vacuity; 003 asserts the flag-off predecessor byte-parity is a pure property of the plan module being inert. The client-side `plan.test.ts` runs under `cd extensions/dashboard-client && npm run typecheck && npm run build` + the vitest suite. Exact flag-off comparison: `MEGACOMPACT_DASH_0A=0 node --test dist/vector-cortex/dash0a-acceptance.test.js`; the aggregator is flag-agnostic. Apply [EVALUATION](../EVALUATION.md) rules; hard causal/tool/anchor/exact failures are zero-tolerance. Unique failure injection: a plan row that lists a current `TabId` in TWO surfaces; the coverage assert must fail (the injector never ships, it only proves the assert is live).

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure — no schema/state migration; UI-only** (all four DASH sprints are UI-only by declaration; DASH-0a moves no component bytes). Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md) — this sprint creates no new payload surface (plan.ts is a static constant module; no new endpoint, no new data read). Dashboard: the plan + nav-map constants only; no route change. Run `cd extensions/dashboard-client && npm run typecheck && npm run build`.

Rollback sets `MEGACOMPACT_DASH_0A=0`; the plan module goes inert (never imported by the shell) and the shell is byte-identical to the predecessor — no evidence deleted, no golden bytes changed. No operator migration.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/dash0a-acceptance.test.js`, `MEGACOMPACT_DASH_0A=0 node --test dist/vector-cortex/dash0a-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all --soft-as-hard --soft-as-hard-base v0.20.29 --pre-commit`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, `node scripts/vector-cortex-scope-check.mjs DASH-0A <COMMIT_SHA>`, `node scripts/vector-cortex-evidence-check.mjs DASH-0A`, `git diff --check`, `cd extensions/dashboard-client && npm run typecheck && npm run build`. No permissive globs or warning-only scans count.

Scope-check note: this sprint's OWNER declaration names `extensions/dashboard-client/src/tabs/` for the *plan* only; the actual moves are DASH-0b/0c. If scope-check flags any moved file, force a one-line deviation note in the evidence and keep the move in the owning sprint, not here.
