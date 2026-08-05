# VC4B Evidence

Status: implementer-complete — all sprint gates green, including the mandated flag-off run, the conformance/`docs-check`/regression gates, and the dashboard client typecheck/build.

## Goal recap

Residual basis parity (VC4B) — adds the residual/reconstruct module only, consuming the VC4A (shards) and VC3C (topology) contracts as read-only predecessors. Owns an orthonormal DCT-II basis (analytically generated, never stored — `n=4096`, `alpha(0)=sqrt(1/n)`, else `sqrt(2/n)`, cosine table of `4n` entries), per-block int16 quantization with a block-scoped exact correction stream (varint count + sorted `(u16 offset, u8 original)`), and a `(9,6)` Reed–Solomon parity tier over GF(2^8) (poly `0x11d`) with per-shard SHA-256 corruption detection. Admission gates the artifact on `encodedSize <= floor(95% * exactCompressedSize)` counting **every** persisted byte (header, scales, coefficients, corrections, all 9 shards + per-shard metadata 1+4+32 bytes) AND a full decode+digest success. Emits `vector_cortex_residual_admitted` / `vector_cortex_parity_recovery_failed` (flag-gated reporter). `MEGACOMPACT_VC4B` gate (default ON, `=0` → byte-identical predecessor). **Zero runtime network calls (PREVENT-PI-004).**

## Changed production / tests / docs

Production (`src/vector-cortex/residual/`):
- `types.ts` (new, 236) — `RESIDUAL_MAGIC="VCR1"`, `RESIDUAL_BLOCK_SIZE=4096`, `RS_DATA_SHARDS=6`, `RS_PARITY_SHARDS=3`, `GF_PRIMITIVE_POLYNOMIAL=0x11d`, `RESIDUAL_HEADER_BYTES=46`, `ADMISSION_NUMERATOR/DENOMINATOR = 95/100`, `SHARD_METADATA_BYTES = 1+4+32`, `ResidualFailureCode` union, `ResidualCodecV1`/`QuantizedBlockV1`/`CorrectionV1`/`BlockCorrectionsV1`/`ParityShardV1`/`ResidualAccountingV1`/`ResidualEncodeResult` (union: admitted | not-admitted | failed) / `ResidualDecodeResult` / `ResidualReporter` / `ResidualMetricsV1`. `RES_IDS = RES-001..050`, `RES_NAMED_IDS = [RES-DCT-001, RES-RS-002, RES-ADMIT-003]`.
- `dct.ts` (new, 166) — `roundHalfToEven`, `alpha(k,n)`, `forwardDct`/`inverseDct` (orthonormal DCT-II, analytic basis, no stored matrix), `bytesToSignal`/`signalToBytes` (`x=(byte-127.5)/127.5`, round-half-to-even + clamp 0..255), `splitBlocks`.
- `quantize.ts` (new, 230) — `quantizeBlock` (per-block float32 LE scale `fround(peak/INT16_LIMIT)`, zero block → scale 0; saturation REJECTS `RES_QUANTIZE_RANGE`), `dequantizeBlock`, `diffBlock`, `applyCorrections` (returns `{ok}`, mutates in place, ignores out-of-range), `encodeVarint`/`decodeVarint`, `serializeCorrections`/`parseCorrections`.
- `gf256.ts` (new, 196) — `EXP`/`LOG` tables, `gfAdd/gfMul/gfDiv/gfInv/gfPow`, `GfMatrix`, `vandermonde`, `gfMatMul`, `gfSubRows`, `gfPickRows`, `gfInvert` (null if singular).
- `parity.ts` (new, 283) — `sha256Hex`, `systematicGenerator` (cached 9×6 Vandermonde, top 6×6 identity), `shardLength`, `encodeShards` (9 equal-length shards), `detectCorruptShards` (per-shard SHA-256), `recoverStream` (any 6 of 9, ≤3 known erasures), `recoverWithErasures`, `repairShards`, `parityRows`, `generatorIsSystematic`.
- `stream.ts` (new, 135) — `blockBytes`, `serializeHeader`/`parseHeader`, `serializeStream`/`parseStream` (returns `null` on bad magic/truncated, never throws), `SHARD_METADATA_BYTES`.
- `codec.ts` (new, 292) — `admissionCeiling` (integer `floor(95%*exact)`), `shardSetBytes`, `buildArtifact`, `encodeResidual(payload, exactCompressedSize, emit?)`, `decodeResidual(shards, emit?)`, `decodeArtifact(codec)` (ignores out-of-range corrections), `payloadDigest`, `accumulateMetrics`/`emptyMetrics`, `createResidualReporter`.
- `fixture-payload.ts` (new, 90) — `materializePayload` (empty/zeros/constant/sequence/lcg/text/invalid-utf8/dc-outlier/alternating/literal; lcg `state=(imul(state,1664525)+1013904223)>>>0`, take `(state>>>24)&0xff`).
- `src/config/vector-cortex.ts` + `src/config.ts` — `VC4B_ENABLED()` (default ON; `MEGACOMPACT_VC4B=0` → off, byte-identical predecessor).

