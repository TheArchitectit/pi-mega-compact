# ENC-1b Evidence — ONNX runtime backend + embedder API completion Settings

Status: **implementer-complete** (both Sonnet workers landed; controller read every production/test file and stamped every gate below; deployment pending).

## Sprint meta

- **Spec:** docs/vector-cortex/sprints/ENC-1b-onnx-runtime-and-embedder-api-settings.md
- **Evidence template:** docs/vector-cortex/EVIDENCE_TEMPLATE.md (short shape — matches ENC-1a's; no separate template file created)
- **Sprint ID string:** `ENC-1B` (all caps per conformance manifest)
- **Flag:** `MEGACOMPACT_ENC_1B` — boolDirect, default ON, `=0` byte-identical to the ENC-1a-era predecessor
- **Workers:** enc1b-worker-a (server+fixtures+aggregator), enc1b-worker-b (client)

## Production ownership files (final state after the controller fix pass)

- `src/config/vector-cortex-enc1b.ts` (50) — flag + `ENC_1B_MAX_EMBEDDING_DIM = 8192` + four pinned env-name constants (`MEGACOMPACT_EMBEDDING_DIM`, `MEGACOMPACT_EMBEDDING_HEADERS`, `MEGACOMPACT_ALLOW_REMOTE_EMBEDDER`, `MEGACOMPACT_ENCODER_NATIVE`)
- `src/config/vector-cortex.ts` (81) — barrel re-export
- `src/config.ts` (218) — barrel re-export
- `extensions/dashboard-server/api-contracts/setup.ts` (136) — SetupStatusResponse +`embeddingDim?: string`, `embeddingHeadersSet?: boolean`, `allowRemoteEmbedder?: boolean`, `encoderNativeOptIn?: boolean`, `encoderBackend?: "wasm"|"native"`, `encoderDemotionReason?: string|null`; SetupConfigureRequest +`embeddingDim?: string`, `embeddingHeaders?: string`, `allowRemoteEmbedder?: boolean`, `encoderNativeOptIn?: boolean` (NO raw `embeddingHeaders` field on the status — redaction mirrors ENC-1a's key pattern)
- `extensions/dashboard-server/routes-setup.ts` (299 — held under the 300 soft cap via the sibling extracts below) — `wantsEnc1a`/`tryEnc1aConfigure` first, `tryEnc1bConfigure`/`enc1bValidateCombined` second, primary embedder path preserved (additive); POST calls `tryEnc1bInto` for the combined upsert AND `writeEmbedderEnv` for the embedder write, so neither stale-write path is present
- `extensions/dashboard-server/routes-setup-enc1b.ts` (NEW, 336) — the ENC-1b sibling impl: `readEnc1bEnv`/`writeEnc1bEnv` (create-or-append upsert, never deletes other keys), `enc1bStatusFields` (computes `encoderBackend`+`encoderDemotionReason` by invoking the EXISTING `selectRuntimeBackend` from `../../src/vector-cortex/encoder/runtime-select.js` with `detectPlatform()` — reader-only, never install logic), `wantsEnc1b`/`tryEnc1bConfigure` (pure shape returns false when combined with valid embedder), `tryEnc1bInto` (combined upsert), `validateDim` (regex `^\d+$`, safe-int, 1..8192 capped) + `validateHeaders` (JSON.parse + non-null non-array object check) + `enc1bValidateCombined` (the combined-payload validator — **controller-fixed**, see below)
- `extensions/dashboard-server/routes-setup-env-upsert.ts` (NEW, 93) — sibling impl: `writeEmbedderEnv(stateDir, resolvedUrl, allowRemote)` — upsert-style primary embedder write that preserves unrelated lines (filters existing against SCAFFOLD_COMMENTS + OWNED_PREFIXES `MEGACOMPACT_EMBEDDING_URL`/`MEGACOMPACT_ALLOW_REMOTE_EMBEDDER`/`MEGACOMPACT_MINILM`, including `# export KEY=` and `# KEY ` prose forms)
- `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts` (310) — boolDirect `MEGACOMPACT_ENC_1B` toggle "ENC-1b ONNX runtime backend + embedder API completion Settings"
- `extensions/dashboard-server/routes-setup.test.ts` (197 — downsized from 455 by the split below)
- `extensions/dashboard-server/routes-setup-enc1b.test.ts` (NEW, 328) — the ENC-1b round-trip + flag-off describe AND the combined-payload/defect-pinning describe (3 tests) — **split out of routes-setup.test.ts at the controller review pass** because the parent crossed the 400 soft cap at 455 (gate FAILED before the split, passed afterward)
- `extensions/dashboard-client/src/tabs/SetupTab/CustomEndpointSection.tsx` (241) — additive `dim` number input + `headers` write-only textarea + chip pairs ("API key saved" + "Headers saved" green pills) + `allowRemote` toggle; ENC-1a prop-driven (never seeds the key/header — write-only), `dim`/`allowRemote` seed from persisted state on first load (`dimSeeded`/`allowRemoteSeeded` one-shot guards)
- `extensions/dashboard-client/src/tabs/SetupTab/CortexRuntimeCard.tsx` (NEW, 103) — the Cortex sub-tab's "Encoder Runtime" card: native opt-in toggle POSTing `encoderNativeOptIn` via `configureEmbedder`, reader-only backend/demotionReason rows
- `extensions/dashboard-client/src/tabs/SetupTab/CortexRuntimeCardStyles.ts` (NEW, 49) — local style constants for the runtime card
- `extensions/dashboard-client/src/tabs/SetupTab/EmbedderSetup.tsx` (345) — `applyEmbedder` widened to `(embedder, url?, apiKey?, dim?, headers?, allowRemote?)`; gating `const enc1bOn = "embeddingHeadersSet" in (status ?? {})` (additive-on-shape, matches the ENC-1a gating contract); `customUrlSeeded` preserved from ENC-1a
- `extensions/dashboard-client/src/tabs/SetupTab/EmbedderSetupHelpers.tsx` (125) — CurrentConfigSection extracted sibling (stay under 400 cap on the parent)
- `extensions/dashboard-client/src/tabs/SetupTab/CortexSetup.tsx` (56) — additive mount `<CortexRuntimeCard />` index between the status card and the blockers list inside the Cortex sub-tab
- `scripts/ml5-enc/gen-fixtures.mjs` (1550) — eighth additive block, algorithm `encoder-runtime-settings`, schema `schemas/encoder-runtime-settings-fixture.schema.json`
- `src/vector-cortex/enc1b-acceptance.test.ts` (NEW, 202) — fixture registration + kind-closure aggregator + contract scans + redaction + env-name pins + additive-only-first-byte-shape check (flag-agnostic, dual-dist safe)

## Live-review defects (caught and fixed by controller inside this sprint)

### Defect 1 — combined-payload validation bypass

`tryEnc1bConfigure` handles only the pure ENC-1b shape (dim/headers ONLY, no valid embedder). When a payload carries BOTH a valid embedder (`embedder: "custom"` or `"ollama"` etc) AND ENC-1b keys, it returns `false`, the route falls through to the primary embedder write, and `tryEnc1bInto` upserts the ENC-1b keys WITHOUT involving `validateDim`/`validateHeaders`. Malformed dim/headers could reach the file via the combined path undetected.

**Fix:** exported `validateDim`/`validateHeaders` from `routes-setup-enc1b.ts` AND added a new exported shard `enc1bValidateCombined(body)` (returns the error code or null). `routes-setup.ts` calls it after the pure-shape attempt and BEFORE the embedder switch — 400 + code, file byte-unchanged. Defect pinned by the combined-payload route tests (both shapes, ports 19600/19601, byte-equality checks).

### Defect 2 — primary embedder write wipes ENC-1a/1b lines

`handleSetupConfigure` previously rewrote the per-repo `.mega-compact.env` from a hardcoded scaffold, wiping the persisted `MEGACOMPACT_EMBEDDING_URL`, `_KEY`, `_DIM`, `_HEADERS` lines whenever a later ENC-1b-only POST (e.g. the Cortex sub-tab native-opt-in toggle) hit the combined path.

**Fix:** extracted a dedicated sibling `routes-setup-env-upsert.ts` exporting `writeEmbedderEnv(stateDir, resolvedUrl, allowRemote)` — preserved lines are filtered against an `OWNED_PREFIXES` allowlist and a `SCAFFOLD_COMMENTS` set; nothing else is deleted. `routes-setup.ts` now calls the sibling. Defect pinned by the "Cortex sub-tab native-opt-in POST preserves previously-persisted ENC-1a/1b embedder keys" route test (seed first, then toggle, then byte-equality on the six persisted lines).

## Conformance

- `conformance/vector-cortex/v2/encoder-runtime-settings/ENC-ONNX-001..006.json` (NEW, kinds: round-trip-set-headers-redacted, round-trip-set-dim-validated, dim-over-cap-rejected, headers-invalid-json-rejected, native-opt-in-flag, flag-off)
- `conformance/vector-cortex/v2/schemas/encoder-runtime-settings-fixture.schema.json` (NEW, 1-line minified shape mirroring the prior ENC-SET schema)
- Manifest update in `conformance/vector-cortex/v2/manifest.json`: owner CSV gains `ENC-1b`, domain list gains `encoder-runtime-settings`, 914 fixtures canonical total (+6 JSON +1 schema from the 907 baseline ENC-0g closed at)

## Gates executed (all PASS)

- [x] `npm run build` → clean (`tsc` + `node scripts/vector-cortex-publish-acceptance.mjs` → 55 acceptance + full bundle list postbuild, 60 total aggregators)
- [x] `node --test dist/src/vector-cortex/enc1b-acceptance.test.js` (primary) → **10/0**
- [x] `node --test dist/vector-cortex/enc1b-acceptance.test.js` (legacy) → **10/0**
- [x] `MEGACOMPACT_ENC_1B=0 node --test dist/src/vector-cortex/enc1b-acceptance.test.js` → **10/0** (flag-off same-pass, pin numbers assert no writer activity)
- [x] `MEGACOMPACT_ENC_1B=0 node --test dist/vector-cortex/enc1b-acceptance.test.js` → **10/0** (flag-off dual-dist)
- [x] Route suites, post-split state (HEAD): `node --test dist/extensions/dashboard-server/routes-setup.test.js` → **7/0** (status/detect + ENC-1a round-trip, unchanged from the ENC-1a era); `node --test dist/extensions/dashboard-server/routes-setup-enc1b.test.js` → **9/0** (6 ENC-1b round-trip/flag-off + 3 combined-payload defect-pinning tests); a joint run `node --test <both files>` reports **16/0, suites 5**. Pre-split, when the ENC-1b describes were inline in routes-setup.test.ts, the joint count of 16 ran as a single-file target.
- [x] `npm test` → **3948 passed, 0 failed across 394 files**
- [x] `npm run lint` → clean (`tsc --noEmit` + guardrails-scan + semantic-scan)
- [x] `python3 scripts/regression_check.py --all` → **0 blocking** (7 dev-only/moderate npm audit warnings unchanged: undici, pi-coding-agent, hono node-server, mcp sdk, openclaw-fs-safe, openclaw, tar)
- [x] `python3 scripts/regression_check.py --soft-as-hard --pre-commit --soft-as-hard-base v0.20.50` → **exit 0**, "0 over hard limit (blocks commit), 63 over soft limit (warning)" — both the trimmed routes-setup.test.ts at 197 lines AND the new routes-setup-enc1b.test.ts at 328 lines are ABSENT from the warning list; the prevented violation class was the 455-line parent
- [x] `node scripts/guardrails-scan.mjs` → clean
- [x] `node scripts/vector-cortex-conformance.mjs --check` → **914 fixtures canonical**
- [x] `node scripts/vector-cortex-docs-check.mjs` → **63 sprints clean**
- [x] `cd extensions/dashboard-client && npm run typecheck && npm run build` → clean (SetupTab chunk `SetupTab-BZ7Jn5MR.js` compiled into dist — the SetupTab chunk differs from ENC-1a's `SetupTab-BSWig-6X.js` per the additive fields + runtime card)
- [x] `git diff --check` → clean
- [x] `node scripts/vector-cortex-scope-check.mjs ENC-1B 3ad2f66` → FAIL first pass, fixed by two ownership amendments (declare `routes-setup-enc1b.ts` sibling + `CortexSetup.tsx` additive mount) in commit fbea968 → **PASS "all 82 committed file(s) inside Production ownership"**
- [x] `node scripts/vector-cortex-evidence-check.mjs ENC-1b` → pending (the record this file provides)

## Commits

- `3ad2f66` — **feat(ENC-1b)**: all Worker A + Worker B + controller-defect-fix code, docs spec amendment, and all conformance fixtures/schemas in one commit; clean gate run on this sha
- `fbea968` — **docs(ENC-1b)**: ownership amendment declaring the two flagged out-of-scope files (sibling routes impl + CortexSetup additive mount)

## Migration and rollback

**Migration:** pure — no store schema change, no session-shape change. The persisted key/value lines land in the EXISTING per-repo `.mega-compact.env` (per `statedir-per-repo-vs-global` memory: never the global one). Upsert writes never delete unrelated lines; readers absent-key default-off for `allowRemote`+`nativeOptIn` booleans and omit `embeddingDim`/`headersSet` when unset (the GET has additive-only fields, so an absence is omission not a separate false — the ENC-1a boolean-semantics quirk).

**Rollback:** set `MEGACOMPACT_ENC_1B=0`. The route removes the new GET fields byte-identical to ENC-1a; the POST falls through to the pure-ENC-1a + pure-embedder paths (the additive `enc1bValidateCombined` helper is flag-gated server-side and returns null when off); the CustomEndpointSection hides the ENC-1b fields; the CortexRuntimeCard hides completely. The persisted `.mega-compact.env` lines are NOT deleted (data preservation — deleting them would be an out-of-band seizure; they remain for the runtime that reads them via `embeddingConfigFromEnv` / native opt-in trigger).

## OPEN / known

- **HG-3 (open)** — the native runtime path (`onnxruntime-node` 258 MiB install block) is the demotion vector (`encoderDemotionReason = "native not installed"` or platform-absent variants the real runtime surfaces verbatim). The sprint lands the toggle+flag+read-only surface; the runtime gate remains OPEN in README.
- **HG-4 / HG-5** — platform-absent (`darwin-x64` arm64-only) and the 512-token RSS margin both remain open blockers; the toggle behaves accordingly (it stores intent but the runtime's own selection is the source of truth).

## Live validation outcome (pending the mandatory Playwright run)

Two flows affirmed by Worker B on a fresh mktemp state-dir with a positional dashboard CLI (`node dist/extensions/dashboard-server.js <stateDir>`, `MEGACOMPACT_DASHBOARD_PORT=9322`): the embedder surface (URL + API key + dimension + headers + allow-remote save/reload round-trip with key+headers blank-after-reload + "saved" chips) AND the Cortex sub-tab runtime card (native opt-in toggle + "Effective backend: native" row rendering). Zero console errors on either. The one path Worker B could not force on this host is a runtime demotion render (onnxruntime-node present → the demotion reason stays empty on this platform; the code path is pinned by the runtime aggregator + the ENC-ONNX-004 native-opt-in fixture).

## Open issues carried forward

- task #26 (pending) — the dashboard-server `--port`-style argv mis-parse (real CLI is positional `<stateDir>` + `MEGACOMPACT_DASHBOARD_PORT` env); it pollutes the cwd with a literal `./--port/` dir when invoked with flag-style args. Out of ENC-1b scope; moderate severity; a pre-existing bug.
