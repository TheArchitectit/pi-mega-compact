# ML5-B — Production bench harness (ONNX Runtime eval)

**Status:** planned | **Depends on:** ML5-A | **Phase:** ML5
**Flag:** `MEGACOMPACT_ML5_B`, defined in `src/config/vector-cortex-ml5b.ts` (sibling extract), re-exported by `vector-cortex.ts` + root `src/config.ts`, default ON; `MEGACOMPACT_ML5_B=0` disables and must be byte-identical to the ML5-A survivor (no bench endpoint exists — the harness is a developer/evidence tool with no runtime code path, and mode B continues to serve all clients exactly as before). Unlike the dashboard sprints, ML5-B introduces **no HTTP endpoint and no dashboard UI**, so there is no SETTINGS toggle and no `EXCLUDED_SETTINGS` interaction — the flag gates nothing at runtime today; it records intent and keeps the sprint's evidence assets scoped.

## Goal and inputs/outputs

**Measurement-first sprint.** ML5-B does no new training. It builds the rigorous measurement harness that answers the HG-5 headline question — *"can the trained Mode-A ONNX encoder run under the RSS budget on real hardware"* — and it hands HG-3 the measured performance data (p95 latency, steady-state marginal RSS) that drives the WASM-vs-native runtime decision in ML5-C.

`scripts/ml5/bench-onnx-prod.mjs` wraps `onnxruntime-node` (native) or `onnxruntime-web` (WASM), selectable via env `MEGACOMPACT_ENCODER_NATIVE=1` (default OFF = WASM), and measures four gates with a **fixed repeat loop and streaming tokens**:

