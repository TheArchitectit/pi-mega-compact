# ML5-A Evidence

Status: implementation-complete — all sprint gates green, including the mandated flag-off run (`MEGACOMPACT_ML5_A=0`, byte-identical), the conformance/regression/guardrails gates, and the python training-lint extension to `regression_check.py`.

**Reconciliation (2026-08-05):** This record covers the ML5-A five-head training + calibration-corpus sprint end to end — the deterministic python pipeline (`train.py` → `export_onnx.py` → `calibrate.py`), the real `trained-heads-v1` / `calibration-v1` loaders in the existing encoder stubs, the six conformance fixtures (`ML5-TRAIN-001..006`) + schema, the acceptance aggregator, the regression_check python-coverage extension, and this evidence record. **Mid-sprint, a concurrent agent's `git reset --hard` on the shared tree wiped every tracked-file edit (the python pipeline, the encoder/calibrate/select loaders, the config + dashboard wiring, the manifest re-registration, and the regression_check python gate); all of it was rebuilt and re-verified, and the manifest was re-registered by re-running `gen-fixtures-ml5a.mjs` (idempotent).** The deterministic digests below are from the rebuilt pipeline.

**Forced deviations (reported to controller):**
1. **`EXPECTED_SPRINTS`/`EXPECTED_PHASES` NOT bumped (44/11).** The ML5-A spec's "Exit evidence" says "bump `EXPECTED_SPRINTS` 37→38 ... this sprint adds a 38th sprint file". That text is stale: the on-disk `scripts/vector-cortex-docs-check.mjs` already reads `EXPECTED_SPRINTS = 44` with a comment that the 7 ML5-A..E / VC6C-IMPL / CONFORM-HYGIENE specs "landed as committed docs on master" — so the sprint count already includes ML5-A. The controller directed me NOT to change these counts. They are left at 44/11 and `docs-check` passes.
2. **Fixture-gate command name is `MEGACOMPACT_ML5_A`, not `MEGACOMPACT_ENCODER_NATIVE`.** The task's flag-name line said `MEGACOMPACT_ENCODER_NATIVE`, but the spec unambiguously names `MEGACOMPACT_ML5_A` and its exact gate commands use it. I followed the spec. Reported so the controller can reconcile the task line.

## Goal recap

Train the five independent projection heads (semantic 384 / dependency 128 / contradiction 128 / cacheStability 64 / payloadRouting 32) on frozen trunk (BGE, 384-dim int8) features, deterministic seed 1729, and build the calibration corpus. ML5-A produces the **learned Mode-A asset + reproducible corpus**; it does NOT select ONNX Runtime into the extension, does NOT promote mode A at runtime (still mode B until ML5-B/C), and does NOT touch the dashboard (only the flag toggle in settings). The meaningful deliverables are the training pipeline + the six conformance fixtures pinning the corpus-split invariants, deterministic export, loss weights, seed pinning, corpus digest, and calibration shape.

**Determinism (design constraint):** the entire chain is seeded (1729) with **no `Math.random` / unseeded draws**. Training (train.py) applies the seed to Python's `random` and NumPy; the ONNX export (export_onnx.py) derives weights deterministically and computes a canonical SHA-256 over (opset, batch, maxTokens, seed, head order/dims/losses, corpus digest, split digest, head weights). Repeated runs produce byte-identical artifacts — verified: `trained-heads.json` and `model.onnx` are byte-identical across two runs (see Fixture/Corpus digests). The corpus does not exist as real data; the pipeline generates a deterministic synthetic corpus inline (`--generate-fixtures N`) so the fixtures are reproducible without a real corpus. Empty / corpus-less input is a graceful no-op (`assetEmitted:false`) — mode B trigram keeps serving.

**Zero runtime network (PREVENT-PI-004):** every script reads/writes local files only; `src/` never imports the training module. All model data is local.

`MEGACOMPACT_ML5_A` gate in `src/config/vector-cortex-ml5a.ts` (default ON; `=0` → byte-identical predecessor, VC2C-era placeholder).

## Changed production / tests / docs

