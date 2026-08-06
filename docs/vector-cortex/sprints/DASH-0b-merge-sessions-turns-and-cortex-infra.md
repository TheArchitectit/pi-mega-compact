# DASH-0b — Merge Sessions+Turns and reorganize Vector Cortex into sections

**Status:** planned | **Depends on:** DASH-0a | **Phase:** DASH
**Flag:** `MEGACOMPACT_DASH_0B`, defined in `src/config/vector-cortex-dash-0b.ts` (sibling per the vc9d precedent; `src/config/vector-cortex.ts` is at the 300-line soft limit), re-exported by `src/config/vector-cortex.ts` + root `src/config.ts`, default ON; `MEGACOMPACT_DASH_0B=0` disables and must be byte-identical to the predecessor (SessionsTab and TurnsTab render as two independent top-level surfaces and VectorCortexTab keeps its flat 14-card layout — exactly as pre-DASH). Registered in `VECTOR_CORTEX_SETTINGS` as a visible boolDirect toggle, never in `EXCLUDED_SETTINGS`.

## Goal and inputs/outputs

First execution sprint of the DASH plan (consumes `DASH_TAB_PLAN` from DASH-0a). Two merges, both **delegate-shell** so every moved component file is byte-preserved and no monolith forms:

**(1) Sessions ← SessionsTab + TurnsTab.** `SessionsTab.tsx` stays the top-level surface and absorbs TurnsTab as a drill-down. A `SessionsViews` section toggle ("Active Sessions" / "Turn Memory") switches between the existent sessions summary/chart/table and the existent turns view. TurnsTab's content is extracted into `tabs/SessionsTab/TurnMemoryView.tsx` (delegate-shell re-exporting the moved body) so the merged Sessions file stays under the `extensions/` 400 soft limit; the TurnsTab.tsx top-level file is reduced to a shell that renders `TurnMemoryView` (kept reachable so the DASH-0d deep-link `#turns` has an anchor) or, cleaner, deleted after DASH-0d relocates all references — this sprint keeps the shell for rollback symmetry.

**(2) VectorCortexTab ← 18 delegate cards → 4 sections.** The existent `VectorCortexTab.tsx` renders 18 flat delegate cards in one column (the 17 `VectorCortex*Card` enumerated below plus `ModelImprovementCard`). This sprint groups them under 4 `<section aria-labelledby>` headers: **Cortex status** (`VectorCortexTopologyCard`, `VectorCortexShardsCard` + the embedded Reconstruct, and the VC0C health card + `ModelImprovementCard`), **Cortex repair** (`VectorCortexClosureCard`, `VectorCortexRestoreCard`, `VectorCortexRepairCard`), **Cortex cache** (`VectorCortexCrystalsCard`, `VectorCortexEconomicsCard`, `VectorCortexDiagnosticsCard`), **Cortex adaptive** (`VectorCortexOutcomesCard`, `VectorCortexPolicyCard`, `VectorCortexPlansCard`, `VectorCortexRenderCard`, `VectorCortexRolloutCard`, `VectorCortexPlatformCard`, `VectorCortexLedgerCard`). `VectorCortexTab.tsx` stays a delegate-shell (≤400 soft) that imports the new `tabs/VectorCortexTab/sections.tsx` which renders the four section groups. No card component file is edited — only their import grouping.

