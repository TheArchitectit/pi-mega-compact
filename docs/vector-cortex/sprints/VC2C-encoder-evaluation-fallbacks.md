# VC2C — Qualify encoder and package fallbacks

**Status:** next | **Depends on:** VC2B | **Phase:** VC2
**Flag:** `MEGACOMPACT_VC2C`, defined in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_VC2C=0` disables and must be byte-identical to the predecessor. Add to dashboard `SETTINGS`, or record the immutable/security exclusion below.

## Goal and inputs/outputs

Consume only reviewer-accepted predecessor contracts and [common contracts](../CONTRACTS.md). Own **QualifiedEncoderV1 / CalibrationV1**. Production ownership: `src/vector-cortex/encoder/{calibrate,select}.ts; scripts/deploy.sh asset gate; package asset inclusion`. Algorithm: Fit calibration on calibration split only; A eligibility atomic; clean offline install; npm dry-run listing, never tgz.

## Numbered implementation tasks

1. Define `QualifiedEncoderV1` eligibility, asset digest, calibration digest, held-out metrics and `CalibrationV1`; register `ENC-017..020`.
2. Implement `calibrate.ts` using only the calibration split and stable score/id ties; prohibit held-out labels from fit inputs.
3. Implement `select.ts` as an atomic eligibility check across every MODEL_ASSET and per-head EVALUATION threshold; any failed field demotes all of A.
4. Extend `scripts/deploy.sh` asset gate and package dry-run listing to require the qualified manifest and total package listing <=35MiB, without creating a tgz artifact.
5. Emit `vector_cortex_encoder_qualification_passed` and `vector_cortex_encoder_qualification_demoted`; expose asset digest/mode in the stated health GET and flag in SETTINGS.
6. After qualification/package production gates pass, add calibrate/select/fallback and asset-script tests, then evidence `VC2C.md`.

## Failure triad and independence

A qualified learned; B trigram; C lexical/exact live. Each uses independent algorithms/assets/indexes as applicable. C states its loss of old semantic context; authority outage freezes derived high-water. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/encoder-qualification/`.

- `ENC-CAL-001: calibration fit excludes held-out fixture IDs`.
- `ENC-ATOMIC-002: one failed causal head demotes entire A`.
- `ENC-PACK-003: clean package listing contains manifest and ONNX under 35MiB`.

Exact test sources: `src/vector-cortex/encoder/{calibrate,select,fallback}.test.ts; scripts/vector-cortex-assets.test.mjs`. Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc2c-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc2c-acceptance.test.js
```

Expected assertions: all `ENC-017..020 plus held-out annotations` conformance rows return their manifest bytes or exact listed failure code; generate split assignments grouped by repo/session; invariant: no group crosses split and selection is invariant to row order. Unique failure injection: corrupt qualification manifest after calibration but before selection; return `ENC_QUALIFICATION_DIGEST_MISMATCH` and choose B. Forced triad: A=fully qualified learned asset; B=trigram forced by one failed threshold; C=lexical/exact forced by absent A and injected B error. Breaker recovery must follow the sprint triad contract. Exact flag-off comparison command: `MEGACOMPACT_VC2C=0 node --test dist/vector-cortex/vc2c-acceptance.test.js`; its outbound/predecessor golden bytes must match exactly. Acceptance: all MODEL_ASSET and per-head EVALUATION thresholds; package <=35MiB listing. Apply [EVALUATION](../EVALUATION.md) annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure—no DB migration; qualification manifest switch**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); exact ledger is not training data. Dashboard: GET health exposes asset digest/mode; SETTINGS flag. Dashboard work must own `extensions/dashboard-server/api-contracts/vector-cortex.ts`, registration in `routes.ts`, handler `routes-vector-cortex.ts`, client `api/vector-cortex.ts`, `types/vector-cortex.ts`, `tabs/VectorCortexTab.tsx`, route/client/component tests, reader-only GET capability, and run `cd extensions/dashboard-client && npm run typecheck && npm run build`.

Rollback sets `MEGACOMPACT_VC2C=0`, selects C, restores the prior derived pointer without deleting evidence, and verifies predecessor golden bytes. Next handoff: VC3A receives qualified VectorSet or explicit B/C mode.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc2c-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, and `git diff --check`. Sprints that add or alter any runtime path also run `node scripts/vector-cortex-network-denial.mjs --modes=A,B,C`; asset/Rust/dashboard gates additionally apply when named by this sprint. No permissive globs or warning-only scans count.
