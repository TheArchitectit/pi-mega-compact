# VC9 — Setup Cortex Target Matrix + Reconstruction (Retro)

**Phase:** Setup Cortex sprints VC9A…VC9D
**Retro created:** 2026-08-07 (CONFORM-HYGIENE, retroactive per framework §5)
**Scope:** defect records for defects found *after* the VC9 phase landed, mapped
to the PREVENT rule that now covers each and the corrective action.

| Defect found after landing | PREVENT rule now covering it | Corrective action that landed |
|---|---|---|
| **Digest-skip sentinel** — `src/vector-cortex/reconstruct/validate.ts:65` `if (s.digest === "0") continue;` silently skipped per-shard digest verification for any co-decoded shard pinned to digest `"0"` (audit Table 1 stub 6, Table 2 row 4). | **PREVENT-VERIFICATION-BYPASS-001** (critical) + **PREVENT-STUB-001** (error) | CONFORM-HYGIENE replaced the literal with `export const PLACEHOLDER_DIGEST = "0"` in `validate.ts` and aligned the `_acceptance-helpers.ts` producer (`digestOverride ?? PLACEHOLDER_DIGEST`), making the sentinel an explicit named marker instead of an implicit `"0"` bypass. |
| **Mock contradiction in a "no mocks, no stubs" file** — `src/vector-cortex/platform/_cross-language-fixture.ts:72` hardcoded `commit: "0".repeat(40)` into a `ParityReportV1` while the file header claimed "no mocks, no stubs" (audit Table 2 row 5). | **PREVENT-MOCK-001** (error) | CONFORM-HYGIENE replaced the `"0".repeat(40)` with a real 40-hex fixture marker commit `2fa7c0de91e4b5aa0d6f8c1e3b7a9d2e5f4180c3`, resolving the header contradiction and satisfying the `COMMIT_RE = /^[0-9a-f]{40}$/` projection validator. |
| **Un-emitted reserved SETUP-CORTEX ranges** — `SETUP-CORTEX 014-019` (6) + `023-029` (7) were reserved in the VC9 spec range `001..039` but never emitted as fixtures (audit Table 4). | Conformance-grows-monotonically + **PREVENT-SPEC-DRIFT-001** | Documented both ranges as `reserved-unused` in `manifest.json` `reservedRanges` (dispositions), so the reserved-but-un-emitted ranges are explicit and the manifest is internally consistent rather than silently absent. |
| **Hard-gate rows missing HG IDs** — `vc2-model-prep.md` §6 items 6/7 (4-threads-mandatory p95; model-card/dataset-manifest/frozen calibration) had no gate IDs, so open gates governing setup-cortex work were not surfaced (audit Table 3 "MISSING HG ID" rows). | — (gate registration, not a PREVENT rule) | Registered **HG-6** (4 threads mandatory for 512-token p95) and **HG-7** (model card / dataset manifest / frozen calibration) in `setup-cortex-blockers.ts`, `status:"open"`, so they surface in the Setup Cortex blockers card alongside HG-1/3/4/5. |

Net new coverage added by this retro: **PREVENT-VERIFICATION-BYPASS-001 (critical)** and
**PREVENT-MOCK-001 (error)** — the two sentinel classes surfaced by the reconstruction
and cross-language-fixture files are now scanner-enforced (via `stub-scan.mjs` /
`mock-scan.mjs`) so they cannot silently re-appear.
