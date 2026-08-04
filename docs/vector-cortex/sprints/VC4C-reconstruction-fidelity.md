# VC4C — Conservative closure and reconstruction fidelity

**Status:** planned | **Depends on:** VC4B | **Phase:** VC4
**Flag:** `MEGACOMPACT_VC4C`, defined in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_VC4C=0` disables and must be byte-identical to the predecessor. Add to dashboard `SETTINGS`, or record the immutable/security exclusion below.

## Goal and inputs/outputs

Consume only reviewer-accepted predecessor contracts and [common contracts](../CONTRACTS.md). Own **ClosureResult / ReconstructionV1**. Production ownership: `src/vector-cortex/reconstruct/{closure,assemble,validate}.ts; scripts/vector-cortex-residual-benchmark.mjs`. Algorithm: Recursively add dependencies/tool pairs; contradiction keeps later exact resolution; unresolved ties reject; assemble source order; mandatory before VC5.

## Numbered implementation tasks

1. Define `ClosureResult` selected IDs/proof/failures plus `mandatoryTokenEstimate` (content only, no prompt framing) and `ReconstructionV1` ordered spans/digest; register `CLO-001..030`, `REC-001..030`.
2. Implement `closure.ts` worklist recursion over dependencies and whole tool pairs until fixed point; track visited IDs to terminate cycles.
3. Resolve contradictions by retaining the later exact source resolution; equal/unordered resolutions return `CLO_CONTRADICTION_UNRESOLVED`.
4. Implement `assemble.ts` to decode validated shards, insert protected exact bytes, sort solely by source range before concatenation, and compute the deterministic mandatory content-token estimate handed unchanged to VC5A.
5. Implement `validate.ts` to reject missing anchors, split pairs, digest mismatch, or unresolved contradiction; emit `vector_cortex_reconstruction_validated` and `vector_cortex_closure_rejected`, and expose summary/failure codes only.
6. After closure/assemble/validate production and benchmark gates pass, add replay fixtures/tests, then evidence `VC4C.md`.

## Failure triad and independence

A closed semantic+exact/residual; B greedy exact closure; C legacy prompt. Each uses independent algorithms/assets/indexes as applicable. C states its loss of old semantic context; authority outage freezes derived high-water. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/reconstruction/`.

- `CLO-TRANSITIVE-001: selecting a adds dependencies b then c`.
- `CLO-CONTRA-002: later exact resolution supersedes earlier claim`.
- `REC-ORDER-003: semantic and exact spans assemble by source offsets`.

Exact test sources: `src/vector-cortex/reconstruct/closure.test.ts`; `src/vector-cortex/reconstruct/assemble.test.ts`; `src/vector-cortex/reconstruct/replay.test.ts`. Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc4c-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc4c-acceptance.test.js
```

Expected assertions: all `CLO-001..030,REC-001..030` conformance rows return their manifest bytes or exact listed failure code; generate finite dependency graphs, paired tools, and contradiction timestamps; invariant: closure reaches a fixed point and validated output contains every protected span. Unique failure injection: erase one dependency shard and corrupt its residual fallback; validator returns `REC_SOURCE_UNAVAILABLE` and prevents live output. Forced triad: A=closed semantic/exact/residual reconstruction; B=greedy exact closure forced by semantic validation failure; C=legacy prompt forced by unresolved contradiction. Breaker recovery must follow the sprint triad contract. Exact flag-off comparison command: `MEGACOMPACT_VC4C=0 node --test dist/vector-cortex/vc4c-acceptance.test.js`; its outbound/predecessor golden bytes must match exactly. Acceptance: dependency/tool/anchor/exact recall=1.0; unresolved contradiction live escapes=0. Apply [EVALUATION](../EVALUATION.md) annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure—no migration; derived rebuild on algorithm bump**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); exact ledger is not training data. Dashboard: GET fidelity summaries and closure failures. Dashboard work must own `extensions/dashboard-server/api-contracts/vector-cortex.ts`, registration in `routes.ts`, handler `routes-vector-cortex.ts`, client `api/vector-cortex.ts`, `types/vector-cortex.ts`, `tabs/VectorCortexTab.tsx`, route/client/component tests, reader-only GET capability, and run `cd extensions/dashboard-client && npm run typecheck && npm run build`.

Rollback sets `MEGACOMPACT_VC4C=0`, selects C, restores the prior derived pointer without deleting evidence, and verifies predecessor golden bytes. Next handoff: VC5A receives only validated closed candidates.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc4c-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, and `git diff --check`. Sprints that add or alter any runtime path also run `node scripts/vector-cortex-network-denial.mjs --modes=A,B,C`; asset/Rust/dashboard gates additionally apply when named by this sprint. No permissive globs or warning-only scans count.
