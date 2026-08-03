# VC3B — Deterministic cortical topology

**Status:** planned | **Depends on:** VC3A | **Phase:** VC3
**Flag:** `MEGACOMPACT_VC3B`, defined in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_VC3B=0` disables and must be byte-identical to the predecessor. Add to dashboard `SETTINGS`, or record the immutable/security exclusion below.

## Goal and inputs/outputs

Consume only reviewer-accepted predecessor contracts and [common contracts](../CONTRACTS.md). Own **TopologyV1 / EdgeV1**. Production ownership: `src/vector-cortex/topology/types.ts`; `src/vector-cortex/topology/build.ts`; `src/vector-cortex/topology/index.ts`. Algorithm: Create top-k=16/head edges above calibrated threshold; stable sort score desc then target ID bytes; dependency directed, contradiction symmetric.

## Numbered implementation tasks

1. Define `TopologyV1` generation/digest and `EdgeV1` source/target/head/score/direction; register `TOP-001..020`.
2. Implement `build.ts` to score each head, retain only calibrated-threshold edges, and cap each source/head at `top-k=16`.
3. Sort candidates by score descending then unsigned target-ID bytes; remove self edges and reject non-finite scores as `TOP_SCORE_NONFINITE`.
4. Encode dependency edges directed and contradiction edges as symmetric paired records; `index.ts` computes stable graph digest.
5. Emit `vector_cortex_topology_built` and `vector_cortex_topology_edge_rejected`; expose exact node/edge shapes through the stated topology endpoint/client.
6. After topology production and dashboard gates pass, add build/property tests and fixtures, then evidence `VC3B.md`.

## Failure triad and independence

A multi-head index; B linear VectorSet scan; C seq/keyword. Each uses independent algorithms/assets/indexes as applicable. C states its loss of old semantic context; authority outage freezes derived high-water. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/topology/`.

- `TOP-K-001: seventeenth eligible neighbor is excluded`.
- `TOP-TIE-002: equal scores sort target IDs by unsigned bytes`.
- `TOP-KIND-003: dependency has one direction while contradiction has two`.

Exact test sources: `src/vector-cortex/topology/build.test.ts`; `src/vector-cortex/topology/property.test.ts`. Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc3b-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc3b-acceptance.test.js
```

Expected assertions: all `TOP-001..020` conformance rows return their manifest bytes or exact listed failure code; generate finite vector sets and threshold/tie patterns; invariant: no self-edge/NaN, degree <=16 per head, and graph digest ignores input order. Unique failure injection: inject NaN from one head among valid candidates; reject that edge with `TOP_SCORE_NONFINITE` without poisoning other heads. Forced triad: A=multi-head topology index; B=linear VectorSet scan with same thresholds; C=source-seq/keyword traversal with vector data unavailable. Breaker recovery must follow the sprint triad contract. Exact flag-off comparison command: `MEGACOMPACT_VC3B=0 node --test dist/vector-cortex/vc3b-acceptance.test.js`; its outbound/predecessor golden bytes must match exactly. Acceptance: byte-identical graph 1,000 runs; no self-edge/NaN; recall >=.95. Apply [EVALUATION](../EVALUATION.md) annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure—derived rebuild only**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); exact ledger is not training data. Dashboard: topology endpoint shapes/nodes/edges. Dashboard work must own `extensions/dashboard-server/api-contracts/vector-cortex.ts`, registration in `routes.ts`, handler `routes-vector-cortex.ts`, client `api/vector-cortex.ts`, `types/vector-cortex.ts`, `tabs/VectorCortexTab.tsx`, route/client/component tests, reader-only GET capability, and run `cd extensions/dashboard-client && npm run typecheck && npm run build`.

Rollback sets `MEGACOMPACT_VC3B=0`, selects C, restores the prior derived pointer without deleting evidence, and verifies predecessor golden bytes. Next handoff: VC3C receives TopologyV1 and generation digest.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc3b-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, and `git diff --check`. Sprints that add or alter any runtime path also run `node scripts/vector-cortex-network-denial.mjs --modes=A,B,C`; asset/Rust/dashboard gates additionally apply when named by this sprint. No permissive globs or warning-only scans count.
