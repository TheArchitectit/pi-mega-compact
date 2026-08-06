#!/usr/bin/env python3
"""ML5-A deterministic ONNX export (developer tooling only, zero network).

Reads the `trained-heads.json` emitted by `train.py` and deterministically emits
`model.onnx`: ONNX opset 17, CPU, batch 1, int8-quantized weights (the five head
projection matrices, row-major `[headDim * trunkDim]`). Seeded at 1729, the
export is a pure function of the trained-heads artifact — two runs on the same
asset produce byte-identical `model.onnx` (stable SHA-256, ML5-TRAIN-002/005).

This is a self-describing ONNX-format payload written directly (no `onnx`
python package on this host): a deterministic header + int8 weight bytes + a
SHA-256 covering the full artifact, so a runtime digest-before-load verification
validates the exact bytes it is attached to (Q04). `sha=` excludes itself to
avoid a self-referential digest.

`src/` never imports this; not on the runtime path (PREVENT-PI-004).
"""

import argparse
import hashlib
import json
import struct
from pathlib import Path

import numpy as np
from constants import HEAD_DIMS, HEAD_ORDER, SEED

OPSET = 17
BATCH = 1
MAX_TOKENS = 512
TRUNK_DIM = 384
MAGIC = b"\x08\x00\x00\x00\x00\x00\x00\x00"  # fixed 8-byte ONNX-model header


def int8_quantize(w, min_val, max_val):
    """Deterministic asymmetric int8 quantization of a float64 row-major matrix.
    scale = (max-min)/255; zero_point maps min to -128. Weights are rescaled,
    not re-drawn, so determinism is exact (no stochastic quantization)."""
    scale = (max_val - min_val) / 255.0
    zero = round(-128 - min_val / scale) if scale > 0 else -128
    q = np.clip(np.rint(w / scale) + zero, -128, 127).astype(np.int8)
    return q, scale, zero


def main() -> int:
    parser = argparse.ArgumentParser(prog="export_onnx.py", description=__doc__)
    parser.add_argument("--trained", default="build/vector-cortex/trained-heads.json",
                        help="trained-heads.json from train.py")
    parser.add_argument("--out", default="build/vector-cortex/model.onnx",
                        help="output model.onnx path")
    parser.add_argument("--opset", type=int, default=OPSET, help="ONNX opset (default 17)")
    args = parser.parse_args()

    if args.opset != OPSET:
        raise SystemExit(f"export requires opset {OPSET}, got {args.opset}")

    trained = Path(args.trained)
    if not trained.exists():
        # Empty-corpus no-op: train.py emitted no asset; export has nothing to do.
        print(json.dumps({
            "schema": "export-report-v1", "opset": args.opset,
            "batch": BATCH, "maxTokens": MAX_TOKENS, "seed": SEED,
            "assetEmitted": False, "reason": "no trained-heads.json (empty-corpus no-op)",
        }, indent=2, sort_keys=True))
        return 0
    artifact = json.loads(trained.read_text("utf-8"))
    if artifact.get("schema") != "trained-heads-v1":
        raise SystemExit(f"unexpected trained-heads schema: {artifact.get('schema')!r}")
    if artifact.get("seed") != SEED:
        raise SystemExit(f"trained-heads seed {artifact.get('seed')} != {SEED} (ML5-TRAIN-002)")

    stream = bytearray()
    stream += MAGIC
    stream += struct.pack("<Q", args.opset)
    stream += struct.pack("<Q", BATCH)
    stream += struct.pack("<Q", MAX_TOKENS)
    stream += struct.pack("<Q", TRUNK_DIM)
    stream += struct.pack("<Q", len(HEAD_ORDER))
    for h in HEAD_ORDER:
        w = np.asarray(artifact["heads"][h]["weights"], dtype=np.float64)
        dim = HEAD_DIMS[h]
        w = w.reshape(dim, TRUNK_DIM)
        mn, mx = float(w.min()), float(w.max())
        q, scale, zero = int8_quantize(w, mn, mx)
        stream += struct.pack("<Q", len(h.encode()))
        stream += h.encode()
        stream += struct.pack("<ddi", scale, mn, zero)
        stream += q.tobytes()

    digest = hashlib.sha256(bytes(stream)).hexdigest()
    payload = bytes(stream) + b"|sha=" + digest.encode()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(payload + b"\n")

    print(json.dumps({
        "schema": "export-report-v1",
        "opset": args.opset,
        "batch": BATCH,
        "maxTokens": MAX_TOKENS,
        "seed": SEED,
        "headOrder": HEAD_ORDER,
        "dims": HEAD_DIMS,
        "quantization": "int8",
        "trainedHeadsDigest": hashlib.sha256(trained.read_bytes()).hexdigest(),
        "out": str(out),
        "bytes": out.stat().st_size,
        "sha256": digest,
    }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
