# Phase ML5 — Self-Improving Cortex (Close the Mode-A Gate)

**Status:** planned | **Depends on:** VC2C (qualification contract), PC chain (done) | **Phase:** ML5
**Flag scope:** per-sprint, default ON, `=0` byte-identical. All sprints follow the VC sprint-chain format.

## Premise

The VC2 chain shipped the **contract** (runtime, five-head encoder types, qualification logic, fallback algebra) but not the **weights**. The committed `model.onnx` is 42 bytes — a placeholder. Mode B (trigram projection) is currently serving all clients. To be a self-improving system we must:

1. **Close HG-1**: train/fit the five heads on a real trunk (BGE-small-int8-ONNX) so the learned Mode-A asset exists.
2. **Close HG-3**: run inference via ONNX Runtime at production scale — on 4 threads, p95 ≤ 40 ms, marginal RSS ≤ 150 MiB, opset 17.
3. **Close HG-4**: select a runtime strategy that covers darwin-x64 within the 80 MiB install budget.
4. **Close HG-5**: measure steady-state RSS headroom at production token counts.
5. **Build ML5-D**: make the entire think → retrain → qualify → promote loop dashboard-visible with a single **"Improve Cortex"** button that runs the pipeline locally and surfaces the result.
6. **Feed the loop** with new conversation turns as fresh training data — a nightly cron that ingests the session's own conversation history (post-redaction), rebuilds the five heads, and re-qualifies.

This is the transition from *static artifact* to *living system*: the user's own agent conversations become the training signal, calibration is re-fit, and Mode-A promotion is re-validated every week without human intervention.

## Architectural invariants (do not violate)

1. **No new runtime network calls** — every ML5 artifact is compute-local: local-training scripts, local evaluation, local packaging. PREVENT-PI-004 stays green.
2. **Flag-on ≠ behavior change** — a flag ON means a dashboard page/endpoint appears; the algorithm falls back to mode B when the asset is absent. This preserves PREVENT-PI-001/002/003.
3. **Soft-as-hard** — any touched file crossing its soft limit blocks at `deploy.sh`; every sprint uses the delegate-shell split pattern proactively (as PC-C did for `client.ts`).
4. **Five heads, five thresholds** — semantic/dependency/contradiction/cache-stability/payload-routing, each independently falling back to trigram-B when its threshold fails. This is atomic (one failed field demotes ALL of A) per VC2C §select.
5. **Deterministic training seed** — Python/NumPy/export seeded at `1729`; every run reproduces the same ONNX bytes. The weight file is a pure function of its corpus (SHA-256 stable for the same corpus).
6. **makdown of the loop** — corpus snapshot digest is written to a provenance ledger; the corpus is the training set's identity.

## Sprint chain (ML5-A → ML5-E)

| Sprint | Title | Hard gate closed | Depends |
|--------|-------|------------------|---------|
| ML5-A | Five-head training + calibration corpus build | HG-1 partial (corpus + first head trained) | VC2C |
| ML5-B | ONNX Runtime eval harness (production bench) | HG-5 (RSS headroom measured) + HG-3 partial (performance bound) | ML5-A |
| ML5-C | WASM vs native runtime decision + packaging | HG-3 (install-budget closure), HG-4 (darwin-x64 strategy) | ML5-B |
| ML5-D | Dashboard "Improve Cortex" surface + promote workflow | (dashboard, not a blocker) | ML5-C |
| ML5-E | Nightly retraining cron + feedback loop | (loop closure) | ML5-D |

### ML5-A — Training corpus + five-head fitting (python side)

This is the only sprint that can't be pure Node: the training loop is Python (`train.py`), running locally on the host where the corpus lives. It must be deterministic and runnable in a single command.

- **Corpus**: the extension's own `context_chunks` / `turns` / `conversations` SQLite tables, filtered to redacted-tagged rows only. Grouped by repo+session (from VC2C calibrate.ts) so splits are stable and reproducible.
- **Task masks**: five projections, trained jointly with the VC2B loss weights (.35/.20/.20/.15/.10) on the BGE-small-int8-ONNX trunk (frozen). The trunk is a fixed feature extractor; the heads are per-task linear projections + a temperature scalar.
- **Calibration**: each head has a fitted calibration (temperature + threshold) measured on the calibration split (held-out from the same corpus). This feeds VC2C's `CalibrationV1`.
- **Deterministic export**: `export_onnx.py --opset 17 --seed 1729` produces the same 23.5 MiB int8 ONNX + tokenizer.json on every run. SHA-256 of the output .onnx is the corpus identity.
- **Evidence**: `vector_cortex_encoder_heads_emitted` + `vector_cortex_encoder_trained` events (local log only).
- **Conformance**: `ML5-TRAIN-001..006` fixtures (corpus split invariants, deterministic export, loss weights, seed pinning, corpus digest, calibration-shape).

