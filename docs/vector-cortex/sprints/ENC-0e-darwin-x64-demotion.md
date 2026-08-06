# ENC-0e — darwin-x64 explicit demotion + Setup card reason

**Status:** planned | **Depends on:** ENC-0b | **Phase:** ENC
**Flag:** `MEGACOMPACT_ENC_0E`, defined in `src/config/vector-cortex-enc0e.ts` (sibling extract), re-exported by `vector-cortex.ts` + root `src/config.ts`, default ON; `MEGACOMPACT_ENC_0E=0` disables and must be byte-identical to the predecessor — the darwin-x64 demotion reason is not appended to the runtime-selection event and the Setup card renders exactly as before (no demotion-reason row). The demotion itself (mode-B/WASM on Intel Mac) remains the ML5-C default and is NOT gated off by `MEGACOMPACT_ENC_0E` — only the explicit reason surface is. Registered in `VECTOR_CORTEX_SETTINGS` as a visible boolDirect toggle, never in `EXCLUDED_SETTINGS`.

## Goal and inputs/outputs

**Close HG-4's operator-visibility gap.** macOS Intel (`darwin-x64`) has **no native binary** upstream (arm64-only; a darwin-x64 transform-class package ships only WASM), so on Intel Macs the runtime must demote to **mode-B WASM or trigram** per HG-4. The demotion path already exists in the ML5-C decision rule (`selectRuntimeBackend` in `src/vector-cortex/encoder/runtime-select.ts` returns `backend:"wasm"` for `darwin-x64`). ENC-0e makes that demotion **explicit, measured, and visible**: it (a) computes a deterministic demotion **reason** for `darwin-x64` on the runtime-selection event via a platform-injectable seam (test-safe — no real Mac needed), and (b) surfaces the demotion reason on the existing **Setup Cortex blockers card** so an Intel-Mac operator sees exactly why mode A is unreachable.

The reason is derived, not hard-coded: on `darwin-x64`, the resolver reads the ENC-0a platform matrix (`darwin-x64` row → `runtime:"wasm", demotion:"wasm"`) and emits `vector_cortex_runtime_selected` with `{backend:"wasm", demotionReason:"darwin-x64: no native binary upstream (arm64-only); mode-B WASM per HG-4"}`. The dashboard Setup card (`CortexBlockersCard` in `SetupTab/CortexSetup.tsx`) renders that reason as an explicitly-diagnosed blocker row instead of a bare "demoted" state.

Inputs: ENC-0a's locked platform matrix + the existing `selectRuntimeBackend` output. Outputs: the enriched `vector_cortex_runtime_selected` event, a new `demotionReason` field in the setup-cortex contract, and the Setup card row. Dashboard wiring follows the VC9A `SETTING`/blocker surface: `GET /api/setup-cortex-status` gains `darwinX64:{demoted:boolean, reason?:string}` via an **additive** contract field consumed by `CortexBlockersCard`.

Production ownership: `src/vector-cortex/encoder/runtime-select.ts (evolves — expandRuntimeSelection: darwin-x64 emits an explicit demotionReason from the injectable platform; keep the pure-function contract); src/vector-cortex/encoder/runtime-select.test.ts (evolves — platform-injected darwin-x64 tests, no real Mac); src/vector-cortex/encoder/decision.ts (evolves — darwin-x64 platform row already in the matrix; expose the reason string); extensions/dashboard-server/setup-cortex-blockers.ts (evolves — add darwin-x64 demotion blocker+reason to the canonical blocker list, no string literals in routes); extensions/dashboard-server/api-contracts/setup-cortex.ts (additive — darwinX64 demotion field); extensions/dashboard-client/src/tabs/SetupTab/CortexBlockersCard.tsx (evolves — render the darwin-x64 demotion reason row, VC9C pattern); conformance/vector-cortex/v2/encoder-demotion/ (fixtures ENC-DEMO-001..006); docs/vector-cortex/evidence/ENC-0e.md (new)`.

## Numbered implementation tasks

