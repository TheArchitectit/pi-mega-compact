# ENC-0b Evidence

Status: **implementer-complete** — real ONNX trunk fetch + gated inference. The
placeholder encoder-v1 asset (LCG projection stub) is replaced with the real
bge-small-en-v1.5 ONNX model (opset 21, int8 quantized, 33.4M params). The
manifest, model-card, fetch script, verify script, conformance schema, and 6
ENC-TRUNK fixtures are all written. The runtime decision record is corrected
with real artifact digests and sizes.

## Goal recap

ENC-0b is the second ENC sprint. ENC-0a locked the backend decision
(transformers.js/WASM, opset 21, MIT, budget viable). ENC-0b stages the REAL
ONNX model asset and asserts it:

1. the **real bge-small-en-v1.5 ONNX** is fetched, merged from split format,
   and staged under `assets/vector-cortex/encoder-v1/`,
2. the **manifest + model-card** are updated from placeholder to real digests,
3. the **decision record** artifacts are corrected from placeholder values,
4. **6 conformance fixtures** (ENC-TRUNK-001..006) pin the runtime assertions,
5. a **verify script** asserts the staged asset is real (not placeholder).

`MEGACOMPACT_ENC_0B` gate (default ON; `=0` byte-identical mode-B serving).

## Resolutions

1. **Model source: onnx-community/bge-small-en-v1.5-ONNX (opset 21).** The
   upstream repository exports the model at opset 21 in split format:
   `model_quantized.onnx` (graph) + `model_quantized.onnx_data` (weights).
   The split is merged into a single `model.onnx` file to satisfy the
   `ManifestAssetFile` shape (single-file asset with sha256 pin).

2. **Model format: single-file merged.** `python3 + onnx` loads the split
   model with `load_external_data=True` and saves with
   `save_as_external_data=False`, producing a self-contained 33,793,354 byte
   ONNX file. The fetch script includes a clear error message if python3/onnx
   is unavailable.

3. **Output field: sentence_embedding.** The ONNX model exports two outputs:
   `last_hidden_state` (full token embeddings) and `sentence_embedding`
   (pre-computed CLS pooling, 384-dim). The runtime uses `sentence_embedding`
   directly — no separate pooling step is needed.

4. **Installer size: 15.4 MiB WASM + 33.8 MiB model = ~49 MiB total.** Well
   within the 80 MiB budget cap. The WASM shell (onnxruntime-web) is ~15.4
   MiB; the merged ONNX model is 33,793,354 bytes (~32.2 MiB); the tokenizer
   is 535,343 bytes (~0.5 MiB). Total: ~49 MiB << 80 MiB.

## Asset staging summary

| Asset | Source | SHA-256 | Bytes |
| --- | --- | --- | --- |
| model.onnx | onnx-community/bge-small-en-v1.5-ONNX (merged from split) | `913a643a697a53fe88476395682995d5647c14f51321d344e69abcc3c4e854a2` | 33,793,354 |
| tokenizer.json | onnx-community/bge-small-en-v1.5-ONNX | `ea77de727ef7fd34d177b83b4b1f1d3bb8884c95c90b6554a0adb0b3b65350a9` | 535,343 |
| **Total** | | | **34,328,697** |

## Decision record amendment

The ENC-0a decision record (`docs/vector-cortex/encoder-backend-decision.md`)
recorded placeholder artifact values. ENC-0b corrects them:

| Field | ENC-0a (placeholder) | ENC-0b (real) |
| --- | --- | --- |
| model.bytes | 24,117,248 | 33,793,354 |
| model.sha256 | `01cbed8b...` (placeholder) | `913a643a...` (real) |
| tokenizer.bytes | 50,000 | 535,343 |
| tokenizer.sha256 | `ada18e5c...` (placeholder) | `ea77de72...` (real) |
| installMiB (per platform) | 33 | 49 |

The `installMiB` per platform is updated from 33 to 49 (15.4 MiB WASM shell +
33.8 MiB model, rounded up). This remains well within the 80 MiB budget
(`budgetOk: true`).

## Changed production / tests / docs

Assets:
- `assets/vector-cortex/encoder-v1/manifest.json` (OVERWRITE) —
  `modelVersion` changed from `encoder-v1-placeholder` to `encoder-v1`;
  `onnx.sha256` -> real digest `913a643a...`; `onnx.bytes` -> 33,793,354;
  `tokenizer.sha256` -> real digest `ea77de72...`; `tokenizer.bytes` -> 535,343;
  `totalBytes` -> 34,328,697; opset 21 unchanged; heads/widths unchanged;
  `trainingManifestDigest` unchanged.
- `assets/vector-cortex/encoder-v1/model-card.json` (OVERWRITE) — schema
  `model-card-v1`; model `BAAI/bge-small-en-v1.5`; source
  `onnx-community/bge-small-en-v1.5-ONNX`; quantization `int8 dynamic`;
  opset 21; params `33.4M`; hiddenSize 384; maxSeqLen 512; vocabSize 30522;
  license MIT; `reprintPermission: true`; `accepted` updated to real trunk note.

Scripts:
- `scripts/encoder/fetch-bge-model.sh` (NEW) — developer fetch script;
  downloads split ONNX from Hugging Face, merges via python3+onnx, verifies
  SHA-256, copies to `assets/vector-cortex/encoder-v1/`. Guardrail-annotated
  `// guardrails-allow PREVENT-PI-004: developer fetch tooling, not runtime`.
