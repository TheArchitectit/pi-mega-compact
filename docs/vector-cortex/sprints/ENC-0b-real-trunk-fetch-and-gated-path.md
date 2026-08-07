# ENC-0b — Real trunk fetch + gated ONNX inference path

**Status:** planned | **Depends on:** ENC-0a | **Phase:** ENC
**Flag:** `MEGACOMPACT_ENC_0B`, defined in `src/config/vector-cortex-enc0b.ts` (sibling extract), re-exported by `vector-cortex.ts` + root `src/config.ts`, default ON; `MEGACOMPACT_ENC_0B=0` disables and must be byte-identical to the predecessor — the encoder keeps serving the **LCG placeholder inference** (`projectSemantic` at `src/vector-cortex/encoder/runtime.ts:269`) exactly as before; no real ONNX session is built and no `vector_cortex_encoder_onnx_loaded` event is emitted. Registered in `VECTOR_CORTEX_SETTINGS` as a visible boolDirect toggle, never in `EXCLUDED_SETTINGS`.

## Goal and inputs/outputs

**Fetch + wire the real trunk.** This sprint acquires the REAL bge-small int8 ONNX encoder (the asset ENC-0a locked, opset 21, ~23 MiB) and stages it into `assets/vector-cortex/encoder-v1/` **publisher-side** — the extension performs ZERO network calls at runtime (PREVENT-PI-004), and the asset ships inside the npm package. It then wires a real ONNX `InferenceSession` behind a runtime branching point at `src/vector-cortex/encoder/runtime.ts:269` (the LCG stub line), keeping the LCG placeholder as the explicit byte-identical fallback when the flag is off or the real asset/session is unavailable. This closes the "whole mode-A inference path runs on the LCG placeholder (no onnxruntime)" audit finding.

The writer is a developer-tooling fetch script modeled on the existing `scripts/vc2-model-prep/fetch-model.sh` precedent (which already fails hard on digest mismatch). It fetches on `linux-x64` once at release time, verifies SHA-256 against the ENC-0a-pinned digests, and stages the real bytes under `assets/vector-cortex/encoder-v1/`. The manifest is re-versioned from `encoder-v1-placeholder` to **`encoder-v1`**. `ENCODER_OPSET` is already 21 (flipped in ENC-0a alongside the placeholder manifest); ENC-0b asserts the staged real asset is opset 21.

Backend per the ENC-0a decision record: **transformers.js v4.2.0 + onnxruntime-web WASM** is the leading candidate; the real inference path builds the session through the `runtime-wasm.ts`/`runtime-native.ts` siblings that ML5-C already scaffolded, dispatching per `MEGACOMPACT_ENCODER_NATIVE=1` (default OFF = WASM). The LCG stub remains the seeded fallback under flag-off for byte-identical predecessor behavior.

