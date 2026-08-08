# ENC-2c Evidence — Native ONNX runtime lazy-download install action

Status: **implementer-complete** — the third and final ENC-2 instalment
(ENC-2a install guide, ENC-2b native qualification retest, ENC-2c lazy-download
upgrade). The sprint turns ENC-2a's operator run-script assist into a dashboard
action: a confirm-gated **Install Native ORT** button on the Setup Cortex sub-tab
that, on confirmation, runs the committed `scripts/encoder/install-native-ort.mjs`
subprocess locally (npm-delegated, sha256-verified) and then re-qualifies the
binding via the ENC-2b retest path, surfacing the fresh verdict + effective
backend on the action result.

## Sprint meta

- **Spec:** docs/vector-cortex/sprints/ENC-2c-lazy-download-upgrade.md
- **Sprint ID string:** `ENC-2c` (owner CSV + manifest registration, algorithm
  `setup-cortex-action`, domain `native-ort-install-action`)
- **Flag:** `MEGACOMPACT_ENC_2C` — boolDirect, default ON;
  `MEGACOMPACT_ENC_2C=0` restores the ENC-2b predecessor byte-identically (no
  install action POST branch, no UI button, no install result fields). Registered
  as a visible `VECTOR_CORTEX_SETTINGS` toggle, never in `EXCLUDED_SETTINGS`.

## Production ownership files (final state)

- `src/config/vector-cortex-enc2c.ts` (40) — `ENC_2C_ENABLED()` positive sprint
  flag sibling, default ON; `=0` disables. Carries a `// guardrails-allow
  PREVENT-PI-004` annotation describing the opt-in confirm-gated install exemption
  (no URL literals; registry URL + sha256 live only in native-install-artifacts.ts).
- `src/config/vector-cortex.ts` (116) — additive re-export (+2 lines).
- `src/config.ts` (228) — additive re-export (+1 line).
- `src/vector-cortex/setup-cortex-blockers-compute.ts` (245) — `SetupCortexActionKind`
  widened with `install-native-ort`; `ACTION_GATE_CANDIDATES` adds
  `"install-native-ort": ["HG-3"]` — the install waits on the install-budget hard
  gate, and a closed HG-3 no longer blocks it.
- `extensions/dashboard-server/api-contracts/setup-cortex.ts` (139) — base
  `SetupCortexActionKind` widened with `install-native-ort` (single source of
  truth for the action union).
- `extensions/dashboard-server/api-contracts/setup-cortex-native-ort.ts` (52) — NEW
  contract: `SetupCortexActionResultWithNativeOrt` extends `SetupCortexActionResult`
  with `nativeOrtRetestResult?: NativeOrtRetestResult | null` and
  `nativeOrtBackendEffective?: "native" | "wasm"`; local `NativeOrtRetestResult`
  interface (platform/version/verdict/p95Ms/rssMiB/testedAt) declared here, NOT
  imported from src (self-contained extensions-layer contract).
- `extensions/dashboard-server/setup-cortex-actions.ts` (267) — `runSetupCortexAction`
  is now async; `install-native-ort` delegates to the new sibling
  `runInstallNativeOrt`. Header doc updated.
- `extensions/dashboard-server/setup-cortex-actions-native-ort.ts` (121) — NEW
  driver: locates the committed `scripts/encoder/install-native-ort.mjs` by
  repo-root walk, `spawnSync(process.execPath, [script])` 60s timeout, logs to
  `<stateDir>/logs/vc9b/install-native-ort-<ts>.log`, then ALWAYS re-qualifies via
  `runNativeRetest` (imported from the compiled dist path) regardless of install
  exit code. Returns the combined result incl. retest fields.
  PREVENT-PI-004 opt-in exemption annotated on the module header AND on the
  spawnSync call (confirm-gated, npm-delegated, no URL literals).
- `extensions/dashboard-server/routes-setup-cortex-actions.ts` (191) — ACTION_KINDS
  adds `install-native-ort`; the POST branch awaits `runSetupCortexAction`; the
  action is recognized ONLY while `ENC_2C_ENABLED()` (flag-off → invalid_action,
  byte-identical ENC-2b predecessor). Header doc updated.
- `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts` (378) —
  boolDirect `MEGACOMPACT_ENC_2C` toggle.
- `src/vector-cortex/enc2c-acceptance.test.ts` (196) — 17-test aggregator.
- `extensions/dashboard-server/setup-cortex-actions-native-ort.test.ts` (137) —
  5-test driver + route unit tests.
