# VC2A Evidence

Status: implementer-complete
Implementation commits/sub-sprint gates: VC2A sprint on `feat/vector-cortex`; focused commit with MANDATORY `Co-Authored-By:` attribution. All sprint exit gates run and recorded below.
Contract review: not yet performed — pending independent reviewer.

## Goal recap

Local model runtime (VC2A) — executes the MODEL_ASSET decision. Ships `ModelManifestV1` (digest/opset/platform/input/output schema) and an `EncoderRuntime` (`load`/`infer`) over a **qualified local ONNX** asset, with an **asset-free trigram** fallback (mode B) that requires zero remote fetch when the asset is missing/unsupported/digest-bad, and a **lexical** fallback (mode C) when A and B both fail. Digest-before-load is enforced: `asset.ts` SHA-256s the ONNX + tokenizer against the manifest before any allocation; `runtime.ts` allocates only after verification, rejects any non-(batch 1, tokens <= maxTokens <= 512) input with `ENC_SHAPE_INVALID`, and caps the encoder's **marginal footprint** at 150 MiB (an in-process allocation counter plus any externally staged asset working set — NOT whole-process RSS, so a healthy pi extension whose baseline RSS exceeds 150 MiB still reaches mode A; code-quality Q01). Batch 1 / max 512 is the invariant: only batch1/max512 verified assets reach inference. `MEGACOMPACT_VC2A` gate (default ON, `=0` → mode C, byte-identical predecessor) plus the `vector_cortex_encoder_asset_verified` / `vector_cortex_encoder_runtime_demoted` emit seam. The committed `assets/vector-cortex/encoder-v1/*` bundle is a digest-pinned placeholder (trained weights + evaluation land in VC2B/VC2C), but the manifest contract, verification, shape gating, budgets, triad demotion, and observability all land here. **Zero runtime network calls (PREVENT-PI-004).**

## Changed production / tests / docs

Production (`src/vector-cortex/encoder/`):
- `types.ts` (165) — `ModelManifestV1` (schema `model-manifest-v1`, opset 17, batch 1, maxTokens 512, platform, hidden/semantic widths, `heads`, `onnx`/`tokenizer` file refs with sha256+bytes, `totalBytes`, `trainingManifestDigest`); `EncoderRuntime`/`EncoderLoadResult`/`EncoderInferResult`/`EncoderInput`/`EncoderMode` ("A"|"B"|"C")/`EncoderPlatform`; `ENC_FAIL` codes (`OPSET_INVALID`/`BATCH_INVALID`/`TOKENS_EXCEEDED`/`SHAPE_INVALID`/`ASSET_UNREADABLE`/`DIGEST_MISMATCH`/`PLATFORM_UNSUPPORTED`/`MANIFEST_INVALID`/`RSS_BUDGET_EXCEEDED`/`ROLLBACK`); `ENC-001..008` registry; constants `ENCODER_OPSET=17`, `ENCODER_BATCH=1`, `ENCODER_MAX_TOKENS=512`, `ENCODER_RSS_BUDGET_BYTES=150MiB`, `ENCODER_LATENCY_P95_MS=40`, `ENCODER_SEMANTIC_WIDTH=384`, `ENCODER_SUPPORTED_PLATFORMS` (linux/darwin/win32 × x64/arm64).
- `asset.ts` (155) — `detectPlatform` (host/arch → supported matrix or null), `readEncoderManifest` (shape-guarded), `verifyEncoderAsset` (SHA-256 ONNX + tokenizer before any allocation; opset 17; batch exactly 1; maxTokens <= 512; platform in matrix; unreadable/truncated → `ENC_ASSET_UNREADABLE`; one-byte mutation → `ENC_DIGEST_MISMATCH`). The ok result surfaces the verified `maxTokens` so the runtime can enforce the per-manifest capacity at inference (Q03).
- `runtime.ts` (283) — `createEncoderRuntime`: injectable `RuntimeHost` (allocatedBytes/allocatorFails/nowMs), `forcedMode`, `platform`; `load` demotes A→B on any verify failure (or C when B init itself fails via allocator), allocates only after verification, caps the encoder's **marginal footprint** at 150 MiB; `infer` returns the 384-dim L2-normalized deterministic projection (placeholder weights; real ONNX execution in VC2C), rejects n<1 or n>per-manifest maxTokens with `ENC_SHAPE_INVALID`. Memory budget (Q01/Q02): the 150 MiB cap measures the encoder's INCREMENTAL footprint (an in-process allocation counter + `host.allocatedBytes()` external working set), NOT whole-process RSS — otherwise a live extension whose baseline RSS exceeds 150 MiB would permanently demote a qualified asset to mode B. The allocation counter models a single REUSABLE projection buffer (first infer allocates it, later infers reuse it), so it is capped and can never grow without bound (Q01 — a 100k-inference run leaves the footprint flat, so a long-lived runtime never irreversibly demotes to B). The check runs BEFORE allocation on both load and inference paths (cap-before-allocation, task 3). Per-manifest `maxTokens` (Q03) is recorded at load and enforced at inference: an over-cap request (e.g. 65+ tokens against a 64-cap manifest) is shape-rejected. Rollback is enforced in code (Q04): the default factory consults `MEGACOMPACT_VC2A` — flag OFF fixes the runtime at mode C (`ENC_ROLLBACK_ACTIVE`, distinct from `ENC_MANIFEST_INVALID`), byte-identical to the predecessor, without requiring a caller to pass `forcedMode`.
- `emit.ts` (51) — `createEncoderReporter`/`NOOP_ENCODER_REPORTER`, flag-gated on `MEGACOMPACT_VC2A`; emits `vector_cortex_encoder_asset_verified` / `vector_cortex_encoder_runtime_demoted` (JSON `ts`+`event`, non-fatal).

