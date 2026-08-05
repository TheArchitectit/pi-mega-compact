# VC4C Evidence

Status: implementer-complete — all sprint gates green, including the mandated flag-off run, the conformance/`docs-check`/regression gates, and the dashboard client typecheck/build.

## Goal recap

Reconstruction fidelity (VC4C) — owns the mandatory conservative **closure** and **assembly/validation** of a recall reconstruction, consuming the VC4A (shards) and VC4B (residual decode) contracts as read-only predecessors. Owns `ClosureResult` / `ReconstructionV1`. Algorithm: recursively add dependencies and whole tool pairs until a fixed point; resolve contradictions by retaining the later exact source resolution (explicit resolution event names the loser directly); equal/unordered resolutions reject (`CLO_CONTRADICTION_UNRESOLVED`); assemble strictly by source range; mandatory before VC5A. `MEGACOMPACT_VC4C` gate (default ON, `=0` → byte-identical predecessor). **Zero runtime network calls (PREVENT-PI-004).**

## Changed production / tests / docs

Production (`src/vector-cortex/reconstruct/`):
- `types.ts` (new, 330) — `ClosureNodeKind = "event"|"exact"|"semantic"|"synthetic"`; `ClosureNode{id,kind,span?,anchor?,resolvedAtMs?,tokenEstimate}`; `ClosureEdge{from,to,kind:"depends"|"tool-pair"|"contradicts"}`; `ClosureGraph{sessionId,nodes,edges,resolutions?}`; `ClosureResult{ok,selected,addedDependencies,removedContradictions,unresolved,proof,failures,mandatoryTokenEstimate}`; `ReconstructionSpan{nodeId,range,source,bytes,digest,protectedSpan}`; `ReconstructionV1{schema:"reconstruction-v1",sessionId,spans,digest,byteTotal,mandatoryTokenEstimate}`; `ReconstructionFailureCode` union; `ReconstructionValidation` discriminated; `ReconstructReporter`; `CLO_IDS`/`REC_IDS` (30 each); `RECONSTRUCT_NAMED_IDS=["CLO-TRANSITIVE-001","CLO-CONTRA-002","REC-ORDER-003"]`. NOTE: residual is a shard `source` only — `ClosureNodeKind` has no "residual" member.
- `closure.ts` (new, 299) — `closeSelection({graph,seeds})` (worklist to fixed point; visited-set cycle termination via `selected` membership; anchor floor always selected — PREVENT-PI-001; tool-pair atomicity both directions — PREVENT-PI-002); `isFixedPoint(graph,result)` (independent re-close check); `closeExactOnly(input)` (Mode B: greedy exact-only closure, no semantics — independent algorithm/index). Contradiction precedence: explicit resolution event > later exact `resolvedAtMs` (both `kind==="exact"`) > tie→`null`→`CLO_CONTRADICTION_UNRESOLVED`. `mandatoryTokenEstimate` is content-only (no prompt framing) — handed unchanged to VC5A, which owns framing + budget admission (`MANDATORY_CLOSURE_OVER_BUDGET`); closure never truncates. All output arrays sorted for order-determinism.
- `assemble.ts` (new, 170) — `assembleSourceOrder({sessionId,selected,nodes,edges,shards,mandatoryTokenEstimate})` async → `{reconstruction:ReconstructionV1|null, code:ReconstructionFailureCode|null}`. `bySourceOrder` sorts spans by `(sessionId,seqStart,byteStart)`; `detectLayoutFailure` returns `REC_SPAN_OVERLAP` (intersecting ranges) / `REC_TOOL_PAIR_SPLIT` (non-adjacent tool pair); missing shard → `REC_SOURCE_UNAVAILABLE`; `sha256Hex` over the byte buffer.
- `validate.ts` (new, 184) — `validateAndAssemble(input)` async → `{validation:ReconstructionValidation, reconstruction}`. Emits `vector_cortex_reconstruction_validated` (ok) or `vector_cortex_closure_rejected` (fail). Rejects: closure not ok / `REC_CONTRADICTION_UNRESOLVED`; anchor missing from selection → `REC_ANCHOR_MISSING`; `findDigestMismatch` (digest!="0" && mismatch → `REC_DIGEST_MISMATCH`, placeholder `0` skipped); assembly failure (`REC_SOURCE_UNAVAILABLE`/`REC_TOOL_PAIR_SPLIT`/`REC_SPAN_OVERLAP`). Exposes summary + failure codes only (no internal buffers leak). Dead `rangesById` helper removed in review.
- `src/config/vector-cortex.ts` + `src/config.ts` — `VC4C_ENABLED()` (default ON; `MEGACOMPACT_VC4C=0` → off, byte-identical predecessor).

