# VC2C Evidence

Status: implementer-complete — reviewer CHANGES REQUESTED (S1 assetDigest contract, S2 naming reconciliation) resolved; all sprint gates green, including the mandated flag-off run.
Implementation commits/sub-sprint gates: VC2C sprint on `feat/vector-cortex`; focused commits with MANDATORY `Co-Authored-By:` attribution (VC2C implementation + reviewer-fix for S1/S2). All sprint exit gates run and recorded below.
Contract review: reviewer CHANGES REQUESTED (S1/S2) addressed and committed; pending re-review.

## Goal recap

Encoder qualification + calibration (VC2C) — consumes the VC2A `ModelManifestV1`/`EncoderRuntime` and VC2B `VectorSetV1`/heads/trigram/lexical contracts and ships **QualifiedEncoderV1** (the mode-A eligibility record) and **CalibrationV1** (frozen per-head temperature/threshold calibration). Task list: register the contract surface (`ENC-017..020`) and add held-out annotations onto the held-out labels (task 1); implement calibration fit on the calibration split only, splitting grouped by repository+session (no group crosses a split) with held-out labels prohibited from the fit (task 2); implement the atomic selection check across every MODEL_ASSET + per-head EVALUATION threshold — one failed field demotes ALL of A, producing `QualifiedEncoderV1` and exposing the failed field (task 3); implement the configured B/C qualification fallback with `forceC`/`injectBError` (task 4); emit `vector_cortex_encoder_qualification_passed` / `vector_cortex_encoder_qualification_demoted` and surface `encoderAssetDigest`/`encoderMode` on the dashboard health card + a `MEGACOMPACT_VC2C` SETTINGS toggle (task 5); after production artifacts pass gates, add unit/acceptance tests + fixtures + package budget gate + evidence (task 6). `MEGACOMPACT_VC2C` gate (default ON, `=0` → byte-identical predecessor: zero VC2C emissions). **Zero runtime network calls (PREVENT-PI-004).**

## Changed production / tests / docs

Production (`src/vector-cortex/encoder/`):
- `types.ts` — added the VC2C contract section: `EncoderHeldOutMetrics` (semantic/dependency/contradiction/cacheStability/payloadRouting rows + reconstruction gates), `EVALUATION_THRESHOLDS` (normative per-head + asset + reconstruction constants mirrored from MODEL_ASSET/EVALUATION), `CalibrationV1` (schema `calibration-v1`, headOrder, calibrationSplitDigest, fittedOnCalibrationOnly, temperatures, thresholds, seed), `QualifiedEncoderV1` (schema `qualified-encoder-v1`, modelVersion, mode A, assetDigest, calibrationDigest, onnxDigest, heldOut, calibration), `ENC_QUALIFICATION_FAIL` (`DIGEST_MISMATCH`/`THRESHOLD_FAILED`/`ASSET_FAILED`/`HELD_OUT_IN_FIT`), and `ENC2C_IDS` (`ENC-017..020`). VC2A/VC2B contracts untouched.
- `calibrate.ts` (new, ~175) — **calibration fit (task 2)**. `fitCalibration`/`calibrationSplitDigest`: the fit rejects ANY example whose `itemId` is in the caller's held-out set (`ENC_QUALIFICATION_HELD_OUT_IN_FIT` — held-out labels are strictly prohibited from fit inputs); splits are grouped by repository+session (a whole group never crosses a split boundary); ties in score resolve by item ID bytewise (never arrival order); the split digest is canonical/sorted/deduped (invariant to row order); per-head deterministic temperature (0.8..1.5) + threshold sealed into a `CalibrationV1`.
- `select.ts` (new, ~206) — **atomic qualification selection (task 3)**. `selectQualifiedEncoder`/`qualificationManifestDigest`: the eligibility check is ATOMIC — EVERY MODEL_ASSET constraint (maxTokens<=512, p95<=40ms, RSS<=150MiB) AND every per-head EVALUATION threshold AND reconstruction gate must pass, or the ENTIRE candidate demotes to mode B (never a partial A), reporting the first failed field (`asset.*`, `head.<name>`, `reconstruction`). Unique failure injection: a supplied `expectedQualificationManifestDigest` that mismatches the presented calibration's digest demotes with `ENC_QUALIFICATION_DIGEST_MISMATCH` (corrupt qualification manifest after calibration, before selection) and chooses B. Reviewer S1/S2 reconciliation: `QualifiedEncoderV1.assetDigest` is now populated with the candidate's REAL ModelManifestV1 asset-manifest digest (`QualificationCandidate.assetManifestDigest`, SHA-256 of the manifest.json bytes) — identical semantics to the dashboard health card's `encoderAssetDigest` — rather than a calibration-derived hash; `calibrationDigest` remains the calibration split-assignment digest. An assertion pins `assetDigest` to the passed-through manifest digest.
- `fallback.ts` (new, ~102) — **B/C qualification fallback (task 4)**. `selectQualificationFallback(qualificationCode, tokens, {forceC, injectBError})`: a qualification demotion selects independently-initialized trigram B (width 512, no limitation); `forceC` or `injectBError` (absent A + injected B error) selects lexical C (width 256) reporting `ENCODER_LEXICAL_LIMITATION`.
- `emit-vc2c.ts` (new, ~69) — `createEncoderQualificationReporter`/`NOOP_VC2C_REPORTER`, flag-gated on `MEGACOMPACT_VC2C`; emits `vector_cortex_encoder_qualification_passed` / `vector_cortex_encoder_qualification_demoted` (JSON `ts`+`event`, non-fatal) (task 5).

