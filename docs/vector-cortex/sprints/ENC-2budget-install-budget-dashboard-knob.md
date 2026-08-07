---
sprint: ENC-2budget-install-budget-knob
phase: ENC-real-encoder
status: implementer-complete → reviewer-accepted
date: 2026-08-07
---

# ENC-2budget (install-budget dashboard knob)

**Goal.** Replace the previously hardcoded 80 MiB install-budget constant with
an operator-configurable dashboard-visible knob
`MEGACOMPACT_NATIVE_ORT_BUDGET_MIB` (default 300 MiB, clamp 8192). The user's
direction on 2026-08-07:

> "remove the 80mb limit that wasn't my design decision"
> "ok can we set it to a number that is in the dashboard that defaults to lets say 300mb"

This sprint delivers the dashboard Settings surface for that knob. The runtime
read-path (`decision.ts::installBudgetMib()` + `runtime-select.ts` budgetOk
computation) and the conformance fixture / script producers were already
landed as the "convert 80 MiB → 300 MiB knob" side of the work; what remained
was the SetupTab CortexRuntimeCard numeric input, the per-repo `.mega-compact.env`
upsert sibling, the contract fields, the flag, and the conformance fixtures
+ tests. This sprint fills those gaps.

Production ownership: `src/config/vector-cortex-enc2budget.ts` (NEW — `ENC_2BUDGET_ENABLED` flag + `ENC_2BUDGET_NATIVE_ORT_BUDGET_ENV` / `ENC_2BUDGET_MAX_MIB` / `ENC_2BUDGET_DEFAULT_MIB` constants); `src/config/vector-cortex.ts` (additive re-export); `src/config.ts` (additive re-export); `src/vector-cortex/encoder/decision.ts` (additive — `resolveInstallBudgetMib` pure helper + `installBudgetMib`); `src/vector-cortex/encoder/runtime-select.ts` (additive — budgetOk sites reference `installBudgetMib`); `extensions/dashboard-server/routes-setup-enc2budget.ts` (NEW sibling — read/write/validate mirroring ENC-1b); `extensions/dashboard-server/routes-setup.ts` (additive branch — import + GET merge + combined validate + upsert); `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts` (additive boolDirect `MEGACOMPACT_ENC_2BUDGET`); `extensions/dashboard-server/api-contracts/setup.ts` (additive contract fields `nativeOrtBudgetMib` + `nativeOrtBudgetEffectiveMib`); `extensions/dashboard-client/src/tabs/SetupTab/CortexRuntimeCard.tsx` (additive numeric input + Save); `scripts/vc9-setup-dashboard/gen-fixtures-enc-budget.mjs` (NEW producer); `scripts/encoder/resolve-backend-decision.mjs` (additive resolver mirror); `scripts/ml5/package-assets.mjs` (additive resolver mirror); `scripts/ml5/gen-fixtures-ml5c.mjs` (additive — ML5-RUNTIME-001 fixture `budget_mib:300`); `scripts/ml5-enc/gen-fixtures.mjs` (additive — ENC-DEC assertions); `scripts/gen-fixtures/encoder-qualification.mjs` (additive — ENC-PACK-003 budget); `scripts/deploy.sh` (additive — `PACKAGE_BUDGET_MIB` env-overridable); `scripts/vector-cortex-docs-check.mjs` (additive — EXPECTED_SPRINTS bump); `conformance/vector-cortex/v2/enc-budget/*` (NEW root — ENC-BUDGET-001..004); `conformance/vector-cortex/v2/schemas/enc-budget-fixture.schema.json` (NEW); `conformance/vector-cortex/v2/manifest.json` (owner `ENC-2a` + domain `enc-budget` registered); `src/vector-cortex/enc2budget-acceptance.test.ts` (NEW aggregator); `src/vector-cortex/enc0a-acceptance.test.ts` (additive — knob-behavior test replacing the old `ENCODER_INSTALL_BUDGET_MIB=80` assertion); `src/vector-cortex/ml5c-acceptance.test.ts` (additive — budget fixture + decision-rule assertions updated to 300 MiB default); `extensions/dashboard-server/routes-setup-enc2budget.test.ts` (NEW route tests); `docs/vector-cortex/evidence/ENC-2budget.md`; `docs/vector-cortex/sprints/ENC-2budget-install-budget-dashboard-knob.md (this file)`. Cross-cutting documentation/evidence updates touched by the 80→300 MiB default framing change (additive prose edits, no code semantics): `docs/vector-cortex/MODEL_ASSET.md`; `docs/vector-cortex/SPRINT_PLAN.md`; `docs/vector-cortex/encoder-backend-decision.md`; `docs/vector-cortex/evidence/ENC-0a.md`; `docs/vector-cortex/evidence/ML5-C.md`; `docs/vector-cortex/sprints/ENC-0g-setup-cortex-honest-state.md`; `docs/vector-cortex/sprints/ENC-2a-native-ort-install-guide.md`; `docs/vector-cortex/vc2-model-prep.md`; `src/vector-cortex/setup-cortex-blockers-compute.ts`.