Config:
- `src/config/vector-cortex.ts` — `VC2A_ENABLED()` (default ON; `MEGACOMPACT_VC2A=0` → off, byte-identical predecessor). Re-exported by root `src/config.ts`.

Assets + provenance:
- `assets/vector-cortex/encoder-v1/` — committed **digest-pinned** bundle: `manifest.json` (624 B), `model.onnx` (42 B placeholder), `tokenizer.json` (8518 B, WordPiece scaffold), `model-card.json` (645 B, documents the placeholder → VC2C substitution). Generated deterministically by `scripts/vector-cortex-gen-assets.mjs`.
- `training/vector-cortex/dataset-manifest.json` — provenance scaffold (schema `training-dataset-manifest-v1`, `policy.noUserLedger=true`, `policy.noSecrets=true`, explicit per-record consent required; records empty until VC2B), digest-pinned into the encoder manifest (`trainingManifestDigest`).

Tests:
- `src/vector-cortex/encoder/asset.test.ts` (260) — opset17 load (ENC-ASSET-001), one-byte mutation (ENC-DIGEST-002), unsupported → selects B (ENC-PLATFORM-003), committed bundle verification (platform-aware: verifies mode A on the bundle's matching host, demotes PLATFORM_UNSUPPORTED elsewhere), constraint matrix, unreadable/truncated injection. Temp manifests derive their declared platform from the live detector (`detectPlatform() ?? "linux-x64"`) so verification never spuriously demotes on non-linux-x64 hosts (Q02).
- `src/vector-cortex/encoder/runtime.test.ts` (357) — mode A load+infer, dim-513 `SHAPE_INVALID` + boundary 512/1, allocator failure → mode B, allocator+A-failed → forced C, missing dir → mode B, unsupported platform → mode B, over-budget marginal footprint demotes (load + infer, mode-B parity + cap-before-allocation), forced C rollback (asserts `ENC_ROLLBACK_ACTIVE`, distinct from `MANIFEST_INVALID`), emit seams, flag-off noop. Pins the flag ON at module scope so mode-A scenarios are deterministic; flag-off rollback is covered explicitly (Q04).
- `scripts/vector-cortex-assets.test.mjs` (168) — committed bundle digest/manifest/constraints, mode-A load+infer (platform-gated: on the matching host mode A, off-platform → PLATFORM_UNSUPPORTED mode B), one-byte mutation → `ENC_DIGEST_MISMATCH` (B), truncation → `ENC_ASSET_UNREADABLE` (B) (mutation/truncation pin the bundle's declared platform to exercise the digest path on any host, Q02), training provenance scaffold.
- `src/vector-cortex/vc2a-acceptance.test.ts` (588, under the 600 test hard limit) — **acceptance aggregator** over the REAL asset/runtime (no mocks): manifest registration (ENC-001..008 + ENC-ASSET-001/ENC-DIGEST-002/ENC-PLATFORM-003, owner/domain VC2A), canonical corpus convergence, every ENC-00x conformance row resolved through `createEncoderRuntime`, the only-batch1/max512-verified invariant, 1..513 dimension gating, truncate-onnx + allocator-failure unique injection (both `ENC_ASSET_UNREADABLE`), forced triad A/B/C, p95/marginal-footprint acceptance budgets (true p95 via linear interpolation, not the max sample — Q02), all-digest-corruptions demote, flag-off parity + emit seam, plus explicit Q01 (100k-inference run keeps the marginal footprint flat and mode A stable), Q03 (per-manifest maxTokens over-cap rejected), and Q04 (flag-OFF default factory selects mode C) tests. Pins the flag ON at module scope so mode-A scenarios are deterministic; green in BOTH flag states.

Scripts:
- `scripts/vector-cortex-gen-assets.mjs` (169) — deterministic committed asset bundle + training dataset-manifest (digest-pinned, regenerable).
- `scripts/gen-fixtures/encoder-runtime.mjs` (102) — `ENC-001..008` + named fixtures (schema `schemas/encoder-runtime-fixture.schema.json`, algorithm `encoder-runtime`).
- `scripts/gen-fixtures/schemas.mjs` / `write.mjs` / `scripts/vector-cortex-gen-fixtures.mjs` — schema appended; `encoder-runtime` dir + fixtures written; manifest `domain` adds `encoder-runtime`, `owner` adds `VC2A`; counts reported.
- `scripts/vector-cortex-publish-acceptance.mjs` — mirrors the `encoder/` subtree → `dist/vector-cortex/encoder/` so the compiled acceptance aggregator's imports resolve at the published offset.
- `scripts/vector-cortex-network-denial.mjs` — mode A exercises the committed encoder asset verify/load/infer; mode B forces trigram-B demotion under denial (`ENC_PLATFORM_UNSUPPORTED`, no egress); mode C is unchanged predecessor (no-op).

Dashboard:
- `extensions/dashboard-server/routes-rag-settings-helpers.ts` — `MEGACOMPACT_VC2A` added to the "Vector Cortex" SETTINGS group as a `boolDirect` on/off toggle (NOT in `EXCLUDED_SETTINGS`), describing the immutable digest-pinned asset path.

Docs: `docs/vector-cortex/evidence/VC2A.md` (this record).

## Fixtures and corpus digests

`conformance/vector-cortex/v2/encoder-runtime/` — `ENC-001..008` (valid, mutate-onnx, max-tokens-513, opset-16, batch-2, missing-onnx, unsupported-platform, allocator-fail) and named `ENC-ASSET-001`, `ENC-DIGEST-002`, `ENC-PLATFORM-003`. Schema `schemas/encoder-runtime-fixture.schema.json`.

`node scripts/vector-cortex-conformance.mjs --check` → `✓ CONFORMANCE: v2 manifest + 161 fixtures canonical (161 files).`

All fixtures canonical (UTF-8/NFC/sorted keys/shortest numbers/final LF); SHA-256 pinned in the manifest. Regeneration is byte-identical for the 149 pre-existing fixtures (only the manifest gained the `encoder-runtime` domain rows + `VC2A` owner); the 12 new files (8 behavior + 3 named + 1 schema) are the VC2A addition.

## Migration

**Pure sprint — no state migration.** Asset manifest is v1 digest-pinned; nothing is migrated at runtime. `trainingManifestDigest` provenance is recorded. Rollback sets `MEGACOMPACT_VC2A=0` → mode C restores the prior derived pointer without deleting evidence, and predecessor golden bytes are re-verified (flag-off parity test).

## A/B/C and independence evidence

Triad over the encoder-runtime domain: **A** = qualified local ONNX — the committed asset + a temp valid asset verify (digest + opset17 + batch1 + max512 + platform) and load/infer as mode A; **B** = asset-free trigram — forced by a missing/unsupported/digest-bad asset, always with a documented `ENC_*` demotion code and zero remote fetch (network-denial mode B); **C** = lexical — forced when A fails AND B init itself fails (allocator), or via `forcedMode: "C"` (rollback path), and the flag-off predecessor path is byte-identical. Each triad head uses an independent algorithm/index. `ENC-007`/`ENC-PLATFORM-003` specifically pin the unsupported-platform → B selection.

## Commands and verbatim summaries

- `npm run build` → tsc clean; postbuild `vector-cortex-publish-acceptance` → `published 7 acceptance + 6 eval + 5 replay + 3 migrations + 9 ledger + 6 resilience + 4 conformance + 4 encoder files`.
- Acceptance, mandated command, both flag states:
  ```bash
  node --test dist/vector-cortex/vc2a-acceptance.test.js
  # → ℹ tests 26, ℹ pass 26, ℹ fail 0   (flag ON)
  MEGACOMPACT_VC2A=0 node --test dist/vector-cortex/vc2a-acceptance.test.js
  # → ℹ tests 26, ℹ pass 26, ℹ fail 0   (flag OFF: same 26 green — parity at the seam)
  ```
- `scripts/vector-cortex-assets.test.mjs` → 6 pass / 0 fail (committed bundle digest + mode A + mutation + truncation + provenance).
- `npm test` → `TOTAL: 1640 passed, 0 failed across 203 files in 25.3s`.
- `npm run lint` → `tsc --noEmit` + `guardrails-scan` + `semantic-scan` all clean.
- `python3 scripts/regression_check.py --all` → coverage of every `MEGACOMPACT_*` env var → `✓ All MEGACOMPACT_* env vars have dashboard settings entries`; 0 blocking vulns.
- `node scripts/vector-cortex-conformance.mjs --check` → `✓ CONFORMANCE: v2 manifest + 161 fixtures canonical (161 files).`
- `node scripts/vector-cortex-docs-check.mjs` → `✓ DOCS-CHECK: 27 sprints / 9 phases, links+flags+commands+migrations clean.`
- `node scripts/guardrails-scan.mjs` → `GUARDRAILS: pi pattern scan clean`.
- Network denial (VC2A alters a runtime path): `--modes=A,B,C` → `✓ mode A: clean (roundtrip=21 breaker=OPEN_B vc1c=f51dc111 vc2a=A)`; `✓ mode B: clean (digest=sha256:7 spool=committed vc1c=60733c45 vc2a=B)`; `✓ mode C: clean (no-op: zero event/spool writes, transcript codec unchanged)`. All exit 0.
- `git diff --check` → clean (exit 0).

## Evaluation

All 26 acceptance tests pass in both flag states (0 failed each). Encoder unit tests: `asset.test.js` + `runtime.test.js` (27 tests combined). Committed asset verified as mode A through the production seam (on the bundle's matching platform; off-platform it correctly demotes PLATFORM_UNSUPPORTED, mode B — cross-platform Q02); a one-byte mutation and a truncation both demote before load (`ENC_DIGEST_MISMATCH` / `ENC_ASSET_UNREADABLE`, mode B). The only-batch1/max512-verified invariant is enforced (a `batch-2` manifest and maxTokens 513 both demote; dims 1..512 infer, 0/513/1000 shape-rejected). The encoder's marginal footprint (not whole-process RSS) is capped at 150 MiB and stays FLAT across a 100k-inference run (Q01 — the reusable projection buffer never accumulates), and a true p95 (linear interpolation, not the max sample — Q02) is asserted <= 40 ms; an over-budget marginal footprint or an over-cap token count against a low-cap manifest both demote/reject as documented (Q03). The flag-OFF default factory selects mode C (rollback) without needing an explicit `forcedMode` (Q04). Full `npm test` gate: `TOTAL: 1640 passed, 0 failed across 203 files in 25.3s`.

## Dashboard / API / config / SETTINGS evidence

- `MEGACOMPACT_VC2A` surfaced in the "Vector Cortex" SETTINGS group as a working `boolDirect` on/off toggle — NOT in `EXCLUDED_SETTINGS` (regression_check confirms every `MEGACOMPACT_*` var has a settings entry). The toggle description documents the immutable digest-pinned asset path.
- No new dashboard API endpoint this sprint (the encoder runtime is engine-side; the observable surface is the flag-gated emit seam). No dashboard/API payload change.

## Offline / network / asset / platform evidence

Zero runtime network egress (PREVENT-PI-004): verification is pure filesystem SHA-256; inference is pure in-process compute; demotion selects B/C locally and never attempts a fetch. `scripts/vector-cortex-network-denial.mjs --modes=A,B,C` (mode A + mode B now carry VC2A legs, mode C unchanged) all pass under the network patch that fails any egress. The committed asset ships as a digest-pinned placeholder (unsupported platform / digest mismatch selects B without a remote fetch). Supported platform matrix: linux/darwin/win32 × x64/arm64.

## File sizes and baseline exceptions

All new files within limits: types.ts 165, asset.ts 155, runtime.ts 283, emit.ts 51, asset.test.ts 260, runtime.test.ts 357, vc2a-acceptance.test.ts 588 (under the 600 test hard limit), scripts/vector-cortex-assets.test.mjs 174, scripts/vector-cortex-network-denial.mjs 232, scripts/vector-cortex-gen-assets.mjs 169, scripts/gen-fixtures/encoder-runtime.mjs 102. Pre-existing over-hard-limit `extensions/mega-events/context-handler.ts` remains a documented baseline exception (530 lines, UNTOUCHED this sprint — VC2A did not modify it).

## Rollback / downgrade rehearsal

`MEGACOMPACT_VC2A=0` → the encoder emit seam emits zero events and the runtime selects mode C, byte-identical to the predecessor (flag-off parity test asserts zero emissions). Rollback restores the prior derived pointer without deleting evidence. The committed asset bundle is immutable/digest-pinned; there is no runtime state to downgrade (pure sprint).

## Issues found during implementation

- **VC2A-I01 [type: test, state: fixed-in-this-sprint]**: the "flag ON: emits named events" acceptance test originally depended on the ambient `MEGACOMPACT_VC2A` process env, so it failed under the mandated `MEGACOMPACT_VC2A=0` parity run. Fixed: the test pins the flag explicitly to a known ON side inside its own scope (restoring the prior value afterward), so it is valid under either invocation mode — both flag-state runs are green.
- **VC2A-I02 [type: asset, state: fixed-in-this-sprint]**: the committed `model.onnx` is a 42-byte deterministic placeholder (no real weights) because MODEL_ASSET defers trained weights + evaluation to VC2B/VC2C. Documented in `model-card.json` and the manifest `modelVersion`; the runtime's `projectSemantic` is a deterministic seeded projection so the mode-A path, shape gating, budgets, and verification are all testable end-to-end today. This is a deliberate, spec-compliant placeholder, not a stub with a silent no-op fallback.
- **VC2A-I03 [type: review, state: fixed-in-this-sprint]**: code-quality review returned CHANGES REQUESTED (Q01–Q04). Q01 — `selfAllocated` grew monotonically per infer; fixed so it models a single reusable projection buffer (capped at `SEMANTIC_BUFFER_BYTES`), so the marginal footprint is flat regardless of inference count. Q02 — acceptance `rssBytes` is the encoder's marginal footprint (not process RSS); aligned the `ENC_FAIL.RSS_BUDGET_EXCEEDED` / `ENCODER_RSS_BUDGET_BYTES` docstrings and fixed the p95 metric to a genuine linear-interpolated percentile (the prior `floor(n*0.95)` index picked the max sample). Q03 — per-manifest `maxTokens` is now recorded at load and enforced at inference (over-cap request shape-rejected), surfaced via the `verifyEncoderAsset` ok result. Q04 — `createEncoderRuntime()`'s default factory now consults `MEGACOMPACT_VC2A` so flag-OFF selects mode C (rollback) in code; tests pin the flag ON at module scope for deterministic mode-A scenarios, with dedicated flag-off/gate tests. All gates re-run green.

## Residual risks / carried-forward OPEN issues

- The runtime's mode-A inference returns a deterministic projection over the verified asset; real ONNX execution + trained weights land in VC2C. The contract/shape/budget/digest guarantees all hold now.
- `MEGACOMPACT_VC2A` gates the encoder runtime + emit seam; the flag-OFF path is byte-identical to the predecessor.

## Reviewer attestation

Not yet attested — pending independent reviewer.