- `scripts/vc9-setup-dashboard/gen-fixtures-enc2c.mjs` (253) — NEW additive fixture
  generator (SETUP-CORTEX-034..038 + widened schema).
- `conformance/vector-cortex/v2/setup-dashboard/SETUP-CORTEX-{034..038}.json` +
  widened schema `schemas/setup-cortex-action-fixture.schema.json`.
- `extensions/dashboard-client/src/types/setup-cortex.ts` (149) — client `action
  kind` union widened with `install-native-ort`; `SetupCortexActionResult` gains
  `nativeOrtRetestResult?` + `nativeOrtBackendEffective?`; local `NativeOrtRetestResult`.
- `extensions/dashboard-client/src/tabs/SetupTab/CortexActionsCard.tsx` (305) —
  install action rendered ONLY while the native binding is absent (polls
  `/api/setup-status` `nativeOrtInstalledVersion`); on success renders the fresh
  verdict/p95/RSS/backend from `nativeOrtRetestResult` in the result area.

Intentionally NOT touched: `src/vector-cortex/encoder/native-qualify-retest.ts`
(the ENC-2b retest module is reused unchanged); `native-install-artifacts.ts`
(registry URL + sha256 stay the single home); ANY network path in src/ or
extensions/ (PREVENT-PI-004 clean — the install is a local subprocess of a
committed repo script, no URL literals); ANY training code (HG-1 unchanged).

## Behavior enforced (the sprint's hard guarantees)

1. **Confirm-gated install** — `install-native-ort` requires `confirm:true`;
   anything else → 400 `confirmation_required`, no spawn. Fixture SETUP-CORTEX-035.
2. **HG-3 block gate** — with HG-3 open (the default in-workstream), the install is
   blocked → 423 `action_blocked_by_open_item` with `["HG-3"]` surfaced and NO
   install subprocess spawns. Fixture SETUP-CORTEX-034.
3. **Flag-off byte-identical** — `MEGACOMPACT_ENC_2C=0` makes `install-native-ort`
   an unrecognized action → 400 `invalid_action`, byte-identical to the ENC-2b
   predecessor (no install action exists). Fixture SETUP-CORTEX-036.
4. **Auto re-qualification** — after the install subprocess runs (regardless of
   exit code) the ENC-2b retest ALWAYS runs; the result carries
   `nativeOrtRetestResult` + `nativeOrtBackendEffective` ("native" iff qualified,
   else "wasm"). Fixture SETUP-CORTEX-037 (`auto_retest: true`).
5. **No-network guard** — the driver carries NO URL literals and no fetch; the
   install is npm-delegated to the committed local script (PREVENT-PI-004 opt-in
   exemption, confirm-gated). Fixture SETUP-CORTEX-038 (`no_url_literal: true`).

## HG-3 mechanism

HG-3 (the open install-budget hard gate) STAYS OPEN in-workstream and gates the
install action — it is not closed by ENC-2c. What ENC-2c delivers is the
*closeable-by-action* surface: once the operator closes HG-3, `install-native-ort`
becomes eligible to run (its `ACTION_GATE_CANDIDATES` entry is `["HG-3"]` only),
and a closed HG-3 no longer blocks it. Until then the route returns 423 and no
spawn occurs — the block-gate test asserts this exactly.

## Conformance fixtures

- `SETUP-CORTEX-034` — install-native-ort, confirm:true, HG-3 open → 423,
  blocker_ids `["HG-3"]`, no_spawn:true.
- `SETUP-CORTEX-035` — install-native-ort, confirm:false → 400
  confirmation_required, no_spawn:true.
- `SETUP-CORTEX-036` — ENC-2c flag-off → 400 invalid_action (byte-identical).
- `SETUP-CORTEX-037` — success (once HG-3 closed) → 200, auto_retest:true,
  no_url_literal:true.
- `SETUP-CORTEX-038` — no_url_literal guard (driver source carries no URL).
- Schema `schemas/setup-cortex-action-fixture.schema.json` widened: `action` enum
  adds `install-native-ort`; additive `enc2c_off` / `auto_retest` / `no_url_literal`
  boolean pins. All canonical (UTF-8 NFC, sorted keys, LF-final) + sha256-pinned.
  Owner CSV +ENC-2c; domain `native-ort-install-action`; fixture count grows by 5
  (959 → 964, plus schema row).