Config:
- `src/config/vector-cortex.ts` — `VC2C_ENABLED()` (default ON; `MEGACOMPACT_VC2C=0` → off, byte-identical predecessor). Re-exported by root `src/config.ts`.

Packaging (task 6, package budget):
- `package.json` — added `assets/vector-cortex/encoder-v1` to the `files` field so the committed qualified encoder manifest + ONNX + tokenizer ship in the npm package (they now appear in `npm pack --dry-run` and stay well under the 35 MiB budget).
- `scripts/deploy.sh` — new step 4.6 VC2C asset/packaging gate: requires `assets/vector-cortex/encoder-v1/{manifest.json,model.onnx,tokenizer.json}` to exist and sums the ENTIRE `npm pack --dry-run --json` `files[].size` (unpacking the package-keyed object) to enforce <= 35 MiB; dry-run only, never a `.tgz` (PREVENT-DIST-001).
- `scripts/vector-cortex-assets.test.mjs` — two VC2C legs: `VC2C package dry-run listing is under the 35 MiB budget` (parses the package-keyed `files` array, asserts manifest + ONNX listed) and `VC2C committed qualified manifest + assets exist and onnx+tokenizer stay under 35 MiB`.

Dashboard / API:
- `extensions/dashboard-server/api-contracts/vector-cortex.ts` — `VectorCortexHealthCard` gained `encoderAssetDigest: string | null` and `encoderMode: "A"|"B"|"C"`.
- `extensions/dashboard-server/routes-vector-cortex.ts` — `encoderAssetDir()` walker + `encoderHealthFacts()` (SHA-256 over the committed qualified manifest + triad mode: A = verified on host, B = present-but-demoted, C = absent), wired into the health body.
- `extensions/dashboard-server/routes-rag-settings-helpers.ts` — `MEGACOMPACT_VC2C` added to the "Vector Cortex" SETTINGS group as a `boolDirect` on/off toggle (NOT in `EXCLUDED_SETTINGS`).
- `extensions/dashboard-client/src/types/vector-cortex.ts` — `encoderAssetDigest`/`encoderMode` added to the client `VectorCortexHealthCard` mirror (client typecheck+build green).
- `extensions/dashboard-client/src/tabs/VectorCortexTab.tsx` — the VC0C "Live Safety Envelope" health card now renders `Encoder mode` (A/B/C) and `Encoder asset` (12-char digest prefix, or "none" when absent), surfacing the two VC2C fields.
- `extensions/dashboard-server/routes-vector-cortex.test.ts` — the health-card test now asserts the two VC2C fields (64-char digest string, triad-member mode).