Python training pipeline (`training/vector-cortex/`, tsc-unmanaged, own 600-line hard cap):
- `train.py` (187) — five-head joint training on frozen trunk (384-dim) features, deterministic seed 1729, numpy-only (torch/onnx absent on the host). Functions: SHA-256 canonical-JSON, deterministic synthetic corpus generation (`generate_synthetic`), whole-repo/session grouping (**a session never splits across the train/calibration boundary**), single-seed pinning (numpy `default_rng(1729)`, `random.seed(1729)`, `torch.manual_seed(1729)` when torch is importable — ML5-TRAIN-005), `train_heads` (row-major `[headDim*trunkDim]` projection matrices under the weighted losses), `persist_weights` (emits `trained-heads.json`, schema `trained-heads-v1`, carrying `trunkDim`/`dims`/`corpusDigest`), `main()` with `--generate-fixtures N` / `--seed 1729` / `--out`. Empty corpus → no-op `assetEmitted:false`.
- `export_onnx.py` (114) — deterministic opset-17 int8 export: reads `trained-heads.json` and writes a self-describing `model.onnx` (8-byte header, opset/batch/maxTokens/trunk dims, per-head `int8_quantize` weights under an explicit quantization scale/zero-point) + an `export-report-v1` JSON with the model SHA-256. The digest covers the full artifact bytes (Q04). Rejects a wrong seed/opset; empty-corpus no-op `assetEmitted:false`.
- `calibrate.py` (156) — fits per-head temperature (from the trained asset) + decision threshold (between-class balance point) on the held-out calibration split → `calibration.json` (schema `calibration-v1`). Held-out-fit violation fails loudly; `group_list_digest` canonicalizes the repo/session group list.
- `model-card.json` (schema `model-card-v1`) — trunk identity (Xenova/bge-small-en-v1.5, 33.4M params, 384 hidden, 512 seq, int8-onnx), head dims, loss weights, seed 1729, opset 17, quantized int8; `trainingCorpusDigest`/`calibrationDate`/`onnxSha256` = null (filled when a real corpus trains).
- `dataset-manifest.json` (schema `training-dataset-manifest-v1`) — sources `[context_chunks, turns, conversations]`, redacted-only filter, repo/session split, session-never-split, policy consent/noSecrets/noUserLedger, train/calibration/test counts 0, corpusDigest null, exclusion rationale.
- `__init__.py` (9) — package docstring updated for the ML5-A files.

TypeScript (real loading in existing VC2B/VC2C stubs):
- `src/config/vector-cortex-ml5a.ts` (30) — `MEGACOMPACT_ML5_A` flag via `sprintFlag`, default ON, flag-off byte-identical.
- `src/config/vector-cortex.ts` (299) — grouped `ML5A_ENABLED` into the existing sibling re-export block, keeping the file at/below its 300 soft limit.
- `src/config.ts` (200) — additive `ML5A_ENABLED` re-export.
- `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts` (232) — `MEGACOMPACT_ML5_A` boolDirect toggle in `VECTOR_CORTEX_SETTINGS`, never `EXCLUDED_SETTINGS`.
- `src/vector-cortex/encoder/heads.ts` (248) — `HeadProjectionTable`, `headsShapeValid`, `loadHeadProjections` (reads real `trained-heads-v1`, gated on `ML5A_ENABLED`, null on flag-off/absent/malformed/wrong-seed), `projectHeadFromTrunk` (applies the real row-major matrix over the trunk embedding, L2-normalizes).
- `src/vector-cortex/encoder/calibrate.ts` (274) — `loadCalibrationV1` (reads real `calibration-v1`, validates five-head order + finite temps/thresholds, gated on `ML5A_ENABLED`; null on failure → placeholder fit keeps serving).
- `src/vector-cortex/encoder/select.ts` (254) — `QualificationCandidate.trainedHeadsPath?`; when `ML5A_ENABLED()` and a path is supplied, `loadHeadProjections` is verified and a null result demotes ALL of A to mode B (atomic, per VC2C §select).

Scripts:
- `scripts/ml5/gen-fixtures-ml5a.mjs` (276) — ML5-A fixture generator: emits the schema + `ML5-TRAIN-001..006`, registers rows with `algorithm:"ml5-train"`/`expected:"ok"`, adds `ML5-A` to the owner CSV and `ml5-fixture` to the `;`-separated schemaVersion CSV, re-sorts, rewrites the canonical manifest. Idempotent.
- `scripts/regression_check.py` — extended for the training dir: `TRAIN_DIRS = ("training/vector-cortex")`, a 600-line HARD cap (no soft limit) via `_classify_file`, a python `.py` size walk in `check_file_sizes`, a new `check_python_compile` (`python3 -m py_compile`) + report, JSON field, and `--pre-commit` blocking on python compile failures.

Tests:
- `src/vector-cortex/ml5a-acceptance.test.ts` (275) — acceptance aggregator, fixtures-driven, flag-agnostic (12 tests, green under both flag states; under the src soft limit so the deploy `--soft-as-hard` release gate never blocks it; see Gate Results).

Docs: `docs/vector-cortex/evidence/ML5-A.md` (this record). The sprint spec `docs/vector-cortex/sprints/ML5-A-encoder-training-five-head.md` was pre-existing (counted in EXPECTED_SPRINTS).

## Fixtures and corpus digests

`conformance/vector-cortex/v2/trained-heads/` (`ML5-TRAIN-001..006`, schema `ml5-fixture.schema.json`); 6 new fixture files + 1 schema, registered with owner `ML5-A` + `ml5-fixture` schemaVersion.

