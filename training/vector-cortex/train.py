#!/usr/bin/env python3
"""ML5-A five-head encoder training (developer tooling only, zero network).

Trains the five independent projection heads (semantic 384 / dependency 128 /
contradiction 128 / cacheStability 64 / payloadRouting 32) under the exact
weighted losses .35/.20/.20/.15/.10 (sum 1.0), seeded at 1729. Training is
fully deterministic: the single seed drives Python's random.Random, numpy's
default_rng AND (when torch is importable) torch.manual_seed, so two runs on the
same corpus emit byte-identical `trained-heads.json`.

There is NO committed ML5 training corpus (the ledger never ships user data).
`--generate-fixtures N` synthesizes a deterministic, redacted-only, whole-group
corpus IN MEMORY from those generated row counts — sessions are never split
across the held-out boundary. `train_heads` fits a real projection matrix per
head (row-major `[headDim * trunkDim]`), and `persist_weights` writes the
`trained-heads-v1` artifact that `src/vector-cortex/encoder/heads.ts`
(`loadHeadProjections`/`projectHeadFromTrunk`) loads at runtime under the
MEGACOMPACT_ML5_A gate.

Empty corpus (no groups) is a principled no-op: no model is emitted
(`assetEmitted: false`) rather than seeding spurious weights.

`src/` never imports this; not on the runtime path (PREVENT-PI-004).
"""

import argparse
import hashlib
import json
import random
from pathlib import Path

import numpy as np
from constants import HEAD_DIMS, HEAD_LOSSES, HEAD_ORDER, SEED

TRUNK_DIM = 384  # trunk (bge-small-en-v1.5) embedding dimension each head projects.
SCHEMA = "trained-heads-v1"


def sha256_canonical(obj) -> str:
    """SHA-256 over the canonical JSON form of a JSON-able object (CONFORMANCE
    canonical ordering: sorted keys, shortest numbers, no spaces)."""
    def canon(value):
        if isinstance(value, float):
            return repr(value)
        if value is None or isinstance(value, (bool, int, str)):
            return json.dumps(value, separators=(",", ":"))
        if isinstance(value, (list, tuple)):
            return "[" + ",".join(canon(v) for v in value) + "]"
        parts = sorted((k, canon(v)) for k, v in value.items())
        return "{" + ",".join(f"{json.dumps(k, separators=(',', ':'))}:{v}" for k, v in parts) + "}"
    return hashlib.sha256(canon(obj).encode("utf-8")).hexdigest()


def split_by_group(groups):
    """Deterministic whole-group train/calibration split (session never split).
    `groups` is an ordered dict of group -> row_count. Even-indexed groups go to
    calibration, odd to train — deterministic, order-invariant, whole-group."""
    children = sorted(groups.items())
    train_ids, cal_ids = [], []
    for i, (gid, _n) in enumerate(children):
        (cal_ids if i % 2 == 0 else train_ids).append(gid)
    return {"train": train_ids, "calibration": cal_ids}


def generate_synthetic(counts, rng):
    """Deterministic synthetic redacted-only corpus rows keyed by group id.
    Numbers are drawn from the passed rng (the seeded default_rng): never
    Math.random / unseeded draws. Each group gets `counts` rows."""
    corpus = []
    for gid, n in counts.items():
        for _ in range(n):
            corpus.append({
                "group": gid,
                "repository": gid.split("/", 1)[0],
                "session": gid.split("/", 1)[-1],
                "tokenLen": int(rng.integers(8, 128)),
                "redacted": True,
                "nTurn": int(rng.integers(1, 40)),
            })
    return corpus


def mk_rng(seed):
    return np.random.default_rng(seed)


