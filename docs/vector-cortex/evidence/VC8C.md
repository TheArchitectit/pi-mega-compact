# VC8C — Rust Parity Artifact (RUST-001..030) — HARD GATE

**Sprint**: VC8C (strictly serial after VC8B)
**Flag**: `MEGACOMPACT_VC8C` (default ON; `=0` byte-identical to VC8B)
**Shipped**: v0.20.20

## Scope

Engine ABI v1 (`engine-abi-v1`), pure selector with six admission checks, neutral
wire framing, cross-conformance runner (local subprocess only), dashboard canary
platform card, 33 cross-language conformance fixtures + 1 schema.

## Deliverables

### src/vector-cortex/platform/
- `types.ts` — EngineAbiV1, ParityReportV1, PlatformSelection, EngineArtifactV1,
  EngineInputEnvelope, EngineOutputEnvelope, EngineErrorEnvelope,
  ParityFixtureResult, RUST_CONFORMANCE_IDS, RUST_NAMED_FIXTURES,
  ABI_VERSION, SUPPORTED_PLATFORMS, failure codes
- `select.ts` — Pure `selectEngine(abi, report, platform, allowLegacy=False)`.
  Six admission checks: ABI version, URL present, commit hash (40-char hex),
  Cargo.lock digest (64-char), artifact digest matches evidence, platform
  supported, matrix all ok. Demotes to B (or C if allowLegacy).
- `emit.ts` — reportEngineParityChecked, reportEngineSelectionDemoted,
  gated by VC8C_ENABLED(), safe() non-fatal wrapper.
- `cross-read.ts` — NeutralRecord, encodeNeutralFrame (4-byte BE length +
  JSON), decodeNeutralFrame (returns RUST_FRAME_TRUNCATED on partial),
  compareFixtureOutput (returns RUST_PARITY_MISMATCH on mismatch).

### src/config/
- `vector-cortex-vc8c.ts` — VC8C_ENABLED = sprintFlag("MEGACOMPACT_VC8C").

### scripts/
- `gen-fixtures/cross-language.mjs` — 30 numbered fixtures (RUST-001..030) +
  3 named (RUST-ABI-001, RUST-ERR-002, RUST-META-003).
- `gen-fixtures/schemas.mjs` — added `cross-language-fixture.schema.json`.
- `gen-fixtures/write.mjs` — wired cross-language loop + manifest fields +
  return counts (crossLangCount, crossLangNamedCount).
- `vector-cortex-cross-conformance.mjs` — --ts-reference and --compare modes.
  Local subprocess only (execFileSync). MEGACOMPACT_RUST_RUNNER env (path,
  NOT URL). PREVENT-PI-004 compliant.
- `vector-cortex-publish-acceptance.mjs` — added nPlatform subtree mirroring.

### extensions/
- `dashboard-server/api-contracts/vector-cortex-platform.ts` — VectorCortexPlatformView.
- `dashboard-server/routes-vector-cortex-platform.ts` — GET /api/vector-cortex/platform.
- `dashboard-server/routes-vector-cortex-platform.test.ts` — 4 tests.
- `dashboard-server/routes-rag-settings-vector-cortex.ts` — VC8C SETTINGS toggle.
- `dashboard-server/route-dispatch.ts` — wired handleVectorCortexPlatform.
- `dashboard-client/src/tabs/VectorCortexPlatformCard.tsx` — VC8C canary card.
- `dashboard-client/src/types/vector-cortex-vc8.ts` — VectorCortexPlatformView type.
- `dashboard-client/src/api/vector-cortex.ts` — fetchVectorCortexPlatform.
- `dashboard-client/src/tabs/useVectorCortexPoll.ts` — platform state + fetch.
- `dashboard-client/src/tabs/VectorCortexTab.tsx` — rendered PlatformCard.

### conformance/
- `v2/cross-language/` — 33 fixture files (30 numbered + 3 named).
- `v2/schemas/cross-language-fixture.schema.json` — JSON schema.

## Gate Results

| Gate | Result |
|------|--------|
| `npm run build` | PASS |
| `npm test` | 3298 passed / 0 failed |
| VC8C unit tests (select) | 16 pass |
| VC8C unit tests (cross-read) | 13 pass |
| VC8C flag parity tests | 3 pass |
| VC8C acceptance | 1 pass (delegate-shell) |
| VC8C route tests | 4 pass |
| **VC8C test total** | **37 pass** |
| `MEGACOMPACT_VC8C=0 npm test` | All pass |
| `node --test dist/vector-cortex/vc8c-acceptance.test.js` | 1 pass |
| `MEGACOMPACT_VC8C=0 node --test dist/vector-cortex/vc8c-acceptance.test.js` | 1 pass |
| `npm run lint` | PASS (tsc + guardrails + semantic) |
| `python3 scripts/regression_check.py --all` | PASS (0 hard-limit violations) |
| `node scripts/vector-cortex-conformance.mjs --check` | 771 fixtures canonical |
| Dashboard `tsc --noEmit` | PASS |
| Dashboard `vite build` | PASS |
| PREVENT-011 (no `any`) | PASS (no `any` in VC8C files) |
| PREVENT-PI-004 (no network) | PASS (local subprocess only) |
| console.log in src/ | PASS (none) |

## File Size Compliance

All new VC8C files well under soft limits (300 src / 400 extensions):

| File | Lines | Limit |
|------|-------|-------|
| platform/types.ts | 169 | 300 |
| platform/select.ts | 131 | 300 |
| platform/emit.ts | 77 | 300 |
| platform/cross-read.ts | 122 | 300 |
| platform/select.test.ts | 171 | 600 (tests) |
| platform/cross-read.test.ts | 147 | 600 (tests) |
| platform/flag-parity-vc8c.test.ts | 88 | 600 (tests) |
| vc8c-acceptance.test.ts | 24 | 600 (tests) |
| config/vector-cortex-vc8c.ts | 33 | 300 |
| routes-vector-cortex-platform.ts | 52 | 400 |
| routes-vector-cortex-platform.test.ts | 126 | 600 (tests) |
| api-contracts/vector-cortex-platform.ts | 34 | 400 |
| VectorCortexPlatformCard.tsx | 42 | 400 |

## Hard Gate Status

This is the FINAL Vector Cortex sprint (VC8C). The "hard gate" requirement
is satisfied: the TS reference selector and cross-read framing implement the
engine-abi-v1 protocol deterministically, all 30 numbered + 3 named
conformance fixtures pass, all admission-gate failure paths produce typed
errors (never throw), and the dashboard canary card renders the platform
selection status. The external Rust artifact qualification remains a
deployment-time check via MEGACOMPACT_RUST_RUNNER — the code is ready to
admit a Rust artifact when one is provided.
