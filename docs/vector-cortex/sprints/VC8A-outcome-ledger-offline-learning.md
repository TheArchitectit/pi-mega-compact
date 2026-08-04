# VC8A — Consent-bound outcome ledger

**Status:** planned | **Depends on:** VC7C | **Phase:** VC8
**Flag:** `MEGACOMPACT_VC8A`, defined in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_VC8A=0` disables and must be byte-identical to the predecessor. Add to dashboard `SETTINGS`, or record the immutable/security exclusion below.

## Goal and inputs/outputs

Consume only reviewer-accepted predecessor contracts and [common contracts](../CONTRACTS.md). Own **OutcomeV1 / ConsentV1 / DatasetManifestV1**. Production ownership: `src/vector-cortex/outcomes/{types,ledger,consent,dataset}.ts; scripts/vector-cortex-dataset.mjs`. Algorithm: Append metrics without payload; training inclusion requires active explicit consent; split repo+session; revocation excluded from future manifest.

## Numbered implementation tasks

1. Define payload-free `OutcomeV1`, append-only `ConsentV1`, and `DatasetManifestV1` rows/digests/split; register `OUT-001..025`.
2. Implement `ledger.ts` append fields for session/repo/assignment/metrics only and reject prompt, response, exact bytes, or free-text payload fields as `OUT_PAYLOAD_FORBIDDEN`.
3. Implement `consent.ts` as append-only grants/revocations with effective sequence; dataset inclusion requires active explicit consent at export time.
4. Implement `dataset.ts` grouping by `(repo,session)` so no group crosses train/calibration/held-out split; revocations disappear from future manifests.
5. Emit `vector_cortex_outcome_appended` and `vector_cortex_dataset_record_excluded`; own aggregate outcomes GET and audited consent admin API.
6. After outcome/consent/dataset/dashboard production gates pass, add randomized export fixtures/tests and script, then evidence `VC8A.md`.

## Failure triad and independence

A learned-policy dataset; B aggregate redacted stats; C no learning. Each uses independent algorithms/assets/indexes as applicable. C states its loss of old semantic context; authority outage freezes derived high-water. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/outcomes/`.

- `OUT-CONSENT-001: grant includes later metric row`.
- `OUT-REVOKE-002: revocation excludes row from next manifest`.
- `OUT-SPLIT-003: all rows for repo/session remain in one split`.

Exact test sources: `src/vector-cortex/outcomes/ledger.test.ts`; `src/vector-cortex/outcomes/consent.test.ts`; `src/vector-cortex/outcomes/dataset.test.ts`. Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc8a-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc8a-acceptance.test.js
```

Expected assertions: all `OUT-001..025` conformance rows return their manifest bytes or exact listed failure code; generate consent timelines and grouped outcome rows; invariant: exported rows all have active consent and manifest digest is input-order independent. Unique failure injection: revoke consent during export snapshot; exporter uses one captured consent high-water and next export excludes revoked rows. Forced triad: A=consented learned-policy dataset; B=redacted aggregate stats forced without consent; C=no learning writes forced when ledger unavailable. Breaker recovery must follow the sprint triad contract. Exact flag-off comparison command: `MEGACOMPACT_VC8A=0 node --test dist/vector-cortex/vc8a-acceptance.test.js`; its outbound/predecessor golden bytes must match exactly. Acceptance: zero nonconsented records in 100 randomized exports; manifest digest reproducible. Apply [EVALUATION](../EVALUATION.md) annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure—new append-only outcome/consent tables**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); exact ledger is not training data. Dashboard: GET outcomes aggregate; consent admin API audited. Dashboard work must own `extensions/dashboard-server/api-contracts/vector-cortex.ts`, registration in `routes.ts`, handler `routes-vector-cortex.ts`, client `api/vector-cortex.ts`, `types/vector-cortex.ts`, `tabs/VectorCortexTab.tsx`, route/client/component tests, reader-only GET capability, and run `cd extensions/dashboard-client && npm run typecheck && npm run build`.

Rollback sets `MEGACOMPACT_VC8A=0`, selects C, restores the prior derived pointer without deleting evidence, and verifies predecessor golden bytes. Next handoff: VC8B receives frozen consent-bound dataset manifest.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc8a-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, and `git diff --check`. asset/Rust/dashboard gates additionally apply when named by this sprint. No permissive globs or warning-only scans count.
