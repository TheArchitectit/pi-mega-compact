# ENC-0e Evidence

Status: **implementer-complete** (awaiting controller review; the controller
bumps to reviewer-accepted). Depends on ENC-0d (commit `4843c3e`,
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

## Gates checkpoint

Controller fills (checked boxes below reflect the controller's run; the
implementer ran the ENC-0e aggregator both flag states + the dashboard-client
build).

- [ ] `npm run build` → clean (`tsc -p tsconfig.json`, postbuild publish-acceptance clean).
- [ ] `node --test dist/vector-cortex/enc0e-acceptance.test.js` → to be stamped.
- [ ] `MEGACOMPACT_ENC_0E=0 node --test dist/vector-cortex/enc0e-acceptance.test.js` → to be stamped.
- [ ] `node scripts/ml5-enc/gen-fixtures.mjs` → idempotent, manifest sha256
      `967e7ca1…a94124` on both runs (
`node scripts/vector-cortex-conformance.mjs --check` → `887 fixtures canonical`).
- [ ] `npm test` → to be stamped (deferred to controller; ~3900 tests).
- [ ] `npm run lint` → to be stamped.
- [ ] `python3 scripts/regression_check.py --all` → to be stamped.
- [ ] `node scripts/guardrails-scan.mjs` → to be stamped.
- [ ] `node scripts/vector-cortex-docs-check.mjs` → to be stamped
      (EXPECTED_SPRINTS reconciles to 60 at integration time, cross-cutting).
- [ ] `node scripts/vector-cortex-scope-check.mjs ENC-0e <COMMIT_SHA>` → to be stamped (post commit).
- [ ] `node scripts/vector-cortex-evidence-check.mjs ENC-0e` → to be stamped.
- [ ] `cd extensions/dashboard-client && npm run typecheck && npm run build` → ran by implementer (client card touched).
- [ ] `git diff --check` → clean (no EOF whitespace).

### Implementer-flagged cap crossing (controller decision required)

`src/config/vector-cortex.ts` is now **301 lines** (+1 re-export line for
`ENC_0E_ENABLED`) — 1 over the 300 soft cap (the soft-as-hard gate BLOCKS
changed files over their soft limit). This was explicitly predicted in the
brief. Options for the controller: (a) accept 301 for this pure re-export
barrel (the precedent ENC-0d assertions the barrel at exactly 300), or
(b) instruct a delegate-barrel/impl split or a one-line tightening. The
implementer did NOT hack around it (no squeezed comments / no removing the
breaker-comment to game the count). All other touched `src/`/`extensions/`/
client files are within their caps.

## Live Playwright validation (MANDATORY per spec §Live Playwright validation)

To be stamped by the controller: launch the dashboard (default
`http://localhost:9320`), navigate to the Setup surface, render the
Cortex blockers card, and assert the `darwinX64` demotion reason is visible in
the DOM with zero console errors. The card renders the reason row when
`darwinX64.demoted === true`. If no reachable dashboard host exists, the sprint
pauses at implementer-complete until a live host is available; the evidence
names the host and the rendered card output. (Controller stamps this after
review.)

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
