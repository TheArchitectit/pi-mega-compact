#!/usr/bin/env bash
# fetch-bge-model.sh — fetch + merge the real bge-small-en-v1.5 ONNX encoder.
#
# Developer tooling only (NOT part of the extension runtime). Stages the
# real learned encoder trunk under assets/vector-cortex/encoder-v1/ so the
# runtime can load a local ONNX session (PREVENT-PI-004: zero runtime network).
#
# Usage:
#   scripts/encoder/fetch-bge-model.sh [outdir]
#
# Default outdir: assets/vector-cortex/encoder-v1
#
# Fetches from onnx-community/bge-small-en-v1.5-ONNX (Hugging Face):
#   - onnx/model_quantized.onnx (graph) + onnx/model_quantized.onnx_data (weights)
#   - tokenizer.json
# Merges the split ONNX into a single file (model.onnx) using python3 + onnx,
# then verifies SHA-256 against the pinned digests in the manifest.

# guardrails-allow PREVENT-PI-004: developer fetch tooling, not runtime
set -euo pipefail

OUTDIR="${1:-assets/vector-cortex/encoder-v1}"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

BASE="https://huggingface.co/onnx-community/bge-small-en-v1.5-ONNX/resolve/main"

# Pinned SHA-256 digests (from assets/vector-cortex/encoder-v1/manifest.json)
MODEL_SHA="913a643a697a53fe88476395682995d5647c14f51321d344e69abcc3c4e854a2"
TOKENIZER_SHA="ea77de727ef7fd34d177b83b4b1f1d3bb8884c95c90b6554a0adb0b3b65350a9"

echo "==> Fetching bge-small-en-v1.5 ONNX (opset 21, int8 quantized)"

# Fetch split ONNX files
echo "  fetching model_quantized.onnx (graph)..."
curl -sSL --fail -o "$TMPDIR/model_quantized.onnx" "$BASE/onnx/model_quantized.onnx"

echo "  fetching model_quantized.onnx_data (weights)..."
curl -sSL --fail -o "$TMPDIR/model_quantized.onnx_data" "$BASE/onnx/model_quantized.onnx_data"

echo "  fetching tokenizer.json..."
curl -sSL --fail -o "$TMPDIR/tokenizer.json" "$BASE/tokenizer.json"

# Verify tokenizer digest
TOKENIZER_GOT="$(sha256sum "$TMPDIR/tokenizer.json" | awk '{print $1}')"
if [ "$TOKENIZER_GOT" != "$TOKENIZER_SHA" ]; then
  echo "DIGEST MISMATCH for tokenizer.json" >&2
  echo "  expected: $TOKENIZER_SHA" >&2
  echo "  actual:   $TOKENIZER_GOT" >&2
  exit 1
fi
echo "  tokenizer sha256=$TOKENIZER_GOT ok"

# Merge split ONNX into single file
echo "==> Merging split ONNX into single file..."

if command -v python3 &>/dev/null; then
  python3 -c "
import sys
try:
    import onnx
except ImportError:
    print('ERROR: python3 onnx package not available.', file=sys.stderr)
    print('Install it:  pip install onnx', file=sys.stderr)
    sys.exit(1)

model = onnx.load('$TMPDIR/model_quantized.onnx', load_external_data=True)
onnx.save_model(model, '$TMPDIR/model.onnx', save_as_external_data=False)
print('  merged model.onnx written')
" || {
    echo "ERROR: python3/onnx merge failed." >&2
    echo "Install onnx:  pip install onnx" >&2
    exit 1
  }
else
  echo "ERROR: python3 not available for ONNX merge." >&2
  echo "Install python3 + onnx:  pip install onnx" >&2
  exit 1
fi

# Verify merged model digest
MODEL_GOT="$(sha256sum "$TMPDIR/model.onnx" | awk '{print $1}')"
if [ "$MODEL_GOT" != "$MODEL_SHA" ]; then
  echo "DIGEST MISMATCH for merged model.onnx" >&2
  echo "  expected: $MODEL_SHA" >&2
  echo "  actual:   $MODEL_GOT" >&2
  exit 1
fi
echo "  model sha256=$MODEL_GOT ok"

# Copy to target directory
mkdir -p "$OUTDIR"
cp "$TMPDIR/model.onnx" "$OUTDIR/model.onnx"
cp "$TMPDIR/tokenizer.json" "$OUTDIR/tokenizer.json"

echo
echo "==> Staged to $OUTDIR/"
echo "    model.onnx     $(stat -c%s "$OUTDIR/model.onnx" 2>/dev/null || stat -f%z "$OUTDIR/model.onnx") bytes"
echo "    tokenizer.json $(stat -c%s "$OUTDIR/tokenizer.json" 2>/dev/null || stat -f%z "$OUTDIR/tokenizer.json") bytes"
echo
echo "Verify:  node scripts/encoder/verify-staged-asset.mjs"
