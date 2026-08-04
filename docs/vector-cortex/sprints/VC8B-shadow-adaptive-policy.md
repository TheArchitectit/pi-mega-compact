# VC8B — Bounded shadow adaptive policy

**Status:** planned | **Depends on:** VC8A | **Phase:** VC8
**Flag:** `MEGACOMPACT_VC8B`, defined in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_VC8B=0` disables and must be byte-identical to the predecessor. Add to dashboard `SETTINGS`, or record the immutable/security exclusion below.

## Goal and inputs/outputs

Consume only reviewer-accepted predecessor contracts and [common contracts](../CONTRACTS.md). Own **PolicyDecisionV1 / PressureV2**. Production ownership: `src/vector-cortex/controller/{types,policy,shadow}.ts; src/vector-cortex/migrations/pressure-v2.ts`. Algorithm: Allowed actions finite; clamp budgets; shadow cannot mutate prompt; canonical pressure `low`; `medium`; `high`; `ultra`; `mega` unknown rejects.

## Numbered implementation tasks

1. Define finite `PolicyDecisionV1` action/budget/reason and canonical `PressureV2`; register `POL-001..025`, `M7-001..015`.
2. Implement `policy.ts` allowed action enum, clamp token budgets to configured min/max, and reject unknown pressure labels as `POL_PRESSURE_UNKNOWN`.
3. Implement `shadow.ts` on copied inputs and return decisions/metrics only; it must have no renderer, store-writer, or prompt mutation capability.
4. Implement M7 copy/validate mapping only `low`; `medium`; `high`; `ultra`; `mega`, compare counts/digests, then atomically switch pressure pointer.
5. Emit `vector_cortex_shadow_decision_recorded` and `vector_cortex_policy_action_rejected`; own policy shadow API/tab and SETTINGS flag.
6. After policy/shadow/M7/dashboard production gates pass, add bounds/mutation fixtures/tests, then evidence `VC8B.md`.

## Failure triad and independence

A offline learned shadow; B static calibrated; C fixed legacy thresholds. Each uses independent algorithms/assets/indexes as applicable. C states its loss of old semantic context; authority outage freezes derived high-water. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/adaptive-policy/`.

- `POL-CLAMP-001: below-min and above-max budgets clamp exactly`.
- `POL-SHADOW-002: decision leaves canonical prompt digest unchanged`.
- `M7-PRESSURE-003: unknown label rejects migration row`.

Exact test sources: `src/vector-cortex/controller/{policy,shadow}.test.ts; src/vector-cortex/migrations/pressure-v2.test.ts`. Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc8b-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc8b-acceptance.test.js
```

Expected assertions: all `POL-001..025,M7-001..015` conformance rows return their manifest bytes or exact listed failure code; generate pressures, arbitrary numeric budgets, and finite actions; invariant: every output action is allowed, budget bounded, and input prompt bytes unchanged. Unique failure injection: kill after M7 copied state then insert unknown legacy pressure; validation returns `M7_PRESSURE_UNKNOWN` and keeps old pointer. Forced triad: A=offline learned shadow decision; B=static calibrated policy forced by invalid A action; C=fixed legacy thresholds forced by M7 or B failure. Breaker recovery must follow the sprint triad contract. Exact flag-off comparison command: `MEGACOMPACT_VC8B=0 node --test dist/vector-cortex/vc8b-acceptance.test.js`; its outbound/predecessor golden bytes must match exactly. Acceptance: 100% actions within bounds; shadow live mutation count zero. Apply [EVALUATION](../EVALUATION.md) annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **M7 pressure-v2 copy/validate/switch**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); exact ledger is not training data. Dashboard: policy shadow API/tab and SETTINGS. Dashboard work must own `extensions/dashboard-server/api-contracts/vector-cortex.ts`, registration in `routes.ts`, handler `routes-vector-cortex.ts`, client `api/vector-cortex.ts`, `types/vector-cortex.ts`, `tabs/VectorCortexTab.tsx`, route/client/component tests, reader-only GET capability, and run `cd extensions/dashboard-client && npm run typecheck && npm run build`.

Rollback sets `MEGACOMPACT_VC8B=0`, selects C, restores the prior derived pointer without deleting evidence, and verifies predecessor golden bytes. Next handoff: VC8C receives signed policy report and pressure fixtures.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc8b-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, and `git diff --check`. asset/Rust/dashboard gates additionally apply when named by this sprint. No permissive globs or warning-only scans count.
