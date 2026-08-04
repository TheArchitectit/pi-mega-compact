"""VC2B normative training constants (single source of truth for the training
toolchain). These mirror `src/vector-cortex/encoder/types.ts`:

  * five heads in stable order with dimensions 384/128/128/64/32;
  * weighted losses .35/.20/.20/.15/.10 (exactly, sum == 1.0);
  * seed 1729 shared by Python/NumPy training AND the ONNX export.

Developer tooling only — zero network (PREVENT-PI-004 is enforced by the
already-shipped runtime; this script package only ever touches local files).
"""

HEAD_ORDER = [
    "semantic",
    "dependency",
    "contradiction",
    "cacheStability",
    "payloadRouting",
]

HEAD_DIMS = {
    "semantic": 384,
    "dependency": 128,
    "contradiction": 128,
    "cacheStability": 64,
    "payloadRouting": 32,
}

# Weighted training losses per head (MODEL_ASSET income):
# semantic cosine/MSE .35, dependency BCE .20, contradiction focal .20,
# cache contrastive .15, payload cross-entropy .10. Exactly these values.
HEAD_LOSSES = {
    "semantic": 0.35,
    "dependency": 0.20,
    "contradiction": 0.20,
    "cacheStability": 0.15,
    "payloadRouting": 0.10,
}

# The five losses must sum to exactly 1.0.
assert abs(sum(HEAD_LOSSES.values()) - 1.0) < 1e-12, "head losses must sum to 1.0"

# Shared deterministic seed: Python/NumPy training AND ONNX export.
SEED = 1729
