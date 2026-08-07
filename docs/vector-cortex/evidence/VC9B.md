# VC9B Evidence

Status: reviewer-accepted
**PUBLISHED as v0.20.28** — implementation landed at commit `1063ee8`; reviewer-attested 2026-08-05/06.
Implementation commits/sub-sprint gates: single commit `feat(vc9b): ...` (1063ee8) + a docs line-count reconciliation (cab8133) — see git log; full gate run on the working tree (build / test / lint / regression / guardrails / conformance / docs-check / scope-check / evidence-check / dashboard-client tsc+build).
Contract review: reviewed by the controller (Opus) on 2026-08-05 — every touched file read (`routes-setup-cortex-actions.ts` POST confirm→400/blocked→423/404-disabled/405 + GET log bounded 8 KiB + traversal rejection; `setup-cortex-actions.ts` driver — `isSafeLogName` regex, `ACTION_LOG_TAIL_BYTES=8192`, `redactLog` sha256/base64 collapse, spawnSync of committed local scripts with `guardrails-allow PREVENT-PI-004`, verify-asset no-subprocess; `setup-cortex-blockers.ts` action matrix fetch-model/bench→HG-1/HG-3, verify-asset→`[]`, ids drawn from the canonical blocker list; `api-contracts/setup-cortex.ts` explicit action types, no `any`; `vector-cortex-vc9b.ts` sibling flag extract; `registry-ext.ts` seam + count test 50→52; 4 action fixtures + sibling schema; flag in `VECTOR_CORTEX_SETTINGS` visible boolDirect, never `EXCLUDED_SETTINGS`), mutation scan clean (no disabled guards/validators, no payload surface, spawnSync gated + loopback-local), per-gate re-runs green (build + publish-acceptance glob picked up new config siblings; acceptance 6/6 both flag states; route tests 11/11; conformance 786; docs 31 sprints; scope 25 files in-ownership; evidence 22/22; guardrails+semantic clean; regression 0 blocking; lint clean; `npm test` 3357/0 across 335 files). Deviations ratified: (1) sibling `setup-cortex-action-fixture.schema.json` + 786 fixture count (vs stated 785) — the minimal conformance validator lacks `oneOf`/conditional-required, so the confirm-rejection action envelope cannot reuse the VC9A reader schema without weakening its required-field contract; justified, self-consistent, passes `--check`; (2) `EXPECTED_ENDPOINT_COUNT` 50→52 (mechanical registry-count reconciliation, in Production ownership). HG-1/HG-3 remain OPEN (fetch-model/bench blocked, never spawn); HG-2 still removed per 2026-08-05 research.

Contract review (implementer self-review complete; controller review PENDING): `routes-setup-cortex-actions.ts` POST handler (confirm→400, blocked→423 with `action_blocked_by_open_item` + blockers, 404-disabled, non-POST→405, success→200/500) + GET log handler (bounded 8 KiB tail, redaction, basename traversal rejection, non-GET→405, missing→400); `setup-cortex-actions.ts` driver (`isSafeLogName` `/^[a-z-]+-\d+\.log$/`, `ACTION_LOG_TAIL_BYTES=8192`, `redactLog` sha256/base64, spawnSync for the gated local scripts with `// guardrails-allow PREVENT-PI-004` annotation, verify-asset no-subprocess); `setup-cortex-blockers.ts` action matrix (fetch-model/bench→HG-1/HG-3, verify-asset→`[]`); `api-contracts/setup-cortex.ts` explicit action types, no `any`; `vector-cortex-vc9b.ts` sibling flag extract; registry `registry-ext.ts` seam + count test 50→52; 4 action fixtures + sibling schema; flag registered in `VECTOR_CORTEX_SETTINGS` as a visible boolDirect toggle, never `EXCLUDED_SETTINGS`. Mutation scan clean (no disabled guards, no payload-surface mutation, spawnSync gated + loopback-local). Forced deviation (flagged for controller ratification): the four action fixtures use a NEW sibling schema `setup-cortex-action-fixture.schema.json` (not the VC9A `setup-cortex-fixture` schema) because the minimal conformance validator lacks `oneOf`/conditional-required and the `confirm`-rejection action envelope cannot be expressed by the VC9A reader schema without weakening its required-field contract → canonical count is **786** (not the stated 785); declared in the spec + residual risks below.

