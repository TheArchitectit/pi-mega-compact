# VC2B — Train multi-head encoder

**Status:** planned | **Depends on:** VC2A | **Phase:** VC2
**Flag:** `MEGACOMPACT_VC2B`, defined in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_VC2B=0` disables and must be byte-identical to the predecessor. Add to dashboard `SETTINGS`, or record the immutable/security exclusion below.

## Goal and inputs/outputs

Consume only reviewer-accepted predecessor contracts and [common contracts](../CONTRACTS.md). Own **VectorSetV1 / HeadCalibrationDraft**. Production ownership: `src/vector-cortex/encoder/{heads,trigram,lexical}.ts; training/vector-cortex/{train.py,export_onnx.py}`. Algorithm: Five dimensions 384/128/128/64/32; losses .35/.20/.20/.15/.10; L2 normalize; seed1729; stable head order.

## Numbered implementation tasks

1. Define `VectorSetV1` ordered heads and `HeadCalibrationDraft`; register `ENC-009..016` before training/export logic.
2. Implement five heads in stable order with dimensions `384/128/128/64/32` and L2-normalize each vector, mapping zero norm to an all-zero vector.
3. Implement training losses exactly `.35/.20/.20/.15/.10`, seed Python/NumPy/export at `1729`, and persist corpus/split digests.
4. Implement trigram B at 512 dimensions and token/phrase lexical C without importing the learned asset or learned calibration.
5. Emit `vector_cortex_encoder_heads_emitted` and `vector_cortex_encoder_fallback_selected`; no dashboard or API change is necessary.
6. After heads/fallback/training production artifacts pass gates, add shape/independence tests and fixtures, then evidence `VC2B.md`.

## Failure triad and independence

A learned projections; B 512d trigram no asset; C token/phrase lexical. Each uses independent algorithms/assets/indexes as applicable. C states its loss of old semantic context; authority outage freezes derived high-water. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/encoder-heads/`.

- `ENC-HEAD-001: all five output shapes match ordered dimensions`.
- `ENC-ZERO-002: empty input produces finite zero vectors`.
- `ENC-FALLBACK-003: removed model still yields 512d trigram B`.

Exact test sources: `src/vector-cortex/encoder/heads.test.ts`; `src/vector-cortex/encoder/fallback-independence.test.ts`. Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc2b-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc2b-acceptance.test.js
```

Expected assertions: all `ENC-009..016` conformance rows return their manifest bytes or exact listed failure code; generate token sequences and repeated seeded exports; invariant: all norms are 0 or within 1e-6 of 1 and repeat drift <=1e-6. Unique failure injection: delete model after A selection but before inference; router catches load failure and selects independently initialized B. Forced triad: A=learned projections with candidate asset; B=512d trigram with asset directory removed; C=token/phrase lexical with both vector runtimes disabled. Breaker recovery must follow the sprint triad contract. Exact flag-off comparison command: `MEGACOMPACT_VC2B=0 node --test dist/vector-cortex/vc2b-acceptance.test.js`; its outbound/predecessor golden bytes must match exactly. Acceptance: repeat drift <=1e-6; every shape exact; B works with model removed. Apply [EVALUATION](../EVALUATION.md) annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure—no migration; model asset revision only**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); exact ledger is not training data. Dashboard: none. No dashboard or API change is necessary for this internal sprint.

Rollback sets `MEGACOMPACT_VC2B=0`, selects C, restores the prior derived pointer without deleting evidence, and verifies predecessor golden bytes. Next handoff: VC2C receives candidate asset digest and per-head logits.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc2b-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, and `git diff --check`. Sprints that add or alter any runtime path also run `node scripts/vector-cortex-network-denial.mjs --modes=A,B,C`; asset/Rust/dashboard gates additionally apply when named by this sprint. No permissive globs or warning-only scans count.
