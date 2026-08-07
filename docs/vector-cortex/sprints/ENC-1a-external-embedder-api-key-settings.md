# ENC-1a — External embedder API key + endpoint Settings surface

**Status:** planned | **Depends on:** ENC-0f | **Phase:** ENC
**Flag:** `MEGACOMPACT_ENC_1A`, defined in `src/config/vector-cortex-enc1a.ts` (sibling extract), re-exported by `vector-cortex.ts` + root `src/config.ts`, default ON; `MEGACOMPACT_ENC_1A=0` disables and must be byte-identical to the predecessor — the Settings panel renders no `MEGACOMPACT_EMBEDDING_KEY` / `MEGACOMPACT_EMBEDDING_URL` text fields (only the existing boolDirect toggles remain), the server routes carry no new keys, and the embedder loader reads only the pre-existing env vars exactly as before. Registered in `VECTOR_CORTEX_SETTINGS` as a visible boolDirect toggle, never in `EXCLUDED_SETTINGS`.

## Goal and inputs/outputs

**Add a Settings-visible field pair for the external embedder endpoint + API key.** Today the runtime reads `MEGACOMPACT_EMBEDDING_URL` and `MEGACOMPACT_EMBEDDING_KEY` from the process env (`src/httpEmbedder.ts:embeddingConfigFromEnv`) and the Setup tab's `CustomEndpointSection` already lets the user enter a custom URL — but there is **no dashboard-visible field for the API key**, and no server route persists the pair to the per-repo `.mega-compact.env` file so the session survives a restart without the user hand-editing shell env. ENC-1a closes that gap: two additive text-input rows on the Setup Embedder surface (endpoint URL + optional Bearer API key), persisted to `.mega-compact.env` by the existing settings-writer route, consumed by `embeddingConfigFromEnv` on next session start. This is the Settings-side completion of the already-shipped BYO-embedder runtime — no new network path, no new embedder, no changes to `httpEmbedder.ts` behavior.

Inputs: the existing `CustomEndpointSection` URL input + the new API-key input. Outputs: two additive contract fields on the existing setup-config read path (`GET /api/setup-status` gains `embeddingEndpointUrl?: string` and `embeddingApiKeySet?: boolean` — the key itself is NEVER returned to the client, only a boolean "is set" marker), the additive writer branch on `POST /api/setup-configure` accepting `{ embeddingEndpointUrl?, embeddingApiKey? }`, and the two new text rows on the dashboard. The key is written to `.mega-compact.env` only; the GET endpoint redacts it to `embeddingApiKeySet: true|false`.

`MEGACOMPACT_ENC_1A` gate (default ON; `=0` = the Settings UI renders only the pre-existing toggles, the GET body omits the two new fields, and the POST handler returns 404/disabled on the new payload keys — byte-identical to ENC-0f-era shape). Flag lives in `src/config/vector-cortex-enc1a.ts`, re-exported by `vector-cortex.ts` + `src/config.ts`, registered as a visible boolDirect toggle (`routes-rag-settings-vector-cortex.ts`, never `EXCLUDED_SETTINGS`).