Tests:
- `src/vector-cortex/vc4c-acceptance.test.ts` (new, 213 — well within the 600 test-file hard limit) — acceptance aggregator over the REAL closure/assemble/validate logic (no mocks/stubs). Drives CLO-001..030 + REC-001..030 + the three named fixtures from the conformance corpus; plus acceptance invariants: every CLO closure reaches a fixed point, a validated reconstruction carries every protected span, UNIQUE failure injection (erase shard `b` + corrupt its residual fallback → `REC_SOURCE_UNAVAILABLE`), a shard whose pinned digest disagrees with its bytes is rejected (`REC_DIGEST_MISMATCH` real digest path, not the `0` unset sentinel), forced triad A/B/C independence, and flag-off parity (byte-identical with `MEGACOMPACT_VC4C=0`).
- `src/vector-cortex/reconstruct/_acceptance-helpers.ts` (new, 455) — fixture materialization extracted from the acceptance aggregator so the test file stays under the 600-line hard limit: turns declarative conformance fixtures (graph/shard names) into real `ClosureGraph`/`DecodedShard` values and drives them through the real logic. `materializeShards` accepts a `digestOverride` so the digest-mismatch test can pin a real (non-`0`) digest.

Dashboard / API / SETTINGS:
- `extensions/dashboard-server/routes-vector-cortex-reconstruct.ts` (new) — reader-only `GET /api/vector-cortex/reconstruct` returning zero-valued `VectorCortexReconstructView`. Flag-gated; 405 on non-GET; never exposes shards/spans/buffers.
- `extensions/dashboard-server/routes-vector-cortex.ts` + `routes.ts` + `server.ts` — re-export + barrel + dispatch of `handleVectorCortexReconstruct`.
- `extensions/dashboard-server/api-contracts/vector-cortex.ts` — `VectorCortexReconstructView` interface.
- `extensions/dashboard-server/routes-vector-cortex-reconstruct.test.ts` (new) — 3 tests (ON: enabled + zero fields + no shard/span leak; OFF: enabled=false; 405 on POST).
- `routes-rag-settings-helpers.ts` — `MEGACOMPACT_VC4C` added to "Vector Cortex" SETTINGS group as `boolDirect` toggle (NOT in `EXCLUDED_SETTINGS`).
- `extensions/dashboard-client/src/api/vector-cortex.ts` + `types/vector-cortex.ts` — `VectorCortexReconstructView` type + `fetchVectorCortexReconstruct()`.
- `extensions/dashboard-client/src/tabs/VectorCortexTab.tsx` — "Reconstruction Fidelity (VC4C)" card mirroring the shards card.

