#!/usr/bin/env python3
"""ENC-0c deterministic synthetic / self-labeled corpus generator.

Developer tooling only (zero network, PREVENT-PI-004; only local files).

PRIVACY HARD GATE: SYNTHETIC / SELF-LABELED ONLY. Every sample is built from
the hard-coded template pools below -- never real user bytes, never ledger
paths, never session data. The strings visible here are the only strings that
can ever appear in a generated line.

DETERMINISM: one random.Random(ENCODER_SEED) (1729, matching constants.SEED
and train-v1.json) seeds selection and token-id derivation. Two runs on the
same tree emit byte-identical corpus + manifest.

SPLIT STRATEGY (whole-group, held-out test immutable): 12 fixed synthetic
`repo-<name>/sess-<n>` groups; sorted group index i maps to a split by
`i % 5 -> {0:train,1:train,2:calibration,3:train,4:test}`. A group is never
split (sessions never split); the test group set (index == 4 mod 5) is fixed
and immutable (ENC-HEADS-005).

Layout consumed by train_heads.py::

    corpus/<split>/<head>-0.jsonl        # one JSON object per line
    {"input_ids":[...], "label":..., "pair_id":str, "repo_session_group":str}

plus dataset-manifest-enc0c.json (per-source sha256, SPDX, byte/sample counts,
split assignment, group->split map, split-rule digest). NOTE: the pre-existing
dataset-manifest.json is the ML5-A provenance manifest (records=0 placeholder)
and is NOT overwritten -- ENC-0c writes a sibling `dataset-manifest-enc0c.json`
to avoid breaking backward compatibility for any consumer still reading that
path.
"""

import argparse
import hashlib
import json
import random
from collections import OrderedDict
from pathlib import Path

ENCODER_SEED = 1729
SCHEMA = "training-dataset-manifest-v1"
CORPUS_SCHEMA = "synthetic-corpus-v1"
SPLIT_RULE = {0: "train", 1: "train", 2: "calibration", 3: "train", 4: "test"}
SPLITS = ("train", "calibration", "test")
HEAD_ORDER = ["semantic", "dependency", "contradiction", "cache", "payload"]

GROUPS = [  # fixed synthetic `repo/session` groups; sessions never split.
    "repo-alpha/sess-1", "repo-alpha/sess-2",
    "repo-beta/sess-3", "repo-beta/sess-4",
    "repo-gamma/sess-5", "repo-gamma/sess-6",
    "repo-delta/sess-7", "repo-delta/sess-8",
    "repo-epsilon/sess-9", "repo-epsilon/sess-10",
    "repo-zeta/sess-11", "repo-zeta/sess-12",
]
PER_GROUP = {"semantic": 8, "dependency": 8, "contradiction": 8, "cache": 6, "payload": 6}

# --- Template pools (the only strings that can reach a label or input text) ---
S1 = ("the quantum oscillator settles at parity", "the oscillator parity is even",
      "a cached tensor is returned verbatim", "tensor cache hit returns the same tensor",
      "pause the pipeline at the anchor", "the anchor pauses the pipeline",
      "two embeddings with identical cosine are merged", "equal-cosine vectors dedupe",
      "the trunk projects a 384 dim vector", "the 384 dim projection comes from the trunk")
S2 = ("the oscillator settles at odd parity", "the oscillator parity is odd",
      "a fresh tensor is computed each call", "no two calls return the same tensor",
      "resume the pipeline at the anchor", "the anchor resumes, nothing pauses",
      "two embeddings with opposite cosine collide", "opposite-cosine vectors are kept apart",
      "the trunk projects a 128 dim vector", "the 128 dim projection comes from the trunk")
NEG = ("the stock market opened lower", "the fern closed its fronds",
       "the river froze overnight", "the convoy turned north")
DEP = [  # (premise, hypothesis, label)
    ("every tensor is cached", "some tensors are cached", "entailment"),
    ("no tensor is cached", "some tensors are cached", "contradiction"),
    ("the cache is empty", "no cache entry exists", "entailment"),
    ("the cache has entries", "no cache entry exists", "contradiction"),
    ("the anchor is stable", "the anchor did not move", "entailment"),
    ("the anchor moved", "the anchor did not move", "contradiction"),
    ("two vectors dedupe", "their similarity passed the threshold", "entailment"),
    ("two vectors dedupe", "their similarity failed the threshold", "contradiction"),
]
CACHE_CANON = ["list-context", "summarize-session", "recall-nearest", "collapse-branch",
               "dedupe-turn", "snapshot-checkpoint", "rank-by-cosine", "render-graph"]