- **p95 latency** — must be ≤ 40 ms at 512 tokens on 4 threads (`intraOpNumThreads: 4`, per the VC2 §3 finding that 2 threads misses the gate).
- **Steady-state marginal RSS** — must be ≤ 150 MiB **over the process baseline**, sampled at steady state across a ~1M-token corpus (per VC2 §3, RSS must be sampled after an explicit GC, run under `--expose-gc`; baseline subtracted so the number isolates the encoder's footprint).
- **Opset 17 handshake** — the loaded model declares `opset_import` = 17, matching what `asset.ts` enforces (per VC2 §5).
- **Determinism** — SHA-256 of the embedding output buffer must be identical across 3 runs (`maxAbsDelta = 0`, per VC2 §3).

Benchmark input comes from `scripts/ml5/bench-corpus-export.mjs`, which exports real `context_chunks` from the local SQLite store (the extension's own session chunks, redacted-tagged rows only) so the harness measures against production-shaped data — not synthetic vectors.

Bench results are emitted as structured events via `appendEvent` to the monitoring `events.log`:

- `vector_cortex_encoder_bench_p95_ms`
- `vector_cortex_encoder_bench_rss_mib`
- `vector_cortex_encoder_bench_opset_ok`
- `vector_cortex_encoder_bench_deterministic`

The dashboard and the ML5-D "Improve Cortex" surface consume these events later; ML5-B itself only writes them.

Production ownership: `scripts/ml5/bench-onnx-prod.mjs (new); scripts/ml5/bench-corpus-export.mjs (new); src/vector-cortex/encoder/bench.ts (new — TypeScript wrapper calling the bench script via child_process, consumed by dashboard + evidence); src/vector-cortex/encoder/bench-export.ts (new — formats results as BenchResultV1); src/store/backfill.ts (audit Table 1 stub 5 at :136 — the bench-corpus export exercises the real backfill path end-to-end: any streaming placeholder is either closed with a real exporter call OR registered via an inline `// guardrails-allow PREVENT-STUB-001: <closure-sprint>` annotation per the CONFORM-HYGIENE scanner contract); conformance/vector-cortex/v2/bench-heads/ (fixtures ML5-BENCH-001..004); scripts/ml5/gen-fixtures-ml5b.mjs (new generator); scripts/vector-cortex-docs-check.mjs (EXPECTED_SPRINTS 37→38); docs/vector-cortex/evidence/ML5-B.md (new)`.

Supported matrix (measured, per [vc2-model-prep](../vc2-model-prep.md) §4): `linux-x64` (validated), `darwin-arm64` (validated); `darwin-x64` and `win32-x64` are **deferred** (darwin-x64 is the HG-4 design-sprint input, not an ML5-B measurement target).

## Numbered implementation tasks

1. Add the `MEGACOMPACT_ML5_B` flag (default ON, `=0` byte-identical) in `src/config/vector-cortex-ml5b.ts` + the `vector-cortex.ts`/`src/config.ts` re-exports. `vector-cortex.ts` stays ≤ 300 (one additive re-export line). No runtime code path is gated today — the flag records intent and scopes ML5-B evidence.
2. Create `scripts/ml5/bench-corpus-export.mjs`: reads `context_chunks` (redacted-tagged rows) from the local SQLite store into a JSONL corpus file (default target ~1M tokens), so the bench harness measures against production data. Reads `<state-dir>` from the same `repoStateDir`/state-dir source the extension uses; no other data is touched. LOCAL ONLY. **This exercises the real backfill path in `src/store/backfill.ts:136`** (audit Table 1 stub 5) — if `bench-corpus-export.mjs` surfaces a streaming placeholder inside backfill, close it with a real implementation here; if it can't be closed this sprint, register it via the inline `// guardrails-allow PREVENT-STUB-001: <closure-sprint>` annotation so the CONFORM-HYGIENE scanner catches the "allow without a real closure-sprint" failure.
3. Create `scripts/ml5/bench-onnx-prod.mjs`: the qualification harness. Wraps `onnxruntime-node` (native) or `onnxruntime-web` (WASM) selected by `MEGACOMPACT_ENCODER_NATIVE` (default OFF = WASM). Fixed repeat loop, streaming tokens over the corpus; measures p95 latency (512 tokens, 4 threads), steady-state marginal RSS over process baseline (post-GC), opset 17 handshake, determinism (SHA-256 across 3 runs). Exits non-zero on any gate failure. Runs under `--expose-gc`.
4. Create `src/vector-cortex/encoder/bench-export.ts`: `BenchResultV1` — `{ timestamp, platform, encoderNative: boolean, threads, tokens, corpusTokens, p95Ms, rssMib, rssBaselineMib, rssMarginalMib, opset, deterministic, digest, gates: { latency, rss, opset, determinism, all } }`.
5. Create `src/vector-cortex/encoder/bench.ts`: a TypeScript shell that calls `scripts/ml5/bench-onnx-prod.mjs` via `child_process`, parses `BenchResultV1`, and writes the four `vector_cortex_encoder_bench_*` events via `appendEvent` to the monitoring `events.log`. This is the consumer-facing surface for the dashboard + evidence, not a runtime path.
6. Add `scripts/ml5/gen-fixtures-ml5b.mjs` emitting `ML5-BENCH-001..004`, register them + owner `ML5-B` in the v2 manifest against `schemas/ml5-fixture.schema.json` (reused unchanged from ML5-A); bump `EXPECTED_SPRINTS` 37→38 in `scripts/vector-cortex-docs-check.mjs`.
7. Add the sprint acceptance aggregator `src/vector-cortex/ml5b-acceptance.test.ts`, then evidence `ML5-B.md`: run the bench locally on the implementation machine and record the measured numbers, gates, and supported matrix in the evidence doc.

## Failure triad and independence

A p95 latency pass/fail: with a fast-enough encoder on 4 threads at 512 tokens over the corpus, the harness asserts p95 ≤ 40 ms and records PASS (fixture 501; ids below use the `ML5-BENCH-` prefix, abbreviated as `501`). B RSS pass/fail: with the encoder at steady state post-GC, the harness asserts marginal RSS over the process baseline ≤ 150 MiB and records PASS (fixture 502). C opset assertion: the loaded model's `opset_import` declares 17 and the handshake records OK (fixture 503). The determinism + end-to-end integration is pinned by fixture 504 — the full bench path (corpus export → run → events written → `BenchResultV1` digest stable) asserting identical SHA-256 across 3 runs and that all four `vector_cortex_encoder_bench_*` events reached the log. A is produced by the latency loop; B by the post-GC steady-state RSS sampler (baseline-subtracted); C purely by the opset handshake. All three use independent measurement inputs. Fixture 504 is the integration pin binding the harness to its corpus input and its event output. `MEGACOMPACT_ML5_B=0` disables the sprint's evidence assets with no runtime behavior change — mode B keeps serving. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/bench-heads/`. Schema: `schemas/ml5-fixture.schema.json` (reused from ML5-A).

- `ML5-BENCH-001: p95 latency pass/fail assertion at 512 tokens on 4 threads` — `{ kind:"bench-heads", flag:"MEGACOMPACT_ML5_B", gate:"latency", tokens:512, threads:4, budget_ms:40, assertion:"p95 <= 40" }`.
- `ML5-BENCH-002: steady-state marginal RSS pass/fail over process baseline` — `{ kind:"bench-heads", flag:"MEGACOMPACT_ML5_B", gate:"rss", budget_mib:150, baseline_subtracted:true, assertion:"marginal <= 150" }`.
- `ML5-BENCH-003: opset 17 handshake assertion` — `{ kind:"bench-heads", flag:"MEGACOMPACT_ML5_B", gate:"opset", opset:17, handshake:"ok" }`.
- `ML5-BENCH-004: determinism + end-to-end integration pin` — `{ kind:"bench-heads", flag:"MEGACOMPACT_ML5_B", gate:"determinism", runs:3, distinct_digests:1, events_written:4, integration:"corpus->bench->events->BenchResultV1" }`.

Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/ml5b-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/ml5b-acceptance.test.js
```

Expected assertions: all `ML5-BENCH-001..004` rows registered with algorithm `bench-heads` against the `ml5-fixture` schema; 501 pins the latency gate; 502 pins the RSS gate; 503 pins the opset handshake; 504 pins determinism and the end-to-end event path. The aggregator is flag-agnostic. Acceptance: no payload leakage — the bench records aggregate measurements and digests only, never chunk/message content (EVAL-REDACT-002); no network (bench + corpus export are pure local computation, PREVENT-PI-004). Apply [EVALUATION](../EVALUATION.md) annotation/power rules; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure — no schema/state changes** (corpus export reads existing `context_chunks` read-only; no new tables; `bench.ts` writes only to the monitoring `events.log`). Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); the harness emits aggregate p95/RSS/opset/determinism measurements and a corpus-level digest, never message content (EVAL-REDACT-002). Dashboard: **no changes** — `bench.ts`/`bench-export.ts` live under `src/`, not `extensions/`, so `cd extensions/dashboard-client && npm run typecheck && npm run build` is NOT required and NOT run. The bench has no HTTP endpoint; it is developer/evidence tooling plus a consumer-facing event writer.

Rollback sets `MEGACOMPACT_ML5_B=0`; no runtime path exists, so the extension is byte-identical to the ML5-A survivor and mode B continues serving — without deleting the evidence assets. The flag is scoped-only and has no `EXCLUDED_SETTINGS` involvement.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/ml5b-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all --soft-as-hard --soft-as-hard-base <PREV_TAG> --pre-commit`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, `node scripts/vector-cortex-scope-check.mjs ML5-B <COMMIT_SHA>`, `node scripts/vector-cortex-evidence-check.mjs ML5-B`, `git diff --check`. No permissive globs or warning-only scans count.

Because ML5-B is a measurement sprint, the bench itself is **run locally on the implementation machine** against the real locally-trained ONNX asset (or the committed 42-byte placeholder's opset-17 handshake where a trained asset is pending ML5-C), and the measured results — p95, marginal RSS, opset, determinism digest, and the linux-x64/darwin-arm64 validated matrix — are **recorded in `docs/vector-cortex/evidence/ML5-B.md`**. The evidence doc is the deliverable that feeds HG-5 (steady-state RSS headroom) and HG-3 (latency data for the WASM-vs-native decision in ML5-C).

`<COMMIT_SHA>` in the scope-check command is this sprint's commit. No client or dashboard server files are touched.

This sprint adds a 38th sprint file, so `EXPECTED_SPRINTS` in `scripts/vector-cortex-docs-check.mjs` is bumped from 37 to 38.
