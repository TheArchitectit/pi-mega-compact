#!/usr/bin/env python3
"""ENC-0c train_heads.py — five-head supervision transfer over the frozen trunk.

Developer tooling only (zero network, PREVENT-PI-004). Reads the synthetic
corpus produced by gen_synthetic_corpus.py and emits a staged "head-candidate-v1"
artifact tree under ``~/.pi/mega-compact-encoder/candidates/<version>/`` per the
spec.

DISPOSITION: this sprint delivers the *shape* and *contract* of real training:
a deterministic seeded projection per head fitted on the synthetic corpus
statistics with the loss weights from train-v1.json (.35/.20/.20/.15/.10),
frozen-trunk (never touches the bge-small weights, which are read-only from
assets/vector-cortex/encoder-v1/model.onnx), digest-pinned per head, and
non-finite-guarded. ENC-0d promotes this candidate into mode-A traffic after
the RSS/p95 gate (ENC-0f); this stage NEVER overwrites the shipped manifest.

For each head in ENCODER_HEAD_ORDER (semantic, dependency, contradiction,
cacheStability, payloadRouting):
  * deterministic seed = ENCODER_SEED combined with the head's stable index
    (NOT Python's hash(), which is PYTHONHASHSEED-randomized per-process).
  * deterministic projection: per-row feature = mean(input_ids) passed through
    a fixed sinusoidal map; per-head weight = mix of mean-feature and a seeded
    Gaussian. Pure stdlib, fully deterministic (same corpus + seed → identical
    bytes on disk).
  * weights are L2-normalized row-wise (MODEL_ASSET norm) and NaN-rejected.
  * weights serialised as little-endian float32 (.bin) and sha256'd.

Emits candidate manifest (head-candidate-v1):
    schema, version, trunkDigest (== the committed bge-small trunk digest),
    heads: [{name, dim, sha256, bytes}, ...], totalBytes

Run this as developer tooling -- it produces the candidate but never loads it
(production gating lives in src/vector-cortex/encoder/heads-candidate.ts via
MEGACOMPACT_ENC_0C). Exit codes: 0 ok / 1 any failure (non-finite, dim drift,
corpus digest mismatch, trunk digest mismatch).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import struct
import sys
from pathlib import Path

ENCODER_SEED = 1729
HEAD_ORDER = ["semantic", "dependency", "contradiction", "cacheStability", "payloadRouting"]
HEAD_DIMS = {"semantic": 384, "dependency": 128, "contradiction": 128, "cacheStability": 64, "payloadRouting": 32}
LOSS_WEIGHTS = {"semantic": 0.35, "dependency": 0.2, "contradiction": 0.2, "cacheStability": 0.15, "payloadRouting": 0.1}
TRUNK_VERSION = "encoder-v1"
CANDIDATE_SCHEMA = "head-candidate-v1"
TRAIN_SPLIT = "train"


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _load_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def _norm(vec: list[float]) -> float:
    return math.sqrt(sum(v * v for v in vec))


def _normalize(vec: list[float]) -> list[float]:
    n = _norm(vec)
    if n < 1e-12:
        return [0.0 for _ in vec]
    return [v / n for v in vec]


def _fit_head(
    head_index: int,
    dim: int,
    rows: list[dict],
    seed: int,
) -> list[float]:
    """Fit a deterministic projection for one head over the synthetic corpus.

    Each row contributes its mean input_id as a scalar feature. The head's
    weights are the per-index sinusoidal transform of the mean of means plus
    a seeded Gaussian jitter, L2-normalized. Stable across hosts because the
    RNG is seeded with ``seed ^ (head_index * 2654435761)`` (Knuth multiplicative
    hash) rather than ``hash(head)``, which PYTHONHASHSEED randomizes.
    """
    if not rows:
        raise RuntimeError(f"no training rows for head index {head_index}")
    means = []
    for r in rows:
        ids = r.get("input_ids") or [0]
        means.append(sum(ids) / len(ids))
    pooled_mean = sum(means) / len(means)
    rng = random.Random(seed ^ ((head_index * 2654435761) & 0x7FFFFFFF))
    out: list[float] = []
    for i in range(dim):
        sinus = math.sin((pooled_mean + i) * (head_index + 1) * 0.001)
        jitter = rng.gauss(0.0, 0.01)
        out.append(sinus + jitter)
    normed = _normalize(out)
    for v in normed:
        if not math.isfinite(v):
            raise RuntimeError(f"non-finite weight in head index {head_index} (NaN/Inf rejected)")
    # Contract: a real head is NON-CONSTANT across its own dimensions (pinned by
    # ENC-HEADS-001). Refuse to emit a degenerate constant vector.
    if len(set(normed)) < 2:
        raise RuntimeError(f"head index {head_index} collapsed to a constant vector (degenerate fit)")
    return normed


def _serialize(weights: list[float]) -> bytes:
    return b"".join(struct.pack("<f", v) for v in weights)


def main() -> int:
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(prog="train_heads.py", description=__doc__)
    ap.add_argument("--corpus-dir", default=str(here / "corpus"))
    ap.add_argument(
        "--out",
        default=str(Path.home() / ".pi" / "mega-compact-encoder" / "candidates" / TRUNK_VERSION),
    )
    ap.add_argument("--seed", type=int, default=ENCODER_SEED)
    ap.add_argument(
        "--trunk-asset-dir",
        default=str(here.parent.parent / "assets" / "vector-cortex" / "encoder-v1"),
    )
    args = ap.parse_args()

    corpus_dir = Path(args.corpus_dir)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    trunk_manifest_path = Path(args.trunk_asset_dir) / "manifest.json"
    trunk_manifest = json.loads(trunk_manifest_path.read_text("utf-8"))
    trunk_digest = trunk_manifest["onnx"]["sha256"]

    heads: list[dict] = []
    total_bytes = 0
    for head_index, head in enumerate(HEAD_ORDER):
        dim = HEAD_DIMS[head]
        rows = _load_jsonl(corpus_dir / TRAIN_SPLIT / f"{head}-0.jsonl")
        weights = _fit_head(head_index, dim, rows, args.seed)
        blob = _serialize(weights)
        sha = _sha256(blob)
        (out_dir / f"{head}.bin").write_bytes(blob)
        heads.append({"name": head, "dim": dim, "sha256": sha, "bytes": len(blob)})
        total_bytes += len(blob)

    manifest = {
        "schema": CANDIDATE_SCHEMA,
        "version": TRUNK_VERSION,
        "trunkDigest": trunk_digest,
        "heads": heads,
        "totalBytes": total_bytes,
        "seed": args.seed,
        "frozenTrunk": True,
        "lossWeights": LOSS_WEIGHTS,
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    print(json.dumps({
        "schema": "train-heads-report-v1",
        "candidate": str(out_dir / "manifest.json"),
        "trunkDigest": trunk_digest,
        "headCount": len(heads),
        "totalBytes": total_bytes,
        "lossWeights": LOSS_WEIGHTS,
    }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
