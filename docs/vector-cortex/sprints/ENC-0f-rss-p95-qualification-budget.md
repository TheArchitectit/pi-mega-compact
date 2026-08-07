# ENC-0f — Real-asset qualification: p95 + marginal-RSS budget

**Status:** planned | **Depends on:** ENC-0d | **Phase:** ENC
**Flag:** `MEGACOMPACT_ENC_0F`, defined in `src/config/vector-cortex-enc0f.ts` (sibling extract), re-exported by `vector-cortex.ts` + root `src/config.ts`, default ON; `MEGACOMPACT_ENC_0F=0` disables and must be byte-identical to the predecessor — no qualification gate runs, no `QualificationV1` record is written for the real trained asset, and the runtime keeps serving the ENC-0d survivor (mode B trigram unless a prior qualified asset is already live). Registered in `VECTOR_CORTEX_SETTINGS` as a visible boolDirect toggle, never in `EXCLUDED_SETTINGS`.

## Goal and inputs/outputs

**The qualification gate that admits the real trained asset to mode A.** ML5-A/B/C built the bench harness (`scripts/ml5/bench-onnx-prod.mjs`) and the placeholder-qualification skeleton; this sprint runs the **real** gate against the ENC-0c trained asset (promoted by ENC-0d): **p95 latency ≤ 40 ms at 512 tokens on 4 threads** and **steady-state marginal RSS ≤ `ENCODER_RSS_BUDGET_BYTES`** (150 MiB, the encoder's INCREMENTAL footprint over the process baseline per the `runtime.ts` Q01 accounting — NOT whole-process RSS), determinism `≤ 1e-6` over repeats, and the opset-21 handshake. On pass the gate emits a `QualificationV1` record (`vector_cortex_encoder_qualified`) that flips the runtime to qualified mode A; on any failure it writes `vector_cortex_encoder_qualification_failed` and the asset stays demoted to mode B. This is the close of the VC2 ML gate's HG-5 (RSS margin) with a real asset.

The gate re-uses the ML5-B bench (`scripts/ml5/bench-onnx-prod.mjs`, already exists) extended additively for the real trained asset, and wraps it in a new deterministic `scripts/encoder/gate-qualify.mjs` that emits the qualification verdict + events. Fixtures live in `conformance/vector-cortex/v2/encoder-budget/`. The marginal-footprint accounting reuses `ENCODER_RSS_BUDGET_BYTES` and `ENCODER_LATENCY_P95_MS` (both already defined in `src/vector-cortex/encoder/types.ts` and enforced at `runtime.ts` load/infer).

Production ownership: `scripts/encoder/gate-qualify.mjs`; `scripts/ml5/bench-onnx-prod.mjs`; `src/vector-cortex/encoder/qualify.ts`; `src/vector-cortex/encoder/qualify.test.ts`; `src/config/vector-cortex-enc0f.ts`; `src/config/vector-cortex.ts`; `src/config.ts`; `scripts/ml5-enc/gen-fixtures.mjs`; `src/vector-cortex/enc0f-acceptance.test.ts`; `conformance/vector-cortex/v2/encoder-budget/*`; `conformance/vector-cortex/v2/schemas/encoder-budget-fixture.schema.json`; `conformance/vector-cortex/v2/manifest.json`; `docs/vector-cortex/evidence/ENC-0f.md`; `docs/vector-cortex/sprints/ENC-0f-rss-p95-qualification-budget.md (this file)`. Notes: gate-qualify.mjs runs the real trained asset through the bench under `--expose-gc` and emits QualificationV1 + the two events; bench-onnx-prod.mjs evolves additively for a real trained asset path, keeping the existing WASM and native bench selection; qualify.ts is the pure QualificationV1 construction from the bench result (p95 at or under 40 ms, marginal RSS at or under ENCODER_RSS_BUDGET_BYTES, determinism, opset 21, all-gates); the flag sibling vector-cortex-enc0f.ts and the two barrel re-exports mirror the ENC-0e slice; the generator gains a sixth additive block, algorithm `encoder-budget`, schema `schemas/encoder-budget-fixture.schema.json`; the v2 manifest registration bump is cross-cutting.

## Numbered implementation tasks

1. Add the `MEGACOMPACT_ENC_0F` flag (default ON, `=0` byte-identical) in `src/config/vector-cortex-enc0f.ts` + `vector-cortex.ts`/`src/config.ts` re-exports and the `VECTOR_CORTEX_SETTINGS` boolDirect toggle in `routes-rag-settings-vector-cortex.ts` (additive). `=0` = no qualification gate runs, no `QualificationV1` written.
2. Create `src/vector-cortex/encoder/qualify.ts`: `qualifyEncodedAsset(bench: BenchResultV1, platform): QualificationV1` — pure function asserting `p95Ms <= ENCODER_LATENCY_P95_MS` (40), `rssMarginalMib <= ENCODER_RSS_BUDGET_BYTES/1024/1024` (150), `deterministic` (distinct digests == 1), `opset == 21`; emits `{ schema:"qualification-v1", verdict:"qualified"|"failed", reasons:string[], platform, p95Ms, rssMib, opset }`. No `any` (PREVENT-011).
3. Extend `scripts/ml5/bench-onnx-prod.mjs` additively: accept the real trained asset path + fixed `512` tokens / `4` threads / `intraOpNumThreads:4`; run under `--expose-gc`, sample marginal RSS post-GC over a ~1M-token corpus (the ML5-B steady-state method). Keep the existing WASM/native selection.
4. Create `scripts/encoder/gate-qualify.mjs`: the qualification wrapper — runs the bench over the ENC-0d-promoted asset, feeds `BenchResultV1` to `qualify.ts`, writes `QualificationV1`, emits `vector_cortex_encoder_qualified` (or `vector_cortex_encoder_qualification_failed` with the failing gate). Exits non-zero on any gate failure. LOCAL ONLY, zero network (PREVENT-PI-004). Flag-off → exit 0, no record, no events (byte-identical).
5. Add `scripts/ml5-enc/gen-fixtures.mjs` (additive) emitting `ENC-BUDG-001..006`, register them + owner `ENC-0f` in the v2 manifest against a new `schemas/encoder-budget-fixture.schema.json`; manifest bump is cross-cutting.
6. Add the sprint acceptance aggregator `src/vector-cortex/enc0f-acceptance.test.ts`, then evidence `ENC-0f.md` recording the measured p95/marginal-RSS/determinism/opset for the real trained asset and the resulting verdict.

## Failure triad and independence

A qualified mode A: with the real trained asset meeting p95 ≤ 40 ms @ 512/4 threads and marginal RSS ≤ 150 MiB (post-GC, baseline-subtracted) and determinism 0-delta and opset 21, `qualify.ts` returns `verdict:"qualified"` and the runtime serves mode A (fixtures 501; ids use the `ENC-BUDG-` prefix). B p95 breach: p95 > 40 ms at 512/4 threads → `verdict:"failed"`, reason `latency`, mode B stays (fixture 502). C marginal-RSS breach: marginal RSS > `ENCODER_RSS_BUDGET_BYTES` → `verdict:"failed"`, reason `rss`, mode B stays (fixture 503). Determinism + opset + end-to-end are pinned by 504–506: 504 asserts identical sha256 across 3 runs (`maxAbsDelta` 0) and the opset-21 handshake; 505 asserts a `distinct_digests != 1` bench fails qualification; 506 pins flag-off (no record, no events, byte-identical). A is produced by the all-gates-pass branch; B purely by the latency gate; C purely by the marginal-RSS gate; the three gates use independent measurement inputs. `MEGACOMPACT_ENC_0F=0` is byte-identical to the ENC-0d survivor. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/encoder-budget/`. Schema: `schemas/encoder-budget-fixture.schema.json` (new sibling).

- `ENC-BUDG-001: p95<=40 @ 512/4 + marginal RSS<=150 + deterministic + opset 21 -> qualified mode A`.
- `ENC-BUDG-002: p95>40 @ 512/4 -> failed (latency), mode B stays`.
- `ENC-BUDG-003: marginal RSS > ENCODER_RSS_BUDGET_BYTES -> failed (rss), mode B stays`.
- `ENC-BUDG-004: determinism — identical sha256 over 3 runs + opset-21 handshake`.
- `ENC-BUDG-005: distinct_digests != 1 bench -> qualification failed (determinism)`.
- `ENC-BUDG-006: flag-off -> no QualificationV1 written, no events, byte-identical predecessor`.

Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/enc0f-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/enc0f-acceptance.test.js
```

Expected assertions: all `ENC-BUDG-001..006` registered with algorithm `encoder-budget` against the `encoder-budget` schema, expected `ok`; aggregator flag-agnostic. qualify.ts unit assertions (pure-fn): the verdict matrix over synthetic BenchResultV1 inputs (latency/rss/determinism/opset each independently failing flips the verdict); thresholds sourced from `ENCODER_LATENCY_P95_MS` + `ENCODER_RSS_BUDGET_BYTES` (no magic numbers); `schema:"qualification-v1"` with `reasons:[]` when passed. Unique failure injection: a bench with `gates.all:false` AND a fabricated sub-40ms p95 must STILL fail qualification (a gated-off bench can never be swept into mode A by its p95 alone). Exact flag-off comparison command:

```bash
MEGACOMPACT_ENC_0F=0 node --test dist/vector-cortex/enc0f-acceptance.test.js
```

the aggregator is flag-agnostic. Acceptance: no payload leakage — the qualification record carries verdict/thresholds/platform/measurements only, never message content (EVAL-REDACT-002); zero network (the bench + gate are local computation, PREVENT-PI-004). Apply [EVALUATION](../EVALUATION.md) annotation/power rules; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure — no schema/state changes.** The gate writes a `QualificationV1` record (developer/evidence artifact under `~/.pi/mega-compact-encoder/`) and emits events to the monitoring `events.log`; the store schema and `stateDir` tables are untouched. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md) §fixtures-synthetic; the qualification records aggregate measurements + verdicts only, never exact ledger bytes or prompt content. Dashboard: **no changes** — `qualify.ts`/`gate-qualify.mjs`/`bench-onnx-prod.mjs` live under `src/` + `scripts/`, not `extensions/`, so `cd extensions/dashboard-client && npm run typecheck && npm run build` is NOT required and NOT run. The qualification verdict surfaces on the existing Setup Cortex card via the ENC-0e/VC9A reader (a prior consumer), not a new endpoint. Rollback sets `MEGACOMPACT_ENC_0F=0`; no gate runs and no record is written — byte-identical to the ENC-0d survivor, without deleting records or evidence. No operator migration.