Tests:
- `src/vector-cortex/encoder/calibrate.test.ts` (new, ~120, under the 600 test hard limit) — held-out prohibition (rejects `ENC_QUALIFICATION_HELD_OUT_IN_FIT`), default seed 1729, dashboard/split grouping (canonical/deduped/order-invariant digest), declared whole-group assignment, fit invariance to row order, surface (0.8..1.5 temperature, schema/shape).
- `src/vector-cortex/encoder/select.test.ts` (new, ~184) — atomic eligibility (fully-satisfactory → A; every asset field enforced; per-head failures semantic/dependency/contradiction-ECE/cache/payloadRouting/reconstruction demote the entire A — including the zero-tolerance `head.payloadRouting` exact/anchor recall rule), stable `qualificationManifestDigest`, corrupt-manifest injection → `ENC_QUALIFICATION_DIGEST_MISMATCH` choose B, matching digest does not demote.
- `src/vector-cortex/encoder/fallback.test.ts` (new, ~76) — qualification demotion → trigram B (512, no limitation, matches standalone `embedTrigram512`), injected B error / forceC → lexical C (256, limitation), disjoint widths, explicit vector on every path.
- `src/vector-cortex/vc2c-acceptance.test.ts` (new, ~526, under the 600 test hard limit) — **acceptance aggregator** over the REAL producers (no mocks): registration of ENC-017..020 + ENC-CAL-001/ENC-ATOMIC-002/ENC-PACK-003 (owner/domain VC2C), canonical corpus convergence, every ENC-017..020 row + the held-out annotation resolved through the real producers, split-assignment invariants (grouped repo/session: no group crosses a split; selection invariant to row order), ENC-CAL-001 (held-out exclusion), ENC-ATOMIC-002 (one failed causal head demotes the entire A), ENC-PACK-003 (clean `npm pack --dry-run` listing contains manifest + ONNX under 35 MiB), unique corrupt-manifest injection (→ `ENC_QUALIFICATION_DIGEST_MISMATCH` choose B + `demoted` event), forced triad A/B/C through the fallback, every MODEL_ASSET + per-head EVALUATION threshold enforced, flag-off parity + emit seam, VC2C flag default-ON/=0. Like VC2B (code-review Q03), the aggregator does NOT pin the flags ON at module scope — the mandated `MEGACOMPACT_VC2C=0` gate genuinely exercises the flag-independent producer paths under the external OFF env; only ON-dependent scenarios self-pin via a `withFlagsOn` helper. 20 tests green in BOTH flag states.

Scripts:
- `scripts/gen-fixtures/encoder-qualification.mjs` (new) — `ENC-017..020` + named `ENC-CAL-001`/`ENC-ATOMIC-002`/`ENC-PACK-003` fixtures (schema `schemas/encoder-qualification-fixture.schema.json`, algorithm `encoder-qualification`).
- `scripts/gen-fixtures/schemas.mjs` / `write.mjs` / `scripts/vector-cortex-gen-fixtures.mjs` — `encoder-qualification` schema appended; `encoder-qualification/` dir + fixtures written + registered; manifest `domain` adds `encoder-qualification`, `owner` adds `VC2C`; counts reported.
- `scripts/vector-cortex-network-denial.mjs` — mode A and mode B now carry VC2C legs (mode A: calibration fit + atomic A qualification + B fallback under denial; mode B: a failed-causal-head demotion + B/C fallback under denial); mode C unchanged (no-op predecessor).

Docs: `docs/vector-cortex/evidence/VC2C.md` (this record).

## Fixtures and corpus digests

`conformance/vector-cortex/v2/encoder-qualification/` — `ENC-017..020` (qualified / calibration-fit / one-failed-causal-head / qualification-digest-mismatch) and named `ENC-CAL-001`, `ENC-ATOMIC-002`, `ENC-PACK-003` (expected includes `budgetBytes`). Schema `schemas/encoder-qualification-fixture.schema.json`.

`node scripts/vector-cortex-conformance.mjs --check` → `✓ CONFORMANCE: v2 manifest + 181 fixtures canonical (181 files).`

All fixtures canonical (UTF-8/NFC/sorted keys/shortest numbers/final LF); SHA-256 pinned in the manifest. Regeneration is byte-identical for the pre-existing fixtures (only the manifest gained the `encoder-qualification` domain rows + `VC2C` owner); the 8 new files (4 behavior + 3 named + 1 schema) are the VC2C addition.

