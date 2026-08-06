# ENC-0a — Backend decision: transformers.js/WASM vs onnxruntime-node native

**Status:** planned | **Depends on:** vc2-model-prep (research brief) | **Phase:** ENC
**Flag:** `MEGACOMPACT_ENC_0A`, defined in `src/config/vector-cortex-enc0a.ts` (sibling extract), re-exported by `vector-cortex.ts` + root `src/config.ts`, default ON; `MEGACOMPACT_ENC_0A=0` disables and must be byte-identical to the predecessor (no decision record written, no newer backend-resolution script runs — the runtime keeps serving mode B trigram exactly as before). Registered in `VECTOR_CORTEX_SETTINGS` as a visible boolDirect toggle, never in `EXCLUDED_SETTINGS`.

## Goal and inputs/outputs

**Decision + measurement sprint — the head of the ENC phase.** The six ENC sprints replace the placeholder learned encoder (`encoder-v1-placeholder`, 42-byte ONNX, LCG-stubbed inference at `src/vector-cortex/encoder/runtime.ts:269` with `benchRecord: null` at `runtime.ts:222`) with a REAL trained ONNX path. Before any asset is fetched (ENC-0b) or any head is trained (ENC-0c), ENC-0a locks the runtime-backend choice, the per-platform install-size matrix, the opset baseline, and the license/pinning audit. Its output is the durable decision record `docs/vector-cortex/encoder-backend-decision.md`, produced deterministically by a new resolution script so the decision is reproducible, not a prose assertion.

The brief's norm is authoritative end-to-end: trunk research (2026-08-05, three-agent fan-out) confirms **BAAI/bge-small-en-v1.5** — MIT license, 33.4M params, ~23 MiB int8 ONNX, **opset 21** (the earlier Xenova opset-17 requirement was dropped by upstream). The two runtime candidates, per [vc2-model-prep](../vc2-model-prep.md) §1–§3:

- **onnxruntime-node native** — ≈258 MiB total install vs the 80 MiB asset/install cap ([MODEL_ASSET](../MODEL_ASSET.md) §Qualification and packaging) = **FAIL unless a per-platform `optionalDependencies` split** ([vc2-model-prep](../vc2-model-prep.md) §3, blocker 3; [VC2C](../sprints/VC2C-encoder-evaluation-fallbacks.md)-era budget).
- **transformers.js v4.2.0 + onnxruntime-web WASM** — ≈9.5 MiB shell = **the leading candidate**; the only path that fits the 80 MiB budget with no per-platform native split.

ENC-0a does NOT decide by re-running the old MiniLM numbers alone: vc2-model-prep benchmarked `all-MiniLM-L6-v2` on `onnxruntime-node` (WASM failed its gates there: 3.4× slower, 2.3× over memory). The bge-small int8 asset was never benchmarked under **transformers.js** — that is the gap this sprint closes with a real, reproducible matrix before the runtime commit.

