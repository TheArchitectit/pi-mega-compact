# VC7B — Provider registry and cache economics

**Status:** planned | **Depends on:** VC7A | **Phase:** VC7
**Flag:** `MEGACOMPACT_VC7B`, defined in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_VC7B=0` disables and must be byte-identical to the predecessor. Add to dashboard `SETTINGS`, or record the immutable/security exclusion below.

## Goal and inputs/outputs

Consume only reviewer-accepted predecessor contracts and [common contracts](../CONTRACTS.md). Own **ProviderProfileV1 extension / CacheExperimentV1**. Production ownership: `src/vector-cortex/provider/{registry,economics}.ts; src/vector-cortex/cache/compiler.ts`. Algorithm: Extend VC5B registry economics only; exclusions require fixture ID; randomize session-level live telemetry; shadow metrics labeled estimates.

## Numbered implementation tasks

1. Extend `ProviderProfileV1` with read/write price, TTL, minimum prefix, and exclusion fixture ID; define `CacheExperimentV1`; register `PRO-024..030`, `CACHE-001..015`.
2. Implement `economics.ts` exact read/write/token savings arithmetic and require a conformance fixture ID for every provider exclusion.
3. Implement `compiler.ts` to create provider-safe crystal boundaries from validated ranges/profile limits without changing request identity.
4. Assign live experiments by stable session bucket; label non-randomized or shadow-only outcomes `estimate` and exclude them from causal intervals.
5. Emit `vector_cortex_cache_experiment_assigned` and `vector_cortex_cache_economics_estimated`; own cache economics endpoint/types/Cache tab.
6. After registry/economics/compiler/dashboard production gates pass, add telemetry and boundary fixtures/tests, then evidence `VC7B.md`.

## Failure triad and independence

A provider crystal compiler; B uncached profile render; C raw legacy request. Each uses independent algorithms/assets/indexes as applicable. C states its loss of old semantic context; authority outage freezes derived high-water. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/cache-economics/`.

- `CACHE-COST-001: known write/read prices yield golden net savings`.
- `CACHE-EXCLUDE-002: provider exclusion without fixture ID rejects`.
- `CACHE-RANDOM-003: every event in one session shares assignment`.

Exact test sources: `src/vector-cortex/provider/{registry,economics}.test.ts; src/vector-cortex/cache/compiler.test.ts`. Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc7b-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc7b-acceptance.test.js
```

Expected assertions: all `PRO-024..030,CACHE-001..015` conformance rows return their manifest bytes or exact listed failure code; generate provider prices, token counts, TTLs, and session IDs; invariant: causal aggregates include only randomized live telemetry and arithmetic remains finite. Unique failure injection: lose assignment journal after first event then restart; stable hash restores the same arm without cross-arm session rows. Forced triad: A=provider crystal compiler with randomized telemetry; B=uncached profile render forced by exclusion; C=raw legacy request forced by unknown provider. Breaker recovery must follow the sprint triad contract. Exact flag-off comparison command: `MEGACOMPACT_VC7B=0 node --test dist/vector-cortex/vc7b-acceptance.test.js`; its outbound/predecessor golden bytes must match exactly. Acceptance: zero false cache identity; causal CI from powered provider telemetry only. Apply [EVALUATION](../EVALUATION.md) annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **M5 request-hash-v2 starts; copy/validate no switch until VC7C**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); exact ledger is not training data. Dashboard: cache economics endpoint/types/Cache tab. Dashboard work must own `extensions/dashboard-server/api-contracts/vector-cortex.ts`, registration in `routes.ts`, handler `routes-vector-cortex.ts`, client `api/vector-cortex.ts`, `types/vector-cortex.ts`, `tabs/VectorCortexTab.tsx`, route/client/component tests, reader-only GET capability, and run `cd extensions/dashboard-client && npm run typecheck && npm run build`.

Rollback sets `MEGACOMPACT_VC7B=0`, selects C, restores the prior derived pointer without deleting evidence, and verifies predecessor golden bytes. Next handoff: VC7C receives M5 shadow comparison and experiment report.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc7b-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, and `git diff --check`. asset/Rust/dashboard gates additionally apply when named by this sprint. No permissive globs or warning-only scans count.
