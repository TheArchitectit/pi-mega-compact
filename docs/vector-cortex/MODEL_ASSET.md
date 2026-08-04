# Learned Model Asset Contract

A learned encoder is **research-only and A-ineligible** until every gate here passes. Trigram mode B and lexical/exact mode C remain live and independently implemented.

## Decision record and architecture

VC2A must produce `assets/vector-cortex/encoder-v1/model-card.json`, `manifest.json`, tokenizer files, runtime model, and `docs/vector-cortex/evidence/VC2A.md`. The model card compares at least MiniLM-class transformer, small BERT, and trained bag/subword baselines on license, offline Node support, size, latency, platform coverage, and held-out quality. The accepted base must permit redistribution and local inference. No runtime downloader or remote fallback.

Normative v1 target (change requires a new asset version): WordPiece tokenizer, NFC comparison text only, max 512 tokens, deterministic truncation preserving first 128 and last 384 tokens; hidden width declared in manifest; five independent projection heads: semantic 384 float32 L2-normalized, dependency 128, contradiction 128, cache-stability 64, payload-routing 32. ONNX opset 17, CPU execution, batch 1. Tokenizer vocabulary and special-token IDs are digest-covered.

## Data, labels, losses, calibration

`training/vector-cortex/dataset-manifest.json` records every source URI/path, immutable digest, license/SPDX, collection date, consent basis, allowed uses, redaction, split group, and removal contact. No user ledger enters training without explicit per-record opt-in consent. Secrets and private fixtures are prohibited. Split by repository/session before examples are generated.

Labels: semantic graded similarity; dependency directed binary; contradiction symmetric binary plus `unknown`; cache-stability same canonical request prefix; payload-routing class `{semantic,exact,residual,anchor}`. Loss is weighted sum: semantic cosine/MSE .35, dependency BCE .20, contradiction focal .20, cache contrastive .15, payload cross-entropy .10. VC2B publishes class weights and seeds. VC2C fits temperature/isotonic calibration on calibration-only data and freezes thresholds.

## Reproducible local pipeline

Implementation must add lockfile-backed, documented commands (names are contractual):

```bash
python3 -m venv .vc-venv
.vc-venv/bin/pip install --require-hashes -r training/vector-cortex/requirements.lock
.vc-venv/bin/python training/vector-cortex/train.py --config training/vector-cortex/train-v1.json --seed 1729
.vc-venv/bin/python training/vector-cortex/export_onnx.py --checkpoint build/vector-cortex/checkpoint --out assets/vector-cortex/encoder-v1/model.onnx --opset 17
node scripts/vector-cortex-verify-assets.mjs assets/vector-cortex/encoder-v1/manifest.json
```

Training/export may be developer tooling; runtime must be TypeScript/local and load only packaged assets or an explicitly configured local path. Manifest covers every byte with SHA-256, shapes/dtypes, runtime/opset, tokenizer, licenses, training manifest digest, calibration, supported platforms, and total bytes.

## Qualification and packaging

A qualifies only if: per-head thresholds in [EVALUATION](EVALUATION.md) pass; 100% deterministic output within `1e-6` on 1,000 repeats; no NaN/wrong dimension; p95 inference ≤40 ms and RSS delta ≤150 MiB on each supported platform; asset total ≤35 MiB compressed npm listing and ≤80 MiB installed; and B/C demotion works on missing/corrupt assets. Supported matrix is explicitly `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`; unsupported platforms select B.

`package.json` changes occur only in VC2C implementation. `scripts/deploy.sh` must be enhanced there to verify manifest digests, supported matrix, and asset paths in `npm pack --dry-run` output (listing only; never create a `.tgz`) before publish. Test a clean temporary npm install with network denied, delete caches, run packaged inference smoke, and verify no write outside temp state.

Required tests: `src/vector-cortex/encoder/runtime.test.ts`, `heads.test.ts`, `fallback.test.ts`; `scripts/vector-cortex-assets.test.mjs`; fixtures `conformance/vector-cortex/v2/model/ENC-001..020`. Compiled commands are `node --test dist/vector-cortex/encoder/runtime.test.js dist/vector-cortex/encoder/heads.test.js dist/vector-cortex/encoder/fallback.test.js` and `node --test scripts/vector-cortex-assets.test.mjs`.
