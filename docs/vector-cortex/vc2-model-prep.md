# VC2 — Real ONNX Model + Backend Viability (research note)

> **STATUS: REFERENCE-ONLY (research note).** This document records measured
> prototype numbers and never modified shipped code. The current source-of-truth
> for the real encoder contract is the shipped ML5-A export pipeline
> (`scripts/vector-cortex-gen-assets.mjs`) and `src/vector-cortex/encoder/`, not
> this note. Refer to this file only for the measured viability data (backend
> choice, digests, remaining VC2C steps), never as the authoritative contract.

**Status:** research / prototype. **No shipped code was modified.** VC2A/VC2B/VC2C
contract code, `src/`, and `assets/vector-cortex/encoder-v1/*` are untouched.

This note answers the question that blocks the deferred VC2 ML gate: *can we run
a real learned encoder locally, and with which backend?* It records measured
numbers from this machine, the `allowScripts` finding, real digests, and the
exact remaining steps to close the gate in VC2C.

Measurement host: `linux-x64`, Node v26.4.0, npm 12.0.1, 24 logical CPUs.
Prototype tooling committed alongside: `scripts/vc2-model-prep/`.

---

## 1. Headline: `onnxruntime-node` works under pi's install-script block

**Recommendation: `onnxruntime-node`. No `allowScripts` entry is required.**

`package.json` allowlists exactly one package (`@mongodb-js/zstd@7.0.0`), so
everything else installs with its lifecycle scripts blocked. The concern was that
`onnxruntime-node` would die the way `better-sqlite3` did. It does not — and the
reason matters, because the two failure modes are different:

- `better-sqlite3` needed **node-gyp compilation**. Blocking its script left it
  with *no binary at all*, so it could never load.
- `onnxruntime-node` **bundles prebuilt CPU binaries for every platform directly
  in the npm tarball**. Nothing has to be compiled, extracted, or selected at
  install time; the loader picks `bin/napi-v6/<platform>/<arch>/` at require time.

It does declare `"postinstall": "node ./script/install"`, which looks
disqualifying but is not. Reading `script/install-metadata.js`, that script's
**only** job is downloading *optional CUDA/TensorRT GPU execution providers*:

```
requirements: {
  "linux/x64":   ["cuda12"],
  "linux/arm64": [], "darwin/x64": [], "darwin/arm64": [],
  "win32/x64":   [], "win32/arm64": []
}
```

CPU inference — the only thing VC2 needs (`executionProviders: ['cpu']`) — uses
the bundled binaries and requires none of that. The script also self-exits early
when the files it manages are already present.

**Blocking this script is a PREVENT-PI-004 *benefit*, not a cost:** that
postinstall is the package's sole network access, and the block removes it.

### Verified empirically

```bash
npm install onnxruntime-node --ignore-scripts   # simulates pi's block
node -e "require('onnxruntime-node')"           # → LOADED OK
```

Installed with scripts fully blocked, then loaded, then ran **real inference on a
real 23 MB MiniLM model** — see §3. The native binaries were present without the
postinstall ever running:

```
bin/napi-v6/linux/x64/onnxruntime_binding.node
bin/napi-v6/linux/x64/libonnxruntime.so.1
```

> **Action for VC2C: none.** Do **not** add an `allowScripts` entry. Adding one
> would re-enable a CUDA download at install time and reintroduce a network call.
> If a future defence-in-depth measure is wanted, pin
> `ONNXRUNTIME_NODE_INSTALL=skip` so the script is a no-op even if scripts are
> ever globally enabled.

---

## 2. `onnxruntime-web` (WASM) — viable but strictly worse; recommend against

The brief flagged WASM as "likely the safer path" given the PGlite precedent.
Prototyped and measured it; that hypothesis **did not hold**. Since
`onnxruntime-node` survives the block, WASM's only advantage (no native binary)
buys nothing, and it loses badly on both qualification gates.

Same model, same host, 512 tokens:

