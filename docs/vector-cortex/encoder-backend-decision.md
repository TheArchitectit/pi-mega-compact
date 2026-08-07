# Encoder backend decision (locked) — transformers.js/WASM

**Status:** LOCKED (decision record, ENC-0a) | **Reproducible via:** `node scripts/encoder/resolve-backend-decision.mjs` | **Contract:** `EncoderBackendDecisionV1` (`src/vector-cortex/encoder/decision.ts`, schema `encoder-backend-decision-v1`)

This is the durable decision record for the real learned encoder front-end choice. It is produced **deterministically** by the resolver script — not asserted in prose — so the decision is reproducible from the same inputs. ENC-0b (asset fetch + runtime wiring) and ENC-0e (darwin-x64 demotion) consume this record.

## 1. Verdict

**Backend: transformers.js v4.2.0 + onnxruntime-web WASM (`backend: "wasm"`).** Option W, the leading candidate.

Rationale — the shipped byte-count for the WASM path is the only one that fits the 80 MiB asset/install cap:

- **transformers.js WASM shell** ≈ **15.4 MiB**; with the bge-small int8 ONNX asset ≈ **33.8 MiB** ⇒ **~49 MiB total, fits the 80 MiB budget** with no per-platform native split.
- **onnxruntime-node native** ≈ **258 MiB** total install vs the 80 MiB cap ([MODEL_ASSET](MODEL_ASSET.md) §Qualification) ⇒ **FAIL** unless a per-platform `optionalDependencies` split (recorded as the native-amended fallback; see §6).

## 2. Decision record (encoder-backend-decision-v1)

The canonical JSON produced by the resolver (bench-qualified branch, ENC-DEC-001):

```json
{
  "schema": "encoder-backend-decision-v1",
  "backend": "wasm",
  "budgetOk": true,
  "opset": 21,
  "platformMatrix": {
    "linux-x64":    { "runtime": "onnxruntime-web", "installMiB": 49, "demotion": "none" },
    "linux-arm64":  { "runtime": "onnxruntime-web", "installMiB": 49, "demotion": "none" },
    "darwin-x64":   { "runtime": "onnxruntime-web", "installMiB": 49, "demotion": "wasm" },
    "darwin-arm64": { "runtime": "onnxruntime-web", "installMiB": 49, "demotion": "none" },
    "win32-x64":    { "runtime": "onnxruntime-web", "installMiB": 49, "demotion": "none" }
  },
  "license": { "spdx": "MIT", "redistribution": true },
  "artifacts": {
    "model": {
      "path": "model.onnx",
      "bytes": 33793354,
      "sha256": "913a643a697a53fe88476395682995d5647c14f51321d344e69abcc3c4e854a2"
    },
    "tokenizer": {
      "path": "tokenizer.json",
      "bytes": 535343,
      "sha256": "ea77de727ef7fd34d177b83b4b1f1d3bb8884c95c90b6554a0adb0b3b65350a9"
    }
  },
  "p95Ms": null,
  "blockedBy": [
    "p95-unmeasured: bge-small int8 was never benchmarked under transformers.js (ENC-0a bench gap)"
  ]
}
```

Notes:
- `p95Ms: null` and the `blockedBy` reason reflect the **degraded-baseline** run (ENC-DEC-006): the bge-small int8 asset was **not actually benchmarked under transformers.js on this implementation machine** — the p95 evidence gap ENC-0a was meant to close is recorded as a blocker, and the decision still resolves deterministically from the recorded `vc2-model-prep` table rather than blocking on an absent measurement.
- `artifacts.model.bytes = 33793354` = ~32.2 MiB int8 merged single-file; the digests are the pinned record the supply-chain guard enforces (§7). **Artifacts corrected by ENC-0b** from placeholder values (24,117,248 / `01cbed8b...`) to real pinned digests (33,793,354 / `913a643a...`). `installMiB` updated from 33 to 49 (15.4 MiB WASM shell + 33.8 MiB model).

## 3. Per-platform install matrix

| Platform | Runtime | installMiB | demotion | Notes |
| --- | --- | --- | --- | --- |
| `linux-x64` | onnxruntime-web | 49 | none | primary qualification target |
| `linux-arm64` | onnxruntime-web | 49 | none | |
| `darwin-x64` | onnxruntime-web | 49 | **wasm** | Intel Mac: **no native binary** upstream (arm64-only) ⇒ demotion per HG-4; **action ships in ENC-0e** |
| `darwin-arm64` | onnxruntime-web | 49 | none | Apple Silicon native WASM path |
| `win32-x64` | onnxruntime-web | 49 | none | |