CACHE_ARG = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta",
             "session-1", "session-2", "canonical.json", "payload.bin"]
PAYLOAD_CLASSES = ("semantic", "exact", "residual", "anchor")
PAYLOAD_TEMPLATES = {  # tag -> routing class samples
    "semantic": ("query-vector", "query:", "lookup-by-meaning", "find-similar"),
    "exact": ("exact-id", "id=", "lookup-by-key", "fetch-by-digest"),
    "residual": ("delta-probe", "diff:", "lookup-by-offset", "patch-remainder"),
    "anchor": ("anchor-pin", "pin:", "lookup-by-anchor", "bind-to-anchor"),
}


def _canon(value):
    """Smallest canonical JSON string (sorted keys, no spaces)."""
    if value is None or isinstance(value, (bool, int, str)):
        return json.dumps(value, separators=(",", ":"))
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_canon(v) for v in value) + "]"
    parts = sorted((k, _canon(v)) for k, v in value.items())
    return "{" + ",".join(f"{json.dumps(k, separators=(',', ':'))}:{v}" for k, v in parts) + "}"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def tokens_for(text: str, length: int, seed: int) -> list:
    """Deterministic token ids in [0, 30522) -- pure function of (text,length,seed)."""
    return [int.from_bytes(hashlib.sha256(f"{text}\x1f{i}\x1f{seed}".encode("utf-8")).digest()[:4], "big") % 30522
            for i in range(length)]


def _samples_for(head, rng):
    """Return [(text, label), ...] for one head/group (deterministic via rng)."""
    if head == "semantic":
        out = []
        for _ in range(PER_GROUP["semantic"]):
            same = rng.random() < .5
            pair = (rng.choice(S1), rng.choice(S1)) if same else (rng.choice(S1), rng.choice(S2))
            out.append((f"{pair[0]} . {pair[1]}", 1 if same else 0))
        return out
    if head == "contradiction":
        out = []
        for _ in range(PER_GROUP["contradiction"]):
            contr = rng.random() < .5
            pair = (rng.choice(S1 + NEG), rng.choice(S1)) if contr else (rng.choice(S1), rng.choice(S1))
            out.append((f"{pair[0]} . {pair[1]}", 1 if contr else 0))
        return out
    if head == "dependency":
        return [(f"{p} => {h}", l) for p, h, l in (rng.choice(DEP) for _ in range(PER_GROUP["dependency"]))]
    if head == "cache":
        out = []
        for _ in range(PER_GROUP["cache"]):
            canon, arg = rng.choice(CACHE_CANON), rng.choice(CACHE_ARG)
            same = rng.random() < .5
            arg2 = arg if same else rng.choice(CACHE_ARG)
            out.append((f"{canon} {arg} | {canon} {arg2}", 1 if same else 0))
        return out
    if head == "payload":
        out = []
        for _ in range(PER_GROUP["payload"]):
            cls = rng.choice(PAYLOAD_CLASSES)
            out.append((f"{PAYLOAD_TEMPLATES[cls][0]} {rng.choice(CACHE_ARG)}", cls))
        return out
    raise ValueError(f"unknown head: {head}")


def gen_samples(head, group, rng, seed):
    """Yield one jsonl-ready line per sample for a head+group."""
    base = _samples_for(head, rng)
    for k, (text, label) in enumerate(base):
        yield {
            "input_ids": tokens_for(text, 24, seed + k),
            "label": label,
            "pair_id": f"{head}-{group.replace('/', '_')}-{k:04d}",
            "repo_session_group": group,
        }


def split_for(index: int) -> str:
    return SPLIT_RULE[index % 5]


