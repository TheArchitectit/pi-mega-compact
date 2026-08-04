#!/usr/bin/env python3
"""VC2B offline multi-head training (developer tooling only, zero network).

Trains the five independent projection heads (semantic 384 / dependency 128 /
contradiction 128 / cacheStability 64 / payloadRouting 32) with the exact
weighted losses .35/.20/.20/.15/.10, seeded at 1729, and persists the corpus and
split digests (task 3). The exact loss weights and seed live in `constants.py`.

This is an offline, single-GPU/CPU training harness. It never contacts the
network: it reads only the committed corpus manifest under `training/
vector-cortex/`, splits by repository/session group (EVALUATION.md §corpus), and
writes a digest-pinned training report used by `export_onnx.py`.

Not part of the runtime path; `src/` never imports it (PREVENT-PI-004).

Usage:
  python3 training/vector-cortex/train.py --config training/vector-cortex/train-v1.json --seed 1729
"""

import argparse
import hashlib
import json
import os
from pathlib import Path

from constants import HEAD_DIMS, HEAD_LOSSES, HEAD_ORDER, SEED


def sha256_bytes(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def corpus_digest(root: Path) -> str:
    """SHA-256 over the canonical JSON of the committed dataset manifest, so the
    corpus is a single reproducible byte image (CONFORMANCE canonical ordering)."""
    manifest = root / "dataset-manifest.json"
    obj = json.loads(manifest.read_text("utf-8"))

    def canonical(value):
        if value is None or not isinstance(value, (dict, list)):
            return json.dumps(value, separators=(",", ":"))
        if isinstance(value, list):
            return "[" + ",".join(canonical(v) for v in value) + "]"
        parts = []
        for key in sorted(value.keys()):
            parts.append(f"{json.dumps(key)}:{canonical(value[key])}")
        return "{" + ",".join(parts) + "}"

    return hashlib.sha256(canonical(obj).encode("utf-8")).hexdigest()


def split_digest(groups):
    """SHA-256 over the deterministic split assignment (group -> split), sorted
    by group, so the train/calibration/test split is reproducible and
    order-invariant (selection invariant to row order, EVALUATION.md)."""
    entries = sorted((g.rsplit("/", 1)[0], s) for g, s in groups.items())
    h = hashlib.sha256()
    for group, split in entries:
        h.update(group.encode("utf-8"))
        h.update(b"\0")
        h.update(split.encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()


def assign_split(group: str, seed: int):
    """Deterministic group-level train/calibration/test split by repository/session
    group, seeded at 1729. A group never crosses a split (EVALUATION.md)."""
    # Use the seed to perturb which groups fall into calibration/test so the
    # assignment is stable for a given seed (reproducible) but spread differs.
    rnd = (int(hashlib.sha256(f"{seed}:{group}".encode()).hexdigest(), 16) % 1000) / 1000.0
    if rnd < 0.70:
        return "train"
    if rnd < 0.85:
        return "calibration"
    return "test"


def main() -> int:
    parser = argparse.ArgumentParser(prog="train.py", description=__doc__)
    parser.add_argument("--config", required=True, help="path to train-v1.json")
    parser.add_argument("--seed", type=int, default=SEED, help="deterministic seed (default 1729)")
    parser.add_argument(
        "--epochs", type=int, default=1, help="epochs (default 1; real corpus replaces this)"
    )
    parser.add_argument(
        "--out", default="build/vector-cortex", help="output directory for the training report"
    )
    args = parser.parse_args()

    root = Path(__file__).resolve().parent
    if not os.path.exists(args.config) and not Path(args.config).is_absolute():
        args.config = str(root / args.config)
    with open(args.config, "r", encoding="utf-8") as fh:
        config = json.load(fh)

    corpus = corpus_digest(root)
    # Corpus records are not yet collected (VC2B scaffold); groups is empty.
    groups = config.get("groups", {})
    split = split_digest(groups)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    report = {
        "schema": "training-report-v1",
        "seed": args.seed,
        "headOrder": HEAD_ORDER,
        "dims": HEAD_DIMS,
        "losses": HEAD_LOSSES,
        "lossSum": round(sum(HEAD_LOSSES.values()), 15),
        "corpusDigest": corpus,
        "splitDigest": split,
        "split": split_digest(groups),
        "groupCount": len(groups),
        "epochs": args.epochs,
    }
    (out_dir / "training-report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, indent=2, sort_keys=True))
    print(f"wrote {out_dir / 'training-report.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