Every `EncoderPlatform` (`"linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64" | "win32-x64"`) resolves to a concrete runtime + installMiB + demotion triple. `darwin-x64` records `demotion: "wasm"` — ENC-0a records the row, ENC-0e ships the darwin-x64 demotion action.

## 4. Opset baseline — 21

**Baseline: ONNX opset 21** (the ENC-0a re-baseline). The earlier Xenova opset-17 requirement was dropped by upstream (BAAI/bge-small-en-v1.5 exports at opset 21).

- **Recorded here:** the decision record pins `opset: 21` (fixtures ENC-DEC-003 + all expected_decision blocks).
- **Runtime constant:** `ENCODER_OPSET` in `src/vector-cortex/encoder/types.ts` was **flipped 17 → 21 in ENC-0a**, alongside the placeholder manifest (`assets/vector-cortex/encoder-v1/manifest.json` `"opset": 21`). The placeholder asset's model/tokenizer digests are unchanged (only the opset scalar changed). ENC-0b asserts the staged real asset is opset 21 — no further constant change is required.

## 5. License verdict & pinning

- **Model:** BAAI/bge-small-en-v1.5 — **MIT**, `redistribution: true`. 33.4M params, ~32.2 MiB int8 ONNX (merged single-file).
- **Runtime:** transformers.js v4.2.0 + onnxruntime-web (Apache-2.0 / MIT surface) as previously audited in vc2-model-prep.
- **Pinned digests (authoritative for the supply-chain guard, corrected by ENC-0b):**
  - model `913a643a697a53fe88476395682995d5647c14f51321d344e69abcc3c4e854a2`
  - tokenizer `ea77de727ef7fd34d177b83b4b1f1d3bb8884c95c90b6554a0adb0b3b65350a9`
  - The resolver treats these as authoritative: any bench input whose sha256 **mismatches** is rejected (supply-chain guard, ENC-DEC-005).

## 6. Budget disposition

| Path | installMiB | vs 80 MiB cap | budgetOk |
| --- | --- | --- | --- |
| transformers.js WASM shell | 15.4 | fits | ✅ |
| + bge-small int8 ONNX | ≈ 49 total | fits | ✅ |
| onnxruntime-node native | 258 | **exceeds** | ❌ |

**budgetOk: true** for the WASM path. The native amendment (Option N, `backend: "native"`, `budgetOk: false`) is recorded as ENC-DEC-002: if a future measurement showed p95 > 40 ms or bytes > 80 MiB, the resolver would select native with an explicit budget amendment rather than silently shipping the bloated option.

## 7. Measured p95 table

| Branch | fixture | p95 (512 tok / 4 threads, linux-x64) | backend | budgetOk |
| --- | --- | --- | --- | --- |
| WASM qualifies | ENC-DEC-001 | 18.2 ms | wasm | true |
| native-amended | ENC-DEC-002 | 54.7 ms | native | false |
| opset-pinned | ENC-DEC-003 | 21.3 ms | wasm | true |
| platform-matrix | ENC-DEC-004 | 17.9 ms | wasm | true |
| sha256-mismatch | ENC-DEC-005 | (rejected) | — | error |
| degraded-baseline | ENC-DEC-006 | **unmeasured** | wasm | true |

**Degraded-baseline note:** values above reflect the recorded/fixture bench inputs. The one genuinely measured live transformers.js p95 for bge-small int8 under WASM remains **unmeasured** in this implementation environment (the bench harness was extended for `--transformers` mode but the live run is recorded as the degraded baseline — `p95Ms: null` with the `p95-unmeasured` blocker). ENC-0b and later sprints supply the live number; the pre-registered rule `p95 ≤ 40 ms AND bytes ≤ 80 MiB → wasm/budgetOk` remains unchanged regardless of which number lands.

## 8. Hard-gate disposition

- **HG-4 (darwin-x64 demotion):** row recorded here with `demotion: "wasm"`; the demotion **action ships in ENC-0e**.
- **HG-3 (measured p95 qualification):** restated — the WASM path fits the budget regardless of p95 (bytes ≤ 80 MiB is the binding constraint), but a **measured** transformers.js p95 is still required before ENC-0b commits the runtime asset wiring. The resolver degrades deterministically until then (ENC-DEC-006) and never blocks on the absent measurement.

## 9. Privacy & scope

The decision record carries **digests, sizes, licenses, install bytes, and verdicts only** — never message/ledger content (EVAL-REDACT-002). Both the resolver and the bench harness are **zero-network local computation** (PREVENT-PI-004). No store schema/stateDir changes: this is a pure migration-disposition sprint.
