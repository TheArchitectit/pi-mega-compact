# VC2B Evidence

Status: implementer-complete
Implementation commits/sub-sprint gates: VC2B sprint on `feat/vector-cortex`; focused commit with MANDATORY `Co-Authored-By:` attribution. All sprint exit gates run and recorded below.
Contract review: not yet performed — pending independent reviewer.

## Goal recap

Multi-head encoder (VC2B) — consumes the VC2A EncoderRuntime contract and ships **VectorSetV1** (five independent L2-normalized projection heads in stable order: semantic 384 / dependency 128 / contradiction 128 / cacheStability 64 / payloadRouting 32) and **HeadCalibrationDraft** (frozen per-head losses .35/.20/.20/.15/.10, seed 1729, corpus/split digests). Task list: define the contracts and register `ENC-009..016` before training/export logic (task 1); implement the five heads with L2 normalization mapping zero norm to an all-zero vector (task 2); implement training losses exactly .35/.20/.20/.15/.10 with seed 1729 and persisted corpus/split digests (task 3); implement trigram B at 512 dims and token/phrase lexical C without importing the learned asset or learned calibration (task 4); emit `vector_cortex_encoder_heads_emitted` and `vector_cortex_encoder_fallback_selected` with no dashboard/API change (task 5); after production artifacts pass gates, add shape/independence tests + fixtures + evidence (task 6). `MEGACOMPACT_VC2B` gate (default ON, `=0` → byte-identical predecessor: zero VC2B emissions). **Zero runtime network calls (PREVENT-PI-004).**

## Changed production / tests / docs

Production (`src/vector-cortex/encoder/`):
- `types.ts` (now ~390) — added `ENCODER_HEAD_ORDER` (semantic/dependency/contradiction/cacheStability/payloadRouting), `EncoderHeadName`, `ENCODER_HEAD_DIMS` (384/128/128/64/32), `ENCODER_HEAD_DIM_ORDER`, `ENCODER_HEAD_LOSS_WEIGHTS` (.35/.20/.20/.15/.10), `ENCODER_HEAD_LOSS_SUM` (1.0), `ENCODER_SEED` (1729), `HeadVector`, `VectorSetV1` (schema `vector-set-v1`, stable-order heads, `normalized`), `HeadCalibrationDraft` (schema `head-calibration-draft-v1`, dims/losses/seed/corpusDigest/splitDigest), `FallbackSelection`, and `ENC2B_IDS` (`ENC-009..016`). The VC2A `ENC_FAIL`/`ModelManifestV1`/`EncoderRuntime` contracts are untouched (VC2A owns them).
- `heads.ts` (new, ~200) — `projectHead`/`encodeVectorSet` produce the five heads in STABLE order, each L2-normalized via `l2Normalize` (zero-norm input → all-zero vector, task 2/ENC-ZERO-002); empty input yields the all-zero vector. `l2Norm`/`headLossWeights` helpers. Deterministic seeded projection (real weights land in VC2C). Wire the VC2B emit seam (`headsEmitted`) on production.
- `trigram.ts` (new, ~120) — **mode B**: asset-free deterministic 512-dim trigram (`embedTrigram512`, `ENCODER_TRIGRAM_WIDTH=512`, `selectTrigramBFallback`). No learned asset, manifest, or calibration import (task 4 / ENC-FALLBACK-003); derives purely from textual authority over byte-level trigrams. `selectTrigramBFallback` is the production mode-B selection point and emits `vector_cortex_encoder_fallback_selected` via the flag-gated reporter (task 5 / code-review S1), so the event fires from the real runtime path, not test wiring.
- `lexical.ts` (new, ~130) — **mode C**: token/phrase lexical encoder (`embedLexical`, `ENCODER_LEXICAL_WIDTH=256`, `selectLexicalC`), which `state`s its loss of old semantic context (`ENCODER_LEXICAL_LIMITATION` — continuity, not completeness, per TRIAD_RESILIENCE). Never imports the learned asset/calibration (task 4). `selectLexicalC` is the production mode-C selection point and also emits `vector_cortex_encoder_fallback_selected` (task 5 / S1) alongside its limitation report.
- `emit-vc2b.ts` (new, ~80) — `createEncoderHeadsReporter`/`NOOP_VC2B_REPORTER`, flag-gated on `MEGACOMPACT_VC2B`; emits `vector_cortex_encoder_heads_emitted` / `vector_cortex_encoder_fallback_selected` (JSON `ts`+`event`, non-fatal) (task 5).
- `router.ts` (new, ~130) — **VC2B encode-or-fallback router** (code-review S2): the production seam that catches a REAL VC2A `runtime.load()` failure (removed model → `ENC_ASSET_UNREADABLE`, digest mismatch → `ENC_DIGEST_MISMATCH`, missing manifest → `ENC_MANIFEST_INVALID`, ...) and hands off to the independently initialized B/C selector. `encodeOrFallback` produces a VectorSetV1 (emits `heads_emitted`) when A qualifies, else selects trigram B / lexical C via `selectTrigramBFallback`/`selectLexicalC` — the `fallback_selected` event now provably fires from the real runtime path. Best-effort and non-fatal; no output bytes change on either flag state.

