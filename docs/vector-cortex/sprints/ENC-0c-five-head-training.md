# ENC-0c — Five-head supervision transfer on the frozen bge-small trunk

**Status:** planned | **Depends on:** ENC-0b | **Phase:** ENC
**Flag:** `MEGACOMPACT_ENC_0C`, defined in `src/config/vector-cortex-enc0c.ts` (sibling extract), re-exported by `vector-cortex.ts` + root `src/config.ts`, default ON; `MEGACOMPACT_ENC_0C=0` disables and must be byte-identical to the predecessor — no training candidates are staged, no head weights are written, and the runtime keeps serving the ENC-0b survivor (real trunk + the ENC-0b dispatch) exactly as before. Registered in `VECTOR_CORTEX_SETTINGS` as a visible boolDirect toggle, never in `EXCLUDED_SETTINGS`.

## Goal and inputs/outputs

**Train the five real heads onto the frozen bge-small trunk** (ENC-0b staged the trunk). The five `encoder-v1` heads shipped shape-only in VC2B (`semantic-384`, `contradiction-128`, `dependency-128`, `cache-stability-64`, `payload-routing-32`; see `ENCODER_HEAD_ORDER`/`ENCODER_HEAD_DIM_ORDER` in `src/vector-cortex/encoder/types.ts`) are filled with real weights via **supervision transfer** ([vc2-model-prep](../vc2-model-prep.md) §6 blocker 1). The trunk is **frozen** during head fitting — only the probe/heads train; the bge-small embeddings are the fixed input features.

The four teacher strategies, per the research brief ([vc2-model-prep](../vc2-model-prep.md) and the MODEL_ASSET five-head contract):

