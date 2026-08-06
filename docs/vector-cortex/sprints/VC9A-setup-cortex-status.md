# VC9A — Setup Cortex status read path

**Status:** done | **Depends on:** VC2A/VC2C + VC0F | **Phase:** VC9
**Flag:** `MEGACOMPACT_VC9A`, defined in `src/config/vector-cortex.ts` (extracted to the `vector-cortex-vc9a.ts` sibling), re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_VC9A=0` disables and must be byte-identical to the predecessor (returns `{enabled:false, mode:"C", status:"off"}`). Registered in `VECTOR_CORTEX_SETTINGS` as a boolDirect, never in `EXCLUDED_SETTINGS`.

## Goal and inputs/outputs

Consume only reviewer-accepted predecessor contracts and [common contracts](../CONTRACTS.md). Own the reader-only endpoint `GET /api/setup-cortex-status` surfacing the cortex encoder gate through the existing dashboard Setup tab, WITHOUT closing the ML gate. Production ownership: `extensions/dashboard-server/routes-setup-cortex.ts; extensions/dashboard-server/routes-setup-cortex.test.ts; extensions/dashboard-server/api-contracts/setup-cortex.ts; extensions/dashboard-server/api-contracts/endpoints/registry-ext.ts; extensions/dashboard-server/setup-cortex-blockers.ts; extensions/dashboard-server/route-dispatch.ts; extensions/dashboard-server/routes.ts; src/config/vector-cortex.ts; src/config/vector-cortex-vc9a.ts; src/config.ts; extensions/dashboard-server/routes-rag-settings-vector-cortex.ts; extensions/dashboard-server/api-contracts.test/endpoints-registry.test.ts; scripts/vc9-setup-dashboard/gen-fixtures.mjs; conformance/vector-cortex/v2/setup-dashboard/; conformance/vector-cortex/v2/schemas/setup-cortex-fixture.schema.json; conformance/vector-cortex/v2/manifest.json; src/vector-cortex/vc9a-acceptance.test.ts; docs/vector-cortex/sprints/VC9A-setup-cortex-status.md; docs/vector-cortex/evidence/VC9A.md; scripts/vector-cortex-docs-check.mjs`.
**Forced deviation (code-following):** `api-contracts.test/endpoints-registry.test.ts` is outside the plan's dev-ownership wording but the mandatory `npm test` gate hard-codes `EXPECTED_ENDPOINT_COUNT = 49`; the additive `setup-cortex-status` endpoint (registered in `registry-ext.ts`) makes the true count 50. The test is bumped 49→50 and the file is added to Production ownership — a mechanical registry-count reconciliation forced by the endpoint, flagged for controller ratification (scope-check's test-boundary exception applies by necessity). The endpoint is registered in the additive `registry-ext.ts` seam (NOT `registry.ts`) — `registry.ts` sits at 497 lines and a new group would cross the 500-line extension hard limit, so the established delegate-shell convention routes additive groups to `registry-ext.ts`; this is a code-following deviation from the plan's `registry.ts (additive)` spelling, flagged for controller ratification. Algorithm: reader-only aggregate reusing `readEncoderManifest` + `verifyEncoderAsset` + `detectPlatform` (`src/vector-cortex/encoder/asset.ts:148/103/55`) and the memoized-facts pattern from `routes-vector-cortex-health.ts:71-122` (manifest bytes + mtime+platform cache key). Blockers enumerate the vc2-model-prep §6 items from a new `setup-cortex-blockers.ts` manifest module (single canonical source, no string literals in routes). Response shape: `{ enabled, flag, mode, assetDigestPrefix, qualification:{verdict,thresholdFailures[]}, blockers:BlockerV1[], encoderHealth, updatedAt, status:VcStatus }`; `status` comes from `deriveVcStatus({enabled: VC9A_ENABLED(), hasData: manifestPresent, structuralOnly: true})`.

## Numbered implementation tasks

1. Define the `SetupCortexStatusResponse` / `BlockerV1` contract in `api-contracts/setup-cortex.ts` and register `setupCortexStatus` under the `setup-cortex` group in `api-contracts/endpoints/registry-ext.ts` (the additive seam that keeps `registry.ts` under its 500-line hard limit).
2. Add the `MEGACOMPACT_VC9A` flag (default ON, `=0` byte-identical) in `src/config/vector-cortex-vc9a.ts` + the `vector-cortex.ts`/`src/config.ts` re-exports, and the `VECTOR_CORTEX_SETTINGS` boolDirect toggle.
3. Author `setup-cortex-blockers.ts` (the four open hard-gate items: HG-1 five-head training; HG-3 onnxruntime-node 258 MiB with the transformers.js v4.2.0 WASM candidate; HG-4 darwin-x64 absent; HG-5 RSS margin) with no string literals in the route.
4. Implement `handleSetupCortexStatus` in `routes-setup-cortex.ts` reusing the encoder asset seams + the memoized-facts pattern; register it in `routes.ts` + `route-dispatch.ts`.
5. Generate + commit the 9 `SETUP-CORTEX-001..009` fixtures (mode A / mode B demotion / mode C asset-missing / flag-off global shape / blockers canonical) + the schema via `scripts/vc9-setup-dashboard/gen-fixtures.mjs`; register them in the v2 manifest.
6. Add the route unit tests (`routes-setup-cortex.test.ts`) + the sprint acceptance aggregator `vc9a-acceptance.test.ts`, then evidence `VC9A.md`.

## Failure triad and independence

A reader-only secured projection (flag-on full shape); B payload-free digest-prefix projection (asset digest prefix only, never bytes); C the offset (flag-off) VC8C-era shape, forced by `MEGACOMPACT_VC9A=0`. A/B share the encoder asset seams; C is produced purely by the flag gate and is byte-identical to the predecessor. Each uses independent algorithms/assets as applicable. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/setup-dashboard/`.