1. Add the `MEGACOMPACT_ENC_0E` flag (default ON, `=0` byte-identical) in `src/config/vector-cortex-enc0e.ts` + `vector-cortex.ts`/`src/config.ts` re-exports and the `VECTOR_CORTEX_SETTINGS` boolDirect toggle in `routes-rag-settings-vector-cortex.ts` (additive). `=0` = no demotion-reason on the event, no Setup card row (the ML5-C demotion default is untouched).
2. Evolve `src/vector-cortex/encoder/runtime-select.ts`: on `darwin-x64`, `selectRuntimeBackend` returns the EXISTING `backend:"wasm"` PLUS a `demotionReason` (from `decision.ts`'s platform matrix row); keep the function pure (platform is an input, so tests inject `platform:"darwin-x64"` with no real Mac). Flag-off strips the `demotionReason` from the returned selection (byte-identical to the ENC-0b survivor).
3. Expose the reason in `src/vector-cortex/encoder/decision.ts`: the `darwin-x64` matrix row's `demotionReason` becomes the single canonical string (no string literals scattered in routes or the event writer).
4. Enrich the runtime-selection event (`runtime-emit.ts` additively): `vector_cortex_runtime_selected` carries `demotionReason` on `darwin-x64` under `MEGACOMPACT_ENC_0E`. Non-fatal; the event writer never throws.
5. Add the contract field to `extensions/dashboard-server/api-contracts/setup-cortex.ts`: `darwinX64?: { demoted:boolean; reason?:string }` (additive, explicit types, no `any`), consumed by `GET /api/setup-cortex-status`.
6. Add the blocker row to `extensions/dashboard-server/setup-cortex-blockers.ts`: the darwin-x64 demotion surfaces as a diagnosed blocker with the reason, so `CortexBlockersCard` shows why mode A is unreachable on Intel Mac.
7. Evolve `extensions/dashboard-client/src/tabs/SetupTab/CortexBlockersCard.tsx`: render the darwin-x64 demotion reason row (VC9C card pattern) when the status payload carries it; unaffected when absent.
8. Add `scripts/ml5-enc/gen-fixtures.mjs` (additive) emitting `ENC-DEMO-001..006`, register them + owner `ENC-0e` in the v2 manifest against a new `schemas/encoder-demotion-fixture.schema.json`; manifest bump is cross-cutting.
9. Add the sprint acceptance aggregator `src/vector-cortex/enc0e-acceptance.test.ts`, then evidence `ENC-0e.md`. Run the dashboard-client gates (`cd extensions/dashboard-client && npm run typecheck && npm run build`) since the client card is touched.

## Failure triad and independence

A darwin-x64 demotion reason: on an injected `platform:"darwin-x64"`, `selectRuntimeBackend` returns `backend:"wasm"` with a concrete `demotionReason` and the enriched event carries it (fixtures 501; ids use the `ENC-DEMO-` prefix). B non-darwin control: on `linux-x64`/`darwin-arm64`, no demotion reason is produced and the existing WASM/native rule is unchanged (fixture 502). C flag-off surface: `MEGACOMPACT_ENC_0E=0` strips the reason from the event and the Setup card renders no demotion row — byte-identical to the ENC-0b predecessor (fixtures 503–504). The card + contract are pinned by 505 (the `darwinX64:{demoted:true,reason}` payload renders the diagnosed row) and 506 (flag-off response has no `darwinX64` reason, card unchanged). A is produced by the injectable-platform demotion; B by the control platforms; C purely by the flag gate. `MEGACOMPACT_ENC_0E=0` is byte-identical to the ENC-0b survivor (the ML5-C demotion default is preserved regardless). Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/encoder-demotion/`. Schema: `schemas/encoder-demotion-fixture.schema.json` (new sibling).

- `ENC-DEMO-001: platform darwin-x64 -> backend wasm + concrete demotionReason on the event`.
- `ENC-DEMO-002: linux-x64/darwin-arm64 -> no demotionReason, existing WASM/native rule unchanged`.
- `ENC-DEMO-003: flag-off -> event carries no demotionReason (byte-identical predecessor)`.
- `ENC-DEMO-004: flag-off -> /api/setup-cortex-status has no darwinX64 reason; card unchanged`.
- `ENC-DEMO-005: status payload darwinX64:{demoted:true,reason} renders the diagnosed blocker row`.
- `ENC-DEMO-006: contract field is additive — non-darwin hosts omit darwinX64, still validate`.

Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/enc0e-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/enc0e-acceptance.test.js
```

Expected assertions: all `ENC-DEMO-001..006` registered with algorithm `encoder-demotion` against the `encoder-demotion` schema, expected `ok`; aggregator flag-agnostic. Runtime-select unit assertions (platform-injected, no real Mac): darwin-x64 yields `backend:"wasm"` + reason; the function stays pure (same inputs → same output across calls); flag-off strips the reason. Route/contract assertions: `GET /api/setup-cortex-status` carries `darwinX64` only on the demoted platform; READER-ONLY GET capability; non-GET → 405; contract field validates with no `any`. Client: the `CortexBlockersCard` renders the reason; `cd extensions/dashboard-client && npm run typecheck && npm run build` passes. Unique failure injection: an injected `platform:"darwin-x64"` with an ENC-0a matrix row missing the `demotionReason` string → the selection must still choose mode-B WASM but the reason falls back to a deterministic sentinel (never a throw, never a fabricated native claim). Exact flag-off comparison command:

```bash
MEGACOMPACT_ENC_0E=0 node --test dist/vector-cortex/enc0e-acceptance.test.js
```

the aggregator is flag-agnostic. Acceptance: no payload leakage — the event + card carry platform/reason/backend only, never message content (EVAL-REDACT-002); zero network (local selection + loopback dashboard, PREVENT-PI-004). Apply [EVALUATION](../EVALUATION.md) annotation/power rules; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure — no schema/state changes.** The demotion reason is computed at runtime-selection time and read back via the existing setup-cortex status endpoint; the store schema and `stateDir` tables are untouched. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); the surfaced payload is a platform/reason/backend triple, never exact ledger bytes or prompt content. Dashboard: the Setup Cortex card is touched — owned files above under `extensions/` + client card; the endpoint surface is the existing reader-only `GET /api/setup-cortex-status` (additive field, no new route, no `EXPECTED_ENDPOINT_COUNT` bump); registration already in `routes.ts`/`route-dispatch.ts` (cross-cutting); run `cd extensions/dashboard-client && npm run typecheck && npm run build`. Rollback sets `MEGACOMPACT_ENC_0E=0`; the runtime-selection event carries no demotion reason and the Setup card renders byte-identical to the ENC-0b predecessor — without deleting the card code or evidence. No operator migration.