**Ownership**: `training/vector-cortex/{train.py,export_onnx.py,calibrate.py}; src/vector-cortex/encoder/{calibrate.ts,heads.ts,select.ts}; scripts/ml5/` (generator + bench); `conformance/vector-cortex/v2/trained-heads/` (fixtures).

### ML5-B — Production bench harness

This is measurement-first: no new training, just a rigorous measurement of the HG-5 headline question ("can we run the trained ONNX under the RSS budget on real hardware").

- **Bench harness**: `scripts/ml5/bench-onnx-prod.mjs` — wraps `onnxruntime-node` (or WASM, selectable) with a fixed repeat loop, streaming tokens, measuring:
  - p95 latency (must be ≤ 40 ms at 512 tokens on 4 threads)
  - steady-state marginal RSS (must be ≤ 150 MiB; corpus of ~1M tokens)
  - opset 17 compatibility
  - deterministic output (SHA-256 of embedding output across runs)
- **Supported matrix**: `linux-x64` (validated), `darwin-arm64` (validated), `darwin-x64` (deferred — for HG-4 design sprint only), `win32-x64` (deferred).
- **Conformance**: `ML5-BENCH-001..004` fixtures (p95 pass/fail, RSS pass/fail, opset assertion, determinism check).
- **Evidence**: bench output recorded in the events log, packaged in evidence.

**Ownership**: `scripts/ml5/bench-onnx-prod.mjs; src/vector-cortex/encoder/{bench.ts,bench-export.ts}; conformance/vector-cortex/v2/bench-heads/` (fixtures).

### ML5-C — Runtime decision + packaging

The**80 MiB install budget** vs **258 MiB onnxruntime-node** is the decisive question. This sprint makes the call and ships the winner.

- **Option W (WASM)**: `onnxruntime-web` (WASM backend via WebAssembly). ~9 MiB extra dep, pure Node, covers all Node platforms (no per-platform optionalDeps), no native compilation. Fits comfortably within 80 MiB. Downside: 4-thread WASM is slower than native CPU (typically 2×–3× slower). Must measure to hit p95 ≤ 40 ms.
- **Option N (native)**: `onnxruntime-node` with per-platform `optionalDependencies` split. Higher absolute performance (native CPU) but install size ≥ 100 MiB once you include ≥ 3 platforms. Might exceed budget unless budget is amended to ~120–150 MiB.
- **Option H (hybrid)**: use WASM for correctness when native is unavailable, use native when it is. Requires both packages, defeating the budget.

**Decision rule**: WASM **if** the measured p95 at 512 tokens on 4 threads is ≤ 40 ms on `linux-x64`, **else** native (with budget amendment). darwin-x64 is out-of-scope per HG-1's deferral.

- **Conformance**: `ML5-RUNTIME-001..005` fixtures (budget compliance, per-platform install, opset 17 handshake, stub fallback when WASM missing).
- **Dashboard**: no UI change (decision is in config); the seller is emitted as a `vector_cortex_runtime_selected` event.

**Ownership**: `src/vector-cortex/encoder/{runtime.ts,runtime-wasm.ts,runtime-native.ts,select.ts}; package.json` (optionalDependencies split); `scripts/ml5/package-assets.mjs; conformance/vector-cortex/v2/runtime-choice/` (fixtures); `extensions/dashboard-server/routes-vector-cortex.ts` (event reader).

### ML5-D — Dashboard "Improve Cortex" surface

The user-facing close: the dashboard's Vector Cortex tab already has a health card; this sprint adds a **"Model Improvement"** sub-panel with a single **"Improve"** button.

- **Reads**: `encoderAssetDigest`, `encoderMode`, current `QualificationV1` verdict, bench history (the 5 most recent `ML5-BENCH-*` events), the "Improve Cortex" action endpoint, and the last promotion timestamp.
- **Actions**:
  - `POST /api/cortex/improve` — local-only, confirms via a modal (`window.confirm`). Runs the training pipeline (ML5-A) using the latest local corpus, gent in a background job, and returns a `{ status:"improving", jobId }`.
  - `GET /api/cortex/improve/status/:jobId` — pollable, returns progress and eventually `{ status:"qualified", verdict, assetDigest }` or `{ status:"demoted_to_B", reason }`.
