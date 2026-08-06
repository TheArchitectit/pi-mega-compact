# Phase ENC — Real Learned Encoder (Ship Mode A)

**Status:** planned | **Depends on:** ML5 chain (shipped v0.20.36–v0.20.41), encoder-placeholder surface | **Phase:** ENC
**Flag scope:** per-sprint `MEGACOMPACT_ENC_0A..0F`, default ON, `=0` byte-identical. All sprints follow the VC sprint-chain format; all six flags are additive re-exports in `src/config/vector-cortex.ts` + `src/config.ts` and registered in `VECTOR_CORTEX_SETTINGS` as boolDirect toggles, never in `EXCLUDED_SETTINGS`.

## Premise

The VC2 chain shipped the **contract** and the ML5 chain shipped the **training/bench/promote scaffolding**, but the learned encoder still runs as a placeholder: the committed `model.onnx` is 42 bytes (`encoder-v1-placeholder`), and `src/vector-cortex/encoder/runtime.ts:269` serves the LCG `projectSemantic` stub with `benchRecord: null` at `runtime.ts:222`. ML5 closed the structural loop but never closed the **weights**. ENC is the close: replace the placeholder with a REAL BGE-small int8 ONNX asset, fit the real five heads onto it, gate promotion on the measured p95/RSS, and surface the darwin-x64 demotion to operators.

The four open gates HG-1 (five-head training), HG-3 (install budget), HG-4 (darwin-x64), HG-5 (RSS/p95) are closed by this phase, in order: ENC-0a picks the backend and opset baseline (HG-3 decision + budget math); ENC-0b fetches the real trunk and wires the ONNX session (HG-1 groundwork); ENC-0c trains the five heads by supervision transfer (HG-1 close); ENC-0d turns the promotion gate into the real-asset promotion path; ENC-0e surfaces the darwin-x64 demotion (HG-4 close); ENC-0f runs the real-asset qualification gate (HG-5 close).

This is the single substantive track in the deferred/stub audit program: every other phase addresses docs or UI drift.

## Architectural invariants (do not violate)

1. **No new runtime network calls** — training/fetch/gating all run as developer tooling on the host that owns the corpus. The shipped extension performs zero network at runtime. PREVENT-PI-004 stays green; the only PREVENT-PI-004-tolerant code is the release-time fetch script (`scripts/encoder/fetch-bge-model.sh`), `// guardrails-allow PREVENT-PI-004: release-time developer tooling, not extension runtime` annotated, never imported by `src/`.
2. **Flag-on ≠ behavior change for absent assets** — every ENC flag defaults to the ENC-0b predecessor's path when the real asset is missing or unqualified. Runtime demotion to mode B is the byte-identical fallback.
3. **Soft-as-hard** — any touched file crossing its soft limit blocks at `deploy.sh`; every sprint uses the delegate-shell split proactively. `runtime.ts` splits into `runtime.ts` + `onnx.ts`; `promotion.ts` splits into `promotion.ts` + `promotion-rollback.ts` + `promotion-emit.ts`.
4. **Five heads, five thresholds** — semantic/dependency/contradiction/cache-stability/payload-routing, each independently falls back to mode B (trigram projection) when its threshold fails. Atomic demotion per VC2C §select.
5. **Deterministic training seed and digest pinning** — every trained/fetched asset carries a SHA-256 digest; the digest pinned in ENC-0a's decision record is authoritative; staged-byte verification happens before any atomic swap (ENC-0d).
6. **Privacy norm** — the training corpus is synthetic/self-labeled only. The exact ledger is never automatically training data; the corpus generator is the only legal ingestion path.

## Sprint chain (ENC-0a → ENC-0f)

| Sprint | Title | Hard gate closed | Depends |
|--------|-------|------------------|---------|
| ENC-0a | Backend decision: transformers.js vs onnxruntime-node | HG-3 (budget decision + opset re-baseline 17→21) | vc2-model-prep |
| ENC-0b | Real trunk fetch + gated ONNX inference path | HG-3 (install), HG-1 (real trunk live) | ENC-0a |
| ENC-0c | Five-head supervision transfer on frozen trunk | HG-1 (real weights) | ENC-0b |
| ENC-0d | Promotion gate over real trained assets + atomic swap | (no HG; closes the promotion loop for real assets) | ENC-0c |
| ENC-0e | darwin-x64 explicit demotion + Setup card reason | HG-4 (operator visibility) | ENC-0b |
| ENC-0f | RSS/p95 qualification budget gate on real trained asset | HG-5 (measured close) | ENC-0d |