- **ML5-TRAIN-001** — corpus sourcing `[context_chunks, turns, conversations]`, redacted-only, session-never-split, both train and calibration splits `>0` (test `0`).
- **ML5-TRAIN-002** — seed 1729, opset 17, int8 quantization, SHA-256 stable across runs.
- **ML5-TRAIN-003** — flag-off (`MEGACOMPACT_ML5_A=0`) → mode B, placeholder heads + calibration, empty corpus is a no-op (no asset emitted).
- **ML5-TRAIN-004** — loss weights .35/.20/.20/.15/.10, sum exactly 1.0.
- **ML5-TRAIN-005** — one seed 1729 drives python/numpy/torch/export.
- **ML5-TRAIN-006** — `CalibrationV1` shape, a deterministic corpus-digest sha256, head dims 384/128/128/64/32.

Corpus after registration: **828 fixtures canonical (828 files)** — `node scripts/vector-cortex-conformance.mjs --check` green (the count reflects the full v2 corpus across all sprints; ML5-A added 6 fixtures + 1 schema on top of the pre-ML5-A total).

Representative deterministic digests from a 16-record synthetic corpus run (`--generate-fixtures 16`, `--seed 1729`):
- `trained-heads.json` (schema `trained-heads-v1`): `ccee33fc319939289749f668c310f516e5aa1e39a6e7c0d9b3840768a23bc9d0` — **byte-identical across two runs**.
- `model.onnx`: file sha256 `596e15f0f76bf45a9b8a497bb2b5a9da9219a28e090d94d9891a908a41e1da39`; `export-report-v1` `sha256` field `401994134f7d442a91074bf6c469dc34eff5d4fa1617f48828ef3c0050b7b9cc` — **both stable across two runs**.
- `calibration.json` (schema `calibration-v1`): `calibrationSplitDigest` `40fb77e11f34a986b2fb37497b36b359347448da32af1ee56779dc5090c0b7e6`, `corpusDigest` `4029101d719264fcf82faabd35b24a5ecb27a83847aa2ebc7a945bc62366f43c` (carried through the trained-heads artifact).

## Gate results

| Gate | Command | Result |
| --- | --- | --- |
| Build | `npm run build` | pass (clean `tsc` + postbuild publish-acceptance mirror) |
| ML5-A acceptance | `node --test dist/vector-cortex/ml5a-acceptance.test.js` | **12 pass / 0 fail** |
| ML5-A flag-off | `MEGACOMPACT_ML5_A=0 node --test dist/vector-cortex/ml5a-acceptance.test.js` | **12 pass / 0 fail** (byte-identical parity) |
| Full suite | `npm test` | **3554 pass / 0 fail across 358 files** (52.2 s; counts float ±1 across runs by pre-existing tests) |
| Lint | `npm run lint` | pass (tsc + pattern + semantic) |
| Guardrails | `node scripts/guardrails-scan.mjs` | pi pattern scan clean |
| Regression | `python3 scripts/regression_check.py --all` | pass (rc=0); **no ML5-A file over any limit; all `training/vector-cortex/*.py` compile** |
| Conformance | `node scripts/vector-cortex-conformance.mjs --check` | `✓ v2 manifest + 828 fixtures canonical (828 files)` |
| Docs-check | `node scripts/vector-cortex-docs-check.mjs` | `✓ 44 sprints / 11 phases, links+flags+commands+migrations clean` |
| Diff hygiene | `git diff --check` | pass |

`cd extensions/dashboard-client && npm run typecheck && npm run build` is **N/A this sprint** — no client files change (ML5-A only wires the settings toggle; the Improve-Cortex surface is ML5-D).

## Unit and acceptance tests

Acceptance aggregator (fixtures-driven, flag-agnostic, 12 tests):

`node --test dist/vector-cortex/ml5a-acceptance.test.js` → `ℹ tests 12` `ℹ pass 12` `ℹ fail 0`

`MEGACOMPACT_ML5_A=0 node --test dist/vector-cortex/ml5a-acceptance.test.js` → `ℹ tests 12` `ℹ pass 12` `ℹ fail 0` (flag-off parity — the same suite is green under both flag states).

Assertions (self-contained, no mocks): manifest registers `ML5-TRAIN-001..006` + the `ml5-fixture` schema with owner `ML5-A`; each fixture's envelope invariants (corpus/splits, deterministic export, loss-sum 1.0 + normative values, single-seed, calibration shape + head dims); the normative constants (seed 1729, head order, dims 384/128/128/64/32, loss weights). The real production loaders are exercised against fixture-format artifacts written to tmp (with `MEGACOMPACT_ML5_A` self-pinned ON, mirroring vc2b): `loadHeadProjections` over a real `trained-heads-v1` returns a valid table and `projectHeadFromTrunk` yields L2-normalized (norm 0 or ≈1) heads; malformed/wrong-seed/absent assets return null (non-fatal); `loadCalibrationV1` over a valid `calibration-v1` returns finite temps/thresholds and rejects malformed input.

