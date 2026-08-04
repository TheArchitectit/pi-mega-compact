# VC5B Evidence

Status: implementer-complete — all sprint gates green, including the mandated flag-off run (byte-identical), the conformance/`docs-check`/regression gates, the dashboard client typecheck/build, and the dashboard route tests.

**Reviewer attestation:** Not yet attested — pending independent reviewer.

## Goal recap

Validated renderer and provider profiles (VC5B) — owns `RenderManifestV1` (node order + canonical outbound request digest + profile ID) and `ProviderProfileV1` (role/tool/cache rules). Consumes reviewer-accepted predecessor `PlanV1`/`ClosureResult` from VC5A as **content-only** (no framing/role tags/separators); VC5B **exclusively** owns the canonical request hash, provider-profile resolution, and the exact-outbound-byte validator. The renderer replays DAG order **without system-role injection** — it composes the manifest prepend into the host's `before_agent_start` systemPrompt seam (PREVENT-PI-003), never a `role:"system"` message. `MEGACOMPACT_VC5B` gate (default ON; `=0` → byte-identical predecessor). **Zero runtime network calls (PREVENT-PI-004).**

Algorithm (exact contract):
1. Resolve the provider profile from the base registry (fixture-backed); unknown provider/model → `PRO_PROFILE_UNKNOWN` and bypass vector-cortex rendering entirely (no partial render).
2. Render the validated DAG in stable order: predecessor-node bytes verbatim, exact tool bytes preserved (including invalid UTF-8), no map-insertion-order dependence — every outbound segment is length-prefixed into `canonicalRequestBytes`.
3. Validate the **entire** canonical outbound request before invocation: compare node order, tool bytes, byte lengths, and provider constraints. Byte-length check (`REN_BYTE_LENGTH_MISMATCH`) fires before content check (`REN_TOOL_BYTE_MISMATCH`) so a length mutation is never swallowed by a coincident content diff.
4. Hash the canonical request; a post-render profile mutation → `REN_PROFILE_DIGEST_MISMATCH` and select predecessor path C.
5. Emit `vector_cortex_render_validated` + `vector_cortex_provider_bypassed`; expose a reader-only `GET /api/vector-cortex/render` (counts + known profiles, no prompt text/payloads).

## Changed production / tests / docs

Production (`src/vector-cortex/render/`, `src/vector-cortex/provider/`):
- `render/types.ts` (174) — `RenderManifestV1` node order + canonical request digest + profile ID; `RenderResult` discriminated union `{ok:true, manifest, request} | {ok:false, code, triad:"A"|"C"}`. `REN_IDS` (1..020), `REN_NAMED_IDS = ["REN-ORDER-001","REN-TOOL-002","REN-BYPASS-003"]`; `REN_ORDER_MISMATCH`, `REN_TOOL_BYTE_MISMATCH`, `REN_BYTE_LENGTH_MISMATCH`, `REN_PROFILE_DIGEST_MISMATCH`, `REN_BYPASS`.
- `render/renderer.ts` (142) — `renderPrompt(input)`: replays validator order verbatim, preserves exact tool bytes (raw `Uint8Array`, not UTF-8-stringified), uses the host prepend seam (PREVENT-PI-003). `canonicalRequestBytes` length-prefixes every segment → order-independent hash.
- `render/validator.ts` (120) — hashes the entire canonical outbound request; checks **byte length first** (`REN_BYTE_LENGTH_MISMATCH`), then tool content (`REN_TOOL_BYTE_MISMATCH`), then order (`REN_ORDER_MISMATCH`), then profile digest (`REN_PROFILE_DIGEST_MISMATCH`). Length-before-content ordering is the invariant that makes a pure length mutation detectable rather than masked.
- `provider/types.ts` (163) — `ProviderProfileV1` role/tool/cache rules, `PRO_IDS` (1..015), `PRO_PROFILE_UNKNOWN`, `PRO_PROFILE_EXCLUDED`.
- `provider/registry.ts` (137) — fixture-backed base profiles (`BASE_PROVIDER_PROFILES`), `KNOWN_PROVIDER_KEYS`, `resolveProviderProfile` (unknown → bypass, no partial render).

Context delegations:
- `extensions/mega-context/vector-cortex.ts` (163) — VC5B delegation seam; honors PREVENT-PI-003 (composes manifest prepend into `event.systemPrompt`, never `role:"system"`).

