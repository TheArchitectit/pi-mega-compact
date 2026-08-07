# VC8A Evidence

Status: **reviewer-accepted** — controller prod-prep sweep (2026-08-07): missing dataset.mjs CLI shipped; outstanding OPEN items none.

**Reviewer attestation:** Not yet attested — pending independent reviewer.

## Prod-prep sweep (2026-08-07)

Close the spec ownership gap: `scripts/vector-cortex-dataset.mjs` (146) — the VC8A offline-learning dataset CLI required by spec task 6 ("add randomized export fixtures/tests and script"). It imports the compiled pure `buildManifest()` / `hasNonconsentedRecords()` from `dist/src/vector-cortex/outcomes/dataset.js`, reads `outcomes.jsonl` + `consent.jsonl` from a state dir, captures a single consent high-water, writes a `DatasetManifestV1` JSON, and exits non-zero on a nonconsented record. Local-only (PREVENT-PI-004). Outstanding OPEN items: none.

## Goal recap

Consent-bound outcome ledger (VC8A) — a payload-free outcome ledger with append-only consent grants/revocations and offline learning dataset manifest builder. VC8A ships four pure subsystems (none read the feature flag — only the emit seam is gated):

- **`OutcomeV1` / `appendOutcome()`** — accepts session/repo/assignment/metrics ONLY. Rejects prompt, response, exactBytes, freeText, content, payload, body, message, reply, output, completion, snippet as `OUT_PAYLOAD_FORBIDDEN`. Pure validation, no flag read.
- **`ConsentV1` / `hasActiveConsent()`** — append-only grants/revocations with effective sequence. A session has active consent at time T iff its most recent record at or before T is a grant. `consentHighWater()` returns the max effectiveSeq for a session.
- **`DatasetManifestV1` / `buildManifest()`** — groups outcomes by (repo, session) so no group crosses train/calibration/held-out split. Revoked sessions disappear from future manifests. Manifest digest is reproducible: SHA-256 over canonical sorted rows, input-order independent.
- **`emit.ts`** — `reportOutcomeAppended` + `reportDatasetRecordExcluded`, gated on `VC8A_ENABLED()`. Payload-free. `safe()` wrapper: broken telemetry never escapes.

`MEGACOMPACT_VC8A` gate (default ON; `=0` -> byte-identical predecessor, VC7C). **Zero runtime network calls (PREVENT-PI-004).**

## Changed production / tests / docs

Production (`src/vector-cortex/outcomes/`):
- `types.ts` (95) — `OutcomeV1`, `ConsentV1`, `DatasetManifestV1`, `OutcomeMetric`, `DatasetSplit`, `DatasetManifestRow`, schema versions, failure codes (`OUT_PAYLOAD_FORBIDDEN`, `OUT_CONSENT_MISSING`, `OUT_SPLIT_VIOLATION`), `OUTCOMES_CONFORMANCE_IDS` (OUT-001..025), `OUTCOMES_NAMED_FIXTURES`.
- `ledger.ts` (88) — `appendOutcome()`, `validateOutcome()`. Rejects 14 forbidden payload fields. Pure, no flag read.
- `consent.ts` (82) — `hasActiveConsent()`, `appendGrant()`, `appendRevoke()`, `consentHighWater()`. Append-only, pure.
- `dataset.ts` (132) — `buildManifest()`, `manifestDigest()`, `hasNonconsentedRecords()`. Groups by (repo, session), 70/15/15 split, SHA-256 over canonical sorted rows. Pure.
- `emit.ts` (79) — `reportOutcomeAppended()` + `reportDatasetRecordExcluded()`, gated on `VC8A_ENABLED()`. `safe()` wrapper.

Config:
- `src/config/vector-cortex.ts` — added `VC8A_ENABLED()` (default ON, `=0` byte-identical to VC7C).
- `src/config.ts` — re-exported `VC8A_ENABLED`.

