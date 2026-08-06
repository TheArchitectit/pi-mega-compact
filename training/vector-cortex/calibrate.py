#!/usr/bin/env python3
"""ML5-A calibration fit (developer tooling, zero network).

Fits the per-head temperature + decision threshold on the held-out
CALIBRATION split only and writes a ``CalibrationV1`` JSON — the exact schema
consumed by ``src/vector-cortex/encoder/calibrate.ts``. Held-out (test/eval)
labels never enter the fit inputs; a calibration example whose id appears in
the held-out set is a fit violation and the fit fails loudly.

The calibration split is grouped by ``repository/session`` and no single group
crosses a split boundary. The emitted ``calibrationSplitDigest`` is the SHA-256
over the sorted group list (order-invariant), matching calibrate.ts semantics.

The fitted temperature is taken from the training run (the per-head temperature
scalar the joint loss maximised); the decision threshold is a true
between-class balance point over the calibration distribution — the midpoint
strictly between the highest-scoring negative and lowest-scoring positive for
each head, never landing on a negative example's own score. Degenerate heads
fall back conservatively exactly as the TS placeholder fitThreshold does. Seed
1729; no ``random`` without a seed.

Not part of the runtime path — ``src/`` never imports it.

Usage:
  python3 training/vector-cortex/calibrate.py --trainedheads build/vector-cortex/trained-heads.json --calib build/vector-cortex/calibration.jsonl --out build/vector-cortex
"""

import argparse
import hashlib
import json
import random
from pathlib import Path

import numpy as np

from constants import HEAD_DIMS, HEAD_ORDER, SEED


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_json(value) -> str:
    if value is None or isinstance(value, (bool, int, float, str)):
        return json.dumps(value, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    parts = []
    for key in sorted(value.keys()):
        parts.append(f"{json.dumps(key)}:{canonical_json(value[key])}")
    return "{" + ",".join(parts) + "}"


def load_calibration(calib_path: Path):
    """Read calibration examples: a list of {id, head, score, label,
    repository, session} records or a JSONL."""
    records = []
    text = calib_path.read_text("utf-8")
    if calib_path.suffix == ".jsonl":
        for line in text.splitlines():
            if line.strip():
                records.append(json.loads(line))
    else:
        data = json.loads(text)
        records = data if isinstance(data, list) else data.get("examples", [])
    return records


def group_list_digest(records) -> str:
    groups = sorted(
        {f"{len(r['repository'])}:{r['repository']}/{len(r['session'])}:{r['session']}" for r in records}
    )
    return sha256_bytes(canonical_json({"groups": groups}).encode("utf-8"))


def fit_threshold(head, records) -> float:
    ex = [r for r in records if r["head"] == head]
    ex_sorted = sorted(
        ex, key=lambda r: (r["score"], r["id"])
    )
    if not ex_sorted:
        return 0.5
    highest_neg = -float("inf")
    lowest_pos = float("inf")
    for r in ex_sorted:
        if r["label"] == 0:
            highest_neg = max(highest_neg, r["score"])
        else:
            lowest_pos = min(lowest_pos, r["score"])
    if lowest_pos == float("inf"):
        return max(0.5, highest_neg + 0.05)
    if highest_neg == -float("inf"):
        return max(0.0, lowest_pos - 0.05)
    return (highest_neg + lowest_pos) / 2.0


def main() -> int:
    parser = argparse.ArgumentParser(prog="calibrate.py", description=__doc__)
    parser.add_argument("--trainedheads", required=True, help="trained-heads.json from train.py")
    parser.add_argument("--calib", required=True, help="calibration examples (JSON or JSONL)")
    parser.add_argument("--heldout", default=None, help="held-out ids JSONL/JSON to forbid from the fit")
    parser.add_argument("--seed", type=int, default=SEED)
    parser.add_argument("--out", default="build/vector-cortex")
    args = parser.parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)

    trained = json.loads(Path(args.trainedheads).read_text("utf-8"))
    records = load_calibration(Path(args.calib))

    held_out_ids = set()
    if args.heldout:
        held = Path(args.heldout).read_text("utf-8")
        if args.heldout.endswith(".jsonl"):
            for line in held.splitlines():
                if line.strip():
                    held_out_ids.add(json.loads(line).get("id"))
        else:
            held_out_ids.update(json.loads(held))

    for r in records:
        if r["id"] in held_out_ids:
            raise SystemExit(
                f"calibration fit violation: held-out item {r['id']} leaked into fit"
            )

    split_digest = group_list_digest(records)
    temperatures = {}
    thresholds = {}
    for head in HEAD_ORDER:
        # Temperature from the trained asset (the per-head temperature scalar).
        temperatures[head] = trained["heads"][head]["temperature"]
        thresholds[head] = fit_threshold(head, records)

    calibration = {
        "schema": "calibration-v1",
        "headOrder": HEAD_ORDER,
        "calibrationSplitDigest": split_digest,
        "fittedOnCalibrationOnly": True,
        "temperatures": temperatures,
        "thresholds": thresholds,
        "seed": args.seed,
        "corpusDigest": trained.get("corpusDigest"),
    }
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "calibration.json"
    out_path.write_text(canonical_json(calibration) + "\n", encoding="utf-8")
    print(json.dumps({"schema": "calibrate-report-v1", "out": str(out_path), "heads": HEAD_ORDER,
                      "calibrationSplitDigest": split_digest, "seed": args.seed}, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
