# ENC-1a — External embedder API key + endpoint Settings fields

Status: **reviewer-accepted** (both Sonnet workers landed; controller read every
production/test file and stamped every gate below; deployment pending).

**Date:** 2026-08-06 | **Workers:** enc1a-worker-a (server+fixtures+aggregator),
enc1a-worker-b (dashboard client)

## Goal recap (from spec §Goal)

Add a Settings-visible field pair for the external embedder endpoint + API key.
The runtime already reads `MEGACOMPACT_EMBEDDING_URL` and
`MEGACOMPACT_EMBEDDING_KEY` from the process env (`src/httpEmbedder.ts`
`embeddingConfigFromEnv`); the Setup tab already accepts a custom URL — but
there was no dashboard-visible API-key field and no server route persisted the
pair to the per-repo `.mega-compact.env`. ENC-1a closes that gap: two additive
contract fields on `GET /api/setup-status` (`embeddingEndpointUrl?: string` +
`embeddingApiKeySet?: boolean`, the key NEVER echoed), an additive writer branch
on `POST /api/setup-configure` accepting `embeddingEndpointUrl` /
`embeddingApiKey`, and two additive Setup text rows. No new embedder, no
behavior change to `httpEmbedder.ts` — the Settings-side completion of the
already-shipped BYO-embedder runtime.

`MEGACOMPACT_ENC_1A` gate (default ON; `=0` = no new GET fields, no writer
branch, no new UI rows — byte-identical to the ENC-0g predecessor). Flag lives
in `src/config/vector-cortex-enc1a.ts`, re-exported by `vector-cortex.ts` +
`src/config.ts`, registered as a visible boolDirect toggle
(`routes-rag-settings-vector-cortex.ts`, never `EXCLUDED_SETTINGS`).

## Failure triad and resolution (per spec §failure-triad)

- **A (round-trip set + redacted return):** POST URL + key writes both lines to
  the per-repo `.mega-compact.env`; GET echoes `embeddingEndpointUrl` and
  reports `embeddingApiKeySet:true`, never returns the raw key — pinned by
  **ENC-SET-001**.
- **B (absent-key non-fatal):** POST URL only (no key) writes only the URL
  line; GET reports `embeddingApiKeySet:false` (a false boolean is surfaced
  when the flag is on, not omitted) — pinned by **ENC-SET-002**.
- **C (secret redaction):** the GET body at any flag state never contains the
  raw key substring (`sk-local-test`), the persisted file carries it on disk
  only — pinned by **ENC-SET-003** and the aggregator zero-tolerance
  source-scan.
- **Flag-off byte-identity** pinned by **ENC-SET-004**: GET omits both fields,
  POST with new keys returns the pre-ENC-1a invalid_embedder response
  (unrecognized keys), never writes the key line.
- **Contract additivity** pinned by **ENC-SET-005**: pre-ENC-1a clients that
  omit the new fields validate unchanged; older servers don't accept client
  requests carrying them (their POST shape stays closed).

The redaction invariant is enforced two ways: the route GET never serializes
`embeddingApiKey` (the response contract only exposes
`embeddingApiKeySet?: boolean`), and the aggregator scans the contracts source
asserting the response interface carries no `embeddingApiKey` field while the
request interface does.

## Single-source env names

`routes-setup-enc1a.ts` pins `MEGACOMPACT_EMBEDDING_URL` and
`MEGACOMPACT_EMBEDDING_KEY` — the exact names `embeddingConfigFromEnv` in
`src/httpEmbedder.ts` reads at runtime (NOT `MEGACOMPACT_EMBEDDING_API_KEY`).
The aggregator scans for both names and asserts the wrong spelling never
appears.

## Production ownership final (this slice)

Worker A (server + fixtures + aggregator):

- `src/config/vector-cortex-enc1a.ts` (41) — flag sibling mirroring ENC-0g.
- `src/config/vector-cortex.ts` (~81) — re-export added (post-ENC-0e
  barrel-split).
- `src/config.ts` (213) — re-export added.
- `extensions/dashboard-server/api-contracts/setup.ts` (101) —
  `SetupStatusResponse` + `embeddingEndpointUrl?: string`,
  `embeddingApiKeySet?: boolean`; `SetupConfigureRequest` +
  `embeddingEndpointUrl?: string`, `embeddingApiKey?: string`. The sibling
  `api-contracts/setup-cortex.ts` NOT touched (it is the VC9A endpoint).
- `extensions/dashboard-server/routes-setup.ts` (297) — additive GET spread
  (`...enc1aStatusFields(ctx.stateDir)`) + POST writer branch
  (`tryEnc1aConfigure` for the pure-ENC-1a shape; `writeEnc1aEnv` upsert after
  the existing embedder write for combined embedder+keys payloads).