Python pipeline determinism (double-run): `train.py` → identical `trained-heads.json` (sha256 `ccee33fc…`); `export_onnx.py` → identical `model.onnx` (sha256 `596e15f0…`) + report sha256 `40199413…`; `calibrate.py` → `calibration.json` with deterministic per-head temps/thresholds. Empty corpus → `assetEmitted:false` (no-op). Held-out-fit violation → clean exit failure.

## Evaluation

- **No payload leakage (EVAL-REDACT-002):** the corpus is filtered to redacted-tagged rows only; conformance fixtures carry only aggregate scores/digests — never raw conversation text. `dataset-manifest.json` records the redacted-only + noSecrets/noUserLedger policy.
- **No runtime network (PREVENT-PI-004):** training reads local SQLite/files; the ONNX export and calibration write local artifacts; `src/` never imports the training module. `pip install` is setup-time, not runtime.
- **Real loaders, placeholder fallback:** with no trained asset (fresh/corpus-less), `loadHeadProjections`/`loadCalibrationV1` return null and `calibrate.ts`/`heads.ts` keep serving the placeholder LCG fit — byte-identical to the VC2C-era state.

## Failure triad and independence

| Arm | Algorithm | Inputs | Independence argument |
| --- | --- | --- | --- |
| **A — trained asset** | The five trained head projections loaded from `trained-heads-v1` and applied to the frozen trunk embedding (mode-A inference). | Real weights + `CalibrationV1` temps/thresholds. | Requires both artifacts present AND `MEGACOMPACT_ML5_A=1`; a failed field (bad dim, wrong seed, digest mismatch) demotes ALL of A atomically. |
| **B — placeholder / mode B** | The VC2B-era LCG fake projections (`heads.ts` `projectHead`) + placeholder `fitTemperature`/`fitThreshold`. | No trained asset; seed from constants. | Fully independent of A's assets — serves identically whether A is absent or flagged off. |
| **C — flag-off / no corpus** | `MEGACOMPACT_ML5_A=0` disables training + loading; empty corpus no-ops (`assetEmitted:false`). | None. | Byte-identical to the predecessor; no trained artifact is emitted or loaded. |

A is produced by the real training + weight load (fixture 001); B by the placeholder paths (fixture 003's mode B); C purely by the flag branch (fixture 003's flag-off). All three use independent inputs.

## Offline / network / asset / platform evidence

Deterministic local toolchain: python + numpy only (scikit-learn absent on the host), seed 1729 everywhere, no `Math.random`. The ONNX export is a local deterministic model — no external fetch. `src/` stays pi-agnostic; the training module is a developer tool with its own 600-line hard cap in `regression_check.py` and a mandatory `python3 -m py_compile` lint pass (tsc does not lint python).

## Rollback / downgrade rehearsal

`MEGACOMPACT_ML5_A=0` — flag-off. Training is disabled and `calibrate.ts`/`heads.ts` continue serving the placeholder behavior — byte-identical to the VC2C-era state, without deleting the trained artifacts or evidence. No schema/state change; the extension's SQLite tables are read-only inputs. Rollback is a pure flag flip.

## Known findings / deferred

1. **Stale `EXPECTED_SPRINTS` bump text in the ML5-A spec.** The spec's Exit-evidence says "bump EXPECTED_SPRINTS 37→38", but the on-disk docs-check already carries 44 (the 7 sprint docs landed on master). Not changed, per controller direction; `docs-check` passes at 44.
2. **Flag-name source-of-truth is the spec.** `MEGACOMPACT_ML5_A` (spec) overrides the task's `MEGACOMPACT_ENCODER_NATIVE`; reported to the controller.
3. **The committed ONNX placeholder is left in place.** Mode A is not promoted this sprint; the runtime continues mode B until ML5-B/C validate + the bench gates sweep. `assets/vector-cortex/encoder-v1/*` is untouched.
4. **`train-v1.json` (pre-existing VC2B util) is unchanged.** It remains a constants/seed reference; the ML5-A pipeline is self-contained in `train.py`/`export_onnx.py`/`calibrate.py` (+ `constants.py`).
5. **Reviewer attestation pending.** Attestation is the controller's act (Claude Opus controller to review), consistent with the sprint-chain convention.

## Reviewer attestation

Name/date/status: pending — Claude (Opus controller) to review. Implementation-complete; the controller attests the sprint gate (as with the peer sprints) before the sprint is marked reviewer-accepted.
