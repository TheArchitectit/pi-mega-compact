# DASH-0A Evidence — Dashboard tab-audit + consolidation merge plan

Status: **implementer-complete** — the contract-planning sprint ships ONLY the typed
merge plan, the flag, conformance fixtures, the acceptance + plan tests, and the
comment-only widget-types fix. NO product behavior changes and NO component moves:
the shell (App.tsx), the lazy list, and all 13 tab/section top-level components render
exactly as they did before this sprint. DASH-0b/0c execute the plan; DASH-0d wires the
deep links + a11y hooks.

## Sprint meta

- **Spec:** docs/vector-cortex/sprints/DASH-0a-tab-audit-and-merge-plan.md
- **Sprint ID string:** `DASH-0A` (owner CSV + manifest registration)
- **Flag:** `MEGACOMPACT_DASH_0A` — boolDirect, default ON, `=0` byte-identical
  predecessor (the plan module is inert — never imported by the shell). Registered as a
  visible `VECTOR_CORTEX_SETTINGS` toggle, never in `EXCLUDED_SETTINGS`.

## Production ownership files (final state)

- `extensions/dashboard-client/src/dash-consolidation/plan.ts` (200) — the typed merge
  plan: `DASHSurface` union (7), `DASH_TAB_PLAN` (7 surfaces × `sources` TabId[] +
  `mergedCardIds`), `DASH_TAB_COUNT = 7`, `DASH_LEGACY_SECTIONS` (topics/achievements/
  game kept-but-folded under admin), `DEEP_LINK_TARGETS` (all 13 TabIds), `DASH_NAV_MAP`
  (a11y landmark rows), `DASH_RESPONSIVE` (per-surface column strategy). `import type
  { TabId }` from `../tabs/registry`; no `any`
- `extensions/mega-runtime/widget-types.ts` (84) — COMMENT-ONLY fix at the `level?` field:
  rewrote the stale "Stub = 1 until S33" wording to reference the S33 live derivation
  (`getTurnLevelImpl` in `runtime-helpers.ts` = `floor(log2(turns+1))+1`). Pure-type
  module → emitted JS byte-identical
- `src/config/vector-cortex-dash-0a.ts` (24) — `DASH_0A_ENABLED()` positive sprint flag
  sibling (sprintFlag pattern from `src/config/vector-cortex-flag.ts`), default ON
- `src/config/vector-cortex.ts` (104) — additive re-export of `DASH_0A_ENABLED` (≤300)
- `src/config.ts` (222) — additive re-export of `DASH_0A_ENABLED` (≤300 soft; +1 line
  from the single-line additive re-export)
- `src/vector-cortex/dash0a-plan.test.ts` (226) — plan audit test: 7 surfaces,
  13 TabIds each in exactly one sources/legacy bucket, merged-card filename provenance,
  `DASH_TAB_COUNT===7`, `setup_subtabs:["config"]` under setup NOT admin = 9 tests
- `src/vector-cortex/dash0a-acceptance.test.ts` (155) — acceptance aggregator: fixture
  registration + kind-closure (3), envelope posture (3), flag invariants (1), settings
  toggle (1) = 8 tests, flag-agnostic
- `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts` (340) — boolDirect
  `MEGACOMPACT_DASH_0A` toggle "Dashboard Consolidation — Tab Plan" (≤400 soft)
- `conformance/vector-cortex/v2/dashboard-consolidation/DASH-0A-001.json` — 001: 7
  surfaces covering 13 source TabIds, each mapped once
- `conformance/vector-cortex/v2/dashboard-consolidation/DASH-0A-002.json` — 002: no
  collision, no dropped source
- `conformance/vector-cortex/v2/dashboard-consolidation/DASH-0A-003.json` — 003: flag-off
  inert shell (byte-identical predecessor)
- `conformance/vector-cortex/v2/schemas/dashboard-consolidation-fixture.schema.json` —
  fixture envelope schema
