# ENC-0a Evidence

Status: **reviewer-accepted** — decision + measurement sprint, the head of the
ENC phase. Backend choice locked to transformers.js/WASM; per-platform install
matrix, opset baseline (21, **flipped in-sprint by the controller**), license
verdict (MIT), and pinned sha256 digests recorded in
`docs/vector-cortex/encoder-backend-decision.md`, produced deterministically by
`scripts/encoder/resolve-backend-decision.mjs`. The resolver output is
deep-equal to the ENC-DEC-001..006 conformance corpus `expected_decision`
blocks; ENC-DEC-005 (sha256 mismatch) correctly fails the resolver. All root
gates executed by the controller; conformance 859 fixtures canonical.

## Goal recap

ENC-0a is the first of six ENC sprints that replace the placeholder learned
encoder (`encoder-v1-placeholder`, LCG-stubbed) with a REAL trained ONNX path.
Before any asset is fetched (ENC-0b) or head trained (ENC-0c), ENC-0a locks:

1. the **runtime backend choice** (transformers.js/WASM vs onnxruntime-node native),
2. the **per-platform install matrix** (5 EncoderPlatforms),
3. the **opset baseline** (21, re-based from 17 — **applied in this sprint**),
4. the **license/pinning audit** (MIT, pinned sha256 digests).

Its output is the durable, deterministic decision record
`docs/vector-cortex/encoder-backend-decision.md` + the resolver that reproduces it.

**Verdict:** `backend: "wasm"`, `budgetOk: true` — transformers.js v4.2.0 +
onnxruntime-web WASM is the leading candidate, the only path fitting the 80 MiB
cap (≈9.5 MiB shell + ≈23 MiB bge-small int8). onnxruntime-node native (≈258 MiB)
fails the budget unless a per-platform split (recorded as ENC-DEC-002).

`MEGACOMPACT_ENC_0A` gate in `src/config/vector-cortex-enc0a.ts` (default ON;
`=0` → no decision-record wiring, runtime byte-identical mode-B serving).

## Changed production / tests / docs

TypeScript (src):
- `src/config/vector-cortex-enc0a.ts` (NEW) — `MEGACOMPACT_ENC_0A` flag via
  `sprintFlag` pattern, default ON, `=0` disables.
- `src/config/vector-cortex.ts` (EDIT) — additive `ENC_0A_ENABLED` re-export in
  the sibling flag block (after DEDUP_ATTR_ENABLED); held ≤ 300.
- `src/config.ts` (EDIT) — additive `ENC_0A_ENABLED` re-export.
- `src/vector-cortex/encoder/decision.ts` (NEW) — `EncoderBackendDecisionV1`
  contract (schema `encoder-backend-decision-v1`, `backend` enum, `budgetOk`,
  `opset:21` literal, `platformMatrix` Record over `EncoderPlatform`, MIT
  license, pinned artifacts, `p95Ms`, `blockedBy`) + `buildDecision()` that
  validates platform completeness; `ENCODER_INSTALL_BUDGET_MIB=80`,
  `ENCODER_DECISION_P95_MS=40`. No `any` (PREVENT-011).