Scripts:
- `scripts/vector-cortex-residual-benchmark.mjs` (new, 190 — VC4C-owned) — drives the REAL `encodeResidual`/`decodeResidual` over 8 corpora (binary/utf8/invalid-utf8/source/json/random/sparse/adversarial + generous). Honest admission pass uses `gzipSync` for the exact size; generous pass for recovery measurement. Reports admission rate, byte overhead, pre-correction error, recovery rate by erasure (0–3), p50/p95, post-decode digest mismatches. Exits 1 on any mismatch.
- `scripts/vector-cortex-publish-acceptance.mjs` — mirrors `dist/src/vector-cortex/reconstruct/*.js` (excluding `.test.js`) into `dist/vector-cortex/reconstruct/` so the mandated `node --test dist/vector-cortex/vc4c-acceptance.test.js` reaches the VC4C subtree (4 runtime files) and `dist/config/vector-cortex.js` for the flag import.
- `scripts/gen-fixtures/schemas.mjs` — appended `reconstruction-fixture.schema.json` (kind="reconstruction", algorithm="reconstruction", expected enum including every `REC_`/`CLO_` code).
- `scripts/gen-fixtures/reconstruction.mjs` (new, 238) — `reconstructionFixture(id,assertion,input,expected)` defining `CLO-001..030` (closure/assembly) + `REC-001..030` (assembly/validation) + 3 named.
- `scripts/gen-fixtures/write.mjs` — writes `conformance/vector-cortex/v2/reconstruction/` fixtures; manifest `domain` adds `reconstruction`, `owner` adds `VC4C`, `schemaVersion` adds `reconstruction-fixture`.
- `scripts/vector-cortex-gen-fixtures.mjs` — prints `reconstructionCount`/`reconstructionNamedCount`.

Docs: `docs/vector-cortex/evidence/VC4C.md` (this record); `docs/vector-cortex/sprints/VC4C-reconstruction-fidelity.md` — ownership line amended to include `types.ts` (contract-first deviation, see Known findings).

## Fixtures and corpus digests

`conformance/vector-cortex/v2/reconstruction/` — `CLO-001..030` + `REC-001..030` + `CLO-TRANSITIVE-001`, `CLO-CONTRA-002`, `REC-ORDER-003` (63 total). Schema `schemas/reconstruction-fixture.schema.json`.

`node scripts/vector-cortex-conformance.mjs --check` → `✓ CONFORMANCE: v2 manifest + 388 fixtures canonical (388 files).` (388 = 324 prior + 63 reconstruction + 1 schema).

All fixtures canonical (UTF-8/NFC/sorted keys/shortest numbers/final LF); SHA-256 pinned in the manifest.

## Migration

**Pure sprint — no migration.** The reconstruction modules are pure in-memory closure/assembly/validation logic with no persistent store. Rollback sets `MEGACOMPACT_VC4C=0` → dashboard view `enabled:false`, reconstruction not produced, byte-identical predecessor. Next handoff: VC5A receives `ClosureResult.mandatoryTokenEstimate` (content-only) and owns framing + budget admission (`MANDATORY_CLOSURE_OVER_BUDGET`).

## A/B/C and independence evidence

Triad over the reconstruction domain: **A** = closed semantic + exact + residual (full `closeSelection` → `assembleSourceOrder` → `validateAndAssemble`, includes semantic spans); **B** = greedy exact-only closure (`closeExactOnly`, no semantics — an independent algorithm/index that consults no semantic node and no semantic vector index, satisfying TRIAD_RESILIENCE A/B non-sharing); **C** = legacy prompt — continuity over completeness, the semantic tier is intentionally dropped and that loss is stated in the output. The acceptance aggregator exercises A/B/C over a mixed graph and asserts they are independent and non-overlapping (B excludes semantics; C omits the semantic tier). No network-denial mode applies (PREVENT-PI-004 inherently satisfied: zero fetch/HTTP at runtime; localhost exceptions N/A).

## Commands and verbatim summaries