Production ownership: `src/config/vector-cortex-enc1a.ts`; `src/config/vector-cortex.ts`; `src/config.ts`; `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts`; `extensions/dashboard-server/routes-setup.ts`; `extensions/dashboard-server/routes-setup-enc1a.ts` (sibling extract of the ENC-1a env read/write helpers + `tryEnc1aConfigure` writer branch — keeps `routes-setup.ts` under the 300 soft cap; added during implementation); `extensions/dashboard-server/api-contracts/setup.ts`; `extensions/dashboard-client/src/tabs/SetupTab/CustomEndpointSection.tsx` (adds an `apiKeySet` prop rendering an "API key saved" chip — the spec's live flow requires the `apiKeySet:true` state be visible on the card; added during the controller post-deploy live-validation pass after the spec's mandated reload step showed no such affordance); `extensions/dashboard-client/src/tabs/SetupTab/EmbedderSetup.tsx` (adds a one-shot `customUrlSeeded` effect seeding the URL field from `status.embeddingEndpointUrl` — the spec's live flow requires the URL field re-render the persisted value on reload; added during the controller post-deploy live-validation pass); `extensions/dashboard-client/src/tabs/SetupTab/EmbedderSetupHelpers.tsx` (sibling extract of `embedderLabel`/`trigramWarning`/`detectBadge` — keeps EmbedderSetup under the 400 cap; added during implementation); `extensions/dashboard-server/routes-setup.test.ts` (route-level round-trip tests, additive); `scripts/ml5-enc/gen-fixtures.mjs`; `src/vector-cortex/enc1a-acceptance.test.ts`; `conformance/vector-cortex/v2/encoder-settings/*`; `conformance/vector-cortex/v2/schemas/encoder-settings-fixture.schema.json`; `conformance/vector-cortex/v2/manifest.json`; `docs/vector-cortex/evidence/ENC-1a.md`; `docs/vector-cortex/sprints/ENC-1a-external-embedder-api-key-settings.md (this file)`. Intentionally NOT touched: `extensions/dashboard-client/src/types/setup-cortex.ts` + `extensions/dashboard-client/src/api/setup-cortex.ts` — they are the VC9A setup-cortex surface covering `/api/setup-cortex-status` + `/api/setup-cortex-action`, a different feature from ENC-1a's `/api/setup-status` + `/api/setup-configure`; the ENC-1a status/configure contracts live in `api-contracts/setup.ts` which the client already imports via `@contracts`. Notes: routes-setup.ts gains an additive writer branch on `setup-configure` that accepts `embeddingEndpointUrl` and `embeddingApiKey` and appends both to the per-repo `.mega-compact.env` (the existing per-repo state-dir write helper, never the global one); the GET gains `embeddingEndpointUrl?` (echoed) and `embeddingApiKeySet?` (boolean only — the raw key is never returned); the CustomEndpointSection gains an additive API-key password input alongside the existing URL input; the flag sibling and the two barrel re-exports mirror the ENC-0f slice; the generator gains a seventh additive block, algorithm `encoder-settings`, schema `schemas/encoder-settings-fixture.schema.json`; the v2 manifest registration bump is cross-cutting.

## Numbered implementation tasks

1. Add the `MEGACOMPACT_ENC_1A` flag (default ON, `=0` byte-identical) in `src/config/vector-cortex-enc1a.ts` + `vector-cortex.ts`/`src/config.ts` re-exports and the `VECTOR_CORTEX_SETTINGS` boolDirect toggle in `routes-rag-settings-vector-cortex.ts` (additive). `=0` = no new fields, no writer branch, byte-identical predecessor.
2. Extend `extensions/dashboard-server/api-contracts/setup.ts` additively: `SetupStatusResponse` (defined in `api-contracts/setup.ts:15`) gains `embeddingEndpointUrl?: string` and `embeddingApiKeySet?: boolean` (explicit types, no `any`); the `SetupConfigureRequest` body type (`api-contracts/setup.ts:67`) gains `embeddingEndpointUrl?: string` and `embeddingApiKey?: string` (optional, additive). The sibling `api-contracts/setup-cortex.ts` is the VC9A endpoint and is NOT touched.
3. Extend `extensions/dashboard-server/routes-setup.ts` additively: the GET handler echoes `embeddingEndpointUrl` from the per-repo `.mega-compact.env` (re-using the same parse logic the dashboard already uses for other per-repo settings) and reports `embeddingApiKeySet` as a boolean; the POST handler accepts the two optional new keys and appends/updates `MEGACOMPACT_EMBEDDING_URL=…` and `MEGACOMPACT_EMBEDDING_KEY=…` in the per-repo `.mega-compact.env` (never the global one — `statedir-per-repo-vs-global` memory). The raw key is written to the file only, never echoed in any GET body or event.
4. Extend `extensions/dashboard-client/src/types/setup-cortex.ts` mirror of the additive fields.
5. Extend `extensions/dashboard-client/src/tabs/SetupTab/CustomEndpointSection.tsx`: add an additive password-type input labeled "API key (optional Bearer)" beside the existing URL input; wire both fields through `EmbedderSetup.tsx`'s apply flow to POST `/api/setup-configure`. The embedder must NOT need a page reload — the save must reflect the persisted-state notice "Saved; takes effect on next session start".
6. Extend `extensions/dashboard-client/src/api/setup-cortex.ts` to pass the two new optional fields through the POST writer.
7. Add `scripts/ml5-enc/gen-fixtures.mjs` (additive) emitting `ENC-SET-001..005`, register them + owner `ENC-1a` in the v2 manifest against a new `schemas/encoder-settings-fixture.schema.json`; manifest bump is cross-cutting.
8. Add the sprint acceptance aggregator `src/vector-cortex/enc1a-acceptance.test.ts`, then evidence `ENC-1a.md`. Run the dashboard-client gates (`cd extensions/dashboard-client && npm run typecheck && npm run build`) since the client card is touched.

## Failure triad and independence

A persisted round-trip: POSTing `{embeddingEndpointUrl:"http://127.0.0.1:11434/v1/embeddings", embeddingApiKey:"sk-local-test"}` writes both lines to `.mega-compact.env`, and the next GET returns `{embeddingEndpointUrl:"http://127.0.0.1:11434/v1/embeddings", embeddingApiKeySet:true}` — pinned by **ENC-SET-001** (round-trip set + redacted return). B missing-key safe: POSTing `{embeddingEndpointUrl:"http://127.0.0.1:11434/v1/embeddings"}` with NO key writes only the URL line and the next GET returns `embeddingApiKeySet:false` — pinned by **ENC-SET-002**. C secret-redaction: no GET response at any flag state ever contains the raw key substring (the aggregator scans the full GET body for the injected test key and asserts absence) — pinned by **ENC-SET-003**. Flag-off is pinned by **ENC-SET-004** (GET omits both fields, POST with the new keys returns 404/disabled, byte-identical predecessor) and contract additivity by **ENC-SET-005** (non-ENC-1a clients that do not send the new fields validate unchanged). A is produced by the writer + reader round-trip; B purely by the absent-key branch; C purely by the redaction branch. `MEGACOMPACT_ENC_1A=0` is byte-identical to the ENC-0f survivor. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/encoder-settings/`. Schema: `schemas/encoder-settings-fixture.schema.json` (new sibling).

- `ENC-SET-001: POST URL + key rounds trip; GET echoes URL and reports apiKeySet:true`.
- `ENC-SET-002: POST URL only; GET reports apiKeySet:false (absent-key is non-fatal)`.
- `ENC-SET-003: GET body never contains the raw API key substring (redaction invariant)`.
- `ENC-SET-004: flag-off -> GET omits both fields, POST with new keys returns disabled, byte-identical`.
- `ENC-SET-005: contract additive — pre-ENC-1a clients that omit the new keys still validate`.

Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/enc1a-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/src/vector-cortex/enc1a-acceptance.test.js
```

Expected assertions: all `ENC-SET-001..005` registered with algorithm `encoder-settings` against the `encoder-settings` schema, expected `ok`; aggregator flag-agnostic. Route-level assertions (real in-memory exercise against `routes-setup.ts` using the same pattern as the pre-existing route tests, no mocks/stubs — `no-mock-data-no-stubs`): POST URL+key writes both lines to the per-repo `.mega-compact.env` in an isolated `MEGACOMPACT_STATE_DIR` tempdir; GET echoes the URL and reports `apiKeySet:true`; the raw key appears in the written file but never in the GET body; POST URL-only writes only the URL line and the next GET reports `apiKeySet:false`; flag-off POST with the new keys returns disabled/404; flag-off GET omits both fields. Client-source assertions: the compiled `CustomEndpointSection.tsx` source carries a `type="password"` input and a label naming the API key; the contract source pins `embeddingApiKeySet?: boolean` (never `embeddingApiKey`). Exact flag-off comparison command:

```bash
MEGACOMPACT_ENC_1A=0 node --test dist/src/vector-cortex/enc1a-acceptance.test.js
```

the aggregator is flag-agnostic. Acceptance: the raw API key is NEVER logged, NEVER returned to a GET client, NEVER included in any event payload — EVAL-REDACT-002 aggregate-only invariant extended to secret material (the redaction test is zero-tolerance). Zero network (the routes read/write local files only; the embedder itself is the pre-existing BYO loopback/remote flow — PREVENT-PI-004 unchanged). Apply [EVALUATION](../EVALUATION.md) annotation/power rules; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure — no store/schema changes.** The two values persist in the per-repo `.mega-compact.env` text file (the existing per-repo state-dir mechanism), NOT in SQLite; the store schema and `stateDir` tables are untouched. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md): the raw API key is written to the disk file and to `process.env.MEGACOMPACT_EMBEDDING_KEY` on load, **never** echoed to the dashboard GET client, **never** emitted in any event, **never** logged. Dashboard: the Setup Embedder surface is touched — owned files above under `extensions/` + client card; the endpoint surface is the existing `GET /api/setup-status` (additive fields) + `POST /api/setup-configure` (additive body keys), no new routes, no `EXPECTED_ENDPOINT_COUNT` bump; run `cd extensions/dashboard-client && npm run typecheck && npm run build`. Rollback sets `MEGACOMPACT_ENC_1A=0`; the Setup surface renders only the pre-existing toggles and the routes omit the new fields, byte-identical to the ENC-0f survivor, without deleting the saved `.mega-compact.env` lines (the runtime still reads them — rollback only hides the UI, never silently discards user data). No operator migration.