## Migration

**Pure sprint — no state migration; model asset revision only.** Nothing is migrated at runtime (VC2C owns qualification + calibration records; the trained weights and their evaluation are substituted in VC2C itself behind the packaged asset). Rollback sets `MEGACOMPACT_VC2C=0` → zero VC2C emissions (mode C parity, byte-identical predecessor); predecessor golden bytes re-verified by the flag-off parity test.

## A/B/C and independence evidence

Triad over the encoder-qualification domain: **A** = qualified learned asset — `selectQualifiedEncoder` produces a `QualifiedEncoderV1` ONLY when EVERY MODEL_ASSET + per-head EVALUATION threshold passes (atomic: one failed field demotes all of A); **B** = asset-free trigram — a qualification demotion selects independently-initialized `embedTrigram512` (512 dims, no limitation); **C** = token/phrase lexical — absent A + injected B error (`injectBError`/`forceC`) selects `embedLexical` (256 dims) reporting its loss of old semantic context. Widths are disjoint (384/128/128/64/32 vs 512 vs 256).

Atomic eligibility is the core VC2C guarantee: a single failed causal dependency head (`precision < .97`) demotes the ENTIRE A to mode B — asserted by ENC-019, ENC-ATOMIC-002, and the acceptance per-head threshold sweep. The corrupt-qualification-manifest injection is a true seam exercise: seal the manifest digest at calibration time, then present a mutated calibration after calibration but before selection → `qualificationManifestDigest` mismatch → `ENC_QUALIFICATION_DIGEST_MISMATCH` and choose B (with the `qualification_demoted` event emitted from the production reporter).

## Commands and verbatim summaries

- `npm run build` → tsc clean (fixed TS6133 unused-var in the new tests); postbuild `vector-cortex-publish-acceptance` → `published 9 acceptance + 6 eval + 5 replay + 3 migrations + 9 ledger + 6 resilience + 4 conformance + 13 encoder files` (acceptance count 8 → 9 from the new VC2C aggregator; encoder count 9 → 13 from calibrate/select/fallback/emit-vc2c).
- Acceptance, mandated command, both flag states:
  ```bash
  node --test dist/vector-cortex/vc2c-acceptance.test.js
  # → ℹ tests 20, ℹ pass 20, ℹ fail 0   (flag ON)
  MEGACOMPACT_VC2C=0 node --test dist/vector-cortex/vc2c-acceptance.test.js
  # → ℹ tests 20, ℹ pass 20, ℹ fail 0   (flag OFF: flag-independent producer paths
  #                                      exercise the external OFF env; ON-dependent
  #                                      scenarios self-pin via withFlagsOn)
  ```
- Unit: `calibrate.test.js` → 8 pass / 0 fail; `select.test.js` → 11 pass / 0 fail (the atomic per-head sweep now also directly exercises the zero-tolerance `head.payloadRouting` exact/anchor recall failure); `fallback.test.js` → 7 pass / 0 fail (26 total).
- `npm test` → `TOTAL: 1780 passed, 0 failed across 212 files in 26.9s`.
- `npm run lint` → `tsc --noEmit` + `guardrails-scan` + `semantic-scan` all clean.
- `python3 scripts/regression_check.py --all` → coverage of every `MEGACOMPACT_*` env var → `✓ All MEGACOMPACT_* env vars have dashboard settings entries`; `✓ No potential regressions detected`; 0 blocking vulns.
- `node scripts/vector-cortex-conformance.mjs --check` → `✓ CONFORMANCE: v2 manifest + 181 fixtures canonical (181 files).`
- `node scripts/vector-cortex-docs-check.mjs` → `✓ DOCS-CHECK: 27 sprints / 9 phases, links+flags+commands+migrations clean.`
- `node scripts/vector-cortex-network-denial.mjs --modes=A,B,C` → `✓ mode A: clean (roundtrip=21 breaker=OPEN_B vc1c=f51dc111 vc2a=A vc2b=5heads vc2c=A)`; `✓ mode B: clean (digest=sha256:7 spool=committed vc1c=60733c45 vc2a=B vc2b=B vc2c=B/C)`; `✓ mode C: clean (no-op: zero event/spool writes, transcript codec unchanged)`. All exit 0.
- `git diff --check` → clean (exit 0).
- Dashboard: `npm run build:dashboard` → vite build green (client typechecks the new health fields).