- **contradiction-128** ← distill the sensei `cross-encoder/nli-deberta-v3-small` deliverable spans (a teacher cross-encoder; the distilled soft labels carry the teacher's contradiction prior, never raw user content).
- **dependency-128** ← NLI entailment prior + self-labeled construction pairs (entailment/contradiction priors from the NLI family + pairs the pipeline constructs deterministically from synthetic templates — no real session dependency labels).
- **cache-stability-64** ← deterministic heuristic features, **no teacher model** (same-canonical-request-prefix hashing features per [MODEL_ASSET](../MODEL_ASSET.md) cache label; label derives from the canonical request digest, not from user payloads).
- **payload-routing-32** ← a small MLP on the trunk embedding, predicting `{semantic,exact,residual,anchor}` routing class.
- **semantic-384** ← the trunk's own CLS-pooled embedding (identity regression onto the bge-small `last_hidden_state[:,0]` pooled vector, L2-normalized).

**Corpus: SYNTHETIC / SELF-LABELED only** (the hard privacy norm). The corpus is assembled per [EVALUATION](../EVALUATION.md) §corpus and §annotation (split by repository+session; held-out test immutable) but the sources are **generated templates and self-labeled construction pairs, never real user sessions** — normative per [SECURITY_PRIVACY](../SECURITY_PRIVACY.md): "the exact ledger is **never automatically training data**". The dataset manifest records every synthetic source URI/digest/license (see [MODEL_ASSET](../MODEL_ASSET.md) Data/Labels/Losses). Loss weights follow MODEL_ASSET: semantic .35, dependency .20, contradiction .20, cache .15, payload .10; VC2B publishes class weights + seeds.

Outputs: a trained candidate head-weight artifact + updated `training/vector-cortex/dataset-manifest.json` + a heads conformance fixture set proving each head fires with real (non-constant) values over a synthetic corpus. The candidate is staged under `~/.pi/mega-compact-encoder/candidates/` (the ML5-E convention) — ENC-0d promotes it after qualification.

Production ownership: `training/vector-cortex/train_heads.py (new — five-head supervision transfer onto the frozen bge-small trunk: teacher-distill + NLI prior + heuristic cache + MLP payload + CLS semantic); training/vector-cortex/gen_synthetic_corpus.py (new — deterministic synthetic/self-labeled corpus + split, grouped by repository+session, no user bytes; writes dataset-manifest.json); training/vector-cortex/train-v1.json (extends — head loss weights, seeds, teacher config); training/vector-cortex/dataset-manifest.json (new — every synthetic source, immutable digest, SPDX, split group); src/vector-cortex/encoder/heads.ts (evolves — loads the trained head weights from a candidate manifest; flag-off keeps the ENC-0b survivor defaults byte-identical); conformance/vector-cortex/v2/encoder-heads-real/ (fixtures ENC-HEADS-001..006); docs/vector-cortex/evidence/ENC-0c.md (new)`.

## Numbered implementation tasks

1. Add the `MEGACOMPACT_ENC_0C` flag (default ON, `=0` byte-identical) in `src/config/vector-cortex-enc0c.ts` + `vector-cortex.ts`/`src/config.ts` re-exports and the `VECTOR_CORTEX_SETTINGS` boolDirect toggle in `routes-rag-settings-vector-cortex.ts` (additive). `=0` = no candidate staged, heads stay at the ENC-0b survivor.
2. Create `training/vector-cortex/gen_synthetic_corpus.py`: the deterministic synthetic corpus generator (templated contradiction/entailment/dependency pairs, cache canonical-request constructions, payload routing samples, and semantic paraphrase pairs), grouped by repository+session, seed-fixed, and split into train/calibration/test with the held-out test immutable. Writes `dataset-manifest.json` with sha256 + SPDX per source. Locally Python-only, deterministic, no network.
3. Create `training/vector-cortex/train_heads.py`: supervision transfer over the frozen bge-small trunk. Implements the four teacher strategies + the CLS semantic identity head; weighted head loss per `train-v1.json` (.35/.20/.20/.15/.10); fixed seeds; emits a **candidate** head-weight manifest under `~/.pi/mega-compact-encoder/candidates/` (never an overwrite of the shipped manifest). Phase-gated; no runtime import (training is developer tooling).
4. Extend `training/vector-cortex/train-v1.json`: encode the head loss weights, seeds, teacher config (nli-deberta-v3-small distiller), and the frozen-trunk flag.
5. Evolve `src/vector-cortex/encoder/heads.ts` (delegate-shell): load the trained head weights from a candidate manifest when `MEGACOMPACT_ENC_0C=1` and a qualified candidate exists; `=0`/absent candidate keeps the predecessor defaults byte-identical (no weight change). No `any` (PREVENT-011).
6. Add `scripts/ml5-enc/gen-fixtures.mjs` (additive) emitting `ENC-HEADS-001..006`, register them + owner `ENC-0c` in the v2 manifest against a new `schemas/encoder-heads-real-fixture.schema.json`; manifest bump is cross-cutting.
7. Add the sprint acceptance aggregator `src/vector-cortex/enc0c-acceptance.test.ts`, then evidence `ENC-0c.md` recording per-head strategy, corpus digests, seed, and the flag-off byte-identical check.

## Failure triad and independence

A trained-heads path: with `MEGACOMPACT_ENC_0C=1` and a qualified candidate, each of the five heads returns a real, non-constant embedded vector that differs across inputs (fixtures 501; ids use the `ENC-HEADS-` prefix). B flag-off: `MEGACOMPACT_ENC_0C=0` loads no candidate and each head returns the predecessor default exactly (byte-identical) (fixture 502). C teacher/quality failure: a malformed or unqualified candidate (missing head dim, non-finite weights, digest mismatch) is rejected and the runtime falls back to the ENC-0b survivor — no candidate is ever force-loaded (fixtures 503–504). Corpus purity + determinism are pinned by 505 (the synthetic corpus groups never split across boundaries and the split digest is stable) and 506 (identical sha256 over head embeddings across 3 forward passes). A is produced by the trained-weight load + forward; B purely by the flag gate; C by each named candidate-failure path. `MEGACOMPACT_ENC_0C=0` is byte-identical to the ENC-0b survivor. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/encoder-heads-real/`. Schema: `schemas/encoder-heads-real-fixture.schema.json` (new sibling).

- `ENC-HEADS-001: all five heads return real, non-constant vectors (semantic 384 / dependency 128 / contradiction 128 / cache 64 / payload 32)`.
- `ENC-HEADS-002: flag-off loads no candidate — every head byte-identical to the ENC-0b survivor`.
- `ENC-HEADS-003: missing head dim in the candidate -> rejected, fallback to survivor (no partial load)`.
- `ENC-HEADS-004: non-finite or digest-mismatched candidate -> rejected, fallback (no force-load)`.
- `ENC-HEADS-005: synthetic corpus split groups never cross train/calibration/test boundaries; split digest stable`.
- `ENC-HEADS-006: head-embedding determinism — identical sha256 across 3 forward passes (maxAbsDelta 0)`.

Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/enc0c-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/enc0c-acceptance.test.js
```

Expected assertions: all `ENC-HEADS-001..006` registered with algorithm `encoder-heads-real` against the `encoder-heads-real` schema, expected `ok`; aggregator flag-agnostic. Head unit assertions: each head's output dimension matches `ENCODER_HEAD_DIM_ORDER` (384/128/128/64/32); non-constant across a synthetic pair; candidate rejection on wrong dim / non-finite / digest mismatch; semantic head is L2-normalized float32 (MODEL_ASSET norm); flag-off bytes match the survivor. Unique failure injection: a candidate whose `contradiction-128` weight matrix is all-NaN is rejected loud and the runtime serves the survivor — never a half-initialized head. Exact flag-off comparison command:

```bash
MEGACOMPACT_ENC_0C=0 node --test dist/vector-cortex/enc0c-acceptance.test.js
```

the aggregator is flag-agnostic. Acceptance: **zero real user bytes in training** — the corpus manifest lists only synthetic sources, and a scan asserts no `stateDir` ledger path appears in any training input (SECURITY_PRIVACY §fixtures-synthetic); training is developer tooling with no runtime path (PREVENT-PI-004, local-only). Apply [EVALUATION](../EVALUATION.md) annotation/power rules; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure — no schema/state changes.** Head training writes candidate artifacts under `~/.pi/mega-compact-encoder/candidates/` and the `dataset-manifest.json`; the store schema and `stateDir` tables are untouched. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md) §fixtures-synthetic: the corpus is **synthetic/self-labeled only** — exact ledger bytes are **never automatically training data**; no real user session text, prompt, or payload enters any label; candidates live under the user's home dir and carry digests/verdicts only (EVAL-REDACT-002). Dashboard: **no changes** — training is developer/ops tooling (`training/` + `scripts/` + `src/vector-cortex/encoder/heads.ts`), not `extensions/`; `cd extensions/dashboard-client && npm run typecheck && npm run build` is NOT required and NOT run. The gate UI card that surfaces a trained-candidate verdict is the ENC-0d/ML5-D Improve-Cortex pattern — not this sprint. Rollback sets `MEGACOMPACT_ENC_0C=0`; the heads serve byte-identical to the ENC-0b survivor and no candidate is loaded, without deleting candidates or evidence. No operator migration.