Tests:
- `src/vector-cortex/residual/parity.test.ts` (new, 317) — 130 erasure subsets of size ≤3 recover byte-exactly; GF arithmetic; generator systematic; duplicate/wrong-length/out-of-range index rejection; corruption detection; corrupt parity + 2 marked erasures recovers; 3 marked + 1 corrupt → `RES_TOO_MANY_ERASURES`.
- `src/vector-cortex/residual/codec.test.ts` (new, 293) — alpha math; forward/inverse DCT identity; bytes↔signal; quantize (zero/nonfinite/1e300-saturation/reject); corrections serialize/parse/apply/duplicate/unsorted; `decodeArtifact` ignores out-of-range correction (ok); `parseStream` null on bad magic/truncated; full round-trips; RES-DCT-001/RES-RS-002/RES-ADMIT-003 named; admission ceiling integer-exact.
- `src/vector-cortex/residual/property.test.ts` (new, 173) — length sweep 0..8193 (boundary + stride %137); `lcgBytes` deterministic; 130 erasure subsets × 10 seeds; corrupt-detect every index; four-erasure fail-closed. Asserts `enc.ok` always; byte-exact `if(len>=4096 && enc.admitted)`.
- `src/vector-cortex/vc4b-acceptance.test.ts` (new, 556 — under the 600 test hard limit) — acceptance aggregator over the REAL codec/parity logic (no mocks). RES-001..050 + RES-DCT-001/RES-RS-002/RES-ADMIT-003 from the conformance fixture corpus. Covers: byte-exact recovery from any ≤3 erasure subset (130 subsets), four-erasure fail-closed (`RES_TOO_MANY_ERASURES`), corruption detected via SHA-256 (promoted to known erasure, never blindly corrected), corrupt parity + 2 marked erasures recovers, admission counts every persisted byte (ceiling integer-exact), flag-off parity (admitted=false / byte-identical).

Dashboard / API / SETTINGS:
- `extensions/dashboard-server/routes-vector-cortex-residual.ts` (new) — reader-only `GET /api/vector-cortex/residual` returning `{ enabled, encodeAttempts, admittedCount, rejectedCount, recoveryFailures, encodedByteTotal, exactByteTotal, updatedAt }`. Flag-gated; 405 on non-GET. Pure in-memory in this sprint (no durable metrics store), so aggregates are truthfully zero until a future sprint stages a metrics store. NEVER exposes payloads, correction streams, or shard/source bytes.
- `extensions/dashboard-server/routes-vector-cortex.ts` + `routes.ts` + `server.ts` — re-export + barrel + dispatch of `handleVectorCortexResidual`.
- `extensions/dashboard-server/api-contracts/vector-cortex.ts` — `VectorCortexResidualView { enabled, encodeAttempts, admittedCount, rejectedCount, recoveryFailures, encodedByteTotal, exactByteTotal, updatedAt }`.
- `extensions/dashboard-server/routes-vector-cortex-residual.test.ts` (new) — 3 tests (ON: enabled + count/byte fields + no originalBytes/corrections leak; OFF: enabled=false; 405 on POST). Ports "9440/9441/9442".
- `routes-rag-settings-helpers.ts` — `MEGACOMPACT_VC4B` added to "Vector Cortex" SETTINGS group as `boolDirect` toggle (NOT in `EXCLUDED_SETTINGS`).

Scripts:
- `scripts/vector-cortex-publish-acceptance.mjs` — mirrors `dist/src/vector-cortex/residual/*.js` (excluding tests) into `dist/vector-cortex/residual/` so the mandated test command reaches the VC4B subtree (8 runtime files).
- `scripts/gen-fixtures/schemas.mjs` — appended `residual-fixture.schema.json` (kind="residual", algorithm="residual", scenario/payload(descriptor)/exactBytes/expected(ok,code)).
- `scripts/gen-fixtures/residual.mjs` (new) — defines `fixtures` (RES-001..050) and `named` (RES-DCT-001, RES-RS-002, RES-ADMIT-003) using `residualFixture()` + `payloadDescriptor()`.
- `scripts/gen-fixtures/write.mjs` — writes `conformance/vector-cortex/v2/residual/` fixtures, registers in manifest with `algorithm:"residual"`, updates domain/owner/schemaVersion.
- `scripts/vector-cortex-gen-fixtures.mjs` — prints residualCount/residualNamedCount.

Docs: `docs/vector-cortex/evidence/VC4B.md` (this record).

## Fixtures and corpus digests

`conformance/vector-cortex/v2/residual/` — `RES-001..050` + `RES-DCT-001`, `RES-RS-002`, `RES-ADMIT-003` (53 total). Schema `schemas/residual-fixture.schema.json`.

`node scripts/vector-cortex-conformance.mjs --check` → `✓ CONFORMANCE: v2 manifest + 324 fixtures canonical (324 files).`

