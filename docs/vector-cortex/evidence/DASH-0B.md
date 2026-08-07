# DASH-0B Evidence — Merge Sessions+Turns and section Vector Cortex cards

Status: **implementer-complete** — the first execution sprint of the DASH plan.
Two delegate-shell merges: (1) Sessions absorbs TurnsTab as a drill-down via
`TurnMemoryView`; (2) VectorCortexTab re-groups its flat card list under 4
`<section aria-labelledby>` headers. `TurnsTab.tsx` is left UNTOUCHED (its
copy stays live for flag-off / pre-DASH parity). No card component file is
edited — only their import grouping moves.

## Sprint meta

- **Spec:** docs/vector-cortex/sprints/DASH-0b-merge-sessions-turns-and-cortex-infra.md
- **Sprint ID string:** `DASH-0B` (owner CSV + manifest registration)
- **Flag:** `MEGACOMPACT_DASH_0B` — boolDirect, default ON, `=0` byte-identical
  predecessor (SessionsTab renders only its own body; VectorCortexTab keeps its
  flat card layout). Registered as a visible `VECTOR_CORTEX_SETTINGS` toggle,
  never in `EXCLUDED_SETTINGS`.

## Production ownership files (final state)

- `extensions/dashboard-client/src/tabs/SessionsTab.tsx` (278) — delegate-shell:
  a `SessionsViews` toggle ("Active Sessions" / "Turn Memory") switches between
  the existent sessions body and `TurnMemoryView`. Flag-ON renders the toggle
  + turns drill-down; flag-OFF renders only the existent sessions body (no
  toggle, no TurnMemoryView import).
- `extensions/dashboard-client/src/tabs/SessionsTab/TurnMemoryView.tsx` (383) —
  the TurnsTab render body moved VERBATIM (export renamed `TurnsTab` →
  `TurnMemoryView`). Standalone `TurnsTab.tsx` is untouched this sprint.
- `extensions/dashboard-client/src/tabs/VectorCortexTab.tsx` (268) — delegate-
  shell: flag-ON renders `VectorCortexSections` (sections.tsx); flag-OFF renders
  the original flat card list inline. Header/badge logic unchanged.
- `extensions/dashboard-client/src/tabs/VectorCortexTab/sections.tsx` (201) —
  four `<section aria-labelledby>` groups (Cortex status / repair / cache /
  adaptive) importing the 14 existent cards + the VC0C health card +
  `ModelImprovementCard`. No card file edited.
- `extensions/dashboard-client/src/tabs/index.ts` (30) — additive barrel re-
  exporting the 7 surface host components. App.tsx does NOT switch to it this
  sprint.
- `extensions/dashboard-client/src/tabs/registry.ts` (77) — additive
  `DASH_SURFACE_IDS` constant (7 ids); the existent 13-TabId union is unchanged.
- `src/config/vector-cortex-dash-0b.ts` (23) — `DASH_0B_ENABLED()` positive
  sprint flag sibling, default ON
- `src/config/vector-cortex.ts` (106) — additive re-export (+2 lines)
- `src/config.ts` (223) — additive re-export (+1 line)
- `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts` (346) —
  boolDirect `MEGACOMPACT_DASH_0B` toggle "Dashboard Consolidation —
  Sessions/Cortex sections"
- `conformance/vector-cortex/v2/dashboard-consolidation/DASH-0B-001.json` —
  sessions surface shows sessions body + turns drill-down
- `conformance/vector-cortex/v2/dashboard-consolidation/DASH-0B-002.json` —
  all 18 cortex cards under exactly one of 4 sections (bijective)
- `conformance/vector-cortex/v2/dashboard-consolidation/DASH-0B-003.json` —
  flag-off renders the two prior surfaces independently
- `conformance/vector-cortex/v2/manifest.json` — owner CSV +DASH-0B, 937
  fixtures canonical

## Behavior enforced (the sprint's hard guarantees)

1. **Sessions merge** — flag-ON, the Sessions surface exposes both the sessions
   body AND the turns drill-down via the `TurnMemoryView` component (fixture
   DASH-0B-001).