## Exit evidence

Run exact project gates:

```bash
npm run build
node --test dist/vector-cortex/enc0c-acceptance.test.js
MEGACOMPACT_ENC_0C=0 node --test dist/vector-cortex/enc0c-acceptance.test.js
npm test
npm run lint
python3 scripts/regression_check.py --all
node scripts/guardrails-scan.mjs
python3 scripts/log_failure.py --list
node scripts/vector-cortex-conformance.mjs --check
node scripts/vector-cortex-docs-check.mjs
node scripts/vector-cortex-scope-check.mjs ENC-0c <COMMIT_SHA>
node scripts/vector-cortex-evidence-check.mjs ENC-0c
git diff --check
```

No permissive globs or warning-only scans count. The evidence doc `ENC-0c.md` records, per head: the teacher strategy, the synthetic-corpus digest, the seed, the trained candidate digest, and the flag-off byte-identical check. The trained weights themselves are NOT committed here — they are a candidate that ENC-0d qualifies and promotes after the RSS/p95 gate (ENC-0f). No dashboard client or server files are touched.

This sprint is one of 15 new sprint docs in the program; the single docs-check reconciliation (owned by the integration step, not by any per-sprint commit) sets `EXPECTED_SPRINTS` to **60** in `scripts/vector-cortex-docs-check.mjs` (count at integration time). Cross-cutting seam only.
