# ENC-0e Evidence

Status: **reviewer-accepted** (controller review complete — see gates + fixes
below). Depends on ENC-0d (commit `4843c3e`,
reviewer-accepted). Closes HG-4's operator-visibility gap on macOS Intel
(`darwin-x64`): the platform has no native onnxruntime-node binary upstream
(arm64-only), so the runtime demotes to **mode-B WASM** per HG-4 — ENC-0e makes
that demotion **explicit, measured, and visible** by computing a deterministic
demotion reason on the ML5-C runtime-selection event and surfacing it on the
existing **Setup Cortex blockers card**, so an Intel-Mac operator sees exactly
why mode A is unreachable.

## Goal recap (from spec §Goal)

`selectRuntimeBackend` (the ENC-0b survivor's ML5-C decision rule) already
returns `backend:"wasm"` for `darwin-x64`. The demotion reason is **derived, not
hard-coded**: on `darwin-x64` the resolver reads the ENC-0a platform matrix
(`runtime:"wasm", demotion:"wasm"`) and emits `vector_cortex_runtime_selected`
with `{backend:"wasm", demotionReason:"darwin-x64: no native binary upstream
(arm64-only); mode-B WASM per HG-4"}`. The dashboard Setup card
(`CortexBlockersCard` in `SetupTab/CortexSetup.tsx`) renders that reason as an
explicitly-diagnosed blocker row instead of a bare "demoted" state. The
reason is computed via a **platform-injectable seam** (the platform is an INPUT
to `selectRuntimeBackend`), so tests inject `platform:"darwin-x64"` with no
real Mac required.

`MEGACOMPACT_ENC_0E` gate (default ON; `=0` strips ONLY the reason surface: no
`demotionReason` on the runtime-selection event, no Setup card row). The ML5-C
WASM demotion itself is NOT gated off — flag-off is byte-identical to the
ENC-0d predecessor. Flag lives in `src/config/vector-cortex-enc0e.ts`,
re-exported by `vector-cortex.ts` + `src/config.ts`, registered as a visible
boolDirect toggle (`routes-rag-settings-vector-cortex.ts`, never
`EXCLUDED_SETTINGS`).

## Failure triad and resolution (per spec §failure-triad)

- **A (darwin-demoted):** on an injected `platform:"darwin-x64"`,
  `selectRuntimeBackend` returns `backend:"wasm"` with the concrete
  `demotionReason` and the enriched event carries it — pinned by
  **ENC-DEMO-001**.
- **B (non-darwin-control):** on `linux-x64`/`darwin-arm64`, no demotion reason
  is produced and the existing WASM/native rule is unchanged (bench-qualified
  WASM and native opt-in both carry `demotionReason:null`) — pinned by
  **ENC-DEMO-002**.
- **C (flag-off surface):** `MEGACOMPACT_ENC_0E=0` strips the reason from the
  event and the Setup card renders no demotion row — byte-identical to the
  ENC-0b predecessor — pinned by **ENC-DEMO-003** (event) and **ENC-DEMO-004**
  (card).

The card + contract are pinned by 505 (the `darwinX64:{demoted:true,reason}`
payload renders the diagnosed row) and 506 (non-darwin hosts omit `darwinX64`,
contract stays additive and validates). A is produced by the
injectable-platform demotion; B by the control platforms; C purely by the flag
gate. Common cooldown/spool/restart/clock rules are normative in
`docs/vector-cortex/TRIAD_RESILIENCE.md`.

## Resolution table (per failure mode)

| Fixture | Kind | Failure mode exercised | Asserted result |
| --- | --- | --- | --- |
| ENC-DEMO-001 | `darwin-demoted` | darwin-x64 → backend wasm + concrete reason on the event | `{backend:"wasm", demotionReason:…HG-4…, event:"vector_cortex_runtime_selected"}`, ok |
| ENC-DEMO-002 | `non-darwin-control` | linux-x64/darwin-arm64 → no reason, existing rule unchanged | `{backend:"native", demotionReason:null}`, ok |
| ENC-DEMO-003 | `flag-off-event` | flag-off → event has no demotionReason | `{backend:"wasm", demotionReason:null}`, ok |
| ENC-DEMO-004 | `flag-off-card` | flag-off → no darwinX64 on status, card unchanged | `{darwinX64_absent:true, card_demotion_row:false}`, ok |
| ENC-DEMO-005 | `card-renders-reason` | payload darwinX64:{demoted:true,reason} renders diagnosed row | `{demoted:true, card_demotion_row:true}`, ok |
| ENC-DEMO-006 | `contract-additive` | non-darwin hosts omit darwinX64, still validate | `{darwinX64_absent:true, contract_validates:true}`, ok |

## Canonical reason string (single source)

`src/vector-cortex/encoder/decision.ts` defines the single canonical string:

```
DARWIN_X64_DEMOTION_REASON =
  "darwin-x64: no native binary upstream (arm64-only); mode-B WASM per HG-4"
```

It is consumed by `runtime-select.ts` (the runtime-selection event) and flows
to the Setup card. A deterministic sentinel
(`DARWIN_X64_DEMOTION_REASON_SENTINEL`) covers the unique-failure-injection case
(a darwin-x64 platform-matrix row that exists but lacks the reason) — the
selection still chooses mode-B WASM and never throws nor fabricates a native
claim. No string literal for this reason survives anywhere else in src/routes
(asserted by the aggregator's single-source scan).

## Platform-injected darwin-x64 selection (no real Mac)

The pure seam is `selectRuntimeBackend({platform, benchRecord, nativeOptIn})` —
the platform is an input, so the aggregator injects `platform:"darwin-x64"`
(and control platforms) with no real Intel Mac:

```json
{"backend":"wasm","budgetOk":true,"p95Ms":null,"platform":"darwin-x64",
 "rationale":"darwin-x64 demoted to WASM per HG-4 (never native on this platform)",
 "demotionReason":"darwin-x64: no native binary upstream (arm64-only); mode-B WASM per HG-4"}
```

The enriched `vector_cortex_runtime_selected` event carries `demotionReason`
additively when present (non-fatal; the event writer never throws).

## Contract + card

- `SetupCortexStatusResponse` (server `api-contracts/setup-cortex.ts` + client
  `types/setup-cortex.ts`) gains `darwinX64?: {demoted:boolean; reason?:string}`
  (additive, explicit types, no `any`). Consumed by the reader-only
  `GET /api/setup-cortex-status`.
- `routes-setup-cortex.ts` (`darwinX64StatusBlock`) populates `darwinX64` from
  the pure runtime selection — demoted = `backend==="wasm" && platform===
  "darwin-x64"`, reason from `demotionReason`. Non-darwin hosts / flag-off
  omit the field (null). No new route, no `EXPECTED_ENDPOINT_COUNT` bump.
- `CortexBlockersCard.tsx` renders the diagnosed HG-4 reason row when
  `darwinX64.demoted === true`; unaffected when absent.
- `setup-cortex-blockers.ts` HG-4 resolution surfaced the darwin-x64 reason.

## Fixtures

`conformance/vector-cortex/v2/encoder-demotion/` (`ENC-DEMO-001..006`, schema
`schemas/encoder-demotion-fixture.schema.json`, algorithm `encoder-demotion`),
owner `ENC-0e` added to the CSV, domain + schemaVersion extended
`encoder-demotion` / `encoder-demotion-fixture`. All six fixtures are canonical
(UTF-8 NFC, sorted keys, LF final) and the generator is idempotent (re-run
byte-identical on `conformance/vector-cortex/v2/manifest.json`; proof below).

## Changed production / tests / docs (this slice)

Production:
- `src/config/vector-cortex-enc0e.ts` (NEW, 42) — `ENC_0E_ENABLED` flag sibling extract.
- `src/config/vector-cortex.ts` (edits) — `ENC_0E_ENABLED` re-export added.
  NOTE: this pushes the file to 301 lines (1 over the 300 soft cap); flagged for
  the controller — see the gates checkpoint / rollback notes.
- `src/config.ts` (EDIT) — `ENC_0E_ENABLED` after `ENC_0D_ENABLED`.
- `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts` (EDIT) —
  boolDirect `MEGACOMPACT_ENC_0E` toggle "ENC-0e darwin-x64 Demotion Reason".
- `src/vector-cortex/encoder/decision.ts` (EVOLVED → 152) — exported
  `DARWIN_X64_DEMOTION_REASON` + `DARWIN_X64_DEMOTION_REASON_SENTINEL`;
  `EncoderPlatformRow` gains optional `demotionReason?: string`.
- `src/vector-cortex/encoder/runtime-select.ts` (EVOLVED → 212) —
  `RuntimeSelectionResult` gains `demotionReason: string | null`; pure helper
  `darwinX64DemotionReason(provider)`; darwin-x64 returns wasm + reason under
  flag ON, null under flag-off and on every other branch.
- `src/vector-cortex/encoder/runtime-emit.ts` (EVOLVED → 64) — additively
  carries `demotionReason` on `vector_cortex_runtime_selected` when present;
  non-fatal.
- `extensions/dashboard-server/api-contracts/setup-cortex.ts` (EDIT → 134) —
  additive `darwinX64?` field.
- `extensions/dashboard-server/routes-setup-cortex.ts` (EDIT → 201) —
  `darwinX64StatusBlock` helper + additive `darwinX64` on the status payload.
- `extensions/dashboard-server/setup-cortex-blockers.ts` (EDIT → 99) — HG-4
  resolution surfaces the darwin-x64 reason.
- `extensions/dashboard-client/src/types/setup-cortex.ts` (EDIT → 128) —
  client mirror of the `darwinX64?` contract field.
- `extensions/dashboard-client/src/tabs/SetupTab/CortexBlockersCard.tsx`
  (EVOLVED → 90) — renders the darwin-x64 demotion reason row when demoted.
- `extensions/dashboard-client/src/tabs/SetupTab/CortexSetup.tsx` (EDIT → 54) —
  passes `darwinX64` down to the card.

Scripts:
- `scripts/ml5-enc/gen-fixtures.mjs` (EDIT, additive → 931) — ENC-DEMO-001..006
  registered, owner ENC-0e, `algorithm: encoder-demotion`, schema
  `schemas/encoder-demotion-fixture.schema.json` (schemaCount 4→5); idempotent
  (re-run byte-identical; proof below).

Tests:
- `src/vector-cortex/enc0e-acceptance.test.ts` (NEW, 295) — registration +
  kind-closure; platform-injected darwin-x64 selection (wasm + canonical reason
  under ON, null under =0); purity (same inputs → same output); single-source
  reason scan (no scattered literals); non-darwin control (linux/darwin-arm64
  unchanged, WASM-qualify unchanged); flag-off byte-identity; contract
  additivity source-pin (optional `darwinX64?`, no `any`); card source-pin
  (`demoted === true` + reason render); sentinel fallback (missing-reason row →
  sentinel, never a throw / never a fabricated native claim); evidence-doc
  presence. Flag-agnostic — passes with the flag ON or OFF.

Conformance:
- `conformance/vector-cortex/v2/encoder-demotion/ENC-DEMO-001..006.json` (NEW)
  + `schemas/encoder-demotion-fixture.schema.json` (NEW).

Docs:
- `docs/vector-cortex/evidence/ENC-0e.md` (this record).
- `docs/vector-cortex/sprints/ENC-0e-darwin-x64-demotion.md` (EDIT) —
  Production ownership kept as semicolon-separated backtick paths (the
  scope-check parser splits on `[;\s]+` against a `/regex/` matcher; one path
  per backtick, all touched files including the spec itself with `(this file)`).

## Idempotency proof

`node scripts/ml5-enc/gen-fixtures.mjs` run twice; the second run is
byte-identical on `conformance/vector-cortex/v2/manifest.json`:

```
run1 sha256: 967e7ca10631c2b297ed7cd59e973fd775c09df4654c70d65490263309a94124
run2 sha256: 967e7ca10631c2b297ed7cd59e973fd775c09df4654c70d65490263309a94124
```

Conformance check: `node scripts/vector-cortex-conformance.mjs --check` →
`887 fixtures canonical (887 files)` (was 880; +6 ENC-DEMO fixtures +1 schema
row).

## Gates checkpoint (controller — all green)

- [x] `npm run build` → clean (`tsc -p tsconfig.json` + postbuild
      publish-acceptance, `51 acceptance + … + 1 dedup-attr files`).
- [x] `node --test dist/vector-cortex/enc0e-acceptance.test.js` → **16 pass / 0
      fail** (flag ON).
- [x] `MEGACOMPACT_ENC_0E=0 node --test dist/vector-cortex/enc0e-acceptance.test.js`
      → **16 pass / 0 fail** (flag-off byte-parity; aggregator flag-agnostic).
- [x] `node scripts/ml5-enc/gen-fixtures.mjs` → idempotent, manifest sha256
      `967e7ca1…a94124` on both runs; `node scripts/vector-cortex-conformance.mjs
      --check` → **887 fixtures canonical (887 files)** (+6 ENC-DEMO + 1 schema).
- [x] `npm test` → **TOTAL: 3904 passed, 0 failed across 383 files**.
- [x] `npm run lint` → pi-pattern scan clean + semantic scan clean
      (SEMANTIC-001).
- [x] `python3 scripts/regression_check.py --all` → 0 blocking (7 dev-only
      warnings unchanged).
- [x] `python3 scripts/regression_check.py --soft-as-hard --pre-commit
      --soft-as-hard-base v0.20.46` → no touched file over its soft cap
      (see the barrel refactor fix below — `vector-cortex.ts` 78 after the
      extract, `vector-cortex-vc3to8.ts` 256, everything else under cap).
- [x] `node scripts/guardrails-scan.mjs` → clean (PREVENT-PI pattern + semantic).
- [x] `node scripts/vector-cortex-docs-check.mjs` → clean (60 sprints / 16
      phases, links+flags+commands+migrations clean).
- [x] `node scripts/vector-cortex-scope-check.mjs ENC-0e 41df543` (amended SHA)
      → **all 27 committed file(s) inside Production ownership + cross-cutting
      seams** (the two initially-out-of-scope files were added to the spec
      ownership block before the amend — see fixes below).
- [x] `node scripts/vector-cortex-evidence-check.mjs ENC-0e` → **1 record, 0
      mismatches, 0 warnings**.
- [x] `cd extensions/dashboard-client && npm run typecheck && npm run build` →
      typecheck clean, build **✓ built in 2.96s**.
- [x] `git diff --check` → clean (no whitespace/EOF errors).

### Controller review fixes (all caught + fixed pre-publish)

1. **Implementer-flagged cap crossing → fixed via barrel refactor.** The worker
   correctly refused to hack the `vector-cortex.ts` 301-line cap. Controller
   extracted VC3A–VC8B into a new sibling `src/config/vector-cortex-vc3to8.ts`
   (256 lines) following the existing `vector-cortex-early.ts` precedent; the
   barrel is now a pure re-export shell at 78 lines. All VC3A–VC8B import paths
   are unchanged (re-export-only). One TS6133 drag (unused `sprintFlag` import
   in the now-pure barrel) removed.
2. **ml5c-acceptance event-shape fix.** ENC-0e's additive `demotionReason` field
   legitimately extended the runtime-selection result shape; the pre-existing
   `allowed = new Set(...)` + `pinned = [...]` sets in
   `src/vector-cortex/ml5c-acceptance.test.ts` pinned the ML5-C-era field list.
   Extended both sets additively (`demotionReason` is aggregate-only — never
   payload, so EVAL-REDACT-002 unchanged). Suite back to 0 failed.
3. **Spec ownership block amended** to include the two real production-owned
   files the scope-check flagged (`vector-cortex-vc3to8.ts` +
   `ml5c-acceptance.test.ts`) — the brief hadn't listed them because the barrel
   refactor was a controller-side decision made after the worker reported.

## Live Playwright validation (spec §Live Playwright validation)

The Setup Cortex blockers card renders the `darwinX64` demotion reason row when
`darwinX64.demoted === true`. The **source-pins** in
`enc0e-acceptance.test.ts` assert the card's render precondition (the
`darwinX64` prop path, the `demoted === true` gate, the reason interpolation)
and the contract's additive optionality. **The live DOM render is
device-side:** `extensions/dashboard-server.ts` is a pi-extension entry that
imports pi-runtime-only modules and cannot be launched by standalone `node` on
this dev host (confirmed with v0.20.46 — see
`docs/vector-cortex/evidence/ENC-0d.md`'s verification-constraint note), so the
mandatory Playwright step runs on the device after `pi update --extensions`
(host reachable at `http://localhost:9320`, navigate to Setup → Cortex, confirm
the HG-4 demotion row + zero console errors). The compiled bundle carries the
card change (`CortexBlockersCard.tsx` → dist hash-asset) and the server route
ships the additive field; the device-side render check is recorded in the
device-side verification routine.

Controller attestation: all thirteen gates green + both controller review
defects fixed + the round-trip from v0.20.46 preserved ENC-0d's published
state (no ENC-0d files touched except the additive ml5c-acceptance shape +
the ENC-0e-additive `routes-setup-cortex.ts`/`CortexBlockersCard.tsx`). Status
is **reviewer-accepted**.

## Migration, privacy, dashboard, rollback

Migration disposition: **pure — no schema/state changes.** The demotion reason
is computed at runtime-selection time and read back via the existing
reader-only `GET /api/setup-cortex-status`; the store schema and `stateDir`
tables are untouched. Privacy follows SECURITY_PRIVACY + EVAL-REDACT-002 — the
surfaced payload is a platform/reason/backend triple, never exact ledger bytes
or prompt content. Rollback sets `MEGACOMPACT_ENC_0E=0`; the runtime-selection
event carries no demotion reason and the Setup card renders byte-identical to
the ENC-0d predecessor — without deleting card code or evidence. The conformance
fixtures are additive (6 files + schema sibling); the manifest re-registration
is idempotent. No operator migration.
