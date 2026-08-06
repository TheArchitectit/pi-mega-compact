# DASH-0d — Rollup: a11y audit, lazy-load reconciliation, flag cleanup, 7-top-level verifier

**Status:** planned | **Depends on:** DASH-0b, DASH-0c | **Phase:** DASH
**Flag:** `MEGACOMPACT_DASH_0D`, defined in `src/config/vector-cortex-dash-0d.ts` (sibling per the vc9d precedent; `src/config/vector-cortex.ts` is at the 300-line soft limit), re-exported by `src/config/vector-cortex.ts` + root `src/config.ts`, default ON; `MEGACOMPACT_DASH_0D=0` disables and must be byte-identical to the predecessor (the App lazy list and registry hold the pre-rollup 13-tab surface set; no removal of indirection names; no new audit/verifier invoked by CI). Registered in `VECTOR_CORTEX_SETTINGS` as a visible boolDirect toggle, never in `EXCLUDED_SETTINGS`.

## Goal and inputs/outputs

Final DASH sprint — the roll-up that makes the 7-surface target externally provable and closes external-audit #9. Four deliverables, all additive-inside-branches so the flag can still reproduce the predecessor 13-tab surface set exactly:

**(1) Accessibility audit hooks** — new `scripts/dashboard-audit.mjs`: launches the built dashboard (or the dev client against a static bundle) and runs axe-core surfaced through the accesslint engine against the merged 7 surfaces, asserting the a11y nav-map from DASH-0a (`DASH_NAV_MAP`): each surface has a landmark `<nav aria-label>`, each merged sub-view has its own `<nav aria-label>`, every `<section>` has an `aria-labelledby` heading id, and the tablist/tab roles match existent `TabBar`/`SetupTab` patterns. Failures of severity serious/critical (WCAG A/AA) fail the gate. Dry-run tolerant: no page (headless Chrome missing) reports a clear non-zero "AUDIT-UNAVAILABLE" and does not silently pass.

**(2) Lazy-loading reconciliation (App.tsx)** — rewrite `App.tsx`'s lazy import list to the consolidated surfaces: `OverviewTab, SessionsTab (sessions+turns), CacheTab (cache+perf), MemoryMapTab (memory graph), VectorCortexTab (diagnostics), SetupTab, AdminTab`. The `TabContent` switch maps the new consolidated `TabId` set; the DASH-0a `DEEP_LINK_TARGETS` becomes a live hash→surface router: `#sessions`, `#turns`→sessions; `#cache`, `#metrics`→cache-perf; `#repos`,`#wiki`,`#memory-map`→memory-graph; `#events`,`#health`,`#vector-cortex`→diagnostics; `#maintenance`,`#config`→admin; `#setup`,`#overview`→ themselves. No URL has routing exists today (single `useState<TabId>("overview")`), so this is an ADDITIVE hash listener — empty hash keeps current behavior (default overview), and every old hash still lands on a live surface (no dead links). `NEW_UI` old dashboard path keeps the legacy 13-tab `TabBar` set.

**(3) Feature-flag / indirection cleanup** — remove names made indirection-only by the merge: the standalone `TurnsTab.tsx` and `MetricsTab.tsx` shell copies (deep-link audit in (2) proves no live consumer points at them), the `legacy_sections` (Topics/Achievements/Game) disposition resolved — each either gains an Admin sub-tab (if the audit shows a real user path) or is documented retired and removed from the registry dead set; `TopicsTab.tsx` "kept, unused" note is closed (retired or re-homed). Indirection names now owned solely by the consolidated barrel.

**(4) Tab-count verifier + conformance + evidence roll-up** — new `scripts/dash-tab-count.mjs`: statically reads `App.tsx`'s `TabContent` switch + `registry.ts` `DASH_TAB_COUNT` and asserts exactly **7 top-level navigational surfaces**; exits non-zero on any deviation. New conformance fixtures DASH-0D-001..004 for the route surfaces; `EXPECTED_SPRINTS` 48→49; final roll-up evidence `DASH-0D.md` recording the full gate pass + the 13→7 accounting.

Production ownership: `extensions/dashboard-client/src/App.tsx (lazy list + hash router + TabContent consolidation), extensions/dashboard-client/src/tabs/registry.ts (TabId union compacted to the 7 surfaces; DASH_NAV_MAP + DEEP_LINK_TARGETS consumed), extensions/dashboard-client/src/tabs/TurnsTab.tsx (removal — duplicate reconciled), extensions/dashboard-client/src/tabs/MetricsTab.tsx (removal — duplicate reconciled), extensions/dashboard-client/src/tabs/AdminTab.tsx (expand to Admin sub-tabs for retained legacy sections), extensions/dashboard-client/src/tabs/TopicsTab.tsx (resolve keep-vs-retire per audit), extensions/dashboard-client/src/tabs/dashHashRouter.ts (new — hash→surface listener), scripts/dashboard-audit.mjs (new — axe/accesslint audit), scripts/dash-tab-count.mjs (new — 7-surface verifier), src/config/vector-cortex-dash-0d.ts (new), src/config/vector-cortex.ts (additive re-export, ≤300), src/config.ts (additive re-export, ≤205), extensions/dashboard-server/routes-rag-settings-vector-cortex.ts (additive boolDirect toggle), conformance/vector-cortex/v2/dashboard-consolidation/DASH-0D-001..004.json (new) + manifest.json rows + gen-fixtures script scripts/dash-consolidation/gen-fixtures.mjs (new), docs/vector-cortex/sprints/DASH-0d-rollup-accessibility-lazyload-flags.md (this spec), docs/vector-cortex/evidence/DASH-0D.md (new roll-up), scripts/vector-cortex-docs-check.mjs (EXPECTED_SPRINTS 48→49)`.