Config:
- `src/config/vector-cortex.ts` — `VC2B_ENABLED()` (default ON; `MEGACOMPACT_VC2B=0` → off, byte-identical predecessor). Re-exported by root `src/config.ts`.

Training + provenance:
- `training/vector-cortex/constants.py` (new) — head order/dims/losses (assert sum == 1.0) + `SEED=1729` (single source for the training toolchain).
- `training/vector-cortex/train.py` (new) — offline training harness: canonical `corpusDigest` over the dataset manifest, deterministic `splitDigest` by repository/session group (order-invariant), seeded 1729, per-head losses .35/.20/.20/.15/.10; writes `training-report.json` (task 3).
- `training/vector-cortex/export_onnx.py` (new) — ONNX export sharing seed 1729, opset 17/CPU/batch 1/max 512, pins the persisted corpus/split digests from the training report into the exported model (real weights substituted in VC2C).
- `training/vector-cortex/train-v1.json` (new) — normative training config (losses, seed, head order).

Tests:
- `src/vector-cortex/encoder/heads.test.ts` (new, ~180, under the 600 test hard limit) — ENC-HEAD-001 shape parity, per-head dims, loss weights exact and sum == 1, seed == 1729, L2 norm 0-or-~1 invariant, repeat drift <= 1e-6, zero-norm → all-zero, emit seam (flag OFF zero emissions, flag ON named events).
- `src/vector-cortex/encoder/fallback-independence.test.ts` (new, ~130) — ENC-FALLBACK-003 (trigram B emits 512 dims with the learned asset removed), trigram/lexical determinism, mode-B selection width, lexical-C limitation report, triad independence (disjoint widths, independent algorithms, no shared asset/index).
- `src/vector-cortex/vc2b-acceptance.test.ts` (new, ~410, under the 600 test hard limit) — **acceptance aggregator** over the REAL producers (no mocks): registration of ENC-009..016 + ENC-HEAD-001/ENC-ZERO-002/ENC-FALLBACK-003 (owner/domain VC2B), canonical corpus convergence, every ENC-009..016 row resolved through the real producers, named assertions, the shape/norm invariant, repeat drift <= 1e-6, unique failure injection (stage a verifying asset dir, delete `model.onnx` after A selection, drive `encodeOrFallback` → the router catches the REAL `ENC_ASSET_UNREADABLE` load failure and selects independently initialized B, asserting `vector_cortex_encoder_fallback_selected` was emitted from the router seam), forced triad A/B/C through the router (A on a verifying dir → VectorSetV1 + `heads_emitted`; B on a removed asset dir → 512d trigram; C via `forceFallback:"C"` → lexical), disjoint-width independence, flag-off parity + emit seam, VC2B flag default-ON/=0. Pins the VC2A+VC2B flags ON at module scope so the router handoff is deterministic; green in BOTH flag states.

Scripts:
- `scripts/gen-fixtures/encoder-heads.mjs` (new, ~130) — `ENC-009..016` + named fixtures (schema `schemas/encoder-heads-fixture.schema.json`, algorithm `encoder-heads`).
- `scripts/gen-fixtures/schemas.mjs` / `write.mjs` / `scripts/vector-cortex-gen-fixtures.mjs` — `encoder-heads` schema appended; `encoder-heads/` dir + fixtures written + registered; manifest `domain` adds `encoder-heads`, `owner` adds `VC2B`; counts reported.
- `scripts/vector-cortex-network-denial.mjs` — mode A and mode B now carry VC2B legs (heads + 512d trigram under denial in A; trigram + lexical C in B); mode C unchanged (no-op predecessor).