def generate(corpus_dir: Path, manifest_path: Path, seed: int):
    rng = random.Random(seed)
    random.seed(seed)
    group_splits = OrderedDict((g, split_for(i)) for i, g in enumerate(GROUPS))
    corpus_dir.mkdir(parents=True, exist_ok=True)
    for s in SPLITS:
        (corpus_dir / s).mkdir(parents=True, exist_ok=True)
    sources, total = {}, 0
    for head in HEAD_ORDER:
        for split in SPLITS:
            lines = [ln for g in GROUPS if group_splits[g] == split
                     for ln in gen_samples(head, g, rng, seed)]
            total += len(lines)
            rel = Path(split) / f"{head}-0.jsonl"
            body = "".join(json.dumps(l, separators=(",", ":"), sort_keys=True) + "\n" for l in lines)
            data = body.encode("utf-8")
            (corpus_dir / rel).write_bytes(data)
            sources[str(rel)] = {"schema": CORPUS_SCHEMA, "head": head, "split": split,
                                 "path": f"corpus/{rel}", "sha256": sha256_bytes(data),
                                 "byteCount": len(data), "sampleCount": len(lines),
                                 "license": "UNLICENSED-synthetic", "generated": True}
    digest_input = _canon({"groups": sorted(GROUPS), "groupSplits": dict(group_splits),
                           "sources": {k: v["sha256"] for k, v in sources.items()}})
    manifest = {
        "schema": SCHEMA, "generator": "gen_synthetic_corpus.py", "seed": seed,
        "syntheticOnly": True, "noUserBytes": True, "splitBy": "repository/session",
        "sessionNeverSplit": True, "splitRule": {str(k): v for k, v in SPLIT_RULE.items()},
        "groupCount": len(GROUPS), "groupSplits": dict(group_splits),
        "testGroups": sorted(g for g, s in group_splits.items() if s == "test"),
        "heads": HEAD_ORDER, "perGroupSampleCount": PER_GROUP, "totalSamples": total,
        "sources": sources, "corpusDigest": sha256_bytes(digest_input.encode("utf-8")),
    }
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return manifest


def check(corpus_dir: Path, manifest_path: Path, seed: int) -> int:
    """--check: verify existing manifest against current generator (no writes)."""
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp)
        fresh = generate(p / "corpus", p / "m.json", seed)
    try:
        existing = json.loads(manifest_path.read_text("utf-8"))
    except FileNotFoundError:
        print("FAIL: manifest not found")
        return 1
    ok = True
    for rel, src in fresh["sources"].items():
        if rel not in existing["sources"]:
            print(f"FAIL: missing source {rel}"); ok = False; continue
        if existing["sources"][rel]["sha256"] != src["sha256"]:
            print(f"FAIL: sha256 drift in {rel}"); ok = False
    if existing.get("corpusDigest") != fresh["corpusDigest"]:
        print("FAIL: corpusDigest drift"); ok = False
    if existing.get("testGroups") != fresh["testGroups"]:
        print("FAIL: testGroups drift"); ok = False
    if existing.get("groupSplits") != fresh["groupSplits"]:
        print("FAIL: groupSplits drift"); ok = False
    if existing.get("splitRule") != fresh["splitRule"]:
        print("FAIL: splitRule drift"); ok = False
    print("PASS: manifest matches current generator (digests stable)" if ok
          else "FAIL: manifest does not match current generator")
    return 0 if ok else 1


def main() -> int:
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(prog="gen_synthetic_corpus.py", description=__doc__)
    ap.add_argument("--out", default=str(here / "corpus"), help="output corpus dir")
    ap.add_argument("--manifest", default=str(here / "dataset-manifest-enc0c.json"), help="manifest path")
    ap.add_argument("--seed", type=int, default=ENCODER_SEED, help="deterministic seed")
    ap.add_argument("--check", action="store_true", help="verify manifest against generator (no writes)")
    args = ap.parse_args()
    if args.check:
        return check(Path(args.out), Path(args.manifest), args.seed)
    m = generate(Path(args.out), Path(args.manifest), args.seed)
    print(json.dumps({"schema": "gen-report-v1", "seed": args.seed, "corpusDir": str(Path(args.out)),
                      "manifest": str(Path(args.manifest)), "corpusDigest": m["corpusDigest"],
                      "totalSamples": m["totalSamples"], "groupCount": m["groupCount"],
                      "testGroups": m["testGroups"], "splitRule": m["splitRule"],
                      "sourceCount": len(m["sources"])}, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