## Decision: the effective operand

GET `/api/setup-status` returns TWO fields:

- `nativeOrtBudgetMib` — the raw persisted string when one is set (absent when
  the operator has not configured the knob).
- `nativeOrtBudgetEffectiveMib` — the integer MiB the runtime WILL use after
  the next restart. Computed by `enc2BudgetStatusFields` via
  `resolveInstallBudgetMib(rawFromDisk) ?? installBudgetMib()` — so the
  dashboard reflects the just-saved value even before the running process has
  re-sourced `.mega-compact.env` (the `ENC-1b`/`ENC-2a` contract already tells
  the operator a restart is required to activate).

This is why a new `resolveInstallBudgetMib(raw)` pure helper was extracted out
of `installBudgetMib()` — the dashboard needs to compute the effective operand
from a persisted-but-not-yet-env-loaded value without reimplementing the clamp.
The pure helper is shared with the scripts (`resolve-backend-decision.mjs`,
`package-assets.mjs`) so the runtime / script / dashboard all use the exact
same clamp rule.

## Conformancefixtures

`conformance/vector-cortex/v2/enc-budget/` (`ENC-BUDGET-001..004`, schema
`schemas/enc-budget-fixture.schema.json`, algorithm `enc-budget`); owner
`ENC-2a` + domain `enc-budget` registered in the v2 manifest. Producer:
`scripts/vc9-setup-dashboard/gen-fixtures-enc-budget.mjs`.

After regen: 919 fixtures canonical (was 914 at HEAD; +4 new ENC-BUDGET; +1
enc-budget-fixture schema).

## Tests

- Aggregator `src/vector-cortex/enc2budget-acceptance.test.ts` — 11 tests /
  3 suites, all pass. Flag-agnostic (passes with `MEGACOMPACT_ENC_2BUDGET` ON
  or OFF).
- Route-level `extensions/dashboard-server/routes-setup-enc2budget.test.ts` —
  5 tests / 2 suites, all pass.
- Build: `npm run build` clean; dashboard client typecheck + build clean.

## Migration / rollback

Pure (read/write existing `.mega-compact.env` + new contract fields). Flag-off
(`MEGACOMPACT_ENC_2BUDGET=0`) → byte-identical to the ENC-1b predecessor: no
new GET fields, no writer branch, no new Settings rows, no CortexRuntimeCard
budget input.

## Hard gates (OPEN per `soft-as-hard-headroom-gate`)

The dashboard budget knob does NOT close HG-3 (the native install path). HG-3
remains OPEN: the operator still needs to install + probe. The knob is the
clean Budget side of the gate — the install-path side is the ENC-2a install
guide (separate sprint spec at
[`sprints/ENC-2a-native-ort-install-guide.md`](ENC-2a-native-ort-install-guide.md)).
HG-1 (5-head training — ENC-0c 5-head training), HG-4 (darwin-x64 demotion —
ENC-0e), HG-5 (RSS/p95 — ENC-0f) unchanged.

## Out-of-session follow-ups

- ENC-2a install guide (the three options A+B+C the user requested): separate
  spec is drafted at `docs/vector-cortex/sprints/ENC-2a-native-ort-install-guide.md`;
  not implemented in this sprint.
- ENC-2b native-retest + ENC-2c lazy-download: not yet spec'd.

## Reviewer verdict

ACCEPTED. All gates pass; the test-count strictly grows (+16 new assertions);
the dashknob is dashboard-visible + per-repo env-persisted + clamped at both
client and server; the effective operand is computed through the shared pure
resolver (not reimplemented). The runtime `installBudgetMib()` semantics are
unchanged from the controller-applied pre-dashknob edit (default 300, clamp
8192) — this sprint only adds the dashboard surface above it.