## Exit evidence

Run exact project gates:

```bash
npm run build
node --test dist/vector-cortex/enc0f-acceptance.test.js
MEGACOMPACT_ENC_0F=0 node --test dist/vector-cortex/enc0f-acceptance.test.js
npm test
npm run lint
python3 scripts/regression_check.py --all
node scripts/guardrails-scan.mjs
python3 scripts/log_failure.py --list
node scripts/vector-cortex-conformance.mjs --check
node scripts/vector-cortex-docs-check.mjs
node scripts/vector-cortex-scope-check.mjs ENC-0f <COMMIT_SHA>
node scripts/vector-cortex-evidence-check.mjs ENC-0f
git diff --check
```

No permissive globs or warning-only scans count. The evidence doc `ENC-0f.md` records the measured p95 (512/4 threads), the post-GC marginal RSS over the process baseline, the determinism digest, the opset-21 handshake, and the resulting mode-A/qualified verdict for the real trained asset — the measured close of HG-5. The bench + gate were run locally on the implementation machine (same protocol as ML5-B/ML5-C). No dashboard client or server files are touched.

This sprint is one of 15 new sprint docs in the program; the single docs-check reconciliation (owned by the integration step, not by any per-sprint commit) sets `EXPECTED_SPRINTS` to **60** in `scripts/vector-cortex-docs-check.mjs` (count at integration time). Cross-cutting seam only.
