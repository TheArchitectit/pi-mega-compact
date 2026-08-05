# VC5C — Powered live reconstruction rollout

**Status:** done | **Depends on:** VC5B | **Phase:** VC5
**Flag:** `MEGACOMPACT_VC5C`, defined in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_VC5C=0` disables and must be byte-identical to the predecessor. Add to dashboard `SETTINGS`, or record the immutable/security exclusion below.

## Goal and inputs/outputs

Consume only reviewer-accepted predecessor contracts and [common contracts](../CONTRACTS.md). Own **RolloutAssignmentV1 / LiveOutcomeV1**. Production ownership: `src/vector-cortex/rollout/{types,assign,gate,emit}.ts; src/vector-cortex/rollout/{_acceptance-fixture,_acceptance-helpers,_acceptance-scenario}.ts; extensions/mega-runtime/vector-cortex-live.ts`. Algorithm: Hash session to stable 10k bucket; gates 1/5/25/50/100%; require 72h AND powered sample AND 10k events/200 sessions.

## Numbered implementation tasks

1. Define `RolloutAssignmentV1` session/bucket/gate/mode and `LiveOutcomeV1` safety/power fields; register `ROL-001..020`.
2. Implement `assign.ts` as a stable session hash into buckets `0..9999`; gates are exactly `1/5/25/50/100%` and assignment never changes with process restart.
3. Implement `gate.ts` to require elapsed 72h AND powered sample AND at least 10,000 events and 200 sessions before advancing one gate.
4. Integrate `vector-cortex-live.ts` before provider invocation so any hard causal/tool/anchor/exact failure immediately selects C and freezes promotion.
5. Emit `vector_cortex_rollout_assigned` and `vector_cortex_rollout_promotion_blocked`; own rollout read endpoint and explicit audited admin control in VectorCortexTab.
6. After rollout/runtime/dashboard production gates pass, add fake-clock live tests and fixtures, then evidence `VC5C.md`.

## Failure triad and independence

A closed renderer; B deterministic greedy renderer; C pre-VC path. Each uses independent algorithms/assets/indexes as applicable. C states its loss of old semantic context; authority outage freezes derived high-water. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/rollout/`.

- `ROL-BUCKET-001: fixed session digest maps to golden bucket`.
- `ROL-POWER-002: 72h and 10k events but 199 sessions cannot advance`.
- `ROL-SAFETY-003: one tool-pair violation immediately blocks promotion`.

Exact test sources: `src/vector-cortex/rollout/assign.test.ts`; `src/vector-cortex/rollout/gate.test.ts`; `src/vector-cortex/rollout/live-chaos.test.ts`. Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc5c-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc5c-acceptance.test.js
```

Expected assertions: all `ROL-001..020 plus held-out replay` conformance rows return their manifest bytes or exact listed failure code; generate session IDs, event/session counts, elapsed times, and safety outcomes; invariant: gate advancement is monotonic by one step and only when every conjunct holds. Unique failure injection: restart at 71h59m with wall-clock jump +1d but monotonic clock unchanged; promotion remains blocked. Forced triad: A=closed renderer for assigned canary buckets; B=deterministic greedy renderer forced by A breaker; C=pre-VC path forced by hard violation. Breaker recovery must follow the sprint triad contract. Exact flag-off comparison command: `MEGACOMPACT_VC5C=0 node --test dist/vector-cortex/vc5c-acceptance.test.js`; its outbound/predecessor golden bytes must match exactly. Acceptance: one-sided CI lower(A-C)>=-1pp and zero hard safety violations. Apply [EVALUATION](../EVALUATION.md) annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure—no migration**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); exact ledger is not training data. Dashboard: rollout endpoint/tab controls via explicit admin. Dashboard work must own `extensions/dashboard-server/api-contracts/vector-cortex.ts`, registration in `routes.ts`, handler `routes-vector-cortex.ts`, client `api/vector-cortex.ts`, `types/vector-cortex.ts`, `tabs/VectorCortexTab.tsx`, route/client/component tests, reader-only GET capability, and run `cd extensions/dashboard-client && npm run typecheck && npm run build`.

Rollback sets `MEGACOMPACT_VC5C=0`, selects C, restores the prior derived pointer without deleting evidence, and verifies predecessor golden bytes. Next handoff: VC6A receives live failure corpus; closure remains mandatory VC4C.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc5c-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, and `git diff --check`. asset/Rust/dashboard gates additionally apply when named by this sprint. No permissive globs or warning-only scans count.