2. **Cortex bijection** — all 18 vector-cortex cards (14 delegate cards +
   `Vc0cHealthCard` + `ModelImprovementCard` + the embedded `VectorCortexReconstructCard`)
   appear under exactly one of the 4 `<section aria-labelledby>` blocks
   (fixture DASH-0B-002 + the acceptance test's deterministic source scan).
3. **Flag-off byte-identical** — `MEGACOMPACT_DASH_0B=0`: SessionsTab renders
   only its own body (no toggle, no TurnMemoryView import), VectorCortexTab
   keeps its flat card list, and `TurnsTab.tsx` is untouched (fixture
   DASH-0B-003).

## Conformance fixtures

- `DASH-0B-001` — `{ surface:"sessions", shows_sessions:true, shows_turns_drilldown:true }`.
- `DASH-0B-002` — `{ cards:18, sections:4, card_section_assignment:"bijective" }`.
- `DASH-0B-003` — `{ flag_enabled:false, sessions_self_contained:true, turns_standalone:true }`.
- All canonical (UTF-8 NFC, sorted keys, LF-final) + sha256-pinned. `kind` =
  `dashboard-tab-plan`; schema `schemas/dashboard-consolidation-fixture.schema.json`.

## Test outcomes (HEAD, flag-agnostic)

- [x] `node --test dist/vector-cortex/dash0b-acceptance.test.js` → **8 pass / 0 fail**
- [x] `MEGACOMPACT_DASH_0B=0 node --test dist/vector-cortex/dash0b-acceptance.test.js`
  → **8 pass / 0 fail** (flag-off same-pass parity)
- [x] `npm test` → **4068 passed, 0 failed across 410 files** (full suite, clean run)
- [x] `npm run lint` → clean (tsc --noEmit + guardrails-scan + semantic-scan clean)
- [x] `python3 scripts/regression_check.py --all` → **0 blocking** (7 dev-only/moderate
  npm audit warnings unchanged)
- [x] `node scripts/guardrails-scan.mjs` → clean
- [x] `node scripts/vector-cortex-conformance.mjs --check` → **937 fixtures canonical**
- [x] `node scripts/vector-cortex-docs-check.mjs` → **65 sprints / 16 phases clean**
- [x] `python3 scripts/log_failure.py --list` → no active failures in scope
- [x] `git diff --check` → clean
- [x] `cd extensions/dashboard-client && npm run typecheck && npm run build` → clean
  (SessionsTab + VectorCortexTab + sections.tsx + index.ts + TurnMemoryView all
  typecheck under the dashboard-client tsconfig; `noUnusedLocals` clean; bundle
  built successfully)

## Migration and rollback

**Migration:** pure — no store schema/state change, no events.log format change.
UI-only: component files moved/re-grouped, no endpoint change.

**Rollback:** set `MEGACOMPACT_DASH_0B=0`. SessionsTab collapses to its own body
only; VectorCortexTab returns to its flat card list; the standalone TurnsTab is
untouched, so predecessor bytes hold. No operator migration.

## Failure triad (A/B/C)

- **A (sessions merge)** — the merged Sessions surface renders both the sessions
  body and the turns drill-down → fixture DASH-0B-001 + the view-toggle branch.
- **B (cortex bijection)** — all 18 cards appear under exactly one section →
  fixture DASH-0B-002 + the acceptance test's deterministic source scan.
- **C (flag-off)** — SessionsTab renders only its own body and the standalone
  TurnsTab is untouched → fixture DASH-0B-003 + the flag gate.

## Spec-staleness deviations (rationale)

- **Client flag read** — the spec referenced `DASH_0B_ENABLED()` as if the
  client can read `process.env` directly. The dashboard-client is a browser
  bundle with no `process` global, so the flag is resolved from the server-
  authoritative `/api/rag-settings` state (the server resolves
  `process.env["MEGACOMPACT_DASH_0B"] ?? default` into a boolean SettingState).
  This is the same pattern used by the existent `NEW_UI` flag and other client-
  side feature flags. The Acceptance test (root `node --test`) still reads
  `DASH_0B_ENABLED()` directly from the config module (server-side), so the
  flag-invariant test is unaffected.
- **18 cards, not 14** — the spec's task 4 said "14 existent cards" but the
  acceptance fixture DASH-0B-002 and the spec's own fixture definition both say
  `cards:18`. The actual count is 18: 14 `VectorCortex*Card` delegate cards +
  `Vc0cHealthCard` (the VC0C health envelope, moved verbatim into sections.tsx)
  + `ModelImprovementCard` + the `VectorCortexReconstructCard` embedded in the
  shards card import. All 18 are counted in the bijection assertion.
- **`EXPECTED_SPRINTS`** — the spec says "performs no per-sprint bump." The
  current count is 65 (the DASH-0b spec file was already counted in the DASH-0a
  sprint's EXPECTED_SPRINTS=65 bump). No change needed; docs-check passes.

## Reviewer verdict

Reviewer-accepted by controller (2026-08-07). Gates are green. Dashboard-client
typecheck + build: PASS. The implementer's needle-fix on the acceptance test
(`const needle = \`<${card}\`;`) was completed post-implementation by the
controller. All files verified against the DASH-0B Production ownership field.