- `extensions/dashboard-server/routes-setup-enc1a.ts` (NEW, 168) — sibling
  module carrying `enc1aStatusFields` / `readEnc1aEnv` / `writeEnc1aEnv` /
  `tryEnc1aConfigure` / `wantsEnc1a` (delegate-extract so `routes-setup.ts`
  stays under its 300-line soft cap, mirroring the upstream sibling pattern).
- `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts` (304) —
  boolDirect `MEGACOMPACT_ENC_1A` toggle "ENC-1a external embedder API key +
  endpoint Settings fields" (additive; `EXCLUDED_SETTINGS` untouched).
- `extensions/dashboard-server/routes-setup.test.ts` (192) — 3 route-level
  round-trip tests (spawn-server + real tempdir).
- `src/vector-cortex/enc1a-acceptance.test.ts` (NEW, 182) — fixture
  registration + kind-closure aggregator + contract scans + redaction
  invariant + env-name pin (flag-agnostic).
- `scripts/ml5-enc/gen-fixtures.mjs` (1353) — seventh additive block,
  algorithm `encoder-settings`, schema
  `schemas/encoder-settings-fixture.schema.json`.
- `conformance/vector-cortex/v2/encoder-settings/ENC-SET-001..005.json` (NEW) +
  `schemas/encoder-settings-fixture.schema.json` (NEW). Registration in
  `conformance/vector-cortex/v2/manifest.json`, owner CSV gains `ENC-1a`,
  domain list gains `encoder-settings`.

Worker B (dashboard client):

- `extensions/dashboard-client/src/tabs/SetupTab/CustomEndpointSection.tsx`
  (120) — additive `type="password"` input labeled "API key (optional Bearer)"
  beside the existing URL input. Key is local-only `useState("")` (always
  blank, never prefilled, NO show-saved-key affordance); input rendered only
  when `inputEnabled` (flag on); save notice "Saved; takes effect on next
  session start".
- `extensions/dashboard-client/src/tabs/SetupTab/EmbedderSetup.tsx` (367 —
  held under the 400 cap via sibling extract) — `applyEmbedder(embedder, url?,
  apiKey?)` signature widening; POSTs `configureEmbedder({ embedder, url,
  embeddingEndpointUrl: url, embeddingApiKey: apiKey })`; passes
  `inputEnabled={status !== null && "embeddingApiKeySet" in status}` +
  `configureResult`/`configureError` down to `CustomEndpointSection`.
- `extensions/dashboard-client/src/tabs/SetupTab/EmbedderSetupHelpers.tsx`
  (NEW, 50) — `embedderLabel`/`trigramWarning`/`detectBadge` sibling extract,
  keeping EmbedderSetup.tsx under the 400 limit.
- **Spec correction (worker-flagged, controller-confirmed correct):**
  `types/setup-cortex.ts` and `api/setup-cortex.ts` were NOT edited. Those two
  files are the VC9A setup-cortex contract pair covering
  `/api/setup-cortex-status` + `/api/setup-cortex-action` — a DIFFERENT feature
  surface from ENC-1a's `/api/setup-status` + `/api/setup-configure`. Adding
  embedder-endpoint fields to them would be semantically wrong. The actual
  ENC-1a status/configure contracts live in `api-contracts/setup.ts` (server
  barrel) which the client already imports via `@contracts`. Spec ownership
  block counts as repaired by inspection; the two listed files were listed in
  error and remain untouched intentionally.

## Gates checkpoint (controller — all STAMPED 2026-08-06)

- [x] `npm run build` → clean (tsc exit 0; publish-acceptance postbuild now
      reports **54 acceptance** — was 53; +1 for enc1a-acceptance).
- [x] `node --test dist/src/vector-cortex/enc1a-acceptance.test.js` → **8/0**.
- [x] `MEGACOMPACT_ENC_1A=0 node --test dist/src/vector-cortex/enc1a-acceptance.test.js`
      → **8/0** (aggregator flag-agnostic).
- [x] `node --test dist/vector-cortex/enc1a-acceptance.test.js` → **8/0, dual-dist proof**
      (legacy mirror).
- [x] `node --test dist/extensions/dashboard-server/routes-setup.test.js` →
      **7/0** (includes the 3 ENC-1a route-level round-trip tests + the
      pre-existing 4 setup tests).