- `conformance/vector-cortex/v2/manifest.json` — owner CSV `DASH-0A`, domain
  `dashboard-consolidation`, algorithm `dashboard-tab-plan`, 934 fixtures canonical

## Behavior enforced (the sprint's hard guarantees)

1. **Totality** — the 7-surface `DASH_TAB_PLAN` covers every current TabId in exactly
   one `sources` bucket (13), plus the `DASH_LEGACY_SECTIONS` keep-but-listed-under-admin
   disposition for topics/achievements/game. `admin` is a surface, never a source TabId.
2. **No collision / no dropped source** — the audit cardinally re-derives the source list
   and fails on any overlap or omission.
3. **Flag-off byte-identical** — `MEGACOMPACT_DASH_0A=0`: the plan module is inert (never
   imported by the shell); all 13 tab/section top-level components render exactly as
   today. Fixture DASH-0A-003 pins `flag_enabled:false, routing_changed:false,
   shell_touched:false`.
4. **Setup sub-tab placement** — the config sub-tab is recorded as
   `setup_subtabs:["config"]` under the `setup` surface (the existent SetupTab SUB_TABS
   member), NOT under `admin`.

## Conformance fixtures

- `DASH-0A-001` — `{ surfaces:7, source_tab_ids:13, each_mapped_once:true }` (totality).
- `DASH-0A-002` — `{ collision:false, dropped_sources:[] }` (no placement collision).
- `DASH-0A-003` — `{ flag_enabled:false, routing_changed:false, shell_touched:false }`
  (flag-off inertness, byte-identical predecessor).
- All canonical (UTF-8 NFC, sorted keys, LF-final) + sha256-pinned. `kind` =
  `dashboard-tab-plan`; schema `schemas/dashboard-consolidation-fixture.schema.json`.

## Test outcomes (HEAD, flag-agnostic)

- [x] `node --test dist/vector-cortex/dash0a-acceptance.test.js` → **8 pass / 0 fail**
- [x] `MEGACOMPACT_DASH_0A=0 node --test dist/vector-cortex/dash0a-acceptance.test.js`
  → **8 pass / 0 fail** (flag-off same-pass parity)
- [x] `node --test dist/src/vector-cortex/dash0a-plan.test.js` → **9 pass / 0 fail**
- [x] `npm test` → **4015 passed, 0 failed across 408 files** (full suite, clean run;
  both new test files discovered by the recursive glob)
- [x] `npm run lint` → clean (`tsc --noEmit` + guardrails-scan + semantic-scan clean)
- [x] `python3 scripts/regression_check.py --all` → **0 blocking** (7 dev-only/moderate
  npm audit warnings unchanged)
- [x] `node scripts/guardrails-scan.mjs` → clean (pi pattern + semantic scan clean)
- [x] `node scripts/vector-cortex-conformance.mjs --check` → **934 fixtures canonical**
- [x] `node scripts/vector-cortex-docs-check.mjs` → **65 sprints / 16 phases clean** (no
  bump — `EXPECTED_SPRINTS` was already updated to 65 for DASH-0a)
- [x] `python3 scripts/log_failure.py --list` → no active failures in scope (only
  pre-existing resolved entries)
- [x] `git diff --check` → clean
- [x] `cd extensions/dashboard-client && npm run typecheck && npm run build` → clean
  (plan.ts typechecks under the dashboard-client tsconfig; `noUnusedLocals` clean; the
  plan module is tree-shaken out of the bundle since no component imports it)

## Migration and rollback

**Migration:** pure — no store schema/state change, no events.log format change, no SQLite
columns, no new payload surface. `plan.ts` is a static constant module; the dashboard
route handling is untouched.

**Rollback:** set `MEGACOMPACT_DASH_0A=0`. The plan module goes inert (never imported by
the shell) and the shell + all 13 tab/section top-level files are byte-identical to the
predecessor. No evidence deleted, no golden bytes changed. No operator migration.

## Failure triad (A/B/C)