## Exit evidence

Run exact project gates:

```bash
npm run build
node --test dist/vector-cortex/enc0e-acceptance.test.js
MEGACOMPACT_ENC_0E=0 node --test dist/vector-cortex/enc0e-acceptance.test.js
npm test
npm run lint
python3 scripts/regression_check.py --all
node scripts/guardrails-scan.mjs
python3 scripts/log_failure.py --list
node scripts/vector-cortex-conformance.mjs --check
node scripts/vector-cortex-docs-check.mjs
node scripts/vector-cortex-scope-check.mjs ENC-0e <COMMIT_SHA>
node scripts/vector-cortex-evidence-check.mjs ENC-0e
cd extensions/dashboard-client && npm run typecheck && npm run build
git diff --check
```

No permissive globs or warning-only scans count. The evidence doc `ENC-0e.md` records the platform-injected darwin-x64 selection (no real Mac required), the enriched event line, the contract `darwinX64` field, and the Setup card render. Because the client card is touched, the dashboard-client typecheck+build gate is run.

## Live Playwright validation (MANDATORY)

The `CortexBlockersCard` darwin-x64 demotion row must be exercised live: launch the dashboard (default `http://localhost:9320`), navigate to the Setup surface, render the Cortex blockers card, and assert the `darwinX64` demotion reason is visible in the DOM with zero console errors. If no reachable dashboard host exists, the sprint pauses at implementer-complete until a live host is available; evidence names the host and the rendered card output.

This sprint is one of 15 new sprint docs in the program; the single docs-check reconciliation (owned by the integration step, not by any per-sprint commit) sets `EXPECTED_SPRINTS` to **60** in `scripts/vector-cortex-docs-check.mjs` (count at integration time). Cross-cutting seam only.
