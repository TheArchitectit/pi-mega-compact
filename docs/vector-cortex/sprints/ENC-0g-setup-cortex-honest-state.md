# ENC-0g — Setup Cortex status route honest state (verdict override + live blockers + re-derived gating)

**Status:** planned | **Depends on:** ENC-0f | **Phase:** ENC
**Flag:** `MEGACOMPACT_ENC_0G`, defined in `src/config/vector-cortex-enc0g.ts` (sibling extract), re-exported by `vector-cortex.ts` + root `src/config.ts`, default ON; `MEGACOMPACT_ENC_0G=0` disables and must be byte-identical to the predecessor — the Setup Cortex status route derives its `qualification` verdict from `verifyEncoderAsset(...).ok` alone, the blocker list is the static `SETUP_CORTEX_BLOCKERS` array exactly as ENC-0f-era, and VC9B action gating reads the static `setupCortexActionBlockers` table as today. Registered in `VECTOR_CORTEX_SETTINGS` as a visible boolDirect toggle, never in `EXCLUDED_SETTINGS`.

## Goal and inputs/outputs

**Make the Setup Cortex status route honest.** A live Playwright review of the dashboard (device on v0.20.47) exposed a UI contradiction: the Setup Cortex card showed `mode:"A"`, `qualification:{verdict:"qualified"}` AND four hard-gate blockers all still `open` (HG-1/HG-3/HG-4/HG-5). Root causes: (1) the verdict is computed purely from `verifyEncoderAsset(...).ok` — a structural check of the ONNX manifest/hashes that never reads the ENC-0f `QualificationV1` record written by `scripts/encoder/gate-qualify.mjs`, so a measured gate `failed` (WASM p95 186.53 ms vs 40 ms, RSS 294 MiB vs 150 MiB) is shown as `qualified`; (2) the blocker manifest is a static array written pre-ENC-0c, so HG-1 (closed by ENC-0c training), the visibility half of HG-4 (closed by ENC-0e) and the stale HG-5 wording (measured by ENC-0f) do not reflect reality; (3) VC9B action gating keyed on stale-open HG-1 blocks fetch-model/bench that should run. ENC-0g closes the gap: the status route reads the latest `QualificationV1` record (when ENC_0F is ON and a record exists) and lets its verdict override the structural verify for the `qualification` field; the blocker list becomes a computed function of (platform, qualification record, asset-manifest head-count) with updated HG statuses; VC9B action gating is re-derived from the live blockers/config. The route stays **reader-only** — it never writes, never returns payloads/prompts/ledger (EVAL-REDACT-002), and reads local files only (PREVENT-PI-004).