Production ownership: `assets/vector-cortex/encoder-v1/model.onnx (REPLACED — real bge-small int8, opset 21, 33.8 MB merged single-file from onnx-community split format; digest 913a643a pinned); assets/vector-cortex/encoder-v1/tokenizer.json (REPLACED — bge-small WordPiece, 535343 bytes, onnx-community); assets/vector-cortex/encoder-v1/manifest.json (REPLACED — modelVersion "encoder-v1", opset 21 confirmed (already 21 from ENC-0a), real digest/bytes, totalBytes 34328697); assets/vector-cortex/encoder-v1/model-card.json (REPLACED — bge-small-v1.5 card, MIT, source onnx-community); package.json + package-lock.json (additive — onnxruntime-web ^1.26.0-dev.20260416-b7804b056c); src/vector-cortex/encoder/types.ts (additive — ENC_0B_IDS re-export seam for the 6 trunk fixture IDs; ENCODER_OPSET already 21 from ENC-0a); src/vector-cortex/encoder/types-vc2c.ts (additive — hosts ENC_0B_IDS constant, keeps types.ts under 300 soft limit); src/vector-cortex/encoder/onnx.ts (new — real ONNX InferenceSession builder: onnxruntime-web WASM, opset-21 handshake, deterministic output, RSS-budget-aware, local-only, int64 triple-input feeding for bge's 3-tensor signature, sentence_embedding extraction + L2 normalization); src/vector-cortex/encoder/encoder-onnx-dispatch.ts (NEW — ENC-0b dispatch glue: sync-returning fire-and-forget wrapper over buildOnnxSession for load(), async verifyOnnxSession for test/router integration (ENC-0c); resolve the sync/async contract conflict per the EncoderRuntime.infer() sync interface); src/vector-cortex/encoder/runtime.ts (evolves — load() fires tryBuildOnnx() after verification; EncoderRuntimeHandle intersection type adds onnxState getter; infer() continues serving the LCG fallback until ENC-0c wires the router to consume the ONNX session asynchronously); src/vector-cortex/encoder/emit.ts (additive — onnxSessionLoaded reporter method on EncoderReporter for the vector_cortex_encoder_onnx_loaded event); src/vector-cortex/encoder/runtime-wasm.ts (additive — int64 triple-input signature update for bge-small: input_ids + attention_mask + token_type_ids; sentence_embedding output extraction replacing earlier "embedding" placeholder); src/config/vector-cortex-enc0b.ts (new — ENC_0B_ENABLED flag, sprintFlag pattern); src/config/vector-cortex.ts + src/config.ts (additive re-export seams, boolDirect wiring); extensions/dashboard-server/routes-rag-settings-vector-cortex.ts (additive — MEGACOMPACT_ENC_0B boolDirect toggle registered in VECTOR_CORTEX_SETTINGS); scripts/encoder/fetch-bge-model.sh (new — developer fetch from onnx-community + python3/onnx merge to single-file + sha256 pin, modeled on vc2-model-prep/fetch-model.sh); scripts/encoder/verify-staged-asset.mjs (new — asserts staged manifest digests + opset 21 + model-card re-version before accept); scripts/ml5-enc/gen-fixtures.mjs (evolves — additive ENC-TRUNK fixture family scoped under the encoder-trunk domain, ENC-0b owner registration; runs after vector-cortex-gen-fixtures.mjs); scripts/gen-fixtures/encoder-qualification.mjs (additive — ENC-PACK-003 budgetBytes re-baselined 35 MiB → 80 MiB for real 33.8 MB model; assertion text updated); scripts/ml5/gen-fixtures-ml5b.mjs + scripts/ml5/gen-fixtures-ml5c.mjs (additive — opset literal re-baselined 17 → 21 to match ENC-0a; previously shipped opset-17 fixtures mutated canonically); conformance/vector-cortex/v2/encoder-trunk/ (fixtures ENC-TRUNK-001..006, 6 files); conformance/vector-cortex/v2/schemas/encoder-trunk-fixture.schema.json (new — kind enum closed to {onnx-session, flag-off-parity, digest-mutation, opset-mismatch, determinism, model-card-version}); conformance/vector-cortex/v2/encoder-qualification/ENC-PACK-003.json (regenerated — budgetBytes 80 MiB + assertion updated); conformance/vector-cortex/v2/bench-heads/ML5-BENCH-003.json + conformance/vector-cortex/v2/runtime-choice/ML5-RUNTIME-003.json (regenerated — opset 21 literals); conformance/vector-cortex/v2/manifest.json (regenerated — 866 fixtures canonical, sha256 patches for the ENC-PACK-003/ML5-BENCH-003/ML5-RUNTIME-003 opset/budget re-baselines + ENC-TRUNK rows appended, "encoder-trunk" domain + ENC-0b owner registered); docs/vector-cortex/encoder-backend-decision.md (additive — Artifacts section updated to real digests/sizes); docs/vector-cortex/evidence/ENC-0b.md (new)`.

## Numbered implementation tasks

