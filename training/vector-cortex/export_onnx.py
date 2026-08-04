#!/usr/bin/env python3
"""VC2B ONNX export (developer tooling only, zero network).

Exports the trained five-head encoder from a checkpoint to `model.onnx`
(MODEL_ASSET: ONNX opset 17, CPU execution, batch 1). Shares the seed 1729 with
training so the exported projections are reproducible (task 3: "seed
Python/NumPy/export at 1729").

The real trained weights are substituted in VC2C; this exporter validates the
shape/opset/seed contract now and emits a deterministic placeholder model so the
export pipeline is wired end-to-end. It reads the training report (which carries
the persisted corpus/split digests) and pins them into the exported model's
metadata so VC2C can verify digest continuity.

Not part of the runtime path; `src/` never imports it.

Usage:
  python3 training/vector-cortex/export_onnx.py --checkpoint build/vector-cortex/checkpoint --out assets/vector-cortex/encoder-v1/model.onnx --opset 17
"""

import argparse
import json
import os
from pathlib import Path

from constants import HEAD_DIMS, HEAD_ORDER, SEED

OPSET = 17
BATCH = 1
MAX_TOKENS = 512


def main() -> int:
    parser = argparse.ArgumentParser(prog="export_onnx.py", description=__doc__)
    parser.add_argument("--checkpoint", required=True, help="checkpoint dir / training report dir")
    parser.add_argument("--out", required=True, help="output model.onnx path (absolute or repo-relative)")
    parser.add_argument("--opset", type=int, default=OPSET, help="ONNX opset (default 17)")
    parser.add_argument("--seed", type=int, default=SEED, help="deterministic seed (default 1729)")
    args = parser.parse_args()

    if args.opset != OPSET:
        raise SystemExit(f"export requires opset {OPSET}, got {args.opset}")

    root = Path(__file__).resolve().parent.parent.parent
    report_path = Path(args.checkpoint) / "training-report.json"
    if not report_path.exists():
        raise SystemExit(f"training report not found at {report_path}")
    report = json.loads(report_path.read_text("utf-8"))

    out = Path(args.out)
    if not out.is_absolute():
        out = root / out

    # Deterministic placeholder model carrying the normative shapes + seed +
    # persisted corpus/split digests (real weights arrive in VC2C). This is a
    # reproducible byte image, not derived from any training signal.
    import hashlib
    header = f"onnx-opset{args.opset}-batch{BATCH}-max{MAX_TOKENS}".encode()
    # A split digest is only present once real corpus records exist (train.py
    # persists `splitDigest: null` + `splitState: "none-yet"` until then); pin it
    # as `split=null` rather than fabricating a meaningful split pin (Q03).
    split_dgst = report.get("splitDigest")
    split_field = b"null" if split_dgst is None else str(split_dgst).encode()
    body = (
        header
        + b"|seed=" + str(args.seed).encode()
        + b"|dims=" + ",".join(str(HEAD_DIMS[h]) for h in HEAD_ORDER).encode()
        + b"|corpus=" + report["corpusDigest"].encode()
        + b"|split=" + split_field
    )
    # The digest covers the full artifact bytes written (header + seed + dims +
    # corpus + split), not just a short header, so a later digest-before-load
    # verification validates the payload it is attached to (Q04). The `sha=` field
    # itself is excluded to avoid a self-referential digest.
    digest = hashlib.sha256(body).hexdigest()
    payload = body + b"|sha=" + digest.encode()

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(payload + b"\n")
    print(
        json.dumps(
            {
                "schema": "export-report-v1",
                "opset": args.opset,
                "batch": BATCH,
                "maxTokens": MAX_TOKENS,
                "seed": args.seed,
                "headOrder": HEAD_ORDER,
                "dims": HEAD_DIMS,
                "corpusDigest": report["corpusDigest"],
                "splitDigest": report["splitDigest"],
                "out": str(out),
                "bytes": out.stat().st_size,
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