- `SETUP-CORTEX-001: mode A projects qualified with the 4 canonical open blockers and a structural status`.
- `SETUP-CORTEX-002: mode B demotion projects a non-empty threshold failure and a structural status`.
- `SETUP-CORTEX-003: mode C asset-missing projects unavailable with a null digest prefix`.
- `SETUP-CORTEX-004: flag-off projects enabled false, mode C, empty blockers, off status`.
- `SETUP-CORTEX-005..009: blockers canonical (HG-1/HG-3/HG-4/HG-5), verdict/status/shape enum closures, payload-free body`.

Exact test sources: `extensions/dashboard-server/routes-setup-cortex.test.ts`. Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc9a-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc9a-acceptance.test.js
```

Expected assertions: all `SETUP-CORTEX-001..009` conformance rows are registered with algorithm `setup-cortex` and validate their schema envelope; the canonical blocker set is exactly `HG-1, HG-3, HG-4, HG-5` (the opset HG-2 blocker is REMOVED per the 2026-08-05 research); the real committed asset's encoder facts cross-check the mode-A fixture on a verified host. Route tests: flag-on returns `enabled`, a full blocker list, `status:"structural"`, and digest prefixes (never payload bytes); flag-off returns `{enabled:false, mode:"C", status:"off"}` with empty blockers; non-GET → 405. The aggregator is flag-agnostic so the SAME suite is green under both flag states. Exact flag-off comparison command: `MEGACOMPACT_VC9A=0 node --test dist/vector-cortex/vc9a-acceptance.test.js`; its outbound/predecessor golden bytes must match exactly. Acceptance: zero payload leakage; reader-only (no mutation surface); every new endpoint returns a non-empty `status` from `deriveVcStatus`. Apply [EVALUATION](../EVALUATION.md) annotation/power rules; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure—no migration; setup-cortex reader v1**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); the read path returns digest prefixes + codes only, never payload bytes / prompts / ledger (EVAL-REDACT-002). Dashboard: Setup Cortex status endpoint owned at `routes-setup-cortex.ts`, registered in `routes.ts` / `route-dispatch.ts` / `api-contracts/endpoints/registry.ts`, SETTINGS toggle in `routes-rag-settings-vector-cortex.ts`; route/contract tests + reader-only GET capability with no mutation surface; run `cd extensions/dashboard-client && npm run typecheck && npm run build` if the client is touched.

Rollback sets `MEGACOMPACT_VC9A=0`, returning `{enabled:false, mode:"C", status:"off"}` (byte-identical to the VC8C-era shape), without deleting evidence; the predecessor golden bytes are unchanged. Next handoff: VC9B receives the setup-cortex action drivers.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc9a-acceptance.test.js`, `MEGACOMPACT_VC9A=0 node --test dist/vector-cortex/vc9a-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, `node scripts/vector-cortex-scope-check.mjs VC9A <COMMIT_SHA>`, `node scripts/vector-cortex-evidence-check.mjs VC9A`, `git diff --check`, `cd extensions/dashboard-client && npm run typecheck && npm run build`. No permissive globs or warning-only scans count.

This sprint adds a 30th sprint file, so `EXPECTED_SPRINTS` in `scripts/vector-cortex-docs-check.mjs` is bumped from 29 to 30; that script is included in Production ownership (a genuine docs-check reconciliation, not a scope drift).