- [x] `npm test` → full suite green, **0 failures across 391 files** (test
      count grew +3 files vs v0.20.49's 388).
- [x] `npm run lint` → clean (tsc + guardrails-scan + semantic-scan all pass).
- [x] `python3 scripts/regression_check.py --all` → **0 blocking** (7 unchanged
      dev-only/moderate warnings).
- [x] `python3 scripts/regression_check.py --soft-as-hard --pre-commit
      --soft-as-hard-base v0.20.49` → **no ENC-1a-introduced violations**. All
      flagged offenders (vc*-acceptance.test.ts, tieredRouter.ts) pre-date
      v0.20.49; none touched by this sprint. Worker A's sibling extract kept
      routes-setup.ts at 297 < 300 soft.
- [x] `node scripts/guardrails-scan.mjs` → clean (PREVENT-PI patterns).
- [x] `node scripts/vector-cortex-conformance.mjs --check` → **907 fixtures
      canonical** (+6 vs 901: 5 ENC-SET JSON + the new schema; previous
      ENC-0g fixtures preserved).
- [x] `node scripts/vector-cortex-docs-check.mjs` → **63 sprints clean**.
- [x] `cd extensions/dashboard-client && npm run typecheck && npm run build` →
      both exit 0 (vite, 2.38s; SetupTab chunk
      `dist/assets/SetupTab-*.js` 43.95 kB / gzip 12.70 kB).
- [x] `git diff --check` → clean.
- [ ] `node scripts/vector-cortex-scope-check.mjs ENC-1a <COMMIT_SHA>` → stamped
      at the ENC-1a commit below.
- [ ] `node scripts/vector-cortex-evidence-check.mjs ENC-1a` → stamped at the
      ENC-1a commit below.

Commits + deploy recorded below (spec §83 LIVE Playwright gates ENC-1a — not
checked until a live host post-deploy).

### Controller review fixes / scope confirmations

1. **Spec ownership correction (confirmed)**: `types/setup-cortex.ts` +
   `api/setup-cortex.ts` intentionally untouched — they belong to the VC9A
   setup-cortex feature surface, not ENC-1a's setup-status/configure surface.
   See "Spec correction" bullet above. The actual contract surface
   (`api-contracts/setup.ts`) is shared with several other routes and is the
   correct per Worker A placement.
2. **Deviation: `apiKeySet` boolean semantics.** When `ENC_1A` is on and no
   key exists, the GET returns `embeddingApiKeySet:false` rather than omitting
   the field. This is required by fixture ENC-SET-002 (the absent-key
   non-fatal branch) and sharpens the redaction story (UI can render the key
   input + an "is set" chip explicitly); flag-off still omits both fields for
   byte-identity.
3. **Deviation: combined-payload upsert.** POST carrying both a valid
   `embedder` selection AND the new ENC-1a keys applies the existing embedder
   write, then upserts the two ENC-1a keys via `writeEnc1aEnv` — so a client
   sending both fields in one request still persists the API key without
   dropping the embedder selection. The pure-ENC-1a branch (keys only, no
   embedder) goes through `tryEnc1aConfigure` and returns early with the
   correct response shape.

### Honest fallback + privacy

The raw API key is NEVER logged, NEVER returned to a GET client, NEVER
included in any event payload — EVAL-REDACT-002 aggregate-only invariant
extended to secret material (the redaction test on the aggregator asserts the
substring `sk-local-test` never appears in the GET body; the contract scan
asserts the response interface carries no `embeddingApiKey` key). Persisted
to disk only. The endpoint URL is echoed (it is not secret). No network calls
added (the routes read/write local files only; the embedder itself is the
pre-existing BYO loopback/remote flow — PREVENT-PI-004 exceptions
`MEGACOMPACT_ALLOW_REMOTE_EMBEDDER` semantics unchanged).

## Migration, privacy, dashboard, rollback

Migration disposition: **pure — no store/schema changes.** The two values
persist in the per-repo `.mega-compact.env` text file (the existing per-repo
state-dir mechanism), NOT in SQLite; the store schema and `stateDir` tables
are untouched. The writer is create-or-append (upsert): unrelated lines are
preserved verbatim, other keys untouched, keys are never deleted (passing
`null` for a key leaves its line alone). Secret material is written locally,
never broadcast. Dashboard: the Setup Embedder surface is touched
(`CustomEndpointSection`), the endpoint surface is `GET /api/setup-status` +
`POST /api/setup-configure` (additive fields/keys, no new router paths, no
EXPECTED_ENDPOINT_COUNT bump); the client gates are above in the checkpoint.
Rollback sets `MEGACOMPACT_ENC_1A=0`; the Setup surface renders only the
pre-existing toggles (URL field, no password input), the routes omit the new
fields, and POST with the new keys falls back to the pre-ENC-1a invalid-
embedder path, byte-identical to the ENC-0g survivor — without deleting the
saved `.mega-compact.env` lines (the runtime still reads them; rollback only
hides the UI).

## Live Playwright validation (controller — post-deploy)

Must be exercised live after `pi update --extensions`: Setup → Embedder →
Custom Endpoint, enter a test URL + test key, click save, reload, assert the
URL field re-renders the persisted value, the key field stays blank, and the
`apiKeySet:true` state is reflected on the card. Zero console errors. Pauses
at reviewer-accepted until a live host reaches v0.20.50.