- `npm run build` → tsc clean (`vector-cortex-publish-acceptance` mirrors the reconstruct subtree: 4 runtime files + config).
- `node --test dist/vector-cortex/vc4c-acceptance.test.js` → `ℹ tests 40 / ℹ pass 40 / ℹ fail 0` (flag ON).
- `MEGACOMPACT_VC4C=0 node --test dist/vector-cortex/vc4c-acceptance.test.js` → `ℹ tests 40 / ℹ pass 40 / ℹ fail 0` (flag OFF).
- `npm test` → `TOTAL: 2343 passed, 0 failed across 240 files` (up from 2281 in VC4B).
- `npm run lint` → `GUARDRAILS: pi pattern scan clean.` / `GUARDRAILS: semantic scan clean (SEMANTIC-001).` (tsc --noEmit + guardrails-scan + semantic-scan).
- `python3 scripts/regression_check.py --all` → `0 blocking (runtime high/critical) | 7 warning(s) (dev-only/moderate/low)`.
- `node scripts/guardrails-scan.mjs` → `GUARDRAILS: pi pattern scan clean.`
- `node scripts/vector-cortex-conformance.mjs --check` → `✓ CONFORMANCE: v2 manifest + 388 fixtures canonical (388 files).`
- `node scripts/vector-cortex-docs-check.mjs` → `✓ DOCS-CHECK: 27 sprints / 9 phases, links+flags+commands+migrations clean.`
- `git diff --check` → clean (no whitespace errors).
- `cd extensions/dashboard-client && npm run typecheck && npm run build` → typecheck clean; build OK.
- `node scripts/vector-cortex-residual-benchmark.mjs` → `✓ residual benchmark: zero post-decode digest mismatches across all corpora` (exit 0).
- `node --test dist/extensions/dashboard-server/routes-vector-cortex-reconstruct.test.js` → `ℹ fail 0` (3 new reconstruct route tests: ON enabled+zero fields, OFF enabled=false, 405 on POST).

## Evaluation

The acceptance aggregator proves: every CLO-001..030 closure reaches a fixed point and is deterministically sorted (visited-set terminates cycles, including self-loops); tool pairs are atomic (PREVENT-PI-002) and the anchor floor is always selected (PREVENT-PI-001); contradictions resolve to the later exact `resolvedAtMs`, an explicit resolution event names the loser directly, and equal/unordered/non-exact resolutions reject as `CLO_CONTRADICTION_UNRESOLVED`; assembly sorts strictly by source range; validation rejects missing anchors, split tool pairs (`REC_TOOL_PAIR_SPLIT`), digest mismatch (`REC_DIGEST_MISMATCH`, placeholder `0` skipped), and unresolved contradictions (`REC_CONTRADICTION_UNRESOLVED`); the UNIQUE failure-injection scenario (erase shard `b` + corrupt its residual fallback) returns `REC_SOURCE_UNAVAILABLE` and blocks live output; a validated reconstruction carries every protected span. All CLO/REC + 3 named fixtures resolve through the real logic. Flag-off parity confirmed byte-identical.

## Known findings / concerns

- **Ownership deviation (contract-first):** `types.ts` was added to the spec's `Production ownership:` line. The VC4B precedent (commit `0746d5a`) establishes that the contract interface ships inside the sprint's own `reconstruct/` subtree before any implementation; the ownership set is therefore broadened to include `types.ts`. This is the single deviation from the original ownership line and is recorded as an amendment to `VC4C-reconstruction-fidelity.md`.
- **Residual codec never admits under the 95%-of-gzip ceiling (honest benchmark finding).** `scripts/vector-cortex-residual-benchmark.mjs` measures `admissionRatePct = 0` across all 8 corpora (binary/utf8/invalid-utf8/source/json/random/sparse/adversarial + generous). The residual artifact is ~5× the payload because the 9 RS shards dominate; it therefore never satisfies `encodedSize <= floor(0.95 * gzipSize)` for binary/random input at any size. This is expected: residual is a *fallback recovery* tier, not a compression win, and the admission gate correctly keeps it off the default path. The generous pass confirms recovery is 100% up to 3 erasures with **zero post-decode digest mismatches**, which is the tier's actual purpose.
- **Pre-existing active failures unrelated to VC4C.** `python3 scripts/log_failure.py --list` shows two `active` runtime failures — `FAIL-38192431` (compaction "Already compacted / Already in progress") and `FAIL-55d81817` (S38 error-retry loop, 0-token requests) — both in other sprints' domains (compaction / retry), not touched by VC4C and not introduced by this work.
- The dashboard reconstruct view reports truthfully-zero fields in this sprint (pure in-memory; no durable metrics store wired), following the same pattern as the VC4A/VC4B routes. `VectorCortexReconstructView` is the seam a future sprint populates.