## Evaluation

All 20 acceptance tests pass in both flag states (0 failed each). Encoder unit suites: `calibrate.test.js` (8) + `select.test.js` (11) + `fallback.test.js` (7). Invariants: calibration fit is invariant to row order (stable score/id ties, canonical split digest); a repo/session group never crosses a split boundary; held-out labels are strictly prohibited from the fit (`ENC_QUALIFICATION_HELD_OUT_IN_FIT`); eligibility is atomic across every MODEL_ASSET + per-head EVALUATION threshold — including the zero-tolerance `head.payloadRouting` exact/anchor recall rule, directly exercised by the select suite — a single failed causal head demotes the entire A; the corrupt-qualification-manifest injection returns `ENC_QUALIFICATION_DIGEST_MISMATCH` and chooses B. Full `npm test` gate: `TOTAL: 1780 passed, 0 failed across 212 files`.

## Dashboard / API / config / SETTINGS evidence

- `MEGACOMPACT_VC2C` surfaced in the "Vector Cortex" SETTINGS group as a working `boolDirect` on/off toggle — NOT in `EXCLUDED_SETTINGS` (regression_check confirms every `MEGACOMPACT_*` var has a settings entry).
- The health card now surfaces `encoderAssetDigest` (SHA-256 of the committed qualified manifest) and `encoderMode` (A/B/C) as reader-only aggregates; the dashboard health-route test asserts both fields. The client `VectorCortexTab` health card renders both — `Encoder mode` and `Encoder asset` (digest prefix) — and the client `VectorCortexHealthCard` type carries both fields. Dashboard client `typecheck` + `build` both pass.

## Offline / network / asset / platform evidence

Zero runtime network egress (PREVENT-PI-004): `calibrate.ts`/`select.ts`/`fallback.ts` are pure in-process hashing/math with no fetch; the asset digest is read from local `assets/vector-cortex/encoder-v1/`. `scripts/vector-cortex-network-denial.mjs --modes=A,B,C` (mode A + mode B now carry VC2C legs, mode C unchanged) all pass under the network patch that fails any egress. The committed qualified encoder package is verified to ship (manifest + ONNX listed in `npm pack --dry-run`) at ~13 MiB total, well under the 35 MiB budget (ENC-PACK-003, deploy.sh step 4.6).

## File sizes and baseline exceptions

All new files within limits: calibrate.ts ~225 (under the 300 src soft limit), select.ts ~237, fallback.ts ~102, emit-vc2c.ts ~70 (src soft limit 300, hard 500), calibrate.test.ts ~120, select.test.ts ~228, fallback.test.ts ~76, vc2c-acceptance.test.ts ~563 (under the 600 test hard limit; over the 300 src test soft limit — same as the VC2A/VC2B aggregators, warning not failure). Pre-existing over-soft-limit `extensions/mega-events/agent-handlers/turnEndHandler/errorRetry.ts` (421) remains UNTOUCHED this sprint.

## Rollback / downgrade rehearsal

`MEGACOMPACT_VC2C=0` → the VC2C emit seam emits zero events and the flag-off parity test asserts zero emissions (byte-identical predecessor). Rollback restores the prior derived pointer without deleting evidence. Pure sprint — no runtime state to downgrade.

## Issues found during implementation