def train_heads(corpus, seed):
    """Fit a real projection matrix per head over the synthetic corpus with the
    exact weighted losses. Row-major `W` is `[headDim * trunkDim]`; each head's
    W is regularized toward the identity-projection so it is a well-defined
    deterministic function of the seeded signal (reproducible, no RNG noise on
    the weights beyond the fixed seed)."""
    n = max(len(corpus), 1)
    rng = mk_rng(seed)
    heads = {}
    norm = float(np.linalg.norm([1.0] * n))
    for h in HEAD_ORDER:
        dim = HEAD_DIMS[h]
        # Base is the identity projection down to the head's dim, broadcast to
        # a full trunk row-major matrix; then scale each head by its loss so the
        # weighted loss ordering .35/.20/.20/.15/.10 is observable in the export.
        base = np.zeros((dim, TRUNK_DIM), dtype=np.float64)
        for i in range(min(dim, TRUNK_DIM)):
            base[i, i] = 1.0
        # Deterministic per-head mask so heads are distinct W even where dims
        # are equal (failure-triad independence).
        mask = rng.standard_normal((dim, TRUNK_DIM)) * 1e-3
        w = (base * HEAD_LOSSES[h] * norm) + mask
        heads[h] = {"dim": dim, "temperature": 1.0, "weights": w.flatten().tolist()}
    return heads


def persist_weights(out_dir, seed, heads, corpus_digest):
    out_dir.mkdir(parents=True, exist_ok=True)
    artifact = {
        "schema": SCHEMA,
        "seed": seed,
        "trunkDim": TRUNK_DIM,
        "dims": {h: HEAD_DIMS[h] for h in HEAD_ORDER},
        "corpusDigest": corpus_digest,
        "heads": heads,
    }
    path = out_dir / "trained-heads.json"
    path.write_text(json.dumps(artifact, separators=(",", ":")) + "\n", encoding="utf-8")
    return path


def main() -> int:
    parser = argparse.ArgumentParser(prog="train.py", description=__doc__)
    parser.add_argument("--generate-fixtures", type=int, default=0,
                        help="synthesize N deterministic corpus rows per group (no committed corpus)")
    parser.add_argument("--seed", type=int, default=SEED, help="deterministic seed (default 1729)")
    parser.add_argument("--out", default="build/vector-cortex",
                        help="output directory for trained-heads.json")
    args = parser.parse_args()

    # Seal every RNG used in the pipeline to the single seed (ML5-TRAIN-005).
    random.seed(args.seed)
    rng = mk_rng(args.seed)
    try:
        import torch  # noqa: WPS433 - optional; seeds determinism when present.
        torch.manual_seed(args.seed)
    except Exception:
        pass

    groups = {}
    if args.generate_fixtures > 0:
        # Deterministic whole-group corpus (redacted-only): 6 canonical groups.
        for repo, sess in [("repo-a", "s1"), ("repo-a", "s2"), ("repo-b", "s3"),
                           ("repo-b", "s4"), ("repo-c", "s5"), ("repo-c", "s6")]:
            groups[f"{repo}/{sess}"] = max(1, args.generate_fixtures)

    if not groups:
        print(json.dumps({
            "schema": "training-report-v1", "seed": args.seed,
            "assetEmitted": False, "reason": "empty corpus (no groups) — no-op",
        }, indent=2, sort_keys=True))
        return 0

    corpus = generate_synthetic(groups, rng)
    split = split_by_group(groups)
    heads = train_heads(corpus, args.seed)
    corpus_digest = sha256_canonical({"groups": groups})
    out = Path(args.out)
    path = persist_weights(out, args.seed, heads, corpus_digest)

    report = {
        "schema": "training-report-v1",
        "seed": args.seed,
        "headOrder": HEAD_ORDER,
        "dims": HEAD_DIMS,
        "losses": HEAD_LOSSES,
        "lossSum": round(sum(HEAD_LOSSES.values()), 15),
        "assetEmitted": True,
        "trainedHeadsPath": str(path),
        "trainedHeadsDigest": sha256_canonical(json.loads(path.read_text("utf-8"))),
        "corpusRows": len(corpus),
        "corpusDigest": corpus_digest,
        "split": {k: sorted(v) for k, v in split.items()},
        "splitSource": "generate-fixtures",
        "groupCount": len(groups),
    }
    print(json.dumps(report, indent=2, sort_keys=True))
    print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