## Test outcomes (HEAD, flag-agnostic)

- [x] `npm run build` → clean (tsc -p tsconfig.json + publish-acceptance: 65
  acceptance files)
- [x] `node --test dist/vector-cortex/enc2c-acceptance.test.js` → **17 pass / 0 fail**
- [x] `node --test dist/extensions/dashboard-server/setup-cortex-actions-native-ort.test.js`
  → **5 pass / 0 fail**
- [x] `node --test dist/extensions/dashboard-server/routes-setup-cortex-actions.test.js`
  → **11 pass / 0 fail** (no regression from the async migration)
- [x] full `npm test` → **4299 pass / 0 fail across 421 files**
- [x] `node scripts/vector-cortex-conformance.mjs --check` → **964 fixtures canonical**
- [x] `node scripts/vector-cortex-docs-check.mjs` → 68 sprints / reun clean (ENC-2c
  was pre-registered in EXPECTED_SPRINTS)
- [x] `cd extensions/dashboard-client && npm run typecheck` → tsc clean
- [x] `cd extensions/dashboard-client && npm run build` → vite build clean

## Spec-staleness deviations (rationale)

- **Fixture generator is a NEW sibling `gen-fixtures-enc2c.mjs`, not an extra block
  in `gen-fixtures-vc9b.mjs`.** Keeps the ENC-2c (lazy-download install) fixtures
  self-contained like the per-sprint additive generators, avoiding a growing
  single-file generator. It rewrites the SHARED action schema (widening the enum),
  so ENC-2c owns schema regeneration while ENC-2c fixtures carry
  `producer: vc9-setup-dashboard/gen-fixtures-enc2c.mjs`.
- **`installScriptPath()` is exported** from the driver so the unit test can assert
  it resolves to the REAL committed script (verifiability, no-mock convention).

## Migration, migration disposition, and rollback

**Migration:** pure — no store schema/state change, no events.log format change.
The install action runs a local subprocess and writes a vc9b log; the retest result
is computed live and never persisted. No operator migration.

**Rollback:** set `MEGACOMPACT_ENC_2C=0`. The button disappears, the action returns
invalid_action, byte-identical to the ENC-2b-era shape, WITHOUT touching the
operator-produced `native-ort/` install dir (data preservation).

## Failure triad (A/B/C)

- **A (install path)** — confirm:true + HG-3 closed → install subprocess runs →
  result carries the fresh retest fields → fixtures SETUP-CORTEX-034 (gated path)
  + SETUP-CORTEX-037 (eligible path).
- **B (confirm gate)** — confirm:false → 400, no spawn → fixture SETUP-CORTEX-035.
- **C (flag-off + no-network)** — ENC_2C=0 → invalid_action byte-identical →
  fixture SETUP-CORTEX-036; driver carries no URL literals → fixture
  SETUP-CORTEX-038 + the aggregator's zero-tolerance scan.

## Live Playwright validation (MANDATORY — status)

Deferred — no native onnxruntime binding is installed on the current host
(`~/.pi/mega-compact/native-ort/node_modules/onnxruntime-node/` absent), so the
Install Native ORT button IS expected to render (native absent). The mandatory flows:

1. **Install button visible when native absent** — navigate to Setup → Cortex,
   assert the "Install Native ORT" action row is present; zero console errors.
2. **Confirm-gated + HG-3 blocked** — clicking Install prompts confirm; on confirm
   the POST returns 423 blocked (HG-3) and the blockers card highlights HG-3 —
   no install subprocess spawns.
3. **Button hidden once native installed** — requires operator running the ENC-2a
   install script on the host; deferred until then. Evidence will name the host and
   the rendered card output once validated.

## Controller-run gates (require a commit SHA; run post-commit)

- `node scripts/vector-cortex-scope-check.mjs ENC-2c <COMMIT_SHA>` — every committed
  file must fall inside the declared ownership ∪ fixed cross-cutting seams.
- `node scripts/vector-cortex-evidence-check.mjs ENC-2c` — re-derives the line counts /
  test counts / fixture count / flag parity claims in this record from the tree; must
  agree.
- `python3 scripts/log_failure.py --list` — no active failures in scope.

## Fix applied during controller review

None recorded at impl time — the implementer run is complete and pending the
controller's scope/evidence verification (this record reflects the pre-review
state; any controller findings land in a follow-up).