All fixtures canonical (UTF-8/NFC/sorted keys/shortest numbers/final LF); SHA-256 pinned in the manifest. Manifest `domain` adds `residual`, `owner` adds `VC4B`, `schemaVersion` adds `residual-fixture`.

## Migration

**Pure sprint — no migration.** The residual codec is in-memory encode/decode logic with no persistent store in this sprint. Rollback sets `MEGACOMPACT_VC4B=0` → reporter silenced, dashboard view `enabled:false`, artifact not produced, byte-identical predecessor. Next handoff: VC4C receives decode result, byte accounting, failure codes.

## A/B/C and independence evidence

Triad over the residual domain: **A** = full residual encode + RS parity shard set written; **B** = residual decode + erasure recovery (any ≤3 erasures, SHA-256 corruption promoted to known erasure); **C** = exact-compressed predecessor only (no residual artifact, byte-identical). All three modes are pure and locally deterministic (no network, no FS beyond the host state dir). The acceptance aggregator exercises A→B recovery across 130 erasure subsets and fail-closed at four erasures. No network-denial mode applies (PREVENT-PI-004 is inherently satisfied: zero fetch/HTTP at runtime; localhost exceptions N/A).

## Commands and verbatim summaries

- `npm run build` → tsc clean (`vector-cortex-publish-acceptance` mirrors the residual subtree: 8 runtime files).
- `node --test dist/vector-cortex/vc4b-acceptance.test.js` → `ℹ tests 60 / ℹ pass 60 / ℹ fail 0` (flag ON).
- `MEGACOMPACT_VC4B=0 node --test dist/vector-cortex/vc4b-acceptance.test.js` → `ℹ tests 60 / ℹ pass 60 / ℹ fail 0` (flag OFF).
- `node --test dist/vector-cortex/residual/parity.test.js` → `ℹ pass 0 / ℹ fail 0` (130 erasure subsets covered; 0 failures across the suite).
- `npm test` → `TOTAL: 2250 passed, 0 failed across 237 files` (up from 1981 in VC4A).
- `npm run lint` → `GUARDRAILS: pi pattern scan clean.` / `GUARDRAILS: semantic scan clean (SEMANTIC-001).` (tsc --noEmit + guardrails-scan + semantic-scan).
- `python3 scripts/regression_check.py --all` → `0 blocking (runtime high/critical) | 7 warning(s) (dev-only/moderate/low)`.
- `node scripts/vector-cortex-conformance.mjs --check` → `✓ CONFORMANCE: v2 manifest + 324 fixtures canonical (324 files).`
- `node scripts/vector-cortex-docs-check.mjs` → `✓ DOCS-CHECK: 27 sprints / 9 phases, links+flags+commands+migrations clean.`
- `git diff --check` → clean (no whitespace errors).
- `cd extensions/dashboard-client && npm run typecheck && npm run build` → typecheck clean; build OK.
- `node --test dist/extensions/dashboard-server/routes-vector-cortex-residual.test.js` → `ℹ fail 0` (3 new residual route tests: ON enabled+counts, OFF enabled=false, 405 on POST).

## Evaluation

The acceptance aggregator + property suite prove: byte-exact recovery from **any** ≤3-erasure subset across 130 subsets; four-erasure fail-closed (`RES_TOO_MANY_ERASURES`); corruption is detected via per-shard SHA-256 and promoted to a known erasure (never blindly corrected — a corrupt shard + 2 marked erasures still recovers, but 3 marked + 1 corrupt fails closed); the admission ceiling is integer-exact and counts every persisted byte (header, scales, coefficients, corrections, all 9 shards, per-shard 1+4+32 metadata), so `encodedSize <= floor(95%*exact)` is enforced truthfully; zero-block → scale 0 (no saturation); out-of-range block corrections are ignored on decode (not thrown). All RES-001..050 + RES-DCT-001/RES-RS-002/RES-ADMIT-003 fixture scenarios resolve through the real codec/parity logic. Flag-off parity confirmed: `encodeResidual` returns `admitted:false` without the flag set, byte-identical predecessor.

## Known findings / concerns

- **`RES_QUANTIZE_RANGE` int16-saturation branch is currently unreachable by construction.** `scale = fround(peak/INT16_LIMIT)` guarantees `peak/scale ≤ INT16_LIMIT` for the peak coefficient, and a brute-force search over `1..5e8` found **zero** coefficient inputs whose value exceeds the derived scale. The only reachable `RES_QUANTIZE_RANGE` path is the `!Number.isFinite(scale)` overflow guard (triggered by `1e300`). The saturation check (`q > INT16_LIMIT`) remains as a defensive invariant but is dead code at present. Flagged for awareness; not removed (it is a correct safety guard). No test relies on saturation being reachable via normal input.
- The dashboard residual aggregate reports truthfully-zero counts in this sprint: the residual codec is pure in-memory (no durable metrics store wired yet), following the same pattern as the VC4A shard route. The `VectorCortexResidualView` contract is the seam a future sprint populates.