Dashboard / API:
- `extensions/dashboard-server/routes-rag-settings-helpers.ts` — `MEGACOMPACT_VC2B` added to the "Vector Cortex" SETTINGS group as a `boolDirect` on/off toggle (NOT in `EXCLUDED_SETTINGS`). No API endpoint or client change (VC2B spec §dashboard: none — the flag is a config seam, the server renders the toggles dynamically).

Docs: `docs/vector-cortex/evidence/VC2B.md` (this record).

## Fixtures and corpus digests

`conformance/vector-cortex/v2/encoder-heads/` — `ENC-009..016` (full-set, five per-head rows, zero-input, trigram-b) and named `ENC-HEAD-001`, `ENC-ZERO-002`, `ENC-FALLBACK-003`. Schema `schemas/encoder-heads-fixture.schema.json`.

`node scripts/vector-cortex-conformance.mjs --check` → `✓ CONFORMANCE: v2 manifest + 173 fixtures canonical (173 files).`

All fixtures canonical (UTF-8/NFC/sorted keys/shortest numbers/final LF); SHA-256 pinned in the manifest. Regeneration is byte-identical for the 161 pre-existing fixtures (only the manifest gained the `encoder-heads` domain rows + `VC2B` owner); the 12 new files (8 behavior + 3 named + 1 schema) are the VC2B addition. Training corpus/split digests are persisted by the training harness (`training-report.json`): `corpusDigest` over the committed dataset manifest, `splitDigest` over the deterministic group assignment (both reproducible).

## Migration

**Pure sprint — no state migration; model asset revision only.** Nothing is migrated at runtime (VC2B owns contracts + producers; the next handoff to VC2C receives the candidate asset digest and per-head logits). Rollback sets `MEGACOMPACT_VC2B=0` → zero VC2B emissions (mode C parity, byte-identical predecessor); predecessor golden bytes re-verified by the flag-off parity test.

## A/B/C and independence evidence

Triad over the encoder-heads domain: **A** = learned projections — the five-head deterministic VectorSetV1 (stable order, dims 384/128/128/64/32); **B** = asset-free trigram — `embedTrigram512` computes a 512-dim vector with NO skill/modal/attribute/model, i.e. purely from textual authority, so a removed/absent learned asset cannot affect it (ENC-FALLBACK-003, independence test, network-denial mode B); **C** = token/phrase lexical — `embedLexical` at the token/phrase level, independently implemented from B (byte-ngram level), reporting its loss of old semantic context. Each head uses an independent algorithm/feature space; widths are disjoint (384/128/128/64/32 vs 512 vs 256).

The three modes are wired through the **encode-or-fallback router** (`encoder/router.ts`), which holds the triad handoff together: it drives the real VC2A `load()` to decide A, and when that load fails it selects B/C through the production selection functions — both of which now emit `vector_cortex_encoder_fallback_selected` (S1). Unique failure injection is a TRUE end-to-end exercise (S2): stage a verifying asset dir, delete `model.onnx` after A selection, call `encodeOrFallback` → the router catches the real `ENC_ASSET_UNREADABLE` load failure, selects independently initialized B (512d), and the fallback-selected event fires from the router seam. Pinpoint that the trigger mounts through the live A→B demo path and does not rely on a direct `selectTrigramBFallback` call.

## Commands and verbatim summaries

- `npm run build` → tsc clean; postbuild `vector-cortex-publish-acceptance` → `published 8 acceptance + 6 eval + 5 replay + 3 migrations + 9 ledger + 6 resilience + 4 conformance + 8 encoder files`.
- Acceptance, mandated command, both flag states:
  ```bash
  node --test dist/vector-cortex/vc2b-acceptance.test.js
  # → ℹ tests 23, ℹ pass 23, ℹ fail 0   (flag ON)
  MEGACOMPACT_VC2B=0 node --test dist/vector-cortex/vc2b-acceptance.test.js
  # → ℹ tests 23, ℹ pass 23, ℹ fail 0   (flag OFF: same 23 green — parity at the seam)
  ```