- **Outputs**: a new **ModelImprovementCard** in VectorCortexTab showing current mode, last bench run, latest qualification verdict, and the Promoted/Rejected badge.
- **Conformance**: `ML5-DASH-001..006` fixtures (card render, modal confirm, improve trigger, status endpoint, mode badge, state transition).
- **Deployment story**: the `onnxruntime-web` WASM footprint is budget-safe, so the "Improve" never needs a native install; works on any device with `pi` + WASM runtime. The `onnxruntime-node` path is attempted only when the user explicitly opts into native (`MEGACOMPACT_ENCODER_NATIVE=1`, default OFF).

**Ownership**: `extensions/dashboard-server/routes-cortex-improve.ts; extensions/dashboard-server/api-contracts/cortex-improve.ts; extensions/dashboard-client/src/components/ModelImprovementCard.tsx; extensions/dashboard-client/src/tabs/VectorCortexTab.tsx; extensions/dashboard-server/route-dispatch.ts; src/config/vector-cortex-ml5d.ts; conformance/vector-cortex/v2/cortex-improve/` (fixtures).

### ML5-E — Nightly retraining cron + feedback loop

This turns one-shot training into a living loop. A cron job daily at 2am (Europe/London hard-coded, the operator's local time) — the system self-improves while the user sleeps.

- **Trigger**: cron `0 2 * * *` (system-level, configured via `crontab -e` on the operator's device, never in the extension).
- **Corpus refresh**: re-exports the corpus snapshot (new sessions since last run → `corpus-digest` check). If no new rows, no-op exit 0.
- **Training**: `scripts/ml5/retrain-nightly.mjs` — an orchestrator calling ML5-A train + ML5-B bench + ML5-C package.
- **Promotion**: only if **all five heads** pass per-head calibration thresholds **and** the new asset beats the currently-committed asset on **held-out evaluation** (a fixed dev set, never from training data). Otherwise stays in mode B and records a "demoted new asset" event.
- **Rollback**: if the newly-promoted asset is later found to regress (a new calibration run at week N+1 scores worse), the prior week's asset is restored. The rollback is atomic via manifest digest swap (no partial state).
- **Guardrails**:
  - Every new asset is a NEW `manifest.json` entry, never an over-write. The manifest is append-only; a prior asset can be restored by SHA-256 in O(1).
  - The cron NEVER commits or pushes — it only writes candidate assets to `~/.pi/mega-compact-encoder/candidates/`. The human operator reviews the dashboard and promotes via the above "Improve Cortex" flow.
  - This is a **local** computer-bound workload, no network.

**Ownership**: `scripts/ml5/retrain-nightly.mjs; scripts/ml5/promotion-gate.mjs; src/vector-cortex/encoder/promotion.ts; conformance/vector-cortex/v2/nightly-retrain/` (fixtures); `scripts/ml5/crontab.example` (documentation).

## Conformance fixtures — ML5 reserved range

`ML5-000..099` — across the sprints:

| Range | Owner | Fixtures |
|-------|-------|----------|
| ML5-TRAIN-001..006 | ML5-A | corpus invariants, deterministic export, calibration shape, loss weights, seed pinning, corpus digest |
| ML5-BENCH-001..004 | ML5-B | p95 pass/fail, RSS pass/fail, opset assertion, determinism check |
| ML5-RUNTIME-001..005 | ML5-C | budget compliance, per-platform install, opset 17 handshake, stub fallback, native fallback |
| ML5-DASH-001..006 | ML5-D | card render, modal confirm, improve trigger, status endpoint, mode badge, state transition |
| ML5-LOOP-001..004 | ML5-E | corpus-digest no-op exit, training run recording, promotion-gate criterion, rollback digest-swap |

Conformance root: `conformance/vector-cortex/v2/ml5/`; schema `schemas/ml5-fixture.schema.json` (new for ML5-A).

## Exit evidence

Every sprint runs the mandatory VC/PC chain gates (`npm run build`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, guardrails, conformance, docs-check, evidence-check, scope-check, diff-check). Dashboard sprints additionally run `cd extensions/dashboard-client && npm run typecheck && npm run build`. The ML5-E workbook field addition is `crontab -e` documentation + the promoted-by-dashboard workflow verified end-to-end on the operator's device.

## Note on the already-installed onnxruntime

You wrote: *"I installed the onnxruntime but I might need a reboot."* If onnxruntime-node requires a postinstall native build step that's currently failing (the usual macOS or pnpm/pNPM issue), ML5-A's Python training scripts don't depend on it — they run under PyTorch / `optimum[onnxruntime]` and produce `.onnx` artifacts. The runtime decision (ML5-C) is where onnxruntime-node vs -web vs -packaging gets decided. Training can begin immediately on Python even with the runtime package pending.

If the reboot is needed for onnxruntime-node to resolve `ERR_MODULE_NOT_FOUND` in the existing project root, that's a local environment issue; we've seen this when a peer-dependency or pNPM workspace link gets in a bad state. It's NOT a design blocker.