The dashboard's rendering surface changes (bundle weight) ONLY when `MEGACOMPACT_DASH_0D=1`; flag-off must produce the pre-rollup 13-surface lazy list (evidence pinned by the flag-off comparison + `dash-tab-count.mjs` acknowledging the flag).

## Numbered implementation tasks

1. Add the `MEGACOMPACT_DASH_0D` flag (default ON, `=0` byte-identical) in the sibling config, re-exports, and the `VECTOR_CORTEX_SETTINGS` boolDirect toggle ("Dashboard Consolidation — Rollup/7-surface").
2. Create `scripts/dash-tab-count.mjs`: parse `App.tsx` `TabContent` + `registry.ts`; assert exactly 7 top-level surfaces when flag-ON; print the 13→7 accounting; exit non-zero otherwise. It must read `MEGACOMPACT_DASH_0D` and report the expected count per flag state (7 on / 13 off).
3. Create `extensions/dashboard-client/src/tabs/dashHashRouter.ts`: an additive `useHashTab(hashTab)` hook mapping `DEEP_LINK_TARGETS` to a consolidated `TabId` (defaults to current behavior on empty hash). Wire it into `App.tsx`.
4. Rewrite `App.tsx` lazylist + `TabContent` to the 7 consolidated surfaces behind the flag (flag-off branch reproduces the 13-surface lazy list byte-identically); `.replace` the registry to the compact 7-id union with the same flag branch.
5. Remove the duplicate `TurnsTab.tsx` and `MetricsTab.tsx` standalone shells once the deep-link audit (task 6) proves no live consumer (SessionsTab mounts `TurnMemoryView`; CacheTab mounts `MetricsCards`). Rollback symmetry: their body components (`TurnMemoryView`, `MetricsCards`) are the new canonical homes; a flag-off build must still surface turns/metrics (the merged surfaces are the only consumers — the removal is safe because the merge already re-homed the bodies in DASH-0b/0c).
6. Run `scripts/dashboard-audit.mjs` against the built merged client: assert the `DASH_NAV_MAP` a11y contract — one landmark nav per surface, per-sub-view navs, `aria-labelledby` sections, tablist roles. Fix any serious/critical findings. Resolve the `legacy_sections` disposition (retain the reaches-natural-user-path ones as Admin sub-tabs in `AdminTab.tsx`; retire the rest from the registry).
7. Create `scripts/dash-consolidation/gen-fixtures.mjs` emitting `DASH-0D-001..004.json` (route-surface matrix: overview→7, hash deep-links resolve, flag-off 13, tab-count===7) + register rows + owner `DASH` in the v2 manifest with algorithm `dashboard-consolidation`.
8. Add `src/vector-cortex/dash0d-acceptance.test.ts`; bump `EXPECTED_SPRINTS` 48→49; write evidence `DASH-0D.md` recording the 13→7 accounting, the full gate pass, and a note that DASH-0B/0C/0D together close external-audit #9 (prior DASH-0a supplied the map).

## Failure triad and independence