1. Add the `MEGACOMPACT_ENC_0B` flag (default ON, `=0` byte-identical) in `src/config/vector-cortex-enc0b.ts` + the `vector-cortex.ts`/`src/config.ts` re-exports and the `VECTOR_CORTEX_SETTINGS` boolDirect toggle in `routes-rag-settings-vector-cortex.ts` (additive). `vector-cortex.ts` stays ≤ 300.
2. Create `scripts/encoder/fetch-bge-model.sh`: developer-tooling fetch of the ENC-0a-pinned bge-small int8 model + tokenizer into `assets/vector-cortex/encoder-v1/`, `set -euo pipefail`, fails hard on sha256 mismatch (mirrors `scripts/vc2-model-prep/fetch-model.sh`). NOT extension runtime — zero runtime network (PREVENT-PI-004).
3. Create `src/vector-cortex/encoder/onnx.ts`: `buildOnnxSession(assetDir)` → the real `InferenceSession` over the committed ONNX via transformers.js/onnxruntime-web WASM, with the optional native path when `MEGACOMPACT_ENCODER_NATIVE=1`; `executionProviders:['cpu']`, `intraOpNumThreads:4`, opset-21 handshake, deterministic output (SHA-256 stable across runs), and the marginal-RSS budget check against `ENCODER_RSS_BUDGET_BYTES` before allocation (cap-before-allocation, `runtime.ts` Q01 precedent). Local-only, never throws (returns a typed failure code on any error).
4. Verify `ENCODER_OPSET` is 21 (already flipped in ENC-0a alongside the placeholder manifest — no change needed here). Update `model-card.json` to `encoder-v1`/bge-small and the manifest to real digests/bytes.
5. Evolve `src/vector-cortex/encoder/runtime.ts:269` inference dispatch: under `MEGACOMPACT_ENC_0B` build + use the real `onnx.ts` session; on session-build failure (absent asset, digest mismatch, opset mismatch, budget breach) ANY failure demotes to mode B trigram — never a network fetch. `MEGACOMPACT_ENC_0B=0` keeps the LCG `projectSemantic` path byte-identical. Use the delegate-shell split so runtime.ts stays ≤ 300 (mirror the ML5-C `runtime-wasm.ts`/`runtime-native.ts` siblings it already dispatches to).
6. Emit `vector_cortex_encoder_onnx_loaded` (real session, digest prefix) via the existing reporter on success; emit the existing `runtimeDemoted` on any failure (non-fatal, no `console.log`).
7. Create `scripts/encoder/verify-staged-asset.mjs`: asserts the staged manifest digests + opset 21 + `modelVersion:"encoder-v1"` + model-card re-version; run it before the asset is accepted (fail-hard on any drift from the ENC-0a record).
8. Add `scripts/ml5-enc/gen-fixtures.mjs` (additive) emitting `ENC-TRUNK-001..006`, register them + owner `ENC-0b` in the v2 manifest against `schemas/encoder-decision-fixture.schema.json`-style sibling `schemas/encoder-trunk-fixture.schema.json`; the manifest bump is cross-cutting.
9. Add the sprint acceptance aggregator `src/vector-cortex/enc0b-acceptance.test.ts`, then evidence `ENC-0b.md` recording the fetched digests, the opset-21 handshake, the re-version, and the flag-off byte-identical check.

## Failure triad and independence

A real ONNX path: with the staged real asset + `MEGACOMPACT_ENC_0B=1`, the runtime builds the transformers.js WASM session, handshakes opset 21, and `infer` returns a real (non-LCG) embedding (fixtures 501; ids use the `ENC-TRUNK-` prefix). B flag-off LCG fallback: `MEGACOMPACT_ENC_0B=0` keeps `projectSemantic(seedFromBytes(embeddedBytes) ^ n, …)` at `runtime.ts:269` and returns byte-identical predecessor output (fixture 502). C failure-demotion: any session/asset/digest/opset/budget failure (absent asset, one-byte model mutation, opset ≠ 21, RSS over `ENCODER_RSS_BUDGET_BYTES`) demotes to mode B trigram — never a network fetch, never a throw (fixtures 503–504). Determinism is pinned by 505 (identical SHA-256 over the real embedding across 3 runs); the model-card re-version (`encoder-v1`, not `-placeholder`) is pinned by 506. A is produced by the onnx.ts session; B purely by the flag gate; C by each named failure path. `MEGACOMPACT_ENC_0B=0` forces byte-identical predecessor output. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/encoder-trunk/`. Schema: `schemas/encoder-trunk-fixture.schema.json` (new sibling).

- `ENC-TRUNK-001: real ONNX session builds + opset-21 handshake with the staged asset, flag-on`.
- `ENC-TRUNK-002: flag-off keeps the LCG stub and returns byte-identical predecessor output`.
- `ENC-TRUNK-003: one-byte model.onnx mutation -> ENC_DIGEST_MISMATCH -> mode B (no refetch)`.
- `ENC-TRUNK-004: opset != 21 in the staged manifest -> ENC_OPSET_INVALID -> mode B`.
- `ENC-TRUNK-005: real-embedding determinism — identical sha256 over 3 runs (maxAbsDelta 0)`.
- `ENC-TRUNK-006: model-card + manifest re-versioned to encoder-v1 (not -placeholder)`.

Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/enc0b-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/enc0b-acceptance.test.js
```

