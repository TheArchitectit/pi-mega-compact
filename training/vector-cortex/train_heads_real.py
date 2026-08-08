#!/usr/bin/env python3
"""ML5-A VC2B-2 — REAL gradient training of the five projection heads against
the frozen bge-small-en-v1.5 ONNX trunk.

Developer tooling only (zero network, PREVENT-PI-004: everything reads local
files under this repo — the committed ONNX trunk, the committed tokenizer and
the committed synthetic corpus). This script supersedes the deterministic
`train.py` / `train_heads.py` *placeholders*: they only ever produced synthetic
weights from sinusoids / sha256-derived fake token ids. This script runs REAL
backpropagation.

Pipeline:
  1. Load the real BGE tokenizer (assets/vector-cortex/encoder-v1/tokenizer.json,
     HuggingFace format) with `transformers.PreTrainedTokenizerFast`.
  2. Load the frozen trunk ONNX (model.onnx, opset 21) with onnxruntime
     (InferenceSession, CPUExecutionProvider). The trunk is NEVER trained —
     it is read-forward, detached, and treated as a constant feature extractor.
  3. For every corpus sample, tokenize `text` -> real BGE token ids -> forward
     the trunk -> [1, 384] CLS-pooled sentence embedding. (The corpus `text`
     field is real raw text; the legacy `input_ids` sha256-derived ids are NOT
     used.)
  4. One linear projection per head `W_h: 384 -> dim` (no bias):
       semantic        384  MSE          (cosine similarity of a text pair)
       dependency      128  BCE          (entailment / contradiction, 2 logits)
       contradiction   128  focal loss   (binary)
       cacheStability   64  contrastive  (NT-Xent-style margin)
       payloadRouting   32  cross-entropy (4 routing classes)
     The projection matrices are the ONLY thing exported; any per-head
     classification/contrastive logit head is a training-time loss accessory.
  5. Loss weights .35/.20/.20/.15/.10 (sum 1.0); seed 1729; 50 epochs; batch 8;
     AdamW lr 1e-3. Evaluate on the held-out test split (whole-group, session
     never split).
  6. Export `trained-heads.json` (schema `trained-heads-v1`, the exact artifact
     `src/vector-cortex/encoder/heads.ts` `loadHeadProjections` consumes):
     per-head `{dim, temperature, weights:[float32 row-major dim*384]}`. Weights
     are float32 as a JSON number list AND a per-head int8 asymmetric-quantized
     copy (scale + zero_point + quantized weights) is written to the sibling
     `trained-heads-int8.json` for an int8 export path.

Deps: `pip install -r requirements.txt` (torch, onnxruntime, transformers,
numpy). On a host without them the script exits non-zero with guidance — it must
be run on a host that has the requirements installed to actually train.

Privacy hard gate: the corpus is synthetic/self-labeled only (opaque template
pools in gen_synthetic_corpus.py); session/repo groups are never split across
train/calibration/test; no user bytes ever appear.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np

from constants import HEAD_DIMS, HEAD_LOSSES, HEAD_ORDER, SEED

TRUNK_DIM = 384
SCHEMA = "trained-heads-v1"

# Canonical head name -> corpus file-stem (the committed corpus files are named
# with the SHORT stem `cache` / `payload`, while the normative head name is
# `cacheStability` / `payloadRouting`).
HEAD_TO_FILE = {
    "semantic": "semantic",
    "dependency": "dependency",
    "contradiction": "contradiction",
    "cacheStability": "cache",
    "payloadRouting": "payload",
}

# Internal (training-only) logit-head output widths. These are NOT exported; they
# are the loss-computation accessories on top of the exported projection head.
LOGIT_N = {
    "semantic": 1,          # scalar cosine similarity (MSE)
    "dependency": 2,        # entailment / contradiction logits (BCE)
    "contradiction": 2,     # positive / negative logits (focal)
    "cacheStability": 2,    # same / different logits (contrastive)
    "payloadRouting": 4,    # semantic / exact / residual / anchor (CE)
}

ENVIRONMENTS = ("train", "calibration", "test")

# How a pair sample's joined `text` is split back into its two member texts.
PAIR_SEP = {
    "semantic": " . ",
    "dependency": " => ",
    "contradiction": " . ",
    "cacheStability": " | ",
}
# payloadRouting samples are single-text (no split).


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


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


def load_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


# ---------------------------------------------------------------------------
# Deps (torch / onnxruntime / transformers) — imported lazily so the script can
# still print a helpful report when run on a host missing the training deps.
# ---------------------------------------------------------------------------
TORCH = None
ORT = None
TF = None


def import_deps():
    global TORCH, ORT, TF
    if TORCH is not None and ORT is not None:
        return
    try:
        import torch
        import onnxruntime
        import transformers
    except Exception as exc:  # noqa: BLE001 - surface the missing-deps message.
        raise RuntimeError(
            "VC2B-2 real training requires torch, onnxruntime and transformers "
            f"(pip install -r requirements.txt). Missing/broken import: {exc}"
        ) from exc
    TORCH, ORT, TF = torch, onnxruntime, transformers


# ---------------------------------------------------------------------------
# Trunk + tokenizer
# ---------------------------------------------------------------------------
def load_tokenizer(tokenizer_json: Path):
    """Load the real BGE tokenizer from its HuggingFace tokenizer.json."""
    import_deps()
    tok = TF.PreTrainedTokenizerFast(tokenizer_file=str(tokenizer_json))
    tok.model_max_length = 512
    return tok


def load_trunk(onnx_path: Path):
    """Load the frozen bge-small trunk for CPU forwarding (never trained)."""
    import_deps()
    so = ORT.SessionOptions()
    so.graph_optimization_level = ORT.GraphOptimizationLevel.ORT_ENABLE_ALL
    sess = ORT.InferenceSession(str(onnx_path), sess_options=so,
                                providers=["CPUExecutionProvider"])
    return sess


def trunk_embed(sess, tok, text: str) -> np.ndarray:
    """Tokenize `text` with the real BGE tokenizer and forward the frozen trunk,
    returning the [1, 384] CLS-pooled sentence embedding (float32)."""
    enc = tok(
        text,
        padding="max_length",
        truncation=True,
        max_length=512,
        return_tensors="np",
    )
    feeds = {
        "input_ids": enc["input_ids"].astype(np.int64),
        "attention_mask": enc["attention_mask"].astype(np.int64),
        "token_type_ids": enc.get("token_type_ids", np.zeros_like(enc["input_ids"])).astype(np.int64),
    }
    out = sess.run(["sentence_embedding"], feeds)[0]  # [1, 384]
    return np.asarray(out, dtype=np.float32)[0]  # [384]


# ---------------------------------------------------------------------------
# Corpus -> precomputed trunk features per head.
# ---------------------------------------------------------------------------
def load_head_samples(head: str, split: str, corpus_dir: Path, sess, tok, device):
    """Load + forward one head's corpus split into torch tensors on `device`.

    Returns (features, labels): features is a tensors structure per head:
      - pair heads: (embA, embB) each [N, 384] detached float32
      - payload: emb [N, 384]
    labels:
      - semantic: [N] float (0.0/1.0 cosine target)
      - dependency: [N] long (0 entailment / 1 contradiction)
      - contradiction: [N] float (0/1)
      - cacheStability: [N] float (0 different / 1 same)
      - payloadRouting: [N] long (class index in PAYLOAD order)
    """
    torch = TORCH
    path = corpus_dir / split / f"{HEAD_TO_FILE[head]}-0.jsonl"
    rows = load_jsonl(path)
    if head == "payloadRouting":
        # Single-text classification. Label -> class index.
        cls_idx = {"semantic": 0, "exact": 1, "residual": 2, "anchor": 3}
        embs = [torch.from_numpy(trunk_embed(sess, tok, r["text"])) for r in rows]
        emb = torch.stack([e if e.dim() == 1 else e[0] for e in embs]).to(device)
        labels = torch.tensor([cls_idx[r["label"]] for r in rows], dtype=torch.long, device=device)
        return {"embs": emb}, labels

    # Pair heads.
    sep = PAIR_SEP[head]
    a_list, b_list = [], []
    labels: list[float | int] = []
    for r in rows:
        text_a, _, text_b = r["text"].partition(sep)
        a_list.append(torch.from_numpy(trunk_embed(sess, tok, text_a)))
        b_list.append(torch.from_numpy(trunk_embed(sess, tok, text_b)))
        labels.append(r["label"])
    emb_a = torch.stack([e if e.dim() == 1 else e[0] for e in a_list]).to(device)
    emb_b = torch.stack([e if e.dim() == 1 else e[0] for e in b_list]).to(device)
    if head == "dependency":
        lab = torch.tensor([0 if l == "entailment" else 1 for l in labels],
                           dtype=torch.long, device=device)
    elif head == "semantic":
        # label is 0/1 same/different -> cosine similarity target (1 for same,
        # 0 for different). dtype float.
        lab = torch.tensor([float(l) for l in labels], dtype=torch.float32, device=device)
    else:  # contradiction (0/1) + cacheStability (0/1)
        lab = torch.tensor([float(l) for l in labels], dtype=torch.float32, device=device)
    return {"embA": emb_a, "embB": emb_b}, lab


# ---------------------------------------------------------------------------
# Per-head models + losses (torch).
# ---------------------------------------------------------------------------
def build_models(torch):
    nn = torch.nn
    models = {}
    # W_h: 384 -> dim projection (exported). Loss accessories are NOT exported —
    # they are training-time logit heads only.
    for h in HEAD_ORDER:
        dim = HEAD_DIMS[h]
        models[h] = {"proj": nn.Linear(TRUNK_DIM, dim, bias=False)}
    # dependency / contradiction: concat(W(A), W(B)) -> 2 logits
    for h in ("dependency", "contradiction"):
        models[h]["classifier"] = nn.Sequential(
            nn.Linear(HEAD_DIMS[h] * 2, 64), nn.ReLU(), nn.Linear(64, LOGIT_N[h])
        )
    # cacheStability: projection is used directly with a margin contrastive loss.
    models["cacheStability"]["classifier"] = None
    # payloadRouting: proj(384->32) -> 4 logits.
    models["payloadRouting"]["classifier"] = nn.Linear(HEAD_DIMS["payloadRouting"], LOGIT_N["payloadRouting"])
    return models


# ---------------------------------------------------------------------------
# Loss helpers
# ---------------------------------------------------------------------------
def focal_binary(logits: "torch.Tensor", target: "torch.Tensor", gamma=2.0, alpha=0.25):
    """Binary focal loss over 2 logits (contradiction head). target float 0/1."""
    torch = TORCH
    log_probs = torch.nn.functional.log_softmax(logits, dim=1)
    probs = log_probs.exp()
    # positive class is index 1.
    pt = probs[:, 1]
    t = target
    # alpha_t: alpha for positives, (1-alpha) for negatives.
    alpha_t = t * alpha + (1 - t) * (1 - alpha)
    pt_t = t * pt + (1 - t) * (1 - pt)
    fl = -alpha_t * (1 - pt_t) ** gamma * (t * log_probs[:, 1] + (1 - t) * log_probs[:, 0])
    return fl.mean()


def contrastive_margin(emb_a: "torch.Tensor", emb_b: "torch.Tensor", target: "torch.Tensor",
                       margin=1.0):
    """Margin contrastive loss over projected embeddings (cacheStability head).
    target float: 1 = same (pull together), 0 = different (push apart)."""
    torch = TORCH
    d = torch.nn.functional.pairwise_distance(emb_a, emb_b, p=2)
    same = target
    diff = 1 - target
    loss = same * d.pow(2) + diff * torch.clamp(margin - d, min=0).pow(2)
    return loss.mean()


def head_loss(head: str, model: dict, feats: dict, labels: "torch.Tensor", device) -> "torch.Tensor":
    """Compute the weighted loss for one head over a batch. feats/labels are the
    batched slices; model contains proj + optional classifier."""
    torch = TORCH
    proj = model["proj"]
    if head == "semantic":
        pA = proj(feats["embA"])
        pB = proj(feats["embB"])
        cos = torch.nn.functional.cosine_similarity(pA, pB, dim=1)  # [N]
        return torch.nn.functional.mse_loss(cos, labels)
    if head == "dependency":
        pA = proj(feats["embA"])
        pB = proj(feats["embB"])
        logits = model["classifier"](torch.cat([pA, pB], dim=1))
        tgt = torch.nn.functional.one_hot(labels, num_classes=LOGIT_N["dependency"]).float()
        return torch.nn.functional.binary_cross_entropy_with_logits(logits, tgt)
    if head == "contradiction":
        pA = proj(feats["embA"])
        pB = proj(feats["embB"])
        logits = model["classifier"](torch.cat([pA, pB], dim=1))
        return focal_binary(logits, labels)
    if head == "cacheStability":
        pA = proj(feats["embA"])
        pB = proj(feats["embB"])
        return contrastive_margin(pA, pB, labels)
    if head == "payloadRouting":
        p = proj(feats["embs"])
        logits = model["classifier"](p)
        return torch.nn.functional.cross_entropy(logits, labels)
    raise ValueError(f"unknown head {head}")


# ---------------------------------------------------------------------------
# Training + evaluation
# ---------------------------------------------------------------------------
def evaluate(head: str, model: dict, feats: dict, labels: "torch.Tensor", device) -> dict:
    """Held-out metrics for the report (non-normative given the synthetic corpus;
    the normative gates live in EVALUATION.md / select.ts). Returns loss + a
    head-specific accuracy/precision proxy."""
    torch = TORCH
    with torch.no_grad():
        loss = head_loss(head, model, feats, labels, device).item()
        if head == "semantic":
            pA = model["proj"](feats["embA"]); pB = model["proj"](feats["embB"])
            cos = torch.nn.functional.cosine_similarity(pA, pB, dim=1)
            pred = (cos >= 0.5).float()
            acc = (pred == labels).float().mean().item()
        elif head == "dependency":
            pA = model["proj"](feats["embA"]); pB = model["proj"](feats["embB"])
            logits = model["classifier"](torch.cat([pA, pB], dim=1))
            pred = logits.argmax(dim=1)
            acc = (pred == labels).float().mean().item()
        elif head == "contradiction":
            pA = model["proj"](feats["embA"]); pB = model["proj"](feats["embB"])
            logits = model["classifier"](torch.cat([pA, pB], dim=1))
            pred = (logits[:, 1] >= 0).long()
            acc = (pred == labels).float().mean().item()
        elif head == "cacheStability":
            pA = model["proj"](feats["embA"]); pB = model["proj"](feats["embB"])
            d = torch.nn.functional.pairwise_distance(pA, pB, p=2)
            pred = (d < 0.5).float()
            acc = (pred == labels).float().mean().item()
        else:  # payloadRouting
            p = model["proj"](feats["embs"])
            logits = model["classifier"](p)
            acc = (logits.argmax(dim=1) == labels).float().mean().item()
    return {"loss": float(loss), "acc": float(acc)}


def batch_slices(n: int, batch: int):
    for start in range(0, n, batch):
        yield slice(start, min(start + batch, n))


def train_head(head: str, model: dict, feats: dict, labels: "torch.Tensor",
               epochs: int, batch: int, lr: float, seed: int, device):
    torch = TORCH
    params = list(model["proj"].parameters())
    if model.get("classifier") is not None:
        params += list(model["classifier"].parameters())
    opt = torch.optim.AdamW(params, lr=lr)
    n = labels.shape[0]
    g = torch.Generator(device=device).manual_seed(seed)
    indices = torch.arange(n, device=device)
    for _epoch in range(epochs):
        perm = torch.randperm(n, generator=g, device=device)
        order = indices[perm]
        running = 0.0; cnt = 0
        for sl in batch_slices(n, batch):
            idx = order[sl]
            opt.zero_grad()
            feat_slice = {}
            for k, v in feats.items():
                if isinstance(v, torch.Tensor) and v.dim() >= 2:
                    feat_slice[k] = v.index_select(0, idx)
                else:
                    feat_slice[k] = v
            lab_slice = labels.index_select(0, idx) if labels.dim() >= 1 else labels
            loss = head_loss(head, model, feat_slice, lab_slice, device)
            loss.backward()
            opt.step()
            running += loss.item() * int(idx.shape[0])
            cnt += int(idx.shape[0])
        # overall epoch loss (approx avg)
        epoch_loss = running / max(cnt, 1)
    return epoch_loss


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------
def quantize_int8(weights: np.ndarray):
    """Asymmetric per-array int8 quantization: scale=(max-min)/255, zero_point
    rounds so that dequant(0)=min. Returns (q, scale, zero_point)."""
    lo, hi = float(weights.min()), float(weights.max())
    scale = max((hi - lo) / 255.0, 1e-12)
    zero_point = int(round(-lo / scale))
    zero_point = max(-128, min(127, zero_point))
    q = np.clip(np.round(weights / scale) + zero_point, -128, 127).astype(np.int8)
    return q, scale, zero_point


def export_heads(out_dir: Path, models, corpus_digest: str, final_losses: dict) -> tuple:
    """Write the `trained-heads-v1` JSON (the exact artifact
    `loadHeadProjections` consumes) + an int8-quantized sibling."""
    out_dir.mkdir(parents=True, exist_ok=True)
    heads = {}
    int8_heads = {}
    for h in HEAD_ORDER:
        dim = HEAD_DIMS[h]
        w = models[h]["proj"].weight.detach().cpu().numpy().astype(np.float32)  # [dim, 384]
        # Row-major [dim * 384] as JSON numbers.
        heads[h] = {"dim": dim, "temperature": 1.0, "weights": w.flatten().tolist()}
        q, scale, zp = quantize_int8(w.flatten())
        int8_heads[h] = {
            "dim": dim,
            "temperature": 1.0,
            "scale": float(scale),
            "zeroPoint": int(zp),
            "weights": q.tolist(),
        }
    artifact = {
        "schema": SCHEMA,
        "seed": SEED,
        "trunkDim": TRUNK_DIM,
        "dims": {h: HEAD_DIMS[h] for h in HEAD_ORDER},
        "corpusDigest": corpus_digest,
        "losses": HEAD_LOSSES,
        "finalLosses": final_losses,
        "heads": heads,
    }
    json_path = out_dir / "trained-heads.json"
    json_path.write_text(json.dumps(artifact, separators=(",", ":")) + "\n", encoding="utf-8")
    int8_artifact = dict(artifact)
    int8_artifact["schema"] = SCHEMA + "-int8"
    int8_artifact["heads"] = int8_heads
    int8_path = out_dir / "trained-heads-int8.json"
    int8_path.write_text(json.dumps(int8_artifact, separators=(",", ":")) + "\n", encoding="utf-8")
    return json_path, int8_path


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(prog="train_heads_real.py", description=__doc__)
    ap.add_argument("--corpus-dir", default=str(here / "corpus"))
    ap.add_argument("--trunk-asset-dir", default=str(here.parent.parent / "assets" / "vector-cortex" / "encoder-v1"))
    ap.add_argument("--out", default=str(here / "build" / "vector-cortex"))
    ap.add_argument("--epochs", type=int, default=50)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--seed", type=int, default=SEED)
    args = ap.parse_args()

    corpus_dir = Path(args.corpus_dir)
    asset_dir = Path(args.trunk_asset_dir)
    out_dir = Path(args.out)

    # Guard: real training requires torch / onnxruntime / transformers.
    try:
        import_deps()
    except RuntimeError as exc:
        print(json.dumps({
            "schema": "training-report-v1", "seed": args.seed,
            "assetEmitted": False, "reason": str(exc),
        }, indent=2, sort_keys=True))
        return 1

    torch = TORCH
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    device = torch.device("cpu")

    tokenizer_path = asset_dir / "tokenizer.json"
    onnx_path = asset_dir / "model.onnx"
    if not tokenizer_path.exists() or not onnx_path.exists():
        print(json.dumps({
            "schema": "training-report-v1", "seed": args.seed, "assetEmitted": False,
            "reason": f"asset missing (tokenizer={tokenizer_path.exists()}, onnx={onnx_path.exists()})",
        }, indent=2, sort_keys=True))
        return 1

    print(f"[vc2b] loading tokenizer from {tokenizer_path}", flush=True)
    tok = load_tokenizer(tokenizer_path)
    print(f"[vc2b] loading frozen trunk from {onnx_path}", flush=True)
    sess = load_trunk(onnx_path)

    # Precompute + forward every head's train/cal/test features once (frozen).
    all_feats = {}
    all_labels = {}
    n_train = {}
    for split in ENVIRONMENTS:
        for h in HEAD_ORDER:
            feats, labels = load_head_samples(h, split, corpus_dir, sess, tok, device)
            all_feats[(h, split)] = feats
            all_labels[(h, split)] = labels
    for h in HEAD_ORDER:
        n_train[h] = int(all_labels[(h, "train")].shape[0])

    print(f"[vc2b] forward pass done; per-head train counts {n_train}", flush=True)

    models = build_models(torch)
    final_losses = {}
    for h in HEAD_ORDER:
        feats = all_feats[(h, "train")]
        labels = all_labels[(h, "train")]
        print(f"[vc2b] training head {h} (dim {HEAD_DIMS[h]}, "
              f"n={n_train[h]}, epochs={args.epochs}, batch={args.batch})", flush=True)
        ep = train_head(h, models[h], feats, labels, args.epochs, args.batch, args.lr, args.seed, device)
        final_losses[h] = round(float(ep), 6)

    # Evaluate on the held-out test split (whole-group, session never split).
    heldout = {}
    for h in HEAD_ORDER:
        feats = all_feats[(h, "test")]
        labels = all_labels[(h, "test")]
        heldout[h] = evaluate(h, models[h], feats, labels, device)
    heldout = {h: {k: round(v, 6) for k, v in vv.items()} for h, vv in heldout.items()}

    # Corpus digest over the committed corpus files (the provenance record).
    corpus_sources = {}
    for split in ENVIRONMENTS:
        for h in HEAD_ORDER:
            rel = Path(split) / f"{HEAD_TO_FILE[h]}-0.jsonl"
            data = (corpus_dir / rel).read_bytes()
            corpus_sources[str(rel)] = sha256_bytes(data)
    corpus_digest = sha256_canonical({"corpus": corpus_sources})

    json_path, int8_path = export_heads(out_dir, models, corpus_digest, final_losses)

    report = {
        "schema": "training-report-v1",
        "seed": args.seed,
        "headOrder": HEAD_ORDER,
        "dims": HEAD_DIMS,
        "losses": HEAD_LOSSES,
        "lossSum": round(sum(HEAD_LOSSES.values()), 15),
        "epochs": args.epochs,
        "batch": args.batch,
        "lr": args.lr,
        "optimizer": "AdamW",
        "finalLosses": final_losses,
        "heldOut": heldout,
        "assetEmitted": True,
        "trainedHeadsPath": str(json_path),
        "trainedHeadsInt8Path": str(int8_path),
        "trainedHeadsDigest": sha256_canonical(json.loads(json_path.read_text("utf-8"))),
        "corpusDigest": corpus_digest,
        "corpusRows": {h: n_train[h] for h in HEAD_ORDER},
        "counts": {s: {h: int(all_labels[(h, s)].shape[0]) for h in HEAD_ORDER} for s in ENVIRONMENTS},
        "totalSamples": sum(n_train.values()),
    }
    print(json.dumps(report, indent=2, sort_keys=True))
    print(f"wrote {json_path}")
    print(f"wrote {int8_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