Changed production/tests/docs: `src/config/vector-cortex.ts`, `src/config/vector-cortex-vc9b.ts`, `src/config.ts`, `extensions/dashboard-server/setup-cortex-blockers.ts`, `extensions/dashboard-server/setup-cortex-actions.ts`, `extensions/dashboard-server/api-contracts/setup-cortex.ts`, `extensions/dashboard-server/routes-setup-cortex-actions.ts`, `extensions/dashboard-server/routes-setup-cortex-actions.test.ts`, `extensions/dashboard-server/routes.ts`, `extensions/dashboard-server/route-dispatch.ts`, `extensions/dashboard-server/api-contracts/endpoints/registry-ext.ts`, `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts`, `extensions/dashboard-server/api-contracts.test/endpoints-registry.test.ts` (count bump 50→52, forced deviation), `scripts/vc9-setup-dashboard/gen-fixtures-vc9b.mjs`, `src/vector-cortex/vc9b-acceptance.test.ts`, `scripts/vector-cortex-docs-check.mjs` (`EXPECTED_SPRINTS` 30→31), `conformance/vector-cortex/v2/schemas/setup-cortex-action-fixture.schema.json`, `conformance/vector-cortex/v2/setup-dashboard/SETUP-CORTEX-010.json`..`.013.json`, `conformance/vector-cortex/v2/manifest.json`, `docs/vector-cortex/sprints/VC9B-setup-cortex-actions.md`, `docs/vector-cortex/evidence/VC9B.md`.
Fixtures and corpus digests: 4 `SETUP-CORTEX-010..013` action fixtures + the sibling `setup-cortex-action-fixture` schema registered in the v2 manifest (786 fixtures canonical); generated by `scripts/vc9-setup-dashboard/gen-fixtures-vc9b.mjs` and committed.
Migration: pure sprint — no migration.
A/B/C and independence evidence: A actor-only confirmation-gated action run (flag-on, 200/400/423); B blocked projection: open-gate blockers surfaced with NO spawn (payload-free); C the offset VC9A-era disabled shape forced by `MEGACOMPACT_VC9B=0` (`{error:"disabled"}` / 404 byte-identical). A/B share the setup-cortex driver + assets; B is produced by the hard-gate matrix before any spawn; C is produced purely by the flag gate. The 4 fixtures pin the action matrix + confirm-rejection + blocked-no-spawn + log-tail bound/redaction.
Commands and verbatim summaries: see Gate Results + unit-test claims below.

## File sizes

All touched files under their extension (500) / src (500) / scripts (no cap) / docs (500) hard limits; `src/config/vector-cortex.ts` (304) and `routes-rag-settings-vector-cortex.ts` (208) grow additively but stay under their soft limits; no file crosses its soft limit in this sprint:

- `src/config/vector-cortex-vc9b.ts` (31)
- `src/config/vector-cortex.ts` (304)
- `src/config.ts` (196)
- `extensions/dashboard-server/setup-cortex-blockers.ts` (98)
- `extensions/dashboard-server/setup-cortex-actions.ts` (242)
- `extensions/dashboard-server/api-contracts/setup-cortex.ts` (123)
- `extensions/dashboard-server/routes-setup-cortex-actions.ts` (133)
- `extensions/dashboard-server/routes-setup-cortex-actions.test.ts` (275)
- `extensions/dashboard-server/routes.ts` (63)
- `extensions/dashboard-server/route-dispatch.ts` (156)
- `extensions/dashboard-server/api-contracts/endpoints/registry-ext.ts` (111)
- `extensions/dashboard-server/api-contracts.test/endpoints-registry.test.ts` (196) — forced deviation: `EXPECTED_ENDPOINT_COUNT` 50→52 for the two new `setup-cortex-action` / `setup-cortex-action-log` endpoints
- `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts` (208)
- `scripts/vc9-setup-dashboard/gen-fixtures-vc9b.mjs` (226)
- `src/vector-cortex/vc9b-acceptance.test.ts` (184)
- `scripts/vector-cortex-docs-check.mjs` (183) — `EXPECTED_SPRINTS` 30→31
- `docs/vector-cortex/sprints/VC9B-setup-cortex-actions.md` (this sprint's spec)
- `docs/vector-cortex/evidence/VC9B.md` (this record)
- `conformance/vector-cortex/v2/schemas/setup-cortex-action-fixture.schema.json` (1, canonical JSON)
- `conformance/vector-cortex/v2/setup-dashboard/SETUP-CORTEX-010.json`..`.013.json` (1 each, canonical JSON)

`registry-ext.ts` grows to 111 (was 78) — well under the 400 soft / 500 hard extension limits; no delegate-shell split required. `api-contracts/endpoints/registry.ts` (496) remains untouched by this sprint — the endpoints registered in the additive `registry-ext.ts` seam.

## Gate Results

| Gate | Result |
|------|--------|
| `npm run build` | PASS |
| `node --test dist/vector-cortex/vc9b-acceptance.test.js` | PASS (6/6) |
| `npm test` | PASS (see below) |
| `npm run lint` | PASS (tsc + guardrails + semantic) |
| `python3 scripts/regression_check.py --all` | PASS (0 hard violations in changed files; only pre-existing soft warnings) |
| `node scripts/guardrails-scan.mjs` | PASS (pi pattern scan clean) |
| `python3 scripts/log_failure.py --list` | PASS (only resolved entries) |
| `node scripts/vector-cortex-conformance.mjs --check` | PASS (786 fixtures canonical) |
| `node scripts/vector-cortex-docs-check.mjs` | PASS (31 sprints / 9 phases) |
| `node scripts/vector-cortex-scope-check.mjs VC9B <commit>` | PASS (all committed files in ownership + seams) |
| `node scripts/vector-cortex-evidence-check.mjs VC9B` | PASS (see below) |
| `git diff --check` | PASS |
| `cd extensions/dashboard-client && npm run typecheck` / `npm run build` | PASS (no client change; verified) |

## VC9B unit/acceptance tests

Acceptance aggregator (fixtures-driven, flag-agnostic):

`node --test dist/vector-cortex/vc9b-acceptance.test.js` → `ℹ tests 6` `ℹ pass 6` `ℹ fail 0`

`MEGACOMPACT_VC9B=0 node --test dist/vector-cortex/vc9b-acceptance.test.js` → `ℹ tests 6` `ℹ pass 6` `ℹ fail 0` (flag-off parity — same suite green under both flag states)

Route unit tests (spawn-and-fetch, exact source listed in the spec):

`node --test dist/extensions/dashboard-server/routes-setup-cortex-actions.test.js` → `ℹ tests 11` `ℹ pass 11` `ℹ fail 0`

Full `npm test` gate: PASS on the merged tree (baseline grows with the 2 new test files). `node scripts/vector-cortex-evidence-check.mjs VC9B` runs the acceptance aggregator for real and confirms the counts above; the line-count + fixture-count claims are re-derived from the tree.

## Evaluation

- `POST /api/setup-cortex-action` is ACTOR-only and confirmation-gated: `confirm:true` required (else 400 `confirmation_required`); blocked actions (fetch-model/bench, open HG-1+HG-3) return 423 `action_blocked_by_open_item` + blockers and NEVER spawn a subprocess (verified by asserting no log file is created in the blocked case); verify-asset runs the real `verifyEncoderAsset` seam (no subprocess — a pure re-read, ungated). Responses carry `{action, ok, exitCode, logPath, logName, spawned}` — digest/codes only, never payload bytes (EVAL-REDACT-002).
- `GET /api/setup-cortex-action-log` returns a bounded 8 KiB (`ACTION_LOG_TAIL_BYTES`) tail, redacting sha256/base64 tokens, and rejects traversal via `isSafeLogName` (basename validated against `/^[a-z-]+-\d+\.log$/`). Non-GET → 405.
- The open hard gates (HG-1/HG-3) stay OPEN in-workstream; fetch-model/bench remain blocked, so their subprocess drivers are never reached. verify-asset, being ungated, is exercised for real.
- Flag-off (`MEGACOMPACT_VC9B=0`) returns `{error:"disabled"}` / 404 on both endpoints, byte-identical to the VC9A predecessor; the separate VC9A reader-only status endpoint is unaffected.
- No mutation surface beyond the intended action/log write path; every new endpoint is gated by the fixture matrix.

## Offline/network/asset/platform evidence

Local-only: spawnSync runs fully local scripts in `scripts/vc2-model-prep/` (fetch-model.sh / bench-onnx.mjs) that do no network; verify-asset reads the committed encoder asset. All `spawnSync` call sites annotated `// guardrails-allow PREVENT-PI-004: loopback-local setup-cortex utility, no network`. Logs written under `<stateDir>/logs/vc9b/`. No remote fetch/HTTP (PREVENT-PI-004, audited). Platform-neutral: the verify-asset seam resolves per `detectPlatform()`; the acceptance test adapts to the committed asset on the current host.

## Rollback/downgrade rehearsal

`MEGACOMPACT_VC9B=0` — flag-off. Both endpoints return `{error:"disabled"}` / 404, byte-identical to the VC9A-era shape; the VC9A status endpoint is unaffected. No schema/state change; evidence retained.

## Residual risks

- **786 vs 785 fixture count (forced deviation, controller to ratify):** the brief's plan anticipated reusing the VC9A `setup-cortex-fixture` schema and landing at 785. The minimal conformance validator has no `oneOf`/conditional-required, so the `confirm`-rejection action envelope cannot cleanly reuse the VC9A reader schema; a sibling `setup-cortex-action-fixture.schema.json` was added → canonical 786. This is documented as a forced deviation in the sprint spec for controller ratification — NOT a gate failure (the committed fixtures + schema + manifest are self-consistent and pass `--check`).
- **gen-fixtures seam:** the main `scripts/vector-cortex-gen-fixtures.mjs` regeneration (`rmSync` of the v2 root) does not yet know about the `setup-dashboard/` fixtures or the `setup-dashboard`/`setup-cortex-action-fixture`/`VC9B` manifest header tokens. A full regeneration by that script would drop these until it is taught about the seam (same latent risk carried by VC9A).
- **Blocked subprocess drivers unexercised end-to-end:** fetch-model.sh / bench-onnx.mjs are always gated (HG-1/HG-3 open), so their actual spawn execution is not reached in the test run; only the blocked-gate path (423, no spawn) is exercised. The spawn plumbing is driven by `setup-cortex-actions.ts` and will be exercised when the gates open in a later sprint (VC9C+). This is by design, not a gap.
- ~~**Reviewer attestation pending**~~ — reviewer-accepted 2026-08-05 (controller Opus); see attestation below.

## Reviewer attestation

Name/date/status: Claude (Opus controller), 2026-08-05, **reviewer-accepted**. Deliberate controller-review deltas confirmed: (1) the sibling `setup-cortex-action-fixture.schema.json` + 786 fixture count (vs stated 785) — forced deviation pending ratification; (2) `EXPECTED_ENDPOINT_COUNT` 50→52 in `api-contracts.test/endpoints-registry.test.ts` (mechanical registry-count reconciliation, added to Production ownership); (3) `MEGACOMPACT_VC9B` in `vector-cortex-vc9b.ts` sibling (delegate-shell) + `VECTOR_CORTEX_SETTINGS` visible boolDirect; (4) flag-off parity exercised by the route unit tests (disables both endpoints) + the evidence-check flag-off parity run; the acceptance aggregator is flag-agnostic so the same suite is green both ways.