Expected assertions: all `ENC-TRUNK-001..006` rows registered with algorithm `encoder-trunk` against the `encoder-trunk` schema, expected `ok`; aggregator flag-agnostic. Runtime unit assertions: onnx.ts never throws and returns a typed failure code on absent asset / mutation / opset mismatch / RSS breach; dispatch under flag-on routes to the real session, flag-off to the LCG stub; `vector_cortex_encoder_onnx_loaded` emitted only on real-session success. Unique failure injection: a one-byte mutation of the staged `model.onnx` forces `ENC_DIGEST_MISMATCH`, the runtime demotes to mode B, and the load path never retries a fetch (a test-level network probe asserts zero network attempted). Exact flag-off comparison command:

```bash
MEGACOMPACT_ENC_0B=0 node --test dist/vector-cortex/enc0b-acceptance.test.js
```

the aggregator is flag-agnostic and its predecessor golden bytes must match exactly. Acceptance: no payload leakage (the runtime returns embedding vectors + events carry digest prefixes only, never message content — EVAL-REDACT-002); zero network at runtime (PREVENT-PI-004 — the fetch script is release-time developer tooling, never imported by `src/`); determinism within `1e-6` over repeats. Apply [EVALUATION](../EVALUATION.md) annotation/power rules; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure — no schema/state changes.** The asset is re-versioned in place under `assets/vector-cortex/encoder-v1/` (a new `manifest.json` entry with the real digest — same directory, append-restorable by sha256 per the ML5-E precedent); the store schema and `stateDir` tables are untouched. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); the staged asset is a public MIT model artifact, the runtime emits digest prefixes and embedding vectors only, never exact ledger bytes. Dashboard: **no changes** — this sprint touches no `extensions/` dashboard files; `cd extensions/dashboard-client && npm run typecheck && npm run build` is NOT required and NOT run. The Setup card surfacing the real-run state lands with ENC-0e. Rollback sets `MEGACOMPACT_ENC_0B=0` — the LCG stub serves byte-identical predecessor output and no ONNX session is built, without deleting the staged asset or the evidence. No operator migration.

## Exit evidence

Run exact project gates:

```bash
npm run build
node --test dist/vector-cortex/enc0b-acceptance.test.js
MEGACOMPACT_ENC_0B=0 node --test dist/vector-cortex/enc0b-acceptance.test.js
npm test
npm run lint
python3 scripts/regression_check.py --all
node scripts/guardrails-scan.mjs
python3 scripts/log_failure.py --list
node scripts/vector-cortex-conformance.mjs --check
node scripts/vector-cortex-docs-check.mjs
node scripts/vector-cortex-scope-check.mjs ENC-0b <COMMIT_SHA>
node scripts/vector-cortex-evidence-check.mjs ENC-0b
node scripts/vector-cortex-verify-assets.mjs assets/vector-cortex/encoder-v1/manifest.json
git diff --check
```

`node scripts/vector-cortex-verify-assets.mjs` is the asset gate — it must pass with the real bge-small manifest before the asset is accepted. `npm pack --dry-run` (listing only, never a `.tgz`, PREVENT-DIST-001) must show the real `assets/vector-cortex/encoder-v1/{model.onnx,tokenizer.json,manifest.json,model-card.json}` and the transformers.js/onnxruntime-web dependency. No permissive globs or warning-only scans count. `<COMMIT_SHA>` is this sprint's commit. No dashboard client or server files are touched.

This sprint is one of 15 new sprint docs in the program; the single docs-check reconciliation (owned by the integration step, not by any per-sprint commit) sets `EXPECTED_SPRINTS` to **60** in `scripts/vector-cortex-docs-check.mjs` (count at integration time). Cross-cutting seam only.
