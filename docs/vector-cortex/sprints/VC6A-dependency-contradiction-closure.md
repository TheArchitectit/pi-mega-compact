# VC6A — Advanced closure optimization

**Status:** planned | **Depends on:** VC5C | **Phase:** VC6
**Flag:** `MEGACOMPACT_VC6A`, defined in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_VC6A=0` disables and must be byte-identical to the predecessor. Add to dashboard `SETTINGS`, or record the immutable/security exclusion below.

## Goal and inputs/outputs

Consume only reviewer-accepted predecessor contracts and [common contracts](../CONTRACTS.md). Own **ClosureProofV2 / RestoreHintV1**. Production ownership: `src/vector-cortex/heal/closure-opt.ts`; `src/vector-cortex/heal/proof.ts`. Algorithm: Optimize already-mandatory VC4C closure using transitive reduction; proof lists each added/removed edge; output must equal conservative closure validity.

## Numbered implementation tasks

1. Define `ClosureProofV2` retained/removed edges and reasons plus `RestoreHintV1`; register `HEAL-001..015`.
2. Implement `closure-opt.ts` deterministic transitive reduction over the already-mandatory VC4C closure, sorting vertices and edges by ID bytes.
3. Never remove tool-pair, anchor, contradiction-resolution, or sole dependency edges; record every considered removal in the proof.
4. Implement `proof.ts` verifier to replay reductions against the conservative oracle and return `HEAL_PROOF_SET_MISMATCH` on selected-set divergence.
5. Emit `vector_cortex_closure_optimized` and `vector_cortex_closure_proof_rejected`; expose the stated proof diagnostics endpoint without source payloads.
6. After optimizer/proof production and dashboard gates pass, add oracle/property fixtures/tests, then evidence `VC6A.md`.

## Failure triad and independence

A optimized proof; B VC4C closure; C legacy prompt. Each uses independent algorithms/assets/indexes as applicable. C states its loss of old semantic context; authority outage freezes derived high-water. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/closure-optimization/`.

- `HEAL-REDUCE-001: a->c is removed when a->b->c exists`.
- `HEAL-PROTECT-002: tool-pair edge is retained despite alternate path`.
- `HEAL-PROOF-003: omitted removal reason fails verification`.

Exact test sources: `src/vector-cortex/heal/closure-opt.test.ts`; `src/vector-cortex/heal/proof.test.ts`. Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc6a-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc6a-acceptance.test.js
```

Expected assertions: all `HEAL-001..015` conformance rows return their manifest bytes or exact listed failure code; generate DAGs with protected edge labels; invariant: optimized and conservative selected protected sets are equal and proof replay is deterministic. Unique failure injection: drop one proof row after optimization; verifier returns `HEAL_PROOF_INCOMPLETE` and routes to B. Forced triad: A=optimized closure with verified proof; B=VC4C conservative closure forced by proof rejection; C=legacy prompt forced if both closure paths fail. Breaker recovery must follow the sprint triad contract. Exact flag-off comparison command: `MEGACOMPACT_VC6A=0 node --test dist/vector-cortex/vc6a-acceptance.test.js`; its outbound/predecessor golden bytes must match exactly. Acceptance: same selected protected set as conservative oracle; >=20% fewer traversals median. Apply [EVALUATION](../EVALUATION.md) annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure—no migration; algorithm-version rebuild**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); exact ledger is not training data. Dashboard: closure proof diagnostics endpoint. Dashboard work must own `extensions/dashboard-server/api-contracts/vector-cortex.ts`, registration in `routes.ts`, handler `routes-vector-cortex.ts`, client `api/vector-cortex.ts`, `types/vector-cortex.ts`, `tabs/VectorCortexTab.tsx`, route/client/component tests, reader-only GET capability, and run `cd extensions/dashboard-client && npm run typecheck && npm run build`.

Rollback sets `MEGACOMPACT_VC6A=0`, selects C, restores the prior derived pointer without deleting evidence, and verifies predecessor golden bytes. Next handoff: VC6B receives missing-source hints and proof.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc6a-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, and `git diff --check`. asset/Rust/dashboard gates additionally apply when named by this sprint. No permissive globs or warning-only scans count.