### ENC-0a — Backend decision record

Locks the runtime backend, the per-platform install-size matrix, the opset baseline, and the license/pinning audit in a durable decision record produced deterministically by `scripts/encoder/resolve-backend-decision.mjs`. Records opset 21 (not 17), the 80 MiB budget, the transformers.js/WASM leading candidate vs the 258 MiB onnxruntime-node failing case, and the darwin-x64 `demotion:"wasm"` platform row. Output: `docs/vector-cortex/encoder-backend-decision.md`. No UI touch.

**Ownership:** `docs/vector-cortex/encoder-backend-decision.md; scripts/encoder/resolve-backend-decision.mjs; src/vector-cortex/encoder/decision.ts; src/config/vector-cortex-enc0a.ts; conformance/vector-cortex/v2/encoder-decision/; scripts/ml5-enc/gen-fixtures.mjs; docs/vector-cortex/evidence/ENC-0a.md`.

### ENC-0b — Real trunk fetch + gated inference

Acquires the BGE-small int8 ONNX encoder at release time into `assets/vector-cortex/encoder-v1/` (publisher-side fetch, sha256-pinned, modeled on `scripts/vc2-model-prep/fetch-model.sh`); wires a real ONNX `InferenceSession` at `src/vector-cortex/encoder/runtime.ts:269` behind `MEGACOMPACT_ENC_0B`. The LCG stub remains the flag-off byte-identical fallback. Manifest re-versioned `encoder-v1-placeholder` → `encoder-v1`; `ENCODER_OPSET` re-baselined 17→21. No UI touch.

**Ownership:** `assets/vector-cortex/encoder-v1/{model.onnx,tokenizer.json,manifest.json,model-card.json}; src/vector-cortex/encoder/{types.ts,onnx.ts,runtime.ts}; scripts/encoder/fetch-bge-model.sh; scripts/encoder/verify-staged-asset.mjs; conformance/vector-cortex/v2/encoder-trunk/; scripts/ml5-enc/gen-fixtures.mjs; docs/vector-cortex/evidence/ENC-0b.md`.

### ENC-0c — Five-head supervision transfer

Trains the five real heads by supervision transfer onto the frozen trunk: contradiction distill from `cross-encoder/nli-deberta-v3-small`; dependency NLI prior + self-labeled pairs; cache-stability deterministic heuristic features (no teacher); payload-routing MLP; semantic = frozen trunk CLS. Corpus is synthetic/self-labeled only — no user bytes. Loss weights `.35/.20/.20/.15/.10`. Output staged under `~/.pi/mega-compact-encoder/candidates/`; ENC-0d promotes.

**Ownership:** `training/vector-cortex/{train_heads.py,gen_synthetic_corpus.py,train-v1.json,dataset-manifest.json}; src/vector-cortex/encoder/heads.ts; conformance/vector-cortex/v2/encoder-heads-real/; scripts/ml5-enc/gen-fixtures.mjs; docs/vector-cortex/evidence/ENC-0c.md`.

### ENC-0d — Promotion gate over real trained assets

`scripts/ml5/promotion-gate.mjs` evolves to digest-verify every staged byte (trunk ONNX + tokenizer + 5 head weights) against the candidate manifest, then perform an atomic swap (write-temp-then-rename) of the shipped manifest to the candidate on a green qualification. Emits `vector_cortex_asset_promoted` / `vector_cortex_asset_demoted` / `vector_cortex_asset_rollback_back` JSON lines. Append-only manifest; rollback to previous `assetDigestStack` entry in O(1) by sha256. No UI touch.

**Ownership:** `scripts/ml5/promotion-gate.mjs; src/vector-cortex/encoder/{promotion.ts,promotion-rollback.ts,promotion-emit.ts}; conformance/vector-cortex/v2/encoder-promotion/; scripts/ml5-enc/gen-fixtures.mjs; docs/vector-cortex/evidence/ENC-0d.md`.

### ENC-0e — darwin-x64 explicit demotion + Setup card

