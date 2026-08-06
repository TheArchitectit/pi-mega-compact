"""vector-cortex training package (VC2B + ML5-A).

Developer tooling only — never imported by runtime `src/` (which stays
pi-agnostic and dependency-free). Contains the offline multi-head training
(`train.py`, with `--generate-fixtures` deterministic synthetic corpus), ONNX
export (`export_onnx.py`), calibration fitting (`calibrate.py`), the shared
loss/seed constants (`constants.py`), and the model-card / dataset-manifest
provenance records. All deterministic, seeded 1729, zero network.
"""