| Backend | threads | p95 latency | steady RSS | ≤40 ms? | ≤150 MiB? |
| --- | --- | --- | --- | --- | --- |
| `onnxruntime-node` | 4 | **22.4 ms** | **119–149 MiB** | PASS | PASS |
| `onnxruntime-web` (wasm) | 4 | 75.4 ms | 341 MiB | **FAIL** | **FAIL** |
| `onnxruntime-web` (wasm) | 1 | 251.2 ms | 275 MiB | **FAIL** | **FAIL** |

WASM is ~3.4× slower and ~2.3× over the memory budget — it cannot qualify for
mode A as the gates are currently written. It also installs cleanly with
`--ignore-scripts`, so it remains a *fallback of last resort* if a future
platform ever lacks a prebuilt native binary, but it should not be the primary
path.

---

## 3. Real benchmark numbers (gates measured, not estimated)

Model: `all-MiniLM-L6-v2`, int8-quantized ONNX export, 23,026,053 bytes.
Command: `node --expose-gc scripts/vc2-model-prep/bench-onnx.mjs <model> --tokens=512 --iters=300 --threads=4`

```json
{
  "backend": "onnxruntime-node", "ortVersion": "1.27.0", "platform": "linux-x64",
  "threads": 4, "tokens": 512, "iters": 300, "loadMs": 68,
  "p50": 19.9, "p95": 23.6, "p99": 30.34,
  "steadyRssMiB": 149.2,
  "determinism": { "repeats": 100, "distinctDigests": 1, "maxAbsDelta": 0 },
  "gates": { "latency": true, "rss": true, "determinism": true, "all": true }
}
```

Latency/RSS across token counts (int8, `onnxruntime-node`):

| tokens | threads | p95 | steady RSS | verdict |
| --- | --- | --- | --- | --- |
| 128 | 1 | 12.1 ms | 80 MiB | pass |
| 256 | 4 | 10.1 ms | 135 MiB | pass |
| 384 | 4 | 14.3 ms | 135 MiB | pass |
| 512 | 4 | 22.4–23.6 ms | 119–149 MiB | pass |
| 512 | **2** | **44.3 ms** | 148 MiB | **FAIL latency** |
| 512 (**fp32**) | 4 | 40.2 ms | 234 MiB | **FAIL both** |

Three findings that are easy to get wrong and should be treated as normative for
whoever implements VC2C:

1. **`intraOpNumThreads: 4` is required, not a tuning nicety.** At 2 threads,
   512-token p95 is 44.3 ms and *misses* the 40 ms gate. Qualification must pin
   the thread count, and single-core/2-core platforms may not qualify for A.
2. **The fp32 export cannot qualify** (234 MiB RSS, 40.2 ms p95). The int8
   quantized export is the only viable candidate.
3. **RSS must be sampled at steady state, after an explicit GC.** A naive
   harness that retains output tensors reports **160.5 MiB** for the exact same
   workload that measures **119–149 MiB** once collected — a false budget
   breach. Each inference allocates a `[1, 512, 384]` float32 tensor (768 KiB);
   uncollected, those dominate the reading. The committed harness runs under
   `--expose-gc` and collects before sampling.

**Margin warning:** 149.2 MiB against a 150 MiB cap is ~0.5% headroom, and the
figure varies run to run (119–149 MiB observed). This gate is *technically* met
but is not robustly met at 512 tokens. See the risk register in §6.

**Determinism gate passes cleanly:** 100 repeats produced a single distinct
SHA-256 over the output buffer and `maxAbsDelta = 0` — bit-exact, comfortably
inside the required `1e-6`. (The spec asks for 1,000 repeats; 100 was used here
for turnaround. Run the full 1,000 via `--repeats=1000` during qualification.)

---

## 4. Real digests (replacing the 42-byte placeholder)

Current `assets/vector-cortex/encoder-v1/model.onnx` is a **42-byte placeholder**
(`ONNX....opsets=17,batch=1,max=512`), digest
`01cbed8b0b301609542ff8c392c3e7d927b0d848ac53a768dfffd33bfe6005ff`. No fake model
binary was produced; these are the digests of genuinely downloaded artifacts.