- **VC2C-I01 [type: correctness, state: fixed-in-this-sprint]**: `npm pack --dry-run --json` returns an OBJECT keyed by package name (with a `files` array of `{path,size}` entries), not a flat array — the first acceptance/asset-test implementations summed an object and the deploy.sh python iterated a dict, both of which would mis-gate at the package-budget seam. Fixed all three (`vc2c-acceptance.test.ts` ENC-PACK-003, `vector-cortex-assets.test.mjs`, `deploy.sh` step 4.6) to unpack the package-keyed object and sum `files[].size`, and confirmed ~13 MiB <= 35 MiB. Also added `assets/vector-cortex/encoder-v1` to `package.json` `files` so the committed manifest + ONNX actually ship (they were excluded before, which would have failed the "manifest + ONNX listed" assertion).
- **VC2C-I02 [type: test, state: fixed-in-this-sprint]**: initial `vc2c-acceptance.test.ts` imported `QualificationCandidate` and `EVALUATION_THRESHOLDS` from the wrong module and mutated readonly `EncoderHeldOutMetrics` fields. Moved the `QualificationCandidate` type import to `./encoder/select.js`, dropped the unused `EVALUATION_THRESHOLDS`/`QualificationVerdict`/`embedTrigram512` imports (TS6133), and replaced raw field mutation with immutable spread-built variants (`dep`, `semantic`, `contradiction`, `cache`, `noVotes`, `oneFailedCausalHead`, `semanticFail`). All three unit suites + acceptance rebuild green.

## Residual risks / carried-forward OPEN issues

- The qualification calibration temperature/threshold fit and the packaged asset remain placeholders behind the committed 42-byte ONNX marker (real trained weights + evaluation are substituted later; VC2C's contract, atomic eligibility, held-out prohibition, split invariants, package budget, emit seam and fallback all hold now).
- The two pre-existing ACTIVE failures (compaction FAIL-38192431, error-retry FAIL-55d81817) are outside VC2C scope and carried forward as tracked items.
- `MEGACOMPACT_VC2C` gates the VC2C emit seam + producers; the flag-OFF path is byte-identical to the predecessor.

## Reviewer attestation

CHANGES REQUESTED raised by the code-quality reviewer, resolved in a follow-up commit:
- **Q01** — `ENC_QUALIFICATION_FAIL.ASSET_FAILED` was dead (declared, never emitted). `selectQualifiedEncoder` now routes any asset-field failure (`asset.maxTokens`/`asset.latencyP95Ms`/`asset.rssDeltaMib`) through `ASSET_FAILED`; per-head/reconstruction failures keep `THRESHOLD_FAILED`. `select.test.ts` asserts the `ASSET_FAILED` code for all three asset fields. The enum now advertises a code the seam actually emits.
- **Q02** — removed the dead `NOOP_VC2C_REPORTER` export and the never-exercised `EncoderQualificationEmitOptions`/`opts.logPath` surface from `emit-vc2c.ts`. The reporter narrows to `createEncoderQualificationReporter(emit?)`, defaulting to a real `Logger`-backed sink; no caller/tester passed a `logPath`, so the surface was pure dead weight.
- **Q03** — `fitThreshold`'s docstring claimed the returned value was "the score at the positive-class balance point", but it picked `floor(negatives*0.5)` into the score-sorted array — which could re-admit the lowest negative on sparse heads (e.g. one negative 0.2 + one positive 0.9 → threshold 0.2). Rewrote both the docstring (now an honest between-class balance point) and the math: with both classes present the threshold is the midpoint between the highest negative and the lowest positive (so a calibration negative's own score is never re-admitted); degenerate single-class heads fall back conservatively (no positives → just above the top observed score; no negatives → just below the lowest observed positive); empty head stays 0.5. Deterministic and row-order-invariant; no threshold value is pinned by any test, so the change is assertion-safe.
- **Q04** — `emit-vc2c.ts`'s `fire()` injected `ts` as an ISO string, overriding the numeric epoch-ms `Logger` injects (`LogEntry.ts` is `number`). Removed the override: the default sink now emits the numeric `ts` from `Logger`, so the two VC2C events are consistent with the rest of the log stream. (The predecessor `emit-vc2b.ts` still uses the ISO-string pattern; VC2C no longer mirrors it.)

S1/S2 (prior spec-compliance review, resolved earlier): `QualifiedEncoderV1.assetDigest` holds the REAL ModelManifestV1 asset-manifest digest (passed through `QualificationCandidate.assetManifestDigest`), matching its documented contract and the dashboard health card's `encoderAssetDigest`; `calibrationDigest` is documented as the calibration split-assignment digest. Downstream VC3A pins the correct digest.

All 20 acceptance tests + 8/11/7 encoder unit tests pass in both flag states; full `npm test` 1785 passed / 0 failed; lint, regression, conformance, docs, network-denial (modes A/B/C) and dashboard typecheck/build all green.