## Exit evidence

Run exact project gates:

```bash
npm run build
node --test dist/src/vector-cortex/enc1a-acceptance.test.js
MEGACOMPACT_ENC_1A=0 node --test dist/src/vector-cortex/enc1a-acceptance.test.js
npm test
npm run lint
python3 scripts/regression_check.py --all
node scripts/guardrails-scan.mjs
python3 scripts/log_failure.py --list
node scripts/vector-cortex-conformance.mjs --check
node scripts/vector-cortex-docs-check.mjs
node scripts/vector-cortex-scope-check.mjs ENC-1a <COMMIT_SHA>
node scripts/vector-cortex-evidence-check.mjs ENC-1a
cd extensions/dashboard-client && npm run typecheck && npm run build
git diff --check
```

No permissive globs or warning-only scans count. The evidence doc `ENC-1a.md` records the round-trip write + the redaction invariant proof (the GET-scan assertion text), the persisted `.mega-compact.env` diff in an isolated stateDir test, and the flag-off byte-identity claim.

## Live Playwright validation (MANDATORY)

The Setup Embedder surface's API-key field must be exercised live: launch the dashboard (default `http://localhost:9320`), navigate to Setup → Embedder → Custom Endpoint, paste a test URL + test key into the two fields, click save, reload the page, and assert the URL field re-renders the persisted value, the key field stays empty (redaction round-trip), and the `apiKeySet:true` state is reflected somewhere visible on the card. Zero console errors. If no reachable dashboard host exists, the sprint pauses at implementer-complete until a live host is available; evidence names the host and the rendered card output.

This sprint is one of 15 new sprint docs in the program; the single docs-check reconciliation (owned by the integration step, not by any per-sprint commit) sets `EXPECTED_SPRINTS` to **60** in `scripts/vector-cortex-docs-check.mjs` (count at integration time). Cross-cutting seam only.