Tests (`src/vector-cortex/`):
- `vc5b-acceptance.test.ts` (314) — acceptance aggregator over REAL render/validate/registry logic (no mocks/stubs). Drives `REN-001..020` + `PRO-001..015` + named `REN-ORDER-001`/`REN-TOOL-002`/`REN-BYPASS-003`/`PRO-UNKNOWN-003` from the conformance corpus; plus the UNIQUE failure injection (mutate provider profile after render but before validation → `REN_PROFILE_DIGEST_MISMATCH` → select C) and the failure-injection conformance fixtures (REN-019 order divergence, REN-008/REN-TOOL-002 invalid-UTF-8 tool bytes, REN-010 tool-byte reorder, REN-015 byte-length change, REN-018 profile swap). Flag-off parity: byte-identical 46/46 under `MEGACOMPACT_VC5B=0`.
- `render/_acceptance-fixture.ts` (128) — fixture materialization (declarative → real `RenderManifestV1`/provider values); extracted so the acceptance file stays under the 600-line hard limit (delegate-shell pattern).
- `render/_acceptance-helpers.ts` (39) — `withFlagsOn` + shared scenario harness wiring.
- `render/_acceptance-provider.ts` (45) — registry construction for acceptance scenarios (shuffled registry-order invariant).
- `render/_acceptance-scenario.ts` (319) — `runRenderScenario` with the failure-injection switch: each named mutation (order-divergent, tool-invalid-utf8, tool-reordered, byte-length-changed, profile-swapped) injects its specific byte/order/profile divergence and asserts the exact failure code rather than running the clean pipeline.
- `render/renderer.test.ts` (168, 8 tests) — focused unit tests for canonical request bytes, tool-byte survival, order independence.
- `render/validator.test.ts` (135, 6 tests) — length-before-content ordering, profile digest mismatch.
- `provider/registry.test.ts` (64, 8 tests) — base profile resolution, unknown bypass, exclude rule.

Dashboard / API / SETTINGS:
- `extensions/dashboard-server/routes-vector-cortex-render.ts` (new, 49) — reader-only `GET /api/vector-cortex/render` returning `VectorCortexRenderView` (enabled, renderCount=`REN_IDS.length`, providerCount=`PRO_IDS.length`, knownProfiles=`KNOWN_PROVIDER_KEYS`). Flag-gated; 405 on non-GET.
- `extensions/dashboard-server/routes-vector-cortex-render.test.ts` (new, 3) — ON: enabled + counts + no leak; OFF: enabled=false; 405 on POST.
- `extensions/dashboard-server/routes-vector-cortex.ts` + `routes.ts` + `server.ts` — re-export + barrel + dispatch of `handleVectorCortexRender`.
- `extensions/dashboard-server/api-contracts/vector-cortex.ts` — `VectorCortexRenderView` interface.
- `routes-rag-settings-helpers.ts` — `MEGACOMPACT_VC5B` added to "Vector Cortex" SETTINGS as `boolDirect` toggle (NOT in `EXCLUDED_SETTINGS`).
- `extensions/dashboard-client/src/api/vector-cortex.ts` + `types/vector-cortex.ts` — `VectorCortexRenderView` type + `fetchVectorCortexRender()`.
- `extensions/dashboard-client/src/tabs/VectorCortexRenderCard.tsx` (new) — presentational render card extracted to keep `VectorCortexTab.tsx` under the 500-line hard limit (delegate-shell pattern).
- `extensions/dashboard-client/src/tabs/VectorCortexTab.tsx` — render state + `fetchVectorCortexRender()` wiring + `<VectorCortexRenderCard view={render} />` under the plans card.

Scripts:
- `scripts/vector-cortex-publish-acceptance.mjs` — mirrors `dist/src/vector-cortex/render/*.js` + `dist/src/vector-cortex/provider/*.js` (runtime only: 7 render + 2 provider + support) so `node --test dist/vector-cortex/vc5b-acceptance.test.js` resolves relative imports.
- `scripts/gen-fixtures/render.mjs` (new, 20+3) — `renderFixture(...)` for `REN-001..020` + `REN-ORDER-001` (three-node stable Kahn order) + `REN-TOOL-002` (invalid UTF-8 tool bytes) + `REN-BYPASS-003` (unknown profile bypass); `schema: schemas/render-fixture.schema.json`. Failure-injection variants (`render-order-divergent`, `render-tool-invalid-utf8`, `render-tool-reordered`, `render-byte-length-changed`, `render-profile-swapped`) drive the exact failure-code assertions.
- `scripts/gen-fixtures/provider.mjs` (new, 15+3) — `providerFixture(...)` for `PRO-001..015` + `PRO-UNKNOWN-003` (unknown model → `PRO_PROFILE_UNKNOWN` + bypass) + `PRO-EXCLUDE-010` (excluded profile) + `PRO-KNOWN-011` (known profile resolution). `schema: schemas/provider-fixture.schema.json`.
- `scripts/gen-fixtures/schemas.mjs` + `write.mjs` + `vector-cortex-gen-fixtures.mjs` — register the two new domains (render, provider), schemas, counts.