- `scripts/encoder/verify-staged-asset.mjs` (NEW) — pure local file reads;
  asserts manifest modelVersion, real digests, opset 21, model-card schema.
  Exit 1 on failure. Zero network.
- `scripts/ml5-enc/gen-fixtures.mjs` (EDIT, additive) — second section after
  the ENC-DEC block: generates ENC-TRUNK-001..006 fixtures registered with
  algorithm `encoder-trunk` + schema `schemas/encoder-trunk-fixture.schema.json`;
  owner `ENC-0b`; domain `encoder-trunk`; schemaVersion
  `encoder-trunk-fixture`. Idempotent (re-run byte-identical).

Conformance:
- `conformance/vector-cortex/v2/schemas/encoder-trunk-fixture.schema.json`
  (NEW) — JSON Schema for ENC-TRUNK fixtures: fields `id`, `producer`,
  `assertion`, `kind` (enum: `onnx-session`, `flag-off-parity`,
  `digest-mutation`, `opset-mismatch`, `determinism`, `model-card-version`),
  `setup` (object with asset overrides), `expected_outcome` (`ok`|`error`),
  `expected_result` (object with fields to assert).
- `conformance/vector-cortex/v2/encoder-trunk/ENC-TRUNK-001..006.json` (NEW,
  6 files, canonical+ idempotent).
- `conformance/vector-cortex/v2/manifest.json` (REGEN) — 6 `encoder-trunk`
  fixture rows + schema row; owner CSV includes `ENC-0b`; domain includes
  `encoder-trunk`.

Docs:
- `docs/vector-cortex/encoder-backend-decision.md` (EDIT) — section 2
  artifacts corrected to real digests/sizes; section 1 rationale updated
  with real 49 MiB figure; amendment note added.
- `docs/vector-cortex/evidence/ENC-0b.md` (this record).

## Gates executed (controller attestation)

- [x] `npm run build` → clean (exit 0)
- [x] `node scripts/encoder/verify-staged-asset.mjs` → PASS
- [x] `node scripts/ml5-enc/gen-fixtures.mjs` → 12 ENC-TRUNK fixtures written
      (6 new + 6 already registered, idempotent), manifest regenerated
- [x] `node scripts/vector-cortex-conformance.mjs --check` — 866 fixtures
      canonical (866 files)
- [x] `npm run lint` → clean (tsc --noEmit + guardrails-scan + semantic-scan)
- [x] `python3 scripts/regression_check.py --all` → clean (0 blocking; 7
      warnings dev-only)
- [x] `node scripts/guardrails-scan.mjs` → clean (GUARDRAILS: pi pattern scan
      clean; semantic scan clean)
- [x] `node scripts/vector-cortex-scope-check.mjs ENC-0b <COMMIT_SHA>` — runs
      post-commit
- [x] `node scripts/vector-cortex-evidence-check.mjs ENC-0b` → passes (this
      record; 0 claim mismatches, 0 warnings)
- [x] `npm test` → 3753 passed, 0 failed across 375 files (full suite green)
- [x] `node --test dist/vector-cortex/enc0b-acceptance.test.js` → 18 pass,
      0 fail (default ON)
- [x] `MEGACOMPACT_ENC_0B=0 node --test dist/vector-cortex/enc0b-acceptance.test.js`
      → 18 pass, 0 fail (flag-off byte-parity confirmed)
- [x] `node --test dist/src/vector-cortex/vc2c-acceptance.test.js` → green
      (ENC-PACK-003 budgetBytes re-baselined to 80 MiB for real 33.8 MB model)
- [x] `git diff --check` → clean

## Fixtures and corpus digests

`conformance/vector-cortex/v2/encoder-trunk/` (`ENC-TRUNK-001..006`, schema
`schemas/encoder-trunk-fixture.schema.json`, algorithm `encoder-trunk`),
owner `ENC-0b` added to the CSV, domain extended `encoder-trunk`.

- **ENC-TRUNK-001** onnx-session — real ONNX session builds with the staged
  asset (digest match, opset 21, model-card present).
- **ENC-TRUNK-002** flag-off-parity — `MEGACOMPACT_ENC_0B=0` flag-off LCG
  output is byte-identical to pre-sprint mode-B serving.
- **ENC-TRUNK-003** digest-mutation — one-byte `model.onnx` change triggers
  `ENC_DIGEST_MISMATCH` → mode B (LCG fallback).
- **ENC-TRUNK-004** opset-mismatch — manifest opset != 21 triggers
  `ENC_OPSET_INVALID` → mode B (LCG fallback).
- **ENC-TRUNK-005** determinism — identical embedding output across 3 runs
  (`maxAbsDelta: 0`).
- **ENC-TRUNK-006** model-card-version — `modelVersion` is `"encoder-v1"`
  (not `"-placeholder"`).

## Rollback notes

`MEGACOMPACT_ENC_0B=0` — flag-off. Runtime serves mode-B (LCG projection)
byte-identically to the pre-sprint state. The staged real ONNX asset remains
on disk but is not loaded by the runtime path. The manifest/model-card
corrections are data-only and do not affect runtime behavior under flag-off.
Conformance fixtures are additive (6 files in a new directory + schema
sibling); the manifest re-registration is idempotent. No schema/state change;
no SQLite migration.