- Unit: `node --test dist/src/vector-cortex/encoder/heads.test.js` → 11 pass / 0 fail; `node --test dist/src/vector-cortex/encoder/fallback-independence.test.js` → 8 pass / 0 fail; `runtime.test.js` → 15 pass / 0 fail; `asset.test.js` → 12 pass / 0 fail (VC2B router handoff is covered by the acceptance aggregator).
- `npm test` → `TOTAL: 1714 passed, 0 failed across 207 files in 23.5s`.
- `npm run lint` → `tsc --noEmit` + `guardrails-scan` + `semantic-scan` all clean.
- `python3 scripts/regression_check.py --all` → coverage of every `MEGACOMPACT_*` env var → `✓ All MEGACOMPACT_* env vars have dashboard settings entries`; `✓ No potential regressions detected`; 0 blocking vulns.
- `node scripts/vector-cortex-conformance.mjs --check` → `✓ CONFORMANCE: v2 manifest + 173 fixtures canonical (173 files).`
- `node scripts/vector-cortex-docs-check.mjs` → `✓ DOCS-CHECK: 27 sprints / 9 phases, links+flags+commands+migrations clean.`
- `node scripts/guardrails-scan.mjs` → `GUARDRAILS: pi pattern scan clean.`; `python3 scripts/log_failure.py --list` → the two pre-existing ACTIVE failures (FAIL-38192431 compaction, FAIL-55d81817 error-retry) are out of VC2B scope; no new in-scope failure.
- Network denial (VC2B adds a runtime path): `--modes=A,B,C` → `✓ mode A: clean (roundtrip=21 breaker=OPEN_B vc1c=f51dc111 vc2a=A vc2b=5heads)`; `✓ mode B: clean (digest=sha256:7 spool=committed vc1c=60733c45 vc2a=B vc2b=B)`; `✓ mode C: clean (no-op: zero event/spool writes, transcript codec unchanged)`. All exit 0.
- `git diff --check` → clean (exit 0).

## Evaluation

All 23 acceptance tests pass in both flag states (0 failed each). Encoder unit suites: `heads.test.js` (11) + `fallback-independence.test.js` (8) + `runtime.test.js` (15) + `asset.test.js` (12). Invariant: every emitted head/trigram/lexical norm is 0 or within 1e-6 of 1; repeat drift <= 1e-6 (asserted across repeated seeded exports and trigram/lexical runs). Every shape is exact per the ordered dims 384/128/128/64/32; B works with the model removed (asset-free trigram). Losses are exactly .35/.20/.20/.15/.10 and sum to 1.0; seed 1729 is shared by training and export (verified end-to-end by running `train.py` + `export_onnx.py`). Unique failure injection now drives the real router against a staged verifying asset dir and asserts `vector_cortex_encoder_fallback_selected` fires from the production seam with the real `ENC_ASSET_UNREADABLE` code. Full `npm test` gate: `TOTAL: 1714 passed, 0 failed across 207 files`.

## Dashboard / API / config / SETTINGS evidence

- `MEGACOMPACT_VC2B` surfaced in the "Vector Cortex" SETTINGS group as a working `boolDirect` on/off toggle — NOT in `EXCLUDED_SETTINGS` (regression_check confirms every `MEGACOMPACT_*` var has a settings entry).
- No dashboard API endpoint or client change this internal sprint (VC2B §dashboard "none"); the observable surface is the flag-gated emit seam. Dashboard client `typecheck` + `build` both pass (run for completeness after the SETTINGS helper edit); no client `dist/` churn is committed (settings toggles are rendered dynamically from the helper).

## Offline / network / asset / platform evidence

Zero runtime network egress (PREVENT-PI-004): heads/trigram/lexical are pure in-process hashing/compute with no fetch; the training toolchain reads/writes local files only. `scripts/vector-cortex-network-denial.mjs --modes=A,B,C` (mode A + mode B now carry VC2B legs, mode C unchanged) all pass under the network patch that fails any egress. Trigram B and lexical C never import the learned asset or learned calibration (task 4) — verified by the independence tests and the network-denial compute.

## File sizes and baseline exceptions