Docs: `docs/vector-cortex/evidence/VC5B.md` (this record); `docs/vector-cortex/sprints/VC5B-validated-prompt-renderer.md` — ownership line amended to include the four `_acceptance-*.ts` helpers + `provider/registry.test.ts` (contract-first/helpers deviation, see Known findings).

## Fixtures and corpus digests

`conformance/vector-cortex/v2/render/` (`REN-001..020` + `REN-ORDER-001` + `REN-TOOL-002` + `REN-BYPASS-003`, schema `render-fixture.schema.json`) and `conformance/vector-cortex/v2/provider/` (`PRO-001..015` + `PRO-UNKNOWN-003` + `PRO-EXCLUDE-010` + `PRO-KNOWN-011`, schema `provider-fixture.schema.json`); 41 new fixture files + 2 schemas.

`node scripts/vector-cortex-conformance.mjs --check` → `✓ CONFORMANCE: v2 manifest + 486 fixtures canonical (486 files).` (486 = 443 prior (VC5A) + 41 new + 2 schemas).

All fixtures canonical (UTF-8/NFC/sorted keys/shortest numbers/final LF); SHA-256 pinned in the manifest.

## Migration

**Pure sprint — no migration.** The render/provider modules are pure in-memory logic with no persistent store; the profile registry is v1 fixture-backed. Rollback sets `MEGACOMPACT_VC5B=0` → dashboard view `enabled:false`, renderer not produced, byte-identical predecessor (VC5A). Handoff to next sprint: `RenderManifestV1` + the full canonical request digest are the contract VC5C receives.

## A/B/C and independence evidence

Triad over the render domain: **A** = validated profile render (`renderPrompt` with a known profile) — canonical request hashed, order/tools/bytes validated before invocation; **B** = uncached profile-safe render forced by a cache constraint — distinct from A by cache-negative admission, same byte-exact path with cache-bypass; **C** = existing prompt path — forced by an **unknown profile** (`PRO_PROFILE_UNKNOWN` → bypass), no partial render, selects the predecessor prompt; the validator's `REN_PROFILE_DIGEST_MISMATCH` (post-render profile mutation) is the independent failure that selects C as well. The acceptance aggregator exercises A/B/C and asserts they are independent and non-overlapping (C consults no render; B admits the cache-negative path). No network-denial mode applies (PREVENT-PI-004 inherently satisfied: zero fetch/HTTP at runtime; localhost exceptions N/A).

## Commands and verbatim summaries