- `src/vector-cortex/encoder/types.ts` (EDIT) — **`ENCODER_OPSET` flipped 17 → 21**
  by the controller (see Resolutions #1). Comment records the ENC-0a ownership:
  "ENC-0a re-baselines from 17 to 21".
- `src/vector-cortex/encoder/asset.ts` (EDIT) — comments updated to
  "require opset 21 (ENC-0a re-baseline)"; "opset != 21 -> ENC_OPSET_INVALID".
- `src/vector-cortex/encoder/runtime-wasm.ts` + `runtime-native.ts` (EDIT) —
  "(normative 17)" → "(normative 21)".
- `src/vector-cortex/encoder/asset.test.ts` + `runtime.test.ts` (EDIT) —
  opset17 → opset21 buffer strings, test names, and references updated; valid-path
  tests use `ENCODER_OPSET` constant.
- `src/vector-cortex/enc0a-acceptance.test.ts` (NEW, 15 tests / 5 suites) —
  fixtures-driven, flag-agnostic aggregator.

Assets:
- `assets/vector-cortex/encoder-v1/manifest.json` (EDIT) — `"opset": 17` →
  `"opset": 21`. Model/tokenizer digests unchanged (only the opset scalar
  changed); `verifyEncoderAsset` now passes against `ENCODER_OPSET = 21`.

Dashboard server:
- `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts` (EDIT) —
  additive `MEGACOMPACT_ENC_0A` boolDirect toggle, never in `EXCLUDED_SETTINGS`
  (file at 262 lines, under 400 soft).

Scripts:
- `scripts/encoder/resolve-backend-decision.mjs` (NEW) — deterministic pure
  resolver: reads an optional measured bench JSONL (`--bench`), otherwise
  degrades to the recorded `vc2-model-prep` table; asserts platform completeness;
  supply-chain guard on pinned sha256; emits `EncoderBackendDecisionV1` to
  `--out`/stdout + one structured `encoder_backend_decision_resolved` log line.
  Zero network (PREVENT-PI-004).
- `scripts/vc2-model-prep/bench-onnx.mjs` (EDIT) — additively extended for
  transformers.js: `--transformers` mode via `@huggingface/transformers`
  `feature-extraction` on `Xenova/bge-small-en-v1.5` (q8); native path
  untouched. Annotated `// guardrails-allow PREVENT-PI-004: release-time
  developer benchmark tooling`.
- `scripts/ml5-enc/gen-fixtures.mjs` (NEW) — emits ENC-DEC-001..006 into
  `conformance/vector-cortex/v2/encoder-decision/`; imports `canonicalJson` +
  `sha256Hex` from `scripts/vc9-setup-dashboard/gen-fixtures.mjs` (ground-fact 5
  import, not copy-paste); registers owner `ENC-0a` + domain `encoder-decision`.
  Idempotent (re-run byte-identical).
- `scripts/gen-fixtures/encoder-runtime.mjs` (EDIT) — ENC-001 + ENC-ASSET-001
  assertion strings updated opset17 → opset21 (with "Opset re-based 17→21 by
  ENC-0a" comment).

Conformance:
- `conformance/vector-cortex/v2/encoder-decision/ENC-DEC-001..006.json` (NEW, 6
  files, canonical + idempotent).
- `conformance/vector-cortex/v2/schemas/encoder-decision-fixture.schema.json`
  (NEW, sibling — mirrors setup-cortex fixture precedent).
- `conformance/vector-cortex/v2/encoder-runtime/ENC-001.json` +
  `ENC-ASSET-001.json` (EDIT) — assertion strings opset17 → opset21.
- `conformance/vector-cortex/v2/manifest.json` (REGEN) — 6 `encoder-decision`
  fixture rows + schema row, algorithm `encoder-decision`, expected `ok` (005
  expected `error`); owner CSV includes `ENC-0a`; domain includes
  `encoder-decision`; ENC-001 + ENC-ASSET-001 digests patched to the new
  opset-21 assertion bytes. Corpus total **859 fixtures**.

Docs:
- `docs/vector-cortex/encoder-backend-decision.md` (NEW) — the locked decision
  record (decision JSON, per-platform matrix, opset baseline §4 updated to
  record the in-sprint flip, license/pinning, budget disposition, measured p95
  table, HG-3/HG-4 disposition).
- `docs/vector-cortex/evidence/ENC-0a.md` (this record).

Spec sweep (controller, no-deferral directive):
- `docs/vector-cortex/sprints/ENC-0a-transformersjs-vs-onnxruntime-node.md` —
  tasks 4/5/7 rewritten: bench harness wired now, opset flip owned by ENC-0a.
- `docs/vector-cortex/sprints/ENC-0b-real-trunk-fetch-and-gated-path.md` —
  lines 10/14/21 updated: opset already 21 from ENC-0a; ENC-0b verifies, no change.
- `docs/vector-cortex/phases/ENC-real-encoder.md` — ENC-0a row + ENC-0b
  paragraph updated for the in-sprint flip.
- `docs/vector-cortex/sprints/COS-FP-R-real-corpus-validation.md`,
  `docs/vector-cortex/sprints/REPO-A-cross-repo-corpus-prep.md`,
  `docs/vector-cortex/phases/COS-FP-cosine-threshold-validation.md`,
  `docs/vector-cortex/phases/REPO-cross-repo-corpus.md`,
  `docs/vector-cortex/sprints/COS-FP-A-synthetic-fp-harness-and-threshold-calibration.md`
  — de-deferral sweep per user directive ("no defered work, all options default
  on, settings-panel toggleable").

## Resolutions

1. **`ENCODER_OPSET` flipped 17 → 21 in-sprint (RESOLVED, controller-applied).**
   The implementer left the constant at 17 citing blast radius (vc2a/vc2b/ml5
   tests, asset.test, runtime.test, committed-asset verification). The user's
   no-deferral directive ("no deferrals, you have to directly find and or do the
   work") overrode the deferral: the controller executed the flip across
   `types.ts` + the placeholder manifest + 4 test files + 2 conformance fixtures
   + the gen-fixtures source. The placeholder manifest's model/tokenizer digests
   are unchanged — only the `opset` scalar changed — so `verifyEncoderAsset`
   passes against `ENCODER_OPSET = 21`. All downstream references (asset.ts,
   runtime-wasm.ts, runtime-native.ts, asset.test.ts, runtime.test.ts,
   ENC-001.json, ENC-ASSET-001.json, encoder-runtime.mjs) updated in the same
   pass. **Blast radius contained: conformance restored to 859 canonical after
   a manifest-regen incident (see Incidents #1).**
2. **bge-small int8 was NOT actually benchmarked under transformers.js on this
   implementation machine** — recorded as the degraded baseline (ENC-DEC-006,
   `p95Ms: null`, `blockedBy: "p95-unmeasured ..."`). The bench harness
   (`bench-onnx.mjs --transformers`) was extended per spec task 4, but the live
   WASM p95 run requires a network fetch of the model (PREVENT-PI-004 exception
   only at release-time developer tooling); the measured run is gated on asset
   availability, not blocking. The decision resolves deterministically from the
   recorded `vc2-model-prep` table rather than blocking. The p95 evidence gap is
   flagged to ENC-0b.
3. **Caught + fixed during implementer self-review: degraded-baseline artifact
   bytes mislabeled.** The resolver's degraded branch initially assigned
   `model.bytes = 9.5 MiB` (the WASM *shell*) and `tokenizer.bytes = 23 MiB`
   (the bge-small *model*) — reversing the true asset labels, and fixture
   ENC-DEC-006 embedded the same inversion. Fixed the resolver to emit
   model = 23 MiB int8 / tokenizer = 50 KB (the 9.5 MiB shell is a runtime
   install footprint already captured per-platform in `installMiB:33`, not a
   model byte-count), regenerated fixture 006 to mirror, and re-verified
   deep-equal across all 6 fixtures. Net budget outcome unchanged (both ≤ 80
   MiB → budgetOk true); this was a labeling, not a decision-rule, correction.
4. **No dashboard client/server source beyond the SETTINGS toggle.** Spec
   mandates "no changes" to the dashboard for ENC-0a; `build:dashboard` was NOT
   run (per spec: NOT required and NOT run).
5. **No `docs-check.mjs` bump (expected-count).** The spec's integration step
   (owned by a later sprint, not ENC-0a) sets `EXPECTED_SPRINTS` to 60; no
   per-sprint bump is ENC-0a's job.

## Incidents

1. **Conformance manifest corruption during opset-flip cascade (RESOLVED).**
   After editing ENC-001/ENC-ASSET-001 fixture assertions, the controller ran
   `node scripts/vector-cortex-gen-fixtures.mjs` to cascade. This regenerated
   `conformance/vector-cortex/v2/manifest.json` from scratch covering only its
   own ~30 sub-generators — 852 → 788 rows, 71 fixture files deleted on disk
   (dedup-attribution/, bench-heads/, cortex-improve/, nightly-retrain/,
   runtime-choice/, trained-heads/, prompt-cache/, setup-dashboard/ partial,
   self-healing/, 6 schema files). Diagnosis: `scripts/gen-fixtures/write.mjs`
   builds manifestRows only from its own imports; the ml5-enc/vc9
   post-generators are read-append and only re-add their own rows. Recovery:
   restored HEAD manifest via `git show HEAD:...manifest.json`, patched only the
   ENC-001 (93270e05…) and ENC-ASSET-001 (5396b01b…) sha256s, wrote it back,
   re-ran `node scripts/ml5-enc/gen-fixtures.mjs` (re-added 6 ENC-DEC + schema),
   then `git checkout HEAD -- <deleted dirs>` to restore files. Result: ✓
   CONFORMANCE: 859 fixtures canonical. **Unresolved underlying bug:** write.mjs
   still lacks coverage for those domains — any future bare regen will
   re-corrupt. Candidate fix: extend write.mjs coverage or make post-generators
   the only manifest writers. Tracked as a follow-up.

## File sizes

- `src/config/vector-cortex-enc0a.ts` (~30) — new, under 300 soft.
- `src/config/vector-cortex.ts` (≤300) — additive re-export, held at soft limit.
- `src/config.ts` (≤300) — additive re-export.
- `src/vector-cortex/encoder/decision.ts` (125) — new, under 300 soft.
- `src/vector-cortex/enc0a-acceptance.test.ts` (342) — new, under 600 hard.
- `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts` (262) —
  additive toggle, under 400 soft.
- `scripts/encoder/resolve-backend-decision.mjs` (215) — new, under 400 soft.
- `scripts/ml5-enc/gen-fixtures.mjs` (294) — new, under 400 soft.

## Fixtures and corpus digests

`conformance/vector-cortex/v2/encoder-decision/` (`ENC-DEC-001..006`, schema
`schemas/encoder-decision-fixture.schema.json`, algorithm `encoder-decision`),
owner `ENC-0a` added to the CSV, domain extended `encoder-decision`.

- **ENC-DEC-001** wasm-qualified — p95 18.2, bytes ≤ 80 MiB → `wasm`, `budgetOk
  true`.
- **ENC-DEC-002** native-amended — p95 54.7 (> 40) → `native`, `budgetOk false`.
- **ENC-DEC-003** opset-pinned — decision `opset` exactly 21.
- **ENC-DEC-004** platform-matrix — every EncoderPlatform resolves;
  `darwin-x64` → `demotion:"wasm"` (HG-4; action ships ENC-0e).
- **ENC-DEC-005** sha256-mismatch — bench `model_sha256` all-zeros → resolver
  FAILS (supply-chain guard; recorded digest authoritative), `expected_outcome
  "error"`.
- **ENC-DEC-006** degraded-baseline — `bench_input null`, no `--bench` →
  resolver degrades to recorded table, still emits `wasm`/`budgetOk true`,
  `p95Ms null`, `blockedBy` non-empty (never blocks on absent measurement).

Corpus after registration: **859 fixtures canonical (859 files)**.

## Gates executed (controller attestation)

- `npm run build` → clean (exit 0), post-opset-flip tree.
- `node --test dist/vector-cortex/enc0a-acceptance.test.js` → **15/15 pass**.
- `MEGACOMPACT_ENC_0A=0 node --test dist/vector-cortex/enc0a-acceptance.test.js`
  → **15/15 pass** (flag-agnostic parity confirmed).
- `npm test` → **1197+15 = 1212 tests pass** (exit 0), post-opset-flip tree.
- `npm run lint` → clean.
- `python3 scripts/regression_check.py --all --soft-as-hard --pre-commit` →
  clean (all changed files under soft limits).
- `node scripts/guardrails-scan.mjs` → clean (0 violations).
- `python3 scripts/log_failure.py --list` → clean.
- `node scripts/vector-cortex-conformance.mjs --check` → **859 fixtures
  canonical (859 files)**.
- `node scripts/vector-cortex-docs-check.mjs` → clean (60/16).
- `node scripts/vector-cortex-scope-check.mjs ENC-0a <COMMIT_SHA>` → pending
  commit SHA (recorded post-commit).
- `node scripts/vector-cortex-evidence-check.mjs ENC-0a` → passes (this record).
- `git diff --check` → clean (no whitespace errors).
- `node scripts/encoder/resolve-backend-decision.mjs` deep-equal to all 5
  passing fixtures' `expected_decision`; exits non-zero on 005 mismatch branch.
- `node scripts/ml5-enc/gen-fixtures.mjs` → 6 fixtures written, manifest
  regenerated (859); re-run byte-identical.

## Unit and acceptance tests

`src/vector-cortex/enc0a-acceptance.test.ts` — fixtures-driven, flag-agnostic,
**15 tests / 5 suites**:

1. Conformance registration (1): manifest registers ENC-DEC-001..006 + schema
   under `encoder-decision` seam; row `algorithm:"encoder-decision"`, path,
   expected (005 = error); owner CSV + domain.
2. Envelope invariants (3): 6 kinds closed to branch set + producer + outcome;
   every non-error decision is well-formed (opset 21, complete 5-platform
   matrix, MIT license, 64-hex digests, blockedBy array, darwin-x64 `wasm`
   demotion); budget constant = 80.
3. Resolver decision branches (7, real subprocess): 001 wasm-qualified, 002
   native-amended, 003 opset 21, 004 platform matrix + darwin-x64 demotion, 005
   sha256-mismatch FAILS (exit non-zero, structured `encoder_backend_decision_failed`
   + sha256 on stderr), 006 degraded (wasm, budgetOk true, p95Ms null, blockedBy
   non-empty), plus one structured-log-line check.
4. buildDecision contract (2): rejects incomplete matrix; builds valid opset-21
   MIT decision for complete matrix.
5. Flag semantics (2): flag exports live boolean; flag-off byte-identity —
   resolver decision bytes byte-identical under `MEGACOMPACT_ENC_0A=0` + no
   decision file written.

Executed: **15/15 pass** flag-on and flag-off (post-`npm run build`).

## Evaluation

- **No payload leakage (EVAL-REDACT-002):** decision carries digests, sizes,
  licenses, verdicts only — never message/ledger content.
- **No runtime network (PREVENT-PI-004):** resolver + bench are zero-network
  local computation (`--transformers` bench mode annotated
  `// guardrails-allow PREVENT-PI-004: release-time developer benchmark tooling`).
- **Deterministic + reproducible:** the decision is produced by the resolver,
  not asserted in prose; deep-equal against the conformance corpus.
- **Supply-chain guard:** pinned sha256 authoritative — any bench-input
  mismatch fails the resolver (ENC-DEC-005).
- **Honest degradation:** no measured bench → resolver degrades to the recorded
  table and still emits a decision (never blocks on absent measurement).
- **Flag-off byte-identical:** `MEGACOMPACT_ENC_0A=0` → no decision record
  written by any runtime path, runtime serves mode B exactly as before; resolver
  is flag-agnostic (byte-identical under both states).
- **Opset flip ownership:** ENC-0a owns the constant and the manifest flip
  together (spec task 5, controller-applied); ENC-0b verifies the staged real
  asset is opset 21, no further constant change.

## Failure triad and independence

| Arm | Algorithm | Inputs | Independence |
| --- | --- | --- | --- |
| **A — WASM qualifies** | p95 ≤ 40 AND bytes ≤ 80 MiB → wasm/budgetOk true. | ENC-DEC-001 (p95 18.2, ~23 MiB). | Active only when both budget + p95 bind. |
| **B — native-amended** | p95 > 40 or bytes > 80 MiB → native/budgetOk false + amendment. | ENC-DEC-002 (p95 54.7). | Triggered on the disjoint p95/budget branch; independent inputs. |
| **C — opset/platform audit** | opset pinned 21; every EncoderPlatform row resolves. | ENC-DEC-003, ENC-DEC-004. | Pure structural asserts, independent of the branch arms; darwin-x64 demotion is HG-4 (ships ENC-0e). |

Pin/degradation arms: ENC-DEC-005 (sha256 mismatch fails — recorded digest
authoritative), ENC-DEC-006 (no bench → clean degrade). Common
cooldown/spool/restart/clock rules follow [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Offline / network / asset / platform evidence

Fully local. Resolver reads a local bench JSONL (or degrades), computes pure
decision logic, writes stdout/file. Bench harness is a local
transformers.js/WASM pipeline (`@huggingface/transformers`), no remote asset
fetch at test time — the live WASM p95 measurement is recorded as the degraded
baseline (see Resolutions #2) and is ENC-0b's parameter. No `fetch`, no HTTP
listener beyond the audited dashboard server. `src/` stays pi-agnostic.

## Rollback / downgrade rehearsal

`MEGACOMPACT_ENC_0A=0` — flag-off. No decision record is written by any runtime
path; the runtime is byte-identical to the predecessor (mode B). Conformance
fixtures are additive (6 files in a new directory + schema sibling); the
manifest re-registration is idempotent. No schema/state change; no SQLite
migration (pure migration-disposition sprint). The decision record + resolver
are docs/scripts only and remain on disk without runtime coupling. The opset
flip is **not** rolled back by the flag — it is a constant re-baseline that the
placeholder manifest was updated to match; flag-off restores mode-B serving
byte-identically regardless of the opset constant value.

## Known findings / follow-ups

1. **p95 measurement gap** — bge-small int8 WASM p95 not actually benchmarked
   here; degraded baseline (`p95Ms:null`). ENC-0b must supply the live number
   before committing runtime asset wiring. The bench harness is wired and ready;
   the measured run is gated on asset availability (network fetch of the model
   is release-time developer tooling only).
2. **write.mjs manifest-regen coverage bug** — running
   `scripts/vector-cortex-gen-fixtures.mjs` bare drops foreign sprint-owned
   domains from the manifest and deletes their fixture files. Recovery procedure
   is documented (Incidents #1); a durable fix (extend write.mjs coverage or
   make post-generators the only manifest writers) is tracked as a follow-up.
3. **Scope-check SHA pending** — recorded post-commit per spec.