- **A (totality)** — the merged 7-surface plan resolves every current TabId + every
  delegate card to exactly one destination → fixture DASH-0A-001 + plan-test bucket audit.
- **B (collision/drop)** — a plan row collides or a TabId is dropped → fixture
  DASH-0A-002 + plan-test collision audit.
- **C (flag-off)** — the plan module present but unused (byte-identical predecessor) →
  fixture DASH-0A-003 + flag-invariant test.

## Spec-staleness deviations (rationale)

- **plan.test.ts location** — the spec ownership put this test inside the
  dashboard-client as `dash-consolidation/plan.test.ts` under a client-side vitest gate,
  but the dashboard-client has NO test runner (no vitest — only `vite build`). Per the
  sprint brief it ships instead as a root `node --test` file at
  `src/vector-cortex/dash0a-plan.test.ts`, compiled by root tsc like all other
  acceptance/plan tests. Because the root build excludes `extensions/dashboard-client`,
  the test audits the shipped `plan.ts` as source text (local file read) rather than a
  type import — the right coupling for a contract-planning sprint.
- **Plan-test gate path** — the brief's gate list named
  `node --test dist/vector-cortex/dash0a-plan.test.js`; the actual path is
  `dist/src/vector-cortex/dash0a-plan.test.js` because only `*-acceptance.test.js`
  files are mirrored to `dist/vector-cortex/` by the postbuild. The plan test is
  discovered by `npm test`'s recursive glob either way.
- **Conformance fixture count** — the brief expected 933 (930 + 3). Following the
  established REPO-A schema-counting convention (its schema row counts as a fixture),
  the new `dashboard-consolidation-fixture` schema row is ALSO registered as a fixture,
  so the canonical count is **934** (930 baseline + 3 DASH-0A fixtures + 1 schema row).
  Without the schema row the checker reports "unlisted file", so 934 is the correct,
  gate-green count.

## Reviewer verdict

**reviewer-accepted** — Controller (Opus) two-stage review complete.

### Controller attestation

All gates green. Verified against HEAD (commit 1eba490 on `feat/DASH-0a`):

- **Scope-check** (scope-check.mjs DASH-0A): all 14 committed files inside Production ownership. The spec's Production ownership field was amended (spec-staleness precedent from REPO-A) to list the actual root-`node --test` paths (`src/vector-cortex/dash0a-plan.test.ts`, `src/vector-cortex/dash0a-acceptance.test.ts`) instead of the originally-planned client-side paths — the dashboard-client has no test runner, documented as deviation #1 below.
- **Evidence-check** (evidence-check.mjs DASH-0A): 0 mismatches.
- **Soft-as-hard** (regression_check.py --all --soft-as-hard --soft-as-hard-base v0.20.57 --pre-commit): clean.
- **npm test**: 4015 passed / 0 failed / 408 files.
- **Conformance**: 934 fixtures canonical (930 baseline + 3 DASH-0A + 1 schema).
- **Dashboard-client**: typecheck + build PASS (plan.ts typechecks; tree-shaken out of the bundle).
- **Additive diffs**: config.ts +1 line (222), vector-cortex.ts +2 lines (104) — minimal, within soft limits.
- **widget-types.ts**: comment-only at line 58 — stale "Stub = 1 until S33" reworded to reference `getTurnLevelImpl`. Pure-type module → emitted JS byte-identical.
- **Flag-off byte-identical**: plan module never imported by the shell; `MEGACOMPACT_DASH_0A=0` leaves all 13 tab/section components rendering exactly as their predecessor. Fixture DASH-0A-003 pins this.
- **git diff --check**: clean.

The three documented spec-staleness deviations (plan.test.ts location, plan-test gate path, conformance count 934) are all legitimate: documented rationale in the §Spec-staleness deviations section above, each follows established precedent (REPO-A schema-row counting convention, root-tsc test compilation pattern), and none weaken a hard guarantee.

**Ship ready**: merge → deploy.sh 0.20.58.