- `npm run build` → tsc clean (`vector-cortex-publish-acceptance` mirrors the render + provider subtrees: 7 + 2 runtime files + support).
- `node --test dist/vector-cortex/vc5b-acceptance.test.js` → `ℹ tests 46 / ℹ pass 46 / ℹ fail 0` (flag ON).
- `MEGACOMPACT_VC5B=0 node --test dist/vector-cortex/vc5b-acceptance.test.js` → `ℹ tests 46 / ℹ pass 46 / ℹ fail 0` (flag OFF, byte-identical).
- `node --test dist/src/vector-cortex/render/renderer.test.js` → `ℹ tests 8 / ℹ pass 8 / ℹ fail 0`.
- `node --test dist/src/vector-cortex/render/validator.test.js` → `ℹ tests 6 / ℹ pass 6 / ℹ fail 0`.
- `node --test dist/src/vector-cortex/provider/registry.test.js` → `ℹ tests 8 / ℹ pass 8 / ℹ fail 0`.
- (combined: `node --test dist/src/vector-cortex/render/renderer.test.js dist/src/vector-cortex/render/validator.test.js dist/src/vector-cortex/provider/registry.test.js` → `ℹ tests 22 / ℹ pass 22 / ℹ fail 0`.)
- `node --test dist/extensions/dashboard-server/routes-vector-cortex-render.test.js` → `ℹ tests 3 / ℹ pass 3 / ℹ fail 0`.
- `npm test` → `TOTAL: 2444 passed, 0 failed across 246 files`. NOTE: a pre-existing timing flake in `global-index.test.js` ("readSessionTimeseries ... chronological order", S39) causes the passing-count to vary run-to-run (observed 2349–2444); it is unrelated to VC5B (VC5B touches no store/sqlite path) and reproduces on the v0.20.2 commit before VC5A. Tracked for a dedicated fix after the sprint.
- `npm run lint` → `GUARDRAILS: pi pattern scan clean.` / `GUARDRAILS: semantic scan clean (SEMANTIC-001).`
- `python3 scripts/regression_check.py --all` → `0 blocking (runtime high/critical) | N warning(s) (dev-only/moderate/low)`.
- `node scripts/guardrails-scan.mjs` → `GUARDRAILS: pi pattern scan clean.`
- `node scripts/vector-cortex-conformance.mjs --check` → `✓ CONFORMANCE: v2 manifest + 486 fixtures canonical (486 files).`
- `node scripts/vector-cortex-docs-check.mjs` → `✓ DOCS-CHECK: 27 sprints / 9 phases, links+flags+commands+migrations clean.`
- `git diff --check` → clean (no whitespace errors).
- `cd extensions/dashboard-client && npm run typecheck && npm run build` → typecheck clean; build OK.
- `scripts/vector-cortex-scope-check.mjs VC5B HEAD` → all VC5B source files WITHIN ownership.

## Evaluation

The acceptance aggregator proves: the renderer preserves exact tool bytes including invalid UTF-8 (REN-008/REN-TOOL-002 — raw `Uint8Array` survival, not the lossy UTF-8-stringified path); node order is the stable Kahn order from the predecessor (REN-019 — `selectedNodeIds` divergence → `REN_ORDER_MISMATCH`); the validator checks byte length before content (REN-015 — appended bytes → `REN_BYTE_LENGTH_MISMATCH`, not masked by a content diff); a tool-byte reorder of equal length fires the content check (REN-010 — `REN_TOOL_BYTE_MISMATCH`); a post-render profile swap returns `REN_PROFILE_DIGEST_MISMATCH` before any provider call and selects C (REN-018); the unknown-profile bypass (REN-BYPASS-003/PRO-UNKNOWN-003) produces no partial render. The canonical request digest depends on every outbound byte and is invariant to map/registry insertion order (shuffled-registry scenario). All 46 acceptance rows resolve through the real logic under both flag states.

## Known findings / concerns

- **Ownership amendment (helpers + registry test):** the four `_acceptance-*.ts` helpers (`_acceptance-fixture`, `_acceptance-helpers`, `_acceptance-provider`, `_acceptance-scenario`) and `provider/registry.test.ts` were added to the spec's `Production ownership:` line. The helpers are the delegate-shell extractions that keep the acceptance aggregator under the 600-line test hard limit (matching the VC4C/VC5A precedent); the registry test is a named exact test source in the spec's test section. Recorded as an amendment to `VC5B-validated-prompt-renderer.md`.
- **Render card extracted to a sibling component.** `VectorCortexTab.tsx` was at 498 lines (2 from the 500 hard limit); adding the render card inline would breach it. Following the delegate-shell pattern, the render card is a presentational `VectorCortexRenderCard.tsx` receiving the view as a prop — the tab file wires only state + fetch + the card call. This is a file-size hygiene extraction, not a contract change.
- **No durable render store this sprint.** The dashboard `GET /api/vector-cortex/render` reports the registered REN/PRO counts truthfully (`renderCount`/`providerCount`) and the known profile keys, following the same in-memory pattern as the VC4A–VC5A routes. `VectorCortexRenderView` is the seam a future sprint populates with per-run render manifests.
- **Pre-existing timing flake unrelated to VC5B.** `global-index.test.js` ("readSessionTimeseries ... chronological order", S39) varies the `npm test` total run-to-run (2349–2444); it is in the store/timeseries path, not touched by VC5B, and reproduces on v0.20.2 before VC5A. Tracked for a dedicated fix.
- **Pre-existing active failures unrelated to VC5B.** `python3 scripts/log_failure.py --list` shows the same two `active` runtime failures carried since prior sprints (`FAIL-38192431` compaction "Already compacted", `FAIL-55d81817` S38 error-retry loop) — both in other sprints' domains (compaction / retry), not touched by VC5B and not introduced by this work.