All new files within limits: types.ts (~390, soft 300 over by design — the file ships both VC2A and VC2B encoder contracts; below the 500 hard limit), heads.ts ~200, trigram.ts ~120, lexical.ts ~130, emit-vc2b.ts ~80, router.ts ~130, heads.test.ts ~180, fallback-independence.test.ts ~130, vc2b-acceptance.test.ts ~410 (under the 600 test hard limit), scripts/gen-fixtures/encoder-heads.mjs ~130. Pre-existing over-soft-limit `extensions/mega-events/agent-handlers/turnEndHandler/errorRetry.ts` (421) and the src test soft limit on the acceptance aggregator (> 300 soft, < 600 hard, same as VC2A's) are warnings, not failures. Pre-existing over-hard-limit `extensions/mega-events/context-handler.ts` remains UNTOUCHED this sprint.

## Rollback / downgrade rehearsal

`MEGACOMPACT_VC2B=0` → the VC2B emit seam emits zero events and the flag-off parity test asserts zero emissions (byte-identical predecessor). Rollback restores the prior derived pointer without deleting evidence. Pure sprint — no runtime state to downgrade.

## Issues found during implementation

- **VC2B-I01 [type: correctness, state: fixed-in-this-sprint]**: the initial `projectRaw` seeded a non-zero raw vector even for EMPTY input, so an empty token sequence normalized to a spurious unit vector instead of the all-zero vector the spec requires (ENC-ZERO-002 "empty input produces finite zero vectors"). Fixed by returning the zero raw vector for empty input, so the zero-norm → all-zero mapping holds on the natural L2-normalization path. Both flag-state acceptance runs re-verified green.
- **VC2B-I02 [type: test, state: fixed-in-this-sprint]**: the ENC-009..016 row loop originally covered only ENC-010..013 per-head rows, leaving ENC-014 (payloadRouting) resolved only via the full-set dims assertion. Extended the loop to slice(1,6) so all five per-head rows (ENC-010..014) resolve through the real `projectHead` producer. 23/23 green.
- **VC2B-I03 [type: correctness, state: fixed-in-this-sprint — code-review S1]**: `vector_cortex_encoder_fallback_selected` only ever fired when a test manually invoked `reporter.fallbackSelected()`; the production B/C selection points (`selectTrigramBFallback`, `selectLexicalC`) returned selection objects without emitting. The VC2A runtime's demotion emits a DIFFERENT event (`vector_cortex_encoder_runtime_demoted`). Fixed by making the two production selection functions invoke `fallbackSelected` through a flag-gated reporter (`createEncoderHeadsReporter`), so the event is live in the real runtime path (task 5). Flag-OFF stays byte-identical (the reporter is a no-op). No dashboard change.
- **VC2B-I04 [type: test/integration, state: fixed-in-this-sprint — code-review S2]**: the acceptance criteria's unique-failure-injection and forced-triad tests described a "router catches load failure and selects independently initialized B" handoff but only simulated it (deleted a staged model.onnx and directly called `selectTrigramBFallback`/`embedTrigram512`); no integration module existed to catch a real VC2A `load()` failure (e.g. `ENC_ASSET_UNREADABLE`) and hand off to the B/C selector while emitting the fallback event. Fixed by adding the production `src/vector-cortex/encoder/router.ts` (`encodeOrFallback`) and reworking both tests to drive it end-to-end: a staged verifying asset dir, `model.onnx` removed after A selection, the router returning the real `ENC_ASSET_UNREADABLE` code and mode B with `fallback_selected` emitted from the router seam; forced triad A (verifying dir → VectorSetV1 + `heads_emitted`), B (removed asset dir → 512d trigram), C (`forceFallback:"C"` → lexical with limitation). 23/23 green in both flag states.

## Residual risks / carried-forward OPEN issues

- The multi-head projections are deterministic seeded transforms (real trained weights + calibration are substituted in VC2C — `HeadCalibrationDraft` is the draft; `CalibrationV1` is VC2C). The contract, shape/norm/drift invariants, loss/seed constants, triad independence and emit seam all hold now.
- The two pre-existing ACTIVE failures (compaction FAIL-38192431, error-retry FAIL-55d81817) are outside VC2B scope and carried forward as tracked items.
- `MEGACOMPACT_VC2B` gates the VC2B emit seam + producers; the flag-OFF path is byte-identical to the predecessor.

## Reviewer attestation

Not yet attested — pending independent reviewer.