| Artifact | Bytes | SHA-256 |
| --- | --- | --- |
| `model.onnx` (int8, **recommended**) | 23,026,053 | `4278337fd0ff3c68bfb6291042cad8ab363e1d9fbc43dcb499fe91c871902474` |
| `tokenizer.json` (WordPiece) | 466,247 | `be50c3628f2bf5bb5e3a7f17b1f74611b2561a3a27eeab05e5aa30f411572037` |
| `model.onnx` (fp32, rejected) | 90,405,214 | `6fd5d72fe4589f189f8ebc006442dbb529bb7ce38f8082112682524616046452` |
| Xenova int8 variant (rejected, opset 11) | 22,972,370 | `afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1` |

Sources (Apache-2.0, redistribution permitted — satisfies the MODEL_ASSET
licensing requirement):

- `https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model_qint8_avx512_vnni.onnx`
- `https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/tokenizer.json`

Reproduce + verify with `scripts/vc2-model-prep/fetch-model.sh`, which fails hard
on digest mismatch.

Intended manifest shape once a compliant model exists (note the two `TODO`s that
§5 must resolve — do not copy this in as-is):

```jsonc
{
  "schema": "model-manifest-v1",
  "modelVersion": "encoder-v1",           // no longer "-placeholder"
  "onnx": {
    "path": "model.onnx",
    "bytes": 23026053,
    "sha256": "4278337fd0ff3c68bfb6291042cad8ab363e1d9fbc43dcb499fe91c871902474"
  },
  "tokenizer": {
    "path": "tokenizer.json",
    "bytes": 466247,
    "sha256": "be50c3628f2bf5bb5e3a7f17b1f74611b2561a3a27eeab05e5aa30f411572037"
  },
  "opset": 14,                             // TODO: must be 17 — see §5
  "batch": 1, "maxTokens": 512,
  "hiddenWidth": 384, "semanticWidth": 384,
  "heads": { /* TODO: five heads not yet trained — see §6 */ },
  "platform": "linux-x64",
  "totalBytes": 23492300
}
```

---

## 5. Opset gap — every off-the-shelf export violates the spec

MODEL_ASSET.md mandates **ONNX opset 17**. None of the published MiniLM exports
meet it (verified by parsing `opset_import` out of the protobuf):

| Export | IR version | opset |
| --- | --- | --- |
| sentence-transformers int8 | 7 | **14** |
| sentence-transformers fp32 | 7 | **14** |
| Xenova `model_quantized` | 6 | **11** |

So the asset cannot simply be downloaded and committed — it must be re-exported.
This is a real gate, not a formality: `asset.ts` enforces opset 17, and shipping
an opset-14 file would be rejected by the runtime's own verification.

Two ways to close it, in preference order:

1. **Re-export at opset 17** with `optimum`/`torch.onnx.export`, then quantize —
   this is what the contractual pipeline in MODEL_ASSET.md already prescribes
   (`training/vector-cortex/export_onnx.py --opset 17`). Preferred: it keeps the
   spec intact and is required anyway for the five projection heads (§6).
2. **Amend the spec to accept opset 14** via a new asset version. Cheaper, but it
   only helps if the stock model were usable as-is — and §6 shows it is not.

Since (2) doesn't avoid a re-export, **(1) is the only real path.**

---

## 6. What still blocks mode A (beyond the backend)

The backend question is now settled; these remain:

| # | Blocker | Severity | Notes |
| --- | --- | --- | --- |
| 1 | **Five projection heads do not exist.** | **blocker** | Spec requires semantic 384 / dependency 128 / contradiction 128 / cache-stability 64 / payload-routing 32. Stock MiniLM emits only `last_hidden_state [1, N, 384]`. Requires VC2B training + export; no download can supply this. |
| 2 | Opset 14 ≠ required 17 | blocker | §5. Resolved by the same re-export as #1. |
| 3 | `onnxruntime-node` installs **259 MiB** | **blocker** | Bundles all 5 platforms (linux-x64 37M, linux-arm64 20M, darwin-arm64 75M, win32-x64 62M, win32-arm64 67M). Backend qualification is p95-gated; the install byte-budget is **operator-configurable** via `MEGACOMPACT_NATIVE_ORT_BUDGET_MIB` (default 300 MiB; shipped 5-platform ~160 MiB fits at the default). The blocker is the missing operator install + probe path, not the byte-count. Needs either a per-platform `optionalDependencies` split or pruning non-target platforms at pack time. |
| 4 | **No `darwin-x64` binary** in ort-node 1.27.0 | high | Supported matrix mandates `darwin-x64`; only `darwin/arm64` ships. Intel macOS must fall back to mode B, or the matrix must drop it. |
| 5 | RSS margin at 512 tokens is ~0.5% | medium | 149.2 MiB vs 150 MiB cap, run-to-run variance 119–149 MiB. Consider capping mode A at 384 tokens (135 MiB, 14.3 ms) for real headroom, or measuring the marginal-footprint accounting `runtime.ts` already implements rather than whole-process RSS. |
| 6 | 4 threads mandatory for 512-token p95 | medium | 2 threads → 44.3 ms, fails. Low-core platforms may not qualify for A. |
| 7 | Model card / dataset manifest / calibration | blocker | `model-card.json` comparison, `training/vector-cortex/dataset-manifest.json`, and frozen VC2C calibration thresholds are all still required by spec. |

Items 1, 2 and 7 are training work (VC2B), not backend work. **Item 3 is the
newly-surfaced one most likely to be missed** — the runtime dependency, not the
model, is what drives the large install footprint.

---

## 7. Exact steps to close the VC2 ML gate

1. **VC2B — train + export.** Fit the five heads on the MiniLM trunk; export with
   `--opset 17`, batch 1, max 512; quantize to int8 (fp32 cannot pass §3).
2. **Qualify.** `node --expose-gc scripts/vc2-model-prep/bench-onnx.mjs <model>
   --tokens=512 --iters=300 --threads=4 --repeats=1000`. Requires all three gates
   green on each supported platform (exit code 0).
3. **Commit assets** to `assets/vector-cortex/encoder-v1/`, regenerate
   `manifest.json` with real digests (§4 shape), and verify via
   `node scripts/vector-cortex-verify-assets.mjs`.
4. **VC2C — `package.json`.** Add `onnxruntime-node` as a dependency. **Do not add
   an `allowScripts` entry** (§1). Resolve the native install path (blocker #3)
   before publishing.
5. **Wire the backend.** Replace the deterministic `projectSemantic` stub in
   `src/vector-cortex/encoder/runtime.ts` with a real `InferenceSession`, pinning
   `executionProviders: ['cpu']` and `intraOpNumThreads: 4`. Keep the existing
   digest-verify-before-load and B/C demotion paths exactly as they are — they
   already implement the contract and are why load failures stay non-fatal.
6. **Guardrails.** Confirm `guardrails-scan.mjs` stays green: CPU inference is
   local-only, so no `PREVENT-PI-004` annotation should be needed. Verify no
   network syscall at runtime via the clean-install, network-denied smoke test
   MODEL_ASSET.md §"Qualification and packaging" already mandates.
7. **`deploy.sh`.** Add the manifest-digest + supported-matrix + asset-path checks
   against `npm pack --dry-run` listing (listing only — never create a `.tgz`,
   PREVENT-DIST-001).

---

## 8. Prototype tooling committed

- `scripts/vc2-model-prep/fetch-model.sh` — fetches candidate assets and verifies
  SHA-256 against §4; fails hard on mismatch.
- `scripts/vc2-model-prep/bench-onnx.mjs` — the qualification harness that
  produced §3. Measures p95 latency, steady-state RSS (post-GC), and determinism;
  exits non-zero if any gate fails.

Both are **developer tooling, not extension runtime**. Neither is imported by
`src/` or `extensions/`, and neither runs during normal operation, so the
extension's zero-network-at-runtime invariant is unaffected. The downloaded model
binaries were deliberately **not** committed (they are large, and no
spec-compliant model exists yet — §5/§6).