Inputs: the existing `verifyEncoderAsset` facts (`mode`, `assetDigestPrefix`, structural `verdict`), the static `SETUP_CORTEX_BLOCKERS` manifest, the ENC-0f `QualificationV1` record at `<stateDir>/encoder-qualification.json` (stateDir from `MEGACOMPACT_STATE_DIR` else `~/.pi/mega-compact-encoder`), and `routes-setup-cortex-actions.ts` gating. Outputs: `GET /api/setup-cortex-status` returns an HONEST `qualification` (`thresholdFailures` = the record `reasons`), a computed `blockers` list with corrected HG statuses/wording, and `setupCortexActionBlockers` gating re-derived from live state. The response SHAPE is unchanged (`SetupCortexStatusResponse` fields identical); only the VALUES become honest. Client components already render server payloads — **no client file changes are expected**; if any status string changes shape the spec calls it out (none do under ENC-0g; the only wording change is HG-5's title text, which is a card row label, not a contract shape).

`MEGACOMPACT_ENC_0G` gate (default ON; `=0` = the status route behaves exactly as ENC-0f-era: verdict from `verifyEncoderAsset` alone, static `SETUP_CORTEX_BLOCKERS`, static `setupCortexActionBlockers` — byte-identical). Flag lives in `src/config/vector-cortex-enc0g.ts`, re-exported by `vector-cortex.ts` + `src/config.ts`, registered as a visible boolDirect toggle (`routes-rag-settings-vector-cortex.ts`, never `EXCLUDED_SETTINGS`).

Production ownership: `src/config/vector-cortex-enc0g.ts`; `src/config/vector-cortex.ts`; `src/config.ts`; `extensions/dashboard-server/routes-setup-cortex.ts`; `extensions/dashboard-server/setup-cortex-blockers.ts`; `src/vector-cortex/setup-cortex-blockers-compute.ts` (pure-logic sibling the dashboard-server module re-exports — added by the fix-up round so the src-tree aggregator can import without crossing `../../extensions` under the legacy `dist/vector-cortex/` mirror); `extensions/dashboard-server/setup-cortex-actions.ts`; `extensions/dashboard-server/routes-setup-cortex-actions.ts`; `extensions/dashboard-server/qualification-record.ts` (QualificationV1 reader + `QUALIFICATION_RECORD_UNAVAILABLE` sentinel + `encoderStateDir()`); `extensions/dashboard-server/routes-setup-cortex-actions-enc0g.test.ts` (soft-cap split sibling carrying the 3 log-honesty tests); `extensions/dashboard-server/api-contracts/setup-cortex.ts`; `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts`; `scripts/ml5-enc/gen-fixtures.mjs`; `src/vector-cortex/enc0g-acceptance.test.ts`; `conformance/vector-cortex/v2/encoder-status/*`; `conformance/vector-cortex/v2/schemas/encoder-status-fixture.schema.json`; `conformance/vector-cortex/v2/manifest.json`; `docs/vector-cortex/evidence/ENC-0g.md`; `docs/vector-cortex/sprints/ENC-0g-setup-cortex-honest-state.md (this file)`. Notes: the status route gains an additive QualificationV1 reader that overrides the structural verdict for the `qualification` field and supplies `thresholdFailures` from the record `reasons`; the blocker module turns `SETUP_CORTEX_BLOCKERS` static data into a pure computed function over (platform, qualification record, manifest head-count) while keeping the canonical HG definitions as the base; the action-gating function re-derives its blocker lists from the live computed blockers; the flag sibling and the two barrel re-exports mirror the ENC-0f/ENC-1a slices; the generator gains a seventh additive block, algorithm `encoder-status`, schema `schemas/encoder-status-fixture.schema.json`; the v2 manifest registration bump is cross-cutting.

## Numbered implementation tasks

1. Add the `MEGACOMPACT_ENC_0G` flag (default ON, `=0` byte-identical) in `src/config/vector-cortex-enc0g.ts` + `vector-cortex.ts`/`src/config.ts` re-exports and the `VECTOR_CORTEX_SETTINGS` boolDirect toggle in `routes-rag-settings-vector-cortex.ts` (additive). `=0` = the status route preserves the ENC-0f-era verdict-from-verify, static blockers, and static gating.
2. (Worker A) Refactor `extensions/dashboard-server/setup-cortex-blockers.ts`: keep the canonical `SetupCortexBlockerV1` defs + HG list as the base data, and add a **pure computed function** `computeSetupCortexBlockers(input: { platform, qualification, headCount })` that (a) closes HG-1 to `closed` when the asset manifest declares five projection heads (ENC-0c), (b) reflects HG-4's ENC-0e visibility-close (binary-absence still present but surfaced), (c) rewrites HG-5's title/wording to reflect the ENC-0f measured verdict (WASM `failed`, p95 186.53 ms, RSS 294 MiB) rather than the stale "~0.5% margin", and (d) leaves HG-3 open (onnxruntime-node ~258 MiB vs the 80 MiB asset budget — genuinely unresolved). HG-3 stays `status:"open"`, `severity:"blocker"`.
3. (Worker A) Re-derive `setupCortexActionBlockers` in the same module from the live computed blockers: an action is gated by exactly the blocker ids whose computed `status === "open"` AND `severity === "blocker"` AND whose per-action gate list includes the action. Intended matrix after the HG-1 close: `fetch-model → ["HG-3"]`, `bench → ["HG-3"]`, `verify-asset → []` (verify-asset stays ungated — a pure re-read of committed assets). HG-1 closed removes it from fetch-model/bench gating.
4. (Worker B) Add a `QualificationV1` reader (`src/vector-cortex/encoder/qualify.ts` already exports the schema/vocabulary; the reader lives beside the route, reading `<stateDir>/encoder-qualification.json`) and wire it into `routes-setup-cortex.ts`: when `ENC_0F_ENABLED()` AND a record exists, the record verdict **overrides** the structural verify for the `qualification` field — `verdict:"failed"` maps to the contract `"demoted"` and `thresholdFailures` becomes the record `reasons`; `verdict:"qualified"` surfaces `qualified`. A missing record, unreadable file, or corrupt JSON degrades to the verify-only behavior with `thresholdFailures` including the marker `qualification_record_unavailable` (exact fallback semantics; see Failure triad).
5. (Worker B) Update `routes-setup-cortex-actions.ts` route tests + any `setup-cortex-actions.ts` call sites to consume the re-derived gating; verify `verify-asset` is UNGATED and `fetch-model`/`bench` surface only HG-3 when it is the live rule.
6. (Worker A) Add `scripts/ml5-enc/gen-fixtures.mjs` (additive) emitting `ENC-STAT-001..006`, register them + owner `ENC-0g` in the v2 manifest against a new `schemas/encoder-status-fixture.schema.json`; manifest bump is cross-cutting.
7. Add the sprint acceptance aggregator `src/vector-cortex/enc0g-acceptance.test.ts`, then evidence `ENC-0g.md`.

**Worker split:** sized for TWO Sonnet workers. **Worker A** owns tasks 1, 2, 3, 6, 7 (flag + config + contract + blocker/status computation + fixtures + aggregator). **Worker B** owns task 4 and task 5 (route verdict override + QualificationV1 reader + action-gating re-derivation + its route tests). **One likely collision:** both touch `extensions/dashboard-server/routes-setup-cortex.ts` — assign the route verdict override to Worker B ONLY; Worker A touches the blockers/actions modules (`setup-cortex-blockers.ts`, `setup-cortex-actions.ts`) and never writes `routes-setup-cortex.ts`, avoiding parallel-write conflicts. Worker A's computed-blocker function must be importable by Worker B's route without edit churn.

## Failure triad and independence

A record-overrides-structural: given a `QualificationV1` record with `verdict:"failed"`, `reasons:["latency","rss","bench_gates_not_green"]` AND a structurally-OK `verifyEncoderAsset` (`ok:true`), the status route reports `qualification:{verdict:"demoted", thresholdFailures:["latency","rss","bench_gates_not_green"]}` — the record overrides the structural pass — pinned by **ENC-STAT-002**. B closed-HG-1-unblocks: with a manifest declaring five projection heads, the computed blockers mark HG-1 `closed` and `fetch-model` gating becomes `["HG-3"]` (no longer blocked by stale-open HG-1) while `bench` with HG-3 open stays gated — pinned by **ENC-STAT-005**. C no-record-fallback: when no `QualificationV1` record exists (or it is missing/unreadable/corrupt), the route falls back to the verify-only verdict with `thresholdFailures:["qualification_record_unavailable"]` (never a fabricated pass, never a bare silent fallback) — pinned by **ENC-STAT-003**. `MEGACOMPACT_ENC_0G=0` is byte-identical to the ENC-0f survivor, pinned by **ENC-STAT-006**. The three branches use independent inputs (the record, the manifest head-count, and the flag). Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/encoder-status/`. Schema: `schemas/encoder-status-fixture.schema.json` (new sibling).

- `ENC-STAT-001: qualified record present -> verdict "qualified" surfaces from the record (overrides structural)`.
- `ENC-STAT-002: failed record [latency,rss,bench_gates_not_green] -> verdict "demoted" + thresholdFailures surfaced even when verify ok`.
- `ENC-STAT-003: no record -> verify-only fallback preserved, thresholdFailures:["qualification_record_unavailable"]`, pre-gate behavior when a record exists but is flagged off.
- `ENC-STAT-004: blocker statuses computed — HG-1 closed when manifest declares 5 heads; HG-5 wording reflects measured verdict`.
- `ENC-STAT-005: action gating re-derived — fetch-model no longer gated by closed HG-1; HG-3 open still gates bench`, the exact intended matrix pinned.
- `ENC-STAT-006: flag-off -> status route byte-identical to ENC-0f era (verify-only verdict, static blockers, static gating)`.

Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/enc0g-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/src/vector-cortex/enc0g-acceptance.test.js
```

Expected assertions: all `ENC-STAT-001..006` registered with algorithm `encoder-status` against the `encoder-status` schema, expected `ok`; aggregator flag-agnostic. Route-level assertions (real in-memory exercise against `routes-setup-cortex.ts` using the same pattern as the pre-existing route tests, no mocks/stubs — `no-mock-data-no-stubs`): a written `QualificationV1` record in an isolated `MEGACOMPACT_STATE_DIR` tempdir overrides a structurally-OK verify; a missing record yields the `qualification_record_unavailable` fallback; the computed blockers close HG-1 on a 5-head manifest; the re-derived gating returns `["HG-3"]` for fetch-model and bench and `[]` for verify-asset. A **no-scattered-literal scan** over `routes-setup-cortex.ts` / `setup-cortex-blockers.ts` / `setup-cortex-actions.ts` asserts the reason vocabulary (`latency`, `rss`, `bench_gates_not_green`) and the verdict strings come from the `qualify.ts` single source, never re-invented as literals (preserve the ENC-0f invariant). Exact flag-off comparison command:

```bash
MEGACOMPACT_ENC_0G=0 node --test dist/src/vector-cortex/enc0g-acceptance.test.js
```

The aggregator is flag-agnostic. Acceptance: the route remains reader-only (never writes, never payloads/prompts/ledger — EVAL-REDACT-002); the QualificationV1 record read is a local filesystem read only (PREVENT-PI-004, zero network); the HG-5 wording change is a card row label, not a contract shape change. Apply [EVALUATION](../EVALUATION.md) annotation/power rules; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure — no store/schema changes.** The status route reads the existing ENC-0f `QualificationV1` record artifact at `<stateDir>/encoder-qualification.json`; the store schema and `stateDir` tables are untouched. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md) + EVAL-REDACT-002: the route surfaces aggregate measurements + verdicts + digest prefixes only, never exact ledger bytes or prompt content. Dashboard: the Setup Cortex status card + action drivers are touched (owned files above under `extensions/` + client surfaces unchanged — no client file edits are expected or made under ENC-0g; the composite card re-renders the honest server payload); `cd extensions/dashboard-client && npm run typecheck && npm run build` IS required since `routes-setup-cortex.ts` is a server (`extensions/`) production file — run the dashboard-client gate even though no client source changed. Rollback sets `MEGACOMPACT_ENC_0G=0`; the status route reports the ENC-0f-era verify-only verdict + static blockers + static gating, byte-identical, without deleting the QualificationV1 record (the record remains on disk for the next ON clock). No operator migration.