Surfaces the ENC-0a darwin-x64 `demotion:"wasm"` platform row as a runtime-selection event reason and renders it on the existing `CortexBlockersCard` under `GET /api/setup-cortex-status` (additive `darwinX64:{demoted,reason?}` field). Platform-injected tests (no real Mac). **UI touch** — runs the dashboard-client gate (`cd extensions/dashboard-client && npm run typecheck && npm run build`).

**Ownership:** `src/vector-cortex/encoder/{runtime-select.ts,runtime-select.test.ts,decision.ts,runtime-emit.ts}; extensions/dashboard-server/{setup-cortex-blockers.ts,api-contracts/setup-cortex.ts}; extensions/dashboard-client/src/tabs/SetupTab/CortexBlockersCard.tsx; conformance/vector-cortex/v2/encoder-demotion/; scripts/ml5-enc/gen-fixtures.mjs; docs/vector-cortex/evidence/ENC-0e.md`.

### ENC-0f — RSS/p95 qualification budget gate

Runs the real trained asset through `scripts/ml5/bench-onnx-prod.mjs` under `--expose-gc`, gates on p95 ≤ 40 ms at 512 tokens / 4 threads and marginal RSS ≤ `ENCODER_RSS_BUDGET_BYTES` (150 MiB, baseline-subtracted), and emits `QualificationV1` (`vector_cortex_encoder_qualified` / `_qualification_failed`) via `src/vector-cortex/encoder/qualify.ts`. On pass the runtime flips to qualified mode A. No UI touch.

**Ownership:** `scripts/encoder/gate-qualify.mjs; scripts/ml5/bench-onnx-prod.mjs; src/vector-cortex/encoder/{qualify.ts,qualify.test.ts}; conformance/vector-cortex/v2/encoder-budget/; scripts/ml5-enc/gen-fixtures.mjs; docs/vector-cortex/evidence/ENC-0f.md`.

## Conformance fixtures — ENC reserved families

Six algorithm families, six fixtures each (`001..006`):

| Family | Owner | Purpose |
|--------|-------|---------|
| `encoder-decision` | ENC-0a | budget-viable WASM / budget-amended native / opset-21 pinning / platform matrix completeness / sha256 bench guard / vc2-model-prep degradation |
| `encoder-trunk` | ENC-0b | ONNX session + opset-21 handshake / flag-off LCG byte-identity / digest-mismatch demote / opset mismatch / real determinism / re-version pinning |
| `encoder-heads-real` | ENC-0c | all five heads non-constant / flag-off survivor byte-identity / dim-missing reject / non-finite reject / corpus split-group integrity / head determinism |
| `encoder-promotion` | ENC-0d | green atomic swap / red demotion / staged-byte sha256 fail / head digest fail / rollback O(1) / flag-off |
| `encoder-demotion` | ENC-0e | darwin-x64 reason on event / linux-arm64 control / flag-off surface strip / status payload darwinX64 / additive contract validation |
| `encoder-budget` | ENC-0f | p95+RSS+determinism all-gates-mode-A / latency breach / RSS breach / determinism+opset pin / fabricated-p95 reject / flag-off |

Conformance root: `conformance/vector-cortex/v2/{encoder-decision,encoder-trunk,encoder-heads-real,encoder-promotion,encoder-demotion,encoder-budget}/`; schemas are siblings under `schemas/encoder-{decision,trunk,heads-real,promotion,demotion,budget}-fixture.schema.json`.

## Exit evidence

Every ENC sprint runs the mandatory gates (`npm run build`; acceptance aggregator flag-on + flag-off; `npm test`; `npm run lint`; `python3 scripts/regression_check.py --all --soft-as-hard --soft-as-hard-base <PREV_TAG> --pre-commit`; `node scripts/guardrails-scan.mjs`; `python3 scripts/log_failure.py --list`; conformance + docs-check; scope-check; evidence-check; `git diff --check`). ENC-0e additionally runs the dashboard-client gate AND the **mandatory live Playwright validation**: the `CortexBlockersCard` darwin-x64 demotion row must render live on the dashboard with zero console errors before evidence acceptance. If no reachable dashboard host exists (default `http://localhost:9320`), the sprint pauses at implementer-complete until one is available. ENC's mode-A runtime acceptance is measured at the gate; ENC-0e's card render is exercised in a live browser.
