# VC4B — Residual codec and numeric parity

**Status:** next | **Depends on:** VC4A | **Phase:** VC4
**Flag:** `MEGACOMPACT_VC4B`, defined in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_VC4B=0` disables and must be byte-identical to the predecessor. Add to dashboard `SETTINGS`, or record the immutable/security exclusion below.

## Goal and inputs/outputs

Consume only reviewer-accepted predecessor contracts and [common contracts](../CONTRACTS.md). Own **ResidualCodecV1 / ParityShardV1**. Production ownership: `src/vector-cortex/residual/types.ts`; `src/vector-cortex/residual/dct.ts`; `src/vector-cortex/residual/quantize.ts`; `src/vector-cortex/residual/parity.ts`; `src/vector-cortex/residual/codec.ts`. Algorithm: Implement RESIDUAL_CODEC: DCT4096, int16+corrections, RS(9,6) GF(0x11d), complete-byte admission <=95% exact compressed.

## Numbered implementation tasks

1. Define `ResidualCodecV1` block/basis/quantization/corrections fields and `ParityShardV1`; register `RES-001..050`.
2. Implement `dct.ts` with fixed block length 4096 and the exact RESIDUAL_CODEC coefficient order and rounding rules.
3. Implement `quantize.ts` int16 coefficients plus correction bytes; reject overflow/non-finite inputs with `RES_QUANTIZE_RANGE`.
4. Implement `parity.ts` Reed-Solomon `(9,6)` over GF polynomial `0x11d`, recovering every set of at most 3 erased shards.
5. Implement `codec.ts` complete-byte admission only when encoded residual+parity is <=95% of exact compressed bytes; emit `vector_cortex_residual_admitted` and `vector_cortex_parity_recovery_failed`, and expose aggregate-only residual metrics.
6. After codec/parity production and dashboard gates pass, add vectors/property tests and benchmark fixtures, then evidence `VC4B.md`.

## Failure triad and independence

A admitted residual+parity; B exact compressed; C ledger bytes. Each uses independent algorithms/assets/indexes as applicable. C states its loss of old semantic context; authority outage freezes derived high-water. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/residual/`.

- `RES-DCT-001: 4096-byte impulse matches coefficient golden`.
- `RES-RS-002: shards 1,4,8 erased reconstruct all bytes`.
- `RES-ADMIT-003: 95% boundary admits, one byte above rejects`.

Exact test sources: `src/vector-cortex/residual/codec.test.ts`; `src/vector-cortex/residual/parity.test.ts`; `src/vector-cortex/residual/property.test.ts`. Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc4b-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc4b-acceptance.test.js
```

Expected assertions: all `RES-001..050` conformance rows return their manifest bytes or exact listed failure code; generate byte blocks lengths 0..8193 and all erasure subsets of size <=3; invariant: admitted decode equals exact input bytes. Unique failure injection: flip one parity shard while marking two data shards erased; the per-shard SHA-256 check marks the corrupt parity shard as the third known erasure, recovery from the remaining six shards succeeds, and the final payload digest matches. A companion case with three marked data erasures plus one corrupt parity shard returns `RES_TOO_MANY_ERASURES` without attempting unknown-error correction. Forced triad: A=admitted residual plus RS parity; B=exact compressed bytes forced by >95% accounting; C=ledger bytes forced by A/B decode failure. Breaker recovery must follow the sprint triad contract. Exact flag-off comparison command: `MEGACOMPACT_VC4B=0 node --test dist/vector-cortex/vc4b-acceptance.test.js`; its outbound/predecessor golden bytes must match exactly. Acceptance: zero post-decode byte mismatch; recover every <=3 erasure set. Apply [EVALUATION](../EVALUATION.md) annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure—codec v1 derived artifacts only**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); exact ledger is not training data. Dashboard: residual aggregate endpoint, never payload. Dashboard work must own `extensions/dashboard-server/api-contracts/vector-cortex.ts`, registration in `routes.ts`, handler `routes-vector-cortex.ts`, client `api/vector-cortex.ts`, `types/vector-cortex.ts`, `tabs/VectorCortexTab.tsx`, route/client/component tests, reader-only GET capability, and run `cd extensions/dashboard-client && npm run typecheck && npm run build`.

Rollback sets `MEGACOMPACT_VC4B=0`, selects C, restores the prior derived pointer without deleting evidence, and verifies predecessor golden bytes. Next handoff: VC4C receives decode result, byte accounting, failure codes.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc4b-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, and `git diff --check`. asset/Rust/dashboard gates additionally apply when named by this sprint. No permissive globs or warning-only scans count.