A: the 7-surface rollup builds and renders with every deep link resolving to a live surface (DASH-0D-001/002). B: the hash router maps every legacy hash (`#turns`, `#metrics`, `#repos`, …) to its consolidated surface (DASH-0D-002). C: flag-off reproduces the pre-rollup 13-surface lazy list byte-identically and `dash-tab-count.mjs` reports 13 (DASH-0D-003/004). A and B use the additive hash router + consolidated switch; C uses the flag branch restoring the original lazy list. All three use independent routing inputs (the new switch / the new hash map / the flag-restored list).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/dashboard-consolidation/`.

- `DASH-0D-001: the merged dashboard exposes exactly 7 top-level navigational surfaces` — `{ surfaces:7, expected_surfaces:["overview","sessions","cache-perf","memory-graph","diagnostics","setup","admin"] }`. Pinned by `scripts/dash-tab-count.mjs`.
- `DASH-0D-002: every legacy hash deep-link resolves to a live consolidated surface` — `{ hash:"#turns", surface:"sessions", resolves:true }` (matrix over all 13 legacy hashes). No dead surface.
- `DASH-0D-003: flag-off reproduces the 13-surface lazy list byte-identically` — `{ flag_enabled:false, surfaces:13, byte_identical:true }`.
- `DASH-0D-004: a11y audit passes serious/critical-clean on the merged surfaces` — `{ surfaces:7, serious_critical_violations:0, nav_map_satisfied:true }`.

Sprint acceptance aggregator: `src/vector-cortex/dash0d-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/dash0d-acceptance.test.js
```

Expected assertions: all DASH-0D-001..004 registered with algorithm `dashboard-consolidation` against the `dashboard-consolidation-fixture` schema; 001/002/004 assert the merged surface count, the deep-link matrix, and the a11y pass; 003 asserts the flag-off 13-surface parity. Client-dimension checks: `cd extensions/dashboard-client && npm run typecheck && npm run build` (client touched — MANDATORY) + the lazy-load smoke (SessionsTab, CacheTab, VectorCortexTab, AdminTab all load) + the asset-gate (packaging now changes — dashboard bundle is rebuilt and `npm pack --dry-run` must still list `extensions/dashboard-client/dist/index.html`; this IS an asset-gate sprint). Exact flag-off comparison: `MEGACOMPACT_DASH_0D=0 node --test dist/vector-cortex/dash0d-acceptance.test.js`; the aggregator is flag-agnostic. Apply [EVALUATION](../EVALUATION.md) rules; hard causal/tool/anchor/exact failures are zero-tolerance. Unique failure injection: a hash deep-link whose target surface was retired without a router entry; the 002 resolve-matrix assert must fail.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure — no schema/state migration; UI-only**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md) — no new payload surface; the hash router is a client-side view concern only, no endpoint reads added; the audit reads DOM structure, never payload bytes. Dashboard: consolidated lazy list + hash router + AdminTab legacy resolution + audit/verifier scripts; no endpoint registry change. Run `cd extensions/dashboard-client && npm run typecheck && npm run build` + the asset-gate (rebuilt dashboard bundle still listed by `npm pack --dry-run`, verify index.html present) + the lazy-load smoke.

Rollback sets `MEGACOMPACT_DASH_0D=0`; the 13-surface lazy list is restored byte-identically (the merged components live on but the registry/lazy-list flag branch reproduces the predecessor surface set), `dash-tab-count.mjs` reports 13, and the audit/verifier are not CI-invoked — evidence not deleted. Next handoff: program handoff notes DASH-0A→0D together close external-audit #9.

## Live Playwright validation (MANDATORY)

The merged 7-surface dashboard must be exercised live in a browser before evidence is accepted. Run `npm run build` + `./scripts/deploy.sh <patch>` (per-sprint publish), then with the dashboard reachable at the loopback host (default `http://localhost:9320`), drive Playwright (`browser_navigate` / `browser_snapshot` / `browser_click`) to assert:
- the 7 consolidated surfaces render (overview, sessions, cache-perf, memory-graph, diagnostics, setup, admin);
- every legacy hash deep-link resolves to a live consolidated surface (matrix over `#sessions`/`#turns`/`#cache`/`#metrics`/`#repos`/`#wiki`/`#memory-map`/`#events`/`#health`/`#vector-cortex`/`#maintenance`/`#config`/`#overview`) with no dead surface;
- `dash-tab-count.mjs` reports 7 on the flag-on tree and 13 on the flag-off tree (`MEGACOMPACT_DASH_0D=0` render check);
- `scripts/dashboard-audit.mjs` (the DASH-a11y audit) passes serious/critical-clean on the merged surfaces against the live DOM;
- no client console errors after navigation across all 7 surfaces.

If no reachable dashboard host exists, the sprint pauses at implementer-complete until a live host is available to run the Playwright pass; evidence must state which host was used and the live surface/hash matrix observed.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/dash0d-acceptance.test.js`, `MEGACOMPACT_DASH_0D=0 node --test dist/vector-cortex/dash0d-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all --soft-as-hard --soft-as-hard-base <PREV_TAG> --pre-commit`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, `node scripts/vector-cortex-scope-check.mjs DASH-0D <COMMIT_SHA>`, `node scripts/vector-cortex-evidence-check.mjs DASH-0D`, `git diff --check`, `cd extensions/dashboard-client && npm run typecheck && npm run build`, plus the two new rollup commands `node scripts/dash-tab-count.mjs` and `node scripts/dashboard-audit.mjs`, and the asset-gate (`npm pack --dry-run` listing `extensions/dashboard-client/dist/index.html`). No permissive globs or warning-only scans count.

Scope-check note: the dashboard asset bundle changes, so the `<COMMIT_SHA>` in the scope-check command is this sprint's commit (run AFTER commit). `scripts/vector-cortex-docs-check.mjs` is touched by the integration pass only — DASH-0d performs no per-sprint bump (the single reconciliation owns EXPECTED_SPRINTS=60 at program commit). The new conformance fixture dir `dashboard-consolidation/` must list its manifest.json rows (DASH-0A-001..003, DASH-0B-001..003, DASH-0C-001..003, DASH-0D-001..004).