**New tab barrel** `src/tabs/index.ts`: re-exports the 7 surface entry points the new registry will use (DASH-0d rewires `App.tsx`'s lazy list), mapping consolidated surfaces to their host components (`SessionsTab`, `VectorCortexTab`, etc.). The barrel is additive; `App.tsx` does NOT switch to it in this sprint.

Production ownership: `extensions/dashboard-client/src/tabs/SessionsTab.tsx (delegate-shell — views toggle + drill-down, stays ≤400 soft), extensions/dashboard-client/src/tabs/SessionsTab/TurnMemoryView.tsx (new — moved turns body, verbatim), extensions/dashboard-client/src/tabs/TurnsTab.tsx (reduced to a shell re-exporting TurnMemoryView, byte-identical on `MEGACOMPACT_DASH_0B=0`? NO — must remain unchanged when flag off), extensions/dashboard-client/src/tabs/VectorCortexTab.tsx (delegate-shell — 4 sections), extensions/dashboard-client/src/tabs/VectorCortexTab/sections.tsx (new — the 4 section groups), extensions/dashboard-client/src/tabs/index.ts (new barrel), extensions/dashboard-client/src/tabs/registry.ts (additive — DASH surface ids documented, kept compatible), src/config/vector-cortex-dash-0b.ts (new), src/config/vector-cortex.ts (additive re-export, ≤300), src/config.ts (additive re-export, ≤205), extensions/dashboard-server/routes-rag-settings-vector-cortex.ts (additive boolDirect toggle), docs/vector-cortex/sprints/DASH-0b-merge-sessions-turns-and-cortex-infra.md (this spec), scripts/vector-cortex-docs-check.mjs (EXPECTED_SPRINTS 46→47)`.

Flag-off layering (CRITICAL): because `TurnsTab.tsx` must stay byte-identical when the flag is off, the merge branch lives entirely behind `MEGACOMPACT_DASH_0B`: the existent `TurnsTab.tsx` default export keeps rendering its full body, and `SessionsTab.tsx` when flag-OFF renders only its own body (no TurnsTab import). Flag-ON, `SessionsTab` renders the views toggle including the turns drill-down. To keep `TurnsTab.tsx` unchanged when flag off yet reduce duplication when on, the existent TurnsTab body moves VERBATIM into `SessionsTab/TurnMemoryView.tsx`; `TurnsTab.tsx` becomes: flag-ON → `TurnMemoryView`; flag-OFF → the ORIGINAL full body must still render. This forces keeping both the original body AND `TurnMemoryView` — which duplicates ~11KB. To avoid duplication and honor byte-parity, we take the DASH-0a/DEDUP-ATTR approach differently: **do not touch `TurnsTab.tsx` at all in this sprint.** Instead `SessionsTab.tsx` imports `TurnMemoryView` (moved from the TurnsTab body) AND the original `TurnsTab.tsx` keeps its own body, temporarily duplicated. Rollback/flag-off parity is therefore exact with zero branching in TurnsTab: flag-OFF routes to top-level TurnsTab (its own copy); flag-ON routes to SessionsTab's TurnMemoryView copy. A follow-on cleanup (DASH-0d, UI-only) deletes the standalone TurnsTab copy after deep-link audit proves no live consumer points at it. This keeps EVERY sprint byte-parity-simple and unique-failure-injectable.

## Numbered implementation tasks

1. Add the `MEGACOMPACT_DASH_0B` flag (default ON, `=0` byte-identical) in the sibling config, re-exports, and the `VECTOR_CORTEX_SETTINGS` boolDirect toggle ("Dashboard Consolidation — Sessions/Cortex sections").
2. Move the existent `TurnsTab.tsx` render body VERBATIM into `tabs/SessionsTab/TurnMemoryView.tsx` (export the moved component as `TurnMemoryView`). LEAVE `TurnsTab.tsx` untouched this sprint (its copy stays live for flag-off / pre-DASH parity).
3. Rewrite `tabs/SessionsTab.tsx` as a delegate-shell: add a `SessionsViews` toggle (`"active" | "turns"`) — flag-ON renders `TurnMemoryView` for `"turns"` and the existent sessions body for `"active"`; flag-OFF renders only the existent sessions body (no toggle). Pure additive — no session component file edited.
4. Create `tabs/VectorCortexTab/sections.tsx`: four `<section>` groups importing the 14 existent cards verbatim by their current paths, each with an `aria-labelledby` heading id (`cortex-status` / `cortex-repair` / `cortex-cache` / `cortex-adaptive`). No card file edited.
5. Rewrite `tabs/VectorCortexTab.tsx` as a delegate-shell that renders `sections.tsx` (dropping its inline card list in favor of the section import). The existent health-card + `ModelImprovementCard` move into the Cortex status section. Header/badge logic unchanged.
6. Add the additive `src/tabs/index.ts` barrel re-exporting the 7 surface host components (`OverviewTab`, `SessionsTab`, `CacheTab`, `MemoryMapTab`, `VectorCortexTab`, `SetupTab`, `AdminTab`-reserved alias documented); `registry.ts` gains a documented `DASH_SURFACE_IDS` constant (7 ids) WITHOUT removing the existent 13 `TabId` union (rollback-safe).
7. Add `src/vector-cortex/dash0b-acceptance.test.ts`. The `EXPECTED_SPRINTS` reconciliation is owned by the single integration step (45→60 at program commit) — this spec performs no per-sprint bump.

## Failure triad and independence

A: merged Sessions surface renders the turns drill-down via `TurnMemoryView` (session+turns both present) (DASH-0B-001). B: the Vector Cortex 4-section grouping renders all 14 cards under exactly one section each (DASH-0B-002). C: flag-off — SessionsTab renders only its own body and the standalone TurnsTab top-level surface is untouched (byte-identical predecessor) (DASH-0B-003). A uses the additive SessionsTab toggle branch; B uses the additive sections grouping; C uses the flag gate with zero changes to the standalone TurnsTab. All three use independent component layout inputs.

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/dashboard-consolidation/` (same family as DASH-0a).

- `DASH-0B-001: Sessions surface exposes both the sessions body and the turns drill-down` — `{ surface:"sessions", shows_sessions:true, shows_turns_drilldown:true }`.
- `DASH-0B-002: all 18 vector-cortex cards appear under exactly one section` — `{ cards:18, sections:4, card_section_assignment:"bijective" }`.
- `DASH-0B-003: flag-off renders the two prior surfaces independently (sessions-only + standalone turns)` — `{ flag_enabled:false, sessions_self_contained:true, turns_standalone:true }`.

Sprint acceptance aggregator: `src/vector-cortex/dash0b-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/dash0b-acceptance.test.js
```

Expected assertions: all DASH-0B-001..003 registered with algorithm `dashboard-consolidation` against the `dashboard-consolidation-fixture` schema; 001 asserts the dual-surface Sessions render; 002 asserts the 18→4 bijection (deterministically counts the card imports in `sections.tsx`); 003 asserts flag-off preserves both independent surfaces. Client-dimension checks: `cd extensions/dashboard-client && npm run typecheck && npm run build` (client touched — MANDATORY) + a lazy-load smoke asserting SessionsTab (new weight) and VectorCortexTab still load without a Suspense error. Exact flag-off comparison: `MEGACOMPACT_DASH_0B=0 node --test dist/vector-cortex/dash0b-acceptance.test.js`; the aggregator is flag-agnostic. Apply [EVALUATION](../EVALUATION.md) rules; hard causal/tool/anchor/exact failures are zero-tolerance. Unique failure injection: a section heading id duplicated across two sections; the bijection assert fails.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure — no schema/state migration; UI-only**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md) — no new payload surface; the merged views consume the same localhost `/api/sessions`, `/api/turns`, and `/api/vector-cortex/*` reader endpoints. Dashboard: SessionsTab merge + VectorCortexTab sectioning + additive barrel; no endpoint registry change. Run `cd extensions/dashboard-client && npm run typecheck && npm run build` + the lazy-load smoke (asset/packaging surface unchanged — no new bundle, so asset-gate not triggered).

Rollback sets `MEGACOMPACT_DASH_0B=0`; the Session toggle collapses and VectorCortexTab returns to its flat layout; the standalone TurnsTab is untouched, so predecessor bytes hold — evidence not deleted. The duplicated turns copy is reconciled (removed) in DASH-0d, never wired by a rollback. No operator migration.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/dash0b-acceptance.test.js`, `MEGACOMPACT_DASH_0B=0 node --test dist/vector-cortex/dash0b-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all --soft-as-hard --soft-as-hard-base v0.20.29 --pre-commit`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, `node scripts/vector-cortex-scope-check.mjs DASH-0B <COMMIT_SHA>`, `node scripts/vector-cortex-evidence-check.mjs DASH-0B`, `git diff --check`, `cd extensions/dashboard-client && npm run typecheck && npm run build`. No permissive globs or warning-only scans count.