**Decision rule (pre-registered, deterministic, measured):** if the measured p95 of bge-small int8 at 512 tokens on 4 threads on `linux-x64` under transformers.js WASM is ≤ 40 ms AND the shipped byte-count fits the 80 MiB budget → ship **transformers.js/WASM** (Option W, the leading candidate). Else record the measured native option (Option N) with an explicit budget amendment in the decision record. `darwin-x64` (Intel Mac) has **no native binary** in the transformers.js/onnxruntime-web-served package (arm64-only upstream; demotion per HG-4 is the ENC-0e sprint's job) — ENC-0a records the platform row, ENC-0e ships the demotion. Opset re-baseline **21** (not 17) is recorded here and enforced from ENC-0b onward.

Production ownership: `docs/vector-cortex/encoder-backend-decision.md (new — the locked decision record: backend choice, per-platform install matrix, opset baseline, license verdict, pinned sha256 digests, budget disposition, measured tables); scripts/encoder/resolve-backend-decision.mjs (new — deterministic pure resolver producing the EncoderBackendDecisionV1 JSON that the record and ENC-0b both consume; reads an optional measured-bench JSONL, never the network); src/config/vector-cortex-enc0a.ts (new — flag, sprintFlag pattern); conformance/vector-cortex/v2/encoder-decision/ (fixtures ENC-DEC-001..006); scripts/ml5-enc/gen-fixtures.mjs (new — emits the ENC-DEC and later enc fixture families; additive per-sprint); docs/vector-cortex/evidence/ENC-0a.md (new — records the measured matrix + the locked decision, per [EVIDENCE_TEMPLATE](../EVIDENCE_TEMPLATE.md))`.

## Numbered implementation tasks

1. Add the `MEGACOMPACT_ENC_0A` flag (default ON, `=0` byte-identical) in `src/config/vector-cortex-enc0a.ts` (sprintFlag pattern from `vector-cortex-flag.ts`), the `vector-cortex.ts` + `src/config.ts` re-exports, and the `VECTOR_CORTEX_SETTINGS` boolDirect toggle in `routes-rag-settings-vector-cortex.ts` (additive, stays ≤ 300). `vector-cortex.ts` stays ≤ 300.
2. Create `src/vector-cortex/encoder/decision.ts`: the `EncoderBackendDecisionV1` contract — `{ schema:"encoder-backend-decision-v1", backend:"wasm"|"native", budgetOk:boolean, opset:21, platformMatrix: Record<EncoderPlatform,{runtime:string;installMiB:number;demotion:"none"|"wasm"|"modeB"}> , license:{spdx:"MIT",redistribution:true}, artifacts:{model:{path,bytes,sha256},tokenizer:{path,bytes,sha256}}, p95Ms:number|null, blockedBy: string[] }`. No `any` (PREVENT-011). Additive re-export by the resolver; the Production ownership note at :24 records it as the contract module the resolver consumes.
3. Create `scripts/encoder/resolve-backend-decision.mjs`: the deterministic resolver. Reads a measured bench JSONL (the transformers.js-vs-native numbers) if present, otherwise degrades to the recorded `vc2-model-prep` §3 table; computes the decision rule from task Goal; asserts the platform matrix resolves to a concrete runtime row for every `EncoderPlatform`; emits the `EncoderBackendDecisionV1` JSON. Pure local computation — zero network (PREVENT-PI-004).
4. Measure the bge-small int8 asset under transformers.js WASM on `linux-x64` using the existing `scripts/vc2-model-prep/bench-onnx.mjs`-style harness extended for transformers.js (extend `scripts/vc2-model-prep/bench-onnx.mjs` additively to accept a `--transformers` mode); record p95 at 512/4 threads and the WASM steady-state marginal RSS under `--expose-gc`.
5. Run `scripts/encoder/resolve-backend-decision.mjs` with the measured record → write the locked `docs/vector-cortex/encoder-backend-decision.md`. Update the opset baseline note: `ENCODER_OPSET` re-baselines from 17 to 21 in ENC-0b (guardrail-reviewed); register the model card re-version `encoder-v1` (drop `-placeholder`) for ENC-0b.
6. Add `scripts/ml5-enc/gen-fixtures.mjs` (first use) emitting `ENC-DEC-001..006`, register them + owner `ENC-0a` in the v2 manifest against a new `schemas/encoder-decision-fixture.schema.json` sibling; the manifest bump itself is cross-cutting.
7. Add the sprint acceptance aggregator `src/vector-cortex/enc0a-acceptance.test.ts`, then evidence `ENC-0a.md` recording the matrix, the opset baseline, the pinned digests, and the verdict.

## Failure triad and independence

A budget-viable WASM: with a measured p95 ≤ 40 ms at 512/4 threads on `linux-x64` and the shipped byte-count ≤ 80 MiB, the resolver selects WASM with `budgetOk:true` (fixture `ENC-DEC-001`; ids use the `ENC-DEC-` prefix). B budget-exceeding: with p95 > 40 ms or a >80 MiB shell, the resolver selects native with `budgetOk:false` and records the amendment (fixture `ENC-DEC-002`). C opset/platform audit: the resolver pins opset 21 exactly and every `EncoderPlatform` row resolves to a concrete runtime + demotion triple (fixtures 503–504). The pinning and multi-source degradation are pinned by 505–506 — 505 asserts an artifact sha256 mismatch in the bench input is caught (the recorded digest is authoritative), and 506 asserts the resolver degrades cleanly to the recorded `vc2-model-prep` table when no measured bench is present (never blocks on an absent measurement). A is produced by the WASM p95+budget branch; B by the native amendment branch; C purely by the opset/platform asserts. `MEGACOMPACT_ENC_0A=0` writes no decision record and runs no resolver — byte-identical mode-B serving. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/encoder-decision/`. Schema: `schemas/encoder-decision-fixture.schema.json` (new sibling, mirrors the setup-cortex fixture precedent).

- `ENC-DEC-001: WASM qualifies (p95<=40, budget<=80MiB) -> backend wasm, budgetOk true`.
- `ENC-DEC-002: p95>40 or budget>80MiB -> backend native, budgetOk false, amended_budget_mib recorded`.
- `ENC-DEC-003: opset baseline pinned to 21 (not 17) across the artifact rows`.
- `ENC-DEC-004: per-platform install matrix resolves a runtime+demotion row for every EncoderPlatform`.
- `ENC-DEC-005: bench-input sha256 mismatch fails the resolver (supply-chain guard)`.
- `ENC-DEC-006: no measured bench present -> resolver degrades to the recorded vc2-model-prep table and still emits a decision (never blocks on absent measurement)`.

Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/enc0a-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/enc0a-acceptance.test.js
```

Expected assertions: all `ENC-DEC-001..006` rows registered with algorithm `encoder-decision` against the `encoder-decision` schema, expected `ok`; aggregator flag-agnostic (passes with `MEGACOMPACT_ENC_0A` on and off). Resolver unit assertions: decision rule branches per the pre-registered rule; matrix completeness (every `EncoderPlatform` resolves, incl. darwin-x64 → `demotion:"wasm"`); opset exactly 21; artifact digests match the pinned record; absorb-6 flag-off writes no decision file. Exact flag-off comparison command:

```bash
MEGACOMPACT_ENC_0A=0 node --test dist/vector-cortex/enc0a-acceptance.test.js
```

the aggregator is flag-agnostic. Acceptance: no payload leakage — the decision carries digests/sizes/license/verdicts only, never message content (EVAL-REDACT-002); the resolver and the bench are zero-network local computation (PREVENT-PI-004 green). Apply [EVALUATION](../EVALUATION.md) annotation/power rules; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure — no schema/state changes.** This is the first ENC sprint; it writes a decision record and benchmark JSON but touches neither the store schema nor `stateDir` tables. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md) §fixtures-synthetic; the decision and bench records contain aggregate measurements, sizes, digests, and licenses — never exact ledger bytes, and no user session content enters any label (normative: the exact ledger is **never automatically training data**). Dashboard: **no changes** — `resolve-backend-decision.mjs` and `decision.ts` live under `scripts/` and `src/`, not `extensions/`; `cd extensions/dashboard-client && npm run typecheck && npm run build` is NOT required and NOT run. The decision surface becomes visible only after ENC-0e's Setup card (darwin demotion reason) consumes this record. Rollback sets `MEGACOMPACT_ENC_0A=0`; the runtime is byte-identical to the predecessor (mode B) and no decision file is written. No operator migration.

