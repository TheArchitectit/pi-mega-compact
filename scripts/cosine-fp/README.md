# cosine-fp — synthetic L2 cosine FP harness (COS-FP-A)

Deterministic, synthetic-corpus-only harness that empirically validates the L2
cosine dedup threshold. It measures false-positive / false-negative rates across
a candidate threshold grid on a **synthetic** corpus (code / prose / mixed) with
known ground-truth labels, and emits a recommended default. It never reads,
embeds, or ships any real session/ledger bytes (EVAL-REDACT-002).

## Why

`DedupConfig.L2_COSINE` is today a fixed `0.85` (from `MEGACOMPACT_L2_THRESHOLD`).
This sprint builds the pragmatic, synthetic half of validating that constant:
a harness that produces an evidence-backed recommendation instead of an
unvalidated number. The real-corpus half (100+ donated sessions) is the sibling
`COS-FP-R` sprint, which ships its own harness and runs when a consented corpus
exists.

## Usage

```bash
# Full grid sweep + emit the report (deterministic for a fixed seed).
node scripts/cosine-fp/bench.mjs
# Override the corpus seed (default 20260806).
MEGACOMPACT_COSINE_FP_SEED=20260806 node scripts/cosine-fp/bench.mjs
# Force the no-fabrication `no_data` early return (A/B/C triad testing).
node scripts/cosine-fp/bench.mjs --empty
# Flag-off: harness inert, no report emission, endpoint 404s.
MEGACOMPACT_COSINE_FP_BENCH=0 node scripts/cosine-fp/bench.mjs
# Regenerate conformance fixtures (COS-FP-A-001..005) + manifest rows.
node scripts/cosine-fp/gen-fixtures.mjs
```

Outputs:
- `scripts/cosine-fp/bench-run/cosine-fp-report.json` — canonical aggregate
  (grid sweep, per-content-type FP/FN/F1, recommendation, digests). This is what
  `GET /api/cosine-fp-report` serves. Same seed + params → identical digest.
- `docs/vector-cortex/cosine-threshold-report.md` — the human-readable eval
  report (append-only relative to COS-FP-R).

## Ground truth

Each corpus item carries a `label` (`dup` / `near` / `clean`) and a `canonId`.
- `dup` — exact or template-permutation duplicate of a canon.
- `near` — controlled perturbation (comment / identifier / word changes).
- `clean` — unique singleton.

The bench scores every unique pair's cosine and labels it per threshold:
`deduped` when cosine `>=` threshold, `passed` otherwise (exact `<` vs `>=`,
off-by-one pinned by fixture COS-FP-A-004). FP = non-dup pair deduped; FN = dup
pair passed.

## Determinism

Corpus RNG is mulberry32 seeded from `MEGACOMPACT_COSINE_FP_SEED` (default
20260806). Embedding is the shipped deterministic trigram embedder reimplemented
here (no runtime dep). Same seed + params → identical report digest (pinned by
fixture COS-FP-A-002).

## Extending

Add a content type by teaching `corpus.mjs` a new template generator and adding
it to the `types` list in `bench.mjs` `evaluate`). Keep the generator
deterministic for a given seed and never read real bytes.