## Exit evidence

Run exact project gates:

```bash
npm run build
node --test dist/src/vector-cortex/enc0g-acceptance.test.js
MEGACOMPACT_ENC_0G=0 node --test dist/src/vector-cortex/enc0g-acceptance.test.js
npm test
npm run lint
python3 scripts/regression_check.py --all
python3 scripts/regression_check.py --soft-as-hard --pre-commit
node scripts/guardrails-scan.mjs
python3 scripts/log_failure.py --list
node scripts/vector-cortex-conformance.mjs --check
node scripts/vector-cortex-docs-check.mjs
node scripts/vector-cortex-scope-check.mjs ENC-0g <COMMIT_SHA>
node scripts/vector-cortex-evidence-check.mjs ENC-0g
cd extensions/dashboard-client && npm run typecheck && npm run build
git diff --check
```

No permissive globs or warning-only scans count. The evidence doc `ENC-0g.md` records the verdict-override proof (a failed record overriding an OK structural verify), the closed-HG-1 gating matrix, the `qualification_record_unavailable` fallback, and the flag-off byte-identity claim.

## Live Playwright validation (MANDATORY)

The Setup Cortex status card must be re-validated live AFTER `pi update --extensions` on the device, because the device was observed on v0.20.47 during diagnosis. On the updated device, launch the dashboard (default `http://localhost:9320`), navigate to Setup → Cortex, and assert the card's `qualification` field reflects the ENC-0f measured verdict (WASM `demoted`/failed with the thresholdFailures, NOT `qualified`), the blockers show HG-1 `closed` (or absent from the open set), HG-3 `open`, and HG-5's wording reflects the measured verdict; attempt the `fetch-model` action and assert it is no longer 423-blocked by stale-open HG-1. Zero console errors. If no reachable dashboard host exists, the sprint pauses at implementer-complete until a live host is available; evidence names the host, the updated version, and the rendered card output.

This sprint is one of 15 new sprint docs in the program; the single docs-check reconciliation (owned by the integration step, not by any per-sprint commit) sets `EXPECTED_SPRINTS` to **60** in `scripts/vector-cortex-docs-check.mjs` (count at integration time). Cross-cutting seam only.