## Exit evidence

Run exact project gates:

```bash
npm run build
node --test dist/vector-cortex/enc0a-acceptance.test.js
MEGACOMPACT_ENC_0A=0 node --test dist/vector-cortex/enc0a-acceptance.test.js
npm test
npm run lint
python3 scripts/regression_check.py --all
node scripts/guardrails-scan.mjs
python3 scripts/log_failure.py --list
node scripts/vector-cortex-conformance.mjs --check
node scripts/vector-cortex-docs-check.mjs
node scripts/vector-cortex-scope-check.mjs ENC-0a <COMMIT_SHA>
node scripts/vector-cortex-evidence-check.mjs ENC-0a
git diff --check
```

No permissive globs or warning-only scans count. The measured bge-small numbers (encoder bench) were gathered by extending the existing `scripts/vc2-model-prep/bench-onnx.mjs` for transformers.js mode and running it locally on the implementation machine; the fitted p95/RSS and the locked decision are recorded in `docs/vector-cortex/evidence/ENC-0a.md` as the deliverable that ENC-0b (asset fetch + runtime wiring) and ENC-0e (darwin-x64 demotion) consume.

`<COMMIT_SHA>` in the scope-check command is this sprint's commit. No client or dashboard server files are touched.

This sprint is one of 15 new sprint docs in the program; the single docs-check reconciliation (owned by the integration step, not by any per-sprint commit) sets `EXPECTED_SPRINTS` to **60** in `scripts/vector-cortex-docs-check.mjs` (count at integration time). Cross-cutting seam only.
