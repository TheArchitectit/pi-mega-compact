# ENC-2budget Evidence — Install budget dashboard knob

Status: **reviewer-accepted** — the operator-configurable
`MEGACOMPACT_NATIVE_ORT_BUDGET_MIB` (default 300 MiB, clamp 8192) is now a
dashboard-visible Settings knob. The runtime read-path
(`decision.ts::installBudgetMib()` + `runtime-select.ts::budgetOk` computation),
the conformance fixture/script producers, and the ENC-0a/ML5-C decision-rule
assertions were updated from the old hardcoded 80 MiB constant to the
configurable default. This sprint adds the dashboard Settings surface above it:
config sibling + flag, API contract fields, server sibling route, route
integration, Settings toggle, client numeric input, conformance fixtures,
acceptance aggregator, route tests, and the deploy.sh env-overridable budget.

## Sprint meta

- **Spec:** docs/vector-cortex/sprints/ENC-2budget-install-budget-dashboard-knob.md
- **Sprint ID string:** `ENC-2BUDGET` (all caps per conformance manifest)
- **Flag:** `MEGACOMPACT_ENC_2BUDGET` — boolDirect, default ON, `=0` byte-identical to the ENC-1b-era predecessor
- **Controller (sole implementer):** all code written directly by the controller (no subagents — they were stopped per the user's instruction "if your going to edit this all directly you should stop the agents")

## Production ownership files (final state after controller review)

- `src/config/vector-cortex-enc2budget.ts` (51) — `ENC_2BUDGET_ENABLED` flag + `ENC_2BUDGET_NATIVE_ORT_BUDGET_ENV` / `ENC_2BUDGET_MAX_MIB = 8192` / `ENC_2BUDGET_DEFAULT_MIB = 300` constants
- `src/config/vector-cortex.ts` (95) — barrel re-export
- `src/config.ts` (218) — barrel re-export
- `src/vector-cortex/encoder/decision.ts` (183) — `resolveInstallBudgetMib(raw)` pure helper (clamps + falls back to default); `installBudgetMib()` now calls it; `INSTALL_BUDGET_DEFAULT_MIB=300`, `INSTALL_BUDGET_CLAMP_MIB=8192`
- `src/vector-cortex/encoder/runtime-select.ts` (214) — four `budgetOk` sites now compute `shippedMib <= installBudgetMib()`; comment updated to "operator-configured install budget (`MEGACOMPACT_NATIVE_ORT_BUDGET_MIB`, default 300 MiB)"
- `extensions/dashboard-server/routes-setup-enc2budget.ts` (171) — NEW sibling mirroring ENC-1b: `readEnc2BudgetEnv` + `writeEnc2BudgetEnv` (create-or-append upsert, never deletes other keys), `enc2BudgetStatusFields` (resolves persisted raw via `resolveInstallBudgetMib`, falls back to `installBudgetMib()`), `validateNativeOrtBudgetMib` (regex `/^\d+$/`, 1..8192), `wantsEnc2Budget`, `tryEnc2BudgetInto`, `enc2BudgetValidateCombined`
- `extensions/dashboard-server/routes-setup.ts` (318) — import the sibling; merge `enc2BudgetStatusFields` onto the GET status body; run `enc2BudgetValidateCombined` before the combined upsert; `tryEnc2BudgetInto` after the embedder write
- `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts` (316) — boolDirect `MEGACOMPACT_ENC_2BUDGET` toggle registered (visible SETTINGS, never EXCLUDED)
- `extensions/dashboard-server/api-contracts/setup.ts` (149) — `SetupStatusResponse.nativeOrtBudgetMib?: string` + `nativeOrtBudgetEffectiveMib?: string`; `SetupConfigureRequest.nativeOrtBudgetMib?: string`
- `extensions/dashboard-client/src/tabs/SetupTab/CortexRuntimeCard.tsx` (194) — numeric MiB input + Save button; seeded from persisted value (or effective operand); effective-mib display; card visible when `"nativeOrtBudgetEffectiveMib" in status`
- `scripts/vc9-setup-dashboard/gen-fixtures-enc-budget.mjs` (209) — NEW producer: writes `ENC-BUDGET-001..004` + `schemas/enc-budget-fixture.schema.json`; owner `ENC-2a` + domain `enc-budget` registered (semicolon-delimited, matching vc9 pattern)
- `scripts/encoder/resolve-backend-decision.mjs` — `resolveInstallBudgetMib(raw)` pure resolver mirror + `installBudgetMib()` env-aware; `resolvedBudgetOk` native branch now `RECORDED.nativeInstallMiB <= budgetMib`
- `scripts/ml5/package-assets.mjs` — `resolveInstallBudgetMib(raw)` mirror + `installBudgetMib();` `budgetAssertion` computes `within = totalMib <= budgetMib`
- `scripts/ml5/gen-fixtures-ml5c.mjs` — ML5-RUNTIME-001 fixture: `budget_mib:300, byte_count_le_budget:true, amended_budget_mib:null`
- `scripts/ml5-enc/gen-fixtures.mjs` — ENC-DEC assertions updated to 300 MiB default
- `scripts/gen-fixtures/encoder-qualification.mjs` — ENC-PACK-003 `budgetBytes: 300 * 1024 * 1024`
- `scripts/deploy.sh` — `PACKAGE_BUDGET_MIB="${MEGACOMPACT_NATIVE_ORT_BUDGET_MIB:-300}"` + `PACKAGE_BUDGET_BYTES=$((PACKAGE_BUDGET_MIB*1024*1024))`
- `scripts/vector-cortex-docs-check.mjs` — `EXPECTED_SPRINTS` bumped 63→65 (two new sprint docs: ENC-2a install-guide + ENC-2budget install-budget knob)
- `conformance/vector-cortex/v2/enc-budget/` (NEW root, 4 fixtures) — ENC-BUDGET-001 (unset → 300 default) / 002 (512 honored) / 003 (9000 out-of-clamp → 300) / 004 ("abc" non-numeric → 300)
- `conformance/vector-cortex/v2/schemas/enc-budget-fixture.schema.json` (NEW)
- `conformance/vector-cortex/v2/manifest.json` — owner CSV gains `ENC-2a`; domain semicolon-list gains `enc-budget`; 919 fixtures canonical total (+4 JSON +1 schema from the 914 baseline)
- `src/vector-cortex/enc2budget-acceptance.test.ts` (181) — NEW aggregator: fixture registration + kind-closure (4 tests), `installBudgetMib()` fixture parity (4 tests — applies each fixture's `env_state` to process.env + verifies resolution matches `expected_effective_mib`), contract + flag invariants (3 tests — source-scan assertions)
- `src/vector-cortex/enc0a-acceptance.test.ts` (297) — old `ENCODER_INSTALL_BUDGET_MIB=80` assertion replaced with knob-behavior test (unset→300, "512"→512, "0"→300, "9000"→300, "12.5"→300, "abc"→300); ENC-DEC-002 `budgetOk === true` (native 258 MiB fits default 300)
- `src/vector-cortex/ml5c-acceptance.test.ts` (269) — ML5-RUNTIME-001 fixture invariant now asserts `budget_mib:300, byte_count_le_budget:true, amended_budget_mib:null`; runtime-select native dispatch `budgetOk === true`; two decision-rule tests updated from `budgetOk:false` to `budgetOk:true` (shipped ~160 MiB fits default 300 MiB budget at the default, not the old 80 MiB)
- `extensions/dashboard-server/routes-setup-enc2budget.test.ts` (198) — NEW route-level tests with real spawned server over tempdir: POST writes `export MEGACOMPACT_NATIVE_ORT_BUDGET_MIB="512"` + GET echoes persisted (512) AND effective (512); out-of-clamp "9000" → 400 `invalid_native_ort_budget_mib`; non-numeric "abc" → 400; flag-off GET omits both fields; flag-off POST falls through

## Decision: the effective operand

GET `/api/setup-status` returns TWO fields:

- `nativeOrtBudgetMib` — the raw persisted string when one is set (absent when unset).
- `nativeOrtBudgetEffectiveMib` — the integer MiB the runtime WILL use after the next restart. Computed by `enc2BudgetStatusFields` via `resolveInstallBudgetMib(rawFromDisk) ?? installBudgetMib()` so the dashboard reflects the just-saved value even before the running process has re-sourced `.mega-compact.env`.

The `resolveInstallBudgetMib(raw)` pure helper was extracted out of `installBudgetMib()` so the dashboard can compute the effective operand from a persisted-but-not-yet-env-loaded value. The pure helper is shared with `scripts/encoder/resolve-backend-decision.mjs` and `scripts/ml5/package-assets.mjs` so runtime / script / dashboard all use the exact same clamp rule.

## Live-review defects (caught and fixed by controller inside this sprint)

### Defect 1 — dashboard effective operand returned stale value after POST

After POST writing "512" to disk, the GET's `nativeOrtBudgetEffectiveMib` returned "300" because `installBudgetMib()` reads `process.env` (which the dashboard server's running process hadn't re-sourced from the just-written `.mega-compact.env`).

**Fix:** extracted pure `resolveInstallBudgetMib(raw)` helper in `decision.ts`; dashboard sibling's `enc2BudgetStatusFields` now resolves the persisted raw value first (`raw !== null ? resolveInstallBudgetMib(raw) : installBudgetMib()`) so the GET reflects what the runtime WILL use after restart. Mirrored the pure resolver into the two script files for consistency. Pinned by the route test "POST 512 → GET echoes 512 persisted AND 512 effective".

### Defect 2 — conformance manifest domain field corrupted (semicolon vs comma)

The original `gen-fixtures-enc-budget.mjs` used `","` as the separator for the manifest's `domain` field, but the domain field is semicolon-delimited (all other generators use `";"`). This merged `encoder-budget` (ENC-0f's domain) into a comma-separated segment, breaking the enc0f + enc0g conformance registration tests (`m.domain.split(";").includes("encoder-budget")` failed).

**Fix:** corrected `setCsv("domain", "enc-budget", ",")` → `setSem("domain", "enc-budget")` using `;` separator (matching `gen-fixtures.mjs` and `gen-fixtures-vc9a.mjs`); repaired the manifest domain field by re-splitting all segments by both `;` and `,`, flattening, deduping, and re-joining by `;`. Also removed the stale `enc-budget-fixture` `schemaVersion` entry the broken generator had wrongly added. Pinned by enc0f (17/17) + enc0g (19/19) passing + conformance `--check` 919 canonical.

### Defect 3 — ml5c-acceptance decision-rule assertions stale at 80 MiB budget

Two ml5c-acceptance tests asserted `budgetOk: false` for the native fallback path, reflecting the old 80 MiB budget (where shipped ~160 MiB > 80 MiB budget). With the default raised to 300 MiB, shipped 160 MiB fits → `budgetOk: true`.

**Fix:** updated both test assertions from `budgetOk:false` to `budgetOk:true` with updated test names ("fits default 300 MiB budget"). The decision-rule dispatch is unchanged (native fallback still selected when no bench record; the budgetOk field now correctly reflects the new default).

### Defect 4 — scope-check sprint-ID ambiguity

Two sprint specs shared the `ENC-2a-` prefix (`ENC-2a-native-ort-install-guide.md` + `ENC-2a-install-budget-dashboard-knob.md`), causing the scope-check's `resolveSpecPath("ENC-2a")` to return an ambiguous-match error.

**Fix:** renamed the budget-knob spec to `ENC-2budget-install-budget-dashboard-knob.md` (sprint ID `ENC-2BUDGET`), disambiguating from the install-guide spec `ENC-2a-native-ort-install-guide.md` (sprint ID `ENC-2A`). The `docs/vector-cortex-docs-check.mjs` `EXPECTED_SPRINTS` constant was bumped 63→65 (two new sprint docs added by this work).

### Defect 5 — enc2budget-acceptance test splits domain by comma

The acceptance aggregator's "domain enc-budget is registered" test split the manifest domain by `,` instead of `;`, but the domain field is semicolon-delimited (owner is comma-delimited). After the manifest repair in defect 2, the semicolon-delimited `enc-budget` entry was no longer inside a comma-separated segment, so the comma split missed it.

**Fix:** changed `m.domain.split(",")` to `m.domain.split(";")` in the acceptance aggregator (matching the convention used by the enc0f + enc0g conformance registration tests). Pinned by the 11/11 pass + flag-off parity.

## Conformance

- `conformance/vector-cortex/v2/enc-budget/ENC-BUDGET-001..004.json` (NEW, algorithm `enc-budget`, schema `schemas/enc-budget-fixture.schema.json`)
- Manifest: owner CSV gains `ENC-2a`; domain semicolon-list gains `enc-budget`; 919 fixtures canonical total (+4 JSON +1 schema from the 914 baseline)

## Gates executed (all PASS)

- [x] `npm run build` → clean (`tsc` + `vector-cortex-publish-acceptance.mjs` → 56 acceptance files)
- [x] `node --test dist/vector-cortex/enc2budget-acceptance.test.js` → **11 pass / 0 fail**
- [x] `node --test dist/extensions/dashboard-server/routes-setup-enc2budget.test.js` → **5 pass / 0 fail**
- [x] `MEGACOMPACT_ENC_2BUDGET=0 node --test dist/vector-cortex/enc2budget-acceptance.test.js` → **11 pass / 0 fail** (flag-off same-pass)
- [x] `node --test dist/vector-cortex/enc0a-acceptance.test.js` → **15 pass / 0 fail**
- [x] `node --test dist/vector-cortex/ml5c-acceptance.test.js` → **15 pass / 0 fail**
- [x] `node --test dist/vector-cortex/enc0f-acceptance.test.js` → **17 pass / 0 fail** (manifest repair verified)
- [x] `node --test dist/vector-cortex/enc0g-acceptance.test.js` → **19 pass / 0 fail** (manifest repair verified)
- [x] `npm test` → **4055 passed, 0 failed across 397 files in 56.7s** (clean run — the known `closeVectorIndex` WASM close stall / exit-hung pattern from prior runs did NOT trigger this time; intermittent per `test-hang-closevectorindex-root-cause` memory)
- [x] `npm run lint` → clean (`tsc --noEmit` + guardrails-scan + semantic-scan)
- [x] `python3 scripts/regression_check.py --all` → **0 blocking** (7 dev-only/moderate npm audit warnings unchanged)
- [x] `python3 scripts/regression_check.py --soft-as-hard --pre-commit --soft-as-hard-base v0.20.52` → **0 over hard limit, 63 over soft (warning)** — NONE of the ENC-2budget changed files are in the warning list (pre-existing files only)
- [x] `node scripts/guardrails-scan.mjs` → clean (GUARDRAILS pi pattern + semantic scan clean)
- [x] `python3 scripts/log_failure.py --list` → 4 prior failures all resolved
- [x] `node scripts/vector-cortex-conformance.mjs --check` → **919 fixtures canonical**
- [x] `node scripts/vector-cortex-docs-check.mjs` → **65 sprints / 16 phases clean**
- [x] `cd extensions/dashboard-client && npm run typecheck && npm run build` → clean (SetupTab chunk `SetupTab-KLTE-VKV.js` compiled — additive budget input)
- [x] `git diff --check` → clean

## Migration and rollback

**Migration:** pure — no store schema change, no session-shape change. The persisted key/value lines land in the EXISTING per-repo `.mega-compact.env` (per `statedir-per-repo-vs-global` memory: never the global one). Upsert writes never delete unrelated lines.

**Rollback:** set `MEGACOMPACT_ENC_2BUDGET=0`. The route removes the new GET fields byte-identical to ENC-1b; the POST falls through to the pure-ENC-1b path (the additive `enc2BudgetValidateCombined` helper is flag-gated and returns null when off); the CortexRuntimeCard hides the budget input; the Settings toggle hides. The persisted `.mega-compact.env` line is NOT deleted (data preservation — deleting it would be an out-of-band seizure; it remains for the runtime that reads it via `installBudgetMib()`).

## OPEN / known

- **HG-3 (open)** — the dashboard budget knob does NOT close HG-3 (the native install path). HG-3 remains OPEN: the operator still needs to install + probe onnxruntime-node. The knob is the clean Budget side of the gate — the install-path side is the ENC-2a install guide (separate sprint spec at `docs/vector-cortex/sprints/ENC-2a-native-ort-install-guide.md`, not yet implemented).
- **HG-1 / HG-4 / HG-5** — unchanged.
- **task #26 (pending)** — the dashboard-server `--port` argv mis-parse bug (pre-existing, out of scope).
- **task #41 (pending)** — ENC-2 chain specs (2b native retest / 2c lazy download still to write).

## Reviewer verdict

ACCEPTED. All gates pass; the test-count strictly grows (+16 new assertions from the ENC-2budget aggregator + route tests); the dashknob is dashboard-visible + per-repo env-persisted + clamped at both client and server; the effective operand is computed through the shared pure resolver (not reimplemented). The manifest domain field was repaired (semicolon-delimited per convention, matching all other generators). The runtime `installBudgetMib()` semantics are unchanged from the pre-dashknob controller edit (default 300, clamp 8192) — this sprint only adds the dashboard surface above it.
