# VC2A — Offline model runtime and asset decision

**Status:** next | **Depends on:** VC1C | **Phase:** VC2
**Flag:** `MEGACOMPACT_VC2A`, defined in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_VC2A=0` disables and must be byte-identical to the predecessor. Add to dashboard `SETTINGS`, or record the immutable/security exclusion below.

## Goal and inputs/outputs

Consume only reviewer-accepted predecessor contracts and [common contracts](../CONTRACTS.md). Own **ModelManifestV1 / EncoderRuntime**. Production ownership: `src/vector-cortex/encoder/{types,runtime,asset}.ts; assets/vector-cortex/encoder-v1/*; training/vector-cortex/*`. Algorithm: Execute MODEL_ASSET architecture decision; ONNX opset17; digest before load; batch1/max512; unsupported platform selects B.

## Numbered implementation tasks

1. Define `ModelManifestV1` digest/opset/platform/input/output fields and `EncoderRuntime.load/infer`; register `ENC-001..008`.
2. Implement `asset.ts` to SHA-256 the ONNX and tokenizer before load and require opset 17, batch 1, maximum 512 tokens.
3. Implement `runtime.ts` to allocate only after manifest verification, reject wrong shapes with `ENC_SHAPE_INVALID`, and cap measured RSS at 150MiB.
4. Package `assets/vector-cortex/encoder-v1/*` and training provenance; unsupported platform or digest mismatch selects B without a remote fetch.
5. Emit `vector_cortex_encoder_asset_verified` and `vector_cortex_encoder_runtime_demoted`; record immutable asset-path exclusion from SETTINGS, with no dashboard/API payload change.
6. After production asset/runtime and package listing gates pass, add runtime/asset/script tests and fixtures, then evidence `VC2A.md`.

## Failure triad and independence

A qualified ONNX only; B trigram; C lexical. Each uses independent algorithms/assets/indexes as applicable. C states its loss of old semantic context; authority outage freezes derived high-water. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/encoder-runtime/`.

- `ENC-ASSET-001: opset17 manifest and digest load successfully`.
- `ENC-DIGEST-002: one-byte model mutation demotes before load`.
- `ENC-PLATFORM-003: unsupported architecture selects trigram B`.

Exact test sources: `src/vector-cortex/encoder/{runtime,asset}.test.ts; scripts/vector-cortex-assets.test.mjs`. Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc2a-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc2a-acceptance.test.js
```

Expected assertions: all `ENC-001..008` conformance rows return their manifest bytes or exact listed failure code; generate manifests with dimensions 1..513 and digest mutations; invariant: only batch1/max512 verified assets reach inference. Unique failure injection: truncate ONNX during digest read and simulate allocator failure; both demote with `ENC_ASSET_UNREADABLE`. Forced triad: A=qualified local ONNX; B=asset-free trigram forced by missing/unsupported asset; C=lexical forced when A and B initialization fail. Breaker recovery must follow the sprint triad contract. Exact flag-off comparison command: `MEGACOMPACT_VC2A=0 node --test dist/vector-cortex/vc2a-acceptance.test.js`; its outbound/predecessor golden bytes must match exactly. Acceptance: load/infer p95 <=40ms, RSS <=150MiB; all digest corruptions demote. Apply [EVALUATION](../EVALUATION.md) annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure—no state migration; asset manifest v1**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); exact ledger is not training data. Dashboard: SETTINGS excludes immutable asset path with justification. No dashboard or API change is necessary for this internal sprint.

Rollback sets `MEGACOMPACT_VC2A=0`, selects C, restores the prior derived pointer without deleting evidence, and verifies predecessor golden bytes. Next handoff: VC2B receives tokenizer/runtime ABI and architecture decision.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc2a-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, and `git diff --check`. Sprints that add or alter any runtime path also run `node scripts/vector-cortex-network-denial.mjs --modes=A,B,C`; asset/Rust/dashboard gates additionally apply when named by this sprint. No permissive globs or warning-only scans count.
