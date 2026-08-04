# VC5A — PromptDagV1 and budgeted planner

**Status:** next | **Depends on:** VC4C | **Phase:** VC5
**Flag:** `MEGACOMPACT_VC5A`, defined in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_VC5A=0` disables and must be byte-identical to the predecessor. Add to dashboard `SETTINGS`, or record the immutable/security exclusion below.

## Goal and inputs/outputs

Consume only reviewer-accepted predecessor contracts and [common contracts](../CONTRACTS.md). Own **PromptDagV1 / PlanV1**. Production ownership: `src/vector-cortex/prompt-dag/{types,builder,validator}.ts; src/vector-cortex/planner/{types,portfolio}.ts`. Algorithm: own the exact single-session DAG schema; stable Kahn order; compute mandatory dependency/tool/anchor closure before optional selection; return `MANDATORY_CLOSURE_OVER_BUDGET` and demote to C when mandatory tokens exceed budget; otherwise run a 0/1 portfolio sorted by utility-per-token then source seq/id and never exceed the remaining budget.

## Numbered implementation tasks

1. Define exact single-session `PromptDagV1` nodes/edges and `PlanV1` selected IDs/tokens/utility/failure; register `DAG-001..030`, `PLN-001..020`.
2. Implement `builder.ts` to reject mixed sessions and build dependency/tool/anchor edges; `validator.ts` uses stable Kahn order with node-ID byte ties.
3. Compute mandatory closure before optional candidates and return `MANDATORY_CLOSURE_OVER_BUDGET` without dropping evidence when its tokens exceed budget.
4. Implement `portfolio.ts` 0/1 selection within remaining tokens, ordered by utility-per-token descending then source seq then ID bytes, never exceeding budget.
5. Emit `vector_cortex_plan_selected` and `vector_cortex_plan_mandatory_overflow`; expose only plan manifests at the stated reader-only GET.
6. After DAG/planner production and dashboard gates pass, add builder/validator/portfolio fixtures and tests, then evidence `VC5A.md`.

## Failure triad and independence

A portfolio optimization; B stable greedy closed plan; C predecessor prompt. Each uses independent algorithms/assets/indexes as applicable. C states its loss of old semantic context; authority outage freezes derived high-water. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture roots: normative DAG cases under `conformance/vector-cortex/v2/prompt-dag/`; portfolio-only cases under `conformance/vector-cortex/v2/planner/`.

- `DAG-CYCLE-001: dependency cycle rejects with DAG_CYCLE`.
- `PLN-MANDATORY-002: 101 mandatory tokens under budget 100 demotes to C`.
- `PLN-TIE-003: equal ratios choose lower source seq then ID bytes`.

Exact test sources: `src/vector-cortex/prompt-dag/{builder,validator}.test.ts; src/vector-cortex/planner/portfolio.test.ts`. Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc5a-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc5a-acceptance.test.js
```

Expected assertions: all `DAG-001..030,PLN-001..020` conformance rows return their manifest bytes or exact listed failure code; generate acyclic single-session DAGs, token budgets, and utilities; invariant: accepted plan is closed, deterministic, and token total <=budget. Unique failure injection: mutate a node token count after planning but before validation; validator returns `PLN_MANIFEST_DIGEST_MISMATCH` before provider call. Forced triad: A=0/1 portfolio optimizer; B=stable greedy closed planner forced by A exception; C=predecessor prompt forced by mandatory overflow. Breaker recovery must follow the sprint triad contract. Exact flag-off comparison command: `MEGACOMPACT_VC5A=0 node --test dist/vector-cortex/vc5a-acceptance.test.js`; its outbound/predecessor golden bytes must match exactly. Acceptance: cycles/incompatibilities rejected 100%; accepted A/B plans never exceed budget; over-budget mandatory closure never drops evidence and always demotes; deterministic 1,000 runs. Apply [EVALUATION](../EVALUATION.md) annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure—no migration**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); exact ledger is not training data. Dashboard: GET /api/vector-cortex/plans manifest-only. Dashboard work must own `extensions/dashboard-server/api-contracts/vector-cortex.ts`, registration in `routes.ts`, handler `routes-vector-cortex.ts`, client `api/vector-cortex.ts`, `types/vector-cortex.ts`, `tabs/VectorCortexTab.tsx`, route/client/component tests, reader-only GET capability, and run `cd extensions/dashboard-client && npm run typecheck && npm run build`.

Rollback sets `MEGACOMPACT_VC5A=0`, selects C, restores the prior derived pointer without deleting evidence, and verifies predecessor golden bytes. Next handoff: VC5B receives validated PlanV1/DAG digest/order.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc5a-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, and `git diff --check`. Asset/Rust/dashboard gates additionally apply when named by this sprint. No permissive globs or warning-only scans count.
