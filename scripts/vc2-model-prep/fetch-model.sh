#!/usr/bin/env bash
# VC2 model prep — fetch the candidate encoder assets (DEVELOPER TOOLING ONLY).
#
# This script is NOT part of the extension runtime. It is run by a developer,
# once, to stage the learned-encoder asset before it is committed under
# assets/vector-cortex/encoder-v1/. The extension itself performs ZERO network
# calls at runtime (PREVENT-PI-004) — it loads only packaged local assets.
#
# Usage:
#   scripts/vc2-model-prep/fetch-model.sh [outdir]
#
# Verifies SHA-256 against the digests recorded in
# docs/vector-cortex/vc2-model-prep.md so a supply-chain swap is caught here,
# before anything is committed.

set -euo pipefail

OUTDIR="${1:-build/vc2-model-prep}"
mkdir -p "$OUTDIR"

# sentence-transformers/all-MiniLM-L6-v2 — Apache-2.0, redistribution permitted.
BASE="https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main"

# Candidate A (RECOMMENDED): int8-quantized encoder, 23,026,053 bytes.
MODEL_URL="$BASE/onnx/model_qint8_avx512_vnni.onnx"
MODEL_OUT="$OUTDIR/model.onnx"
MODEL_SHA="4278337fd0ff3c68bfb6291042cad8ab363e1d9fbc43dcb499fe91c871902474"

# WordPiece tokenizer, 466,247 bytes.
TOKENIZER_URL="$BASE/tokenizer.json"
TOKENIZER_OUT="$OUTDIR/tokenizer.json"
TOKENIZER_SHA="be50c3628f2bf5bb5e3a7f17b1f74611b2561a3a27eeab05e5aa30f411572037"

fetch() {
  local url="$1" out="$2" want="$3"
  echo "→ fetching $(basename "$out")"
  curl -sSL --fail -o "$out" "$url"
  local got
  got="$(sha256sum "$out" | awk '{print $1}')"
  if [ "$got" != "$want" ]; then
    echo "DIGEST MISMATCH for $out" >&2
    echo "  expected: $want" >&2
    echo "  actual:   $got" >&2
    exit 1
  fi
  echo "  ok  sha256=$got  bytes=$(stat -c%s "$out" 2>/dev/null || stat -f%z "$out")"
}

fetch "$MODEL_URL" "$MODEL_OUT" "$MODEL_SHA"
fetch "$TOKENIZER_URL" "$TOKENIZER_OUT" "$TOKENIZER_SHA"

echo
echo "Staged in $OUTDIR."
echo "NOTE: this export is opset 14, NOT the opset 17 required by MODEL_ASSET.md."
echo "See docs/vector-cortex/vc2-model-prep.md §'Opset gap' before committing."