Tests:
- `outcomes/ledger.test.ts` (156) — payload rejection (6 forbidden fields), append-only, field validation, missing required fields, non-numeric metrics.
- `outcomes/consent.test.ts` (128) — grant at effective seq, revoke wins, re-grant wins, session-scoped, consentHighWater, sorting.
- `outcomes/dataset.test.ts` (152) — consented inclusion, revocation exclusion, no consent exclusion, split integrity, multi-session splits, digest reproducibility, digest sensitivity, nonconsented detection.
- `outcomes/flag-parity-vc8a.test.ts` (138) — arithmetic parity ON vs OFF, event emission ON, event suppression OFF, payload-free payloads, throwing emitter non-fatal, absent emitter no-op.
- `vc8a-acceptance.test.ts` (28) — delegate-shell listing siblings + run commands.

Dashboard:
- `api-contracts/vector-cortex-outcomes.ts` (56) — `VectorCortexOutcomesView`, `ConsentAdminRequest`, `ConsentAdminResponse`.
- `routes-vector-cortex-outcomes.ts` (98) — GET /api/vector-cortex/outcomes (reader-only, counts + codes), POST /api/vector-cortex/outcomes/consent (audited).
- `routes-vector-cortex-outcomes.test.ts` (132) — ON aggregate, OFF mode C, non-GET rejected, payload-free body.
- `route-dispatch.ts` — wired `handleVectorCortexOutcomes`.
- `dashboard-client/src/types/vector-cortex-vc8.ts` (23) — `VectorCortexOutcomesView`.
- `dashboard-client/src/types/vector-cortex.ts` — re-exported `VectorCortexOutcomesView`.
- `dashboard-client/src/api/vector-cortex.ts` — `fetchVectorCortexOutcomes()`.
- `dashboard-client/src/tabs/VectorCortexOutcomesCard.tsx` (45) — VC8A consent-bound outcomes card.
- `dashboard-client/src/tabs/VectorCortexTab.tsx` — imported + rendered `VectorCortexOutcomesCard`.
- `dashboard-client/src/tabs/useVectorCortexPoll.ts` — `fetchVectorCortexOutcomes` + `outcomes` state.

Scripts:
- `scripts/gen-fixtures/outcomes.mjs` (120) — 25 OUT-001..025 + 3 named (OUT-CONSENT-001, OUT-REVOKE-002, OUT-SPLIT-003). All digests via `node:crypto`.
- `scripts/gen-fixtures/schemas.mjs` — added `outcome-fixture.schema.json`, `consent-fixture.schema.json`, `dataset-manifest-fixture.schema.json`.
- `scripts/gen-fixtures/write.mjs` — wired outcomes import + OUTCOMES_DIR + fixture loop + manifest extensions.
- `scripts/vector-cortex-dataset.mjs` (146) — VC8A offline-learning dataset CLI (spec ownership line 8 + task 6). Reads outcomes/consent JSONL from a state dir, captures one consent high-water, delegates to `buildManifest()` + `hasNonconsentedRecords()`, writes `DatasetManifestV1`. Local-only (PREVENT-PI-004).

## Fixtures and corpus digests

Conformance root: `conformance/vector-cortex/v2/outcomes/`.

| ID | Kind | Assertion |
| --- | --- | --- |
| OUT-001..OUT-025 | outcome | Payload-free outcome append validation accepted |
| OUT-CONSENT-001 | consent | Grant includes later metric row |
| OUT-REVOKE-002 | consent | Revocation excludes row from next manifest |
| OUT-SPLIT-003 | dataset | All rows for repo/session remain in one split |

## Gate results

- `npm run build` — PASS (tsc)
- `node --test dist/vector-cortex/vc8a-acceptance.test.js` — PASS
- `MEGACOMPACT_VC8A=0 node --test dist/vector-cortex/vc8a-acceptance.test.js` — PASS (byte-identical parity)
- `npm run lint` — PASS
- `python3 scripts/regression_check.py --all` — PASS
- `node scripts/guardrails-scan.mjs` — PASS
- `cd extensions/dashboard-client && npm run typecheck && npm run build` — PASS

## Rollback

`MEGACOMPACT_VC8A=0` selects mode C (no learning), restores VC7C predecessor behavior. The ledger/consent/dataset arithmetic still runs (pure) but no events are emitted and the dashboard reports `enabled:false` + mode C.
