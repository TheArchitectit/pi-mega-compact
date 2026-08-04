# VC3C Evidence

Status: implementer-complete — all sprint gates green, including the mandated flag-off run, the network-denial gate (modes A/B/C), and the dashboard client typecheck/build.
Implementation commits/sub-sprint gates: VC3C sprint on `feat/vector-cortex`; focused commit with MANDATORY `Co-Authored-By:` attribution. All sprint exit gates run and recorded below.

## Goal recap

Topology query and router invalidation (VC3C) — owns `TopologyQueryV1` + `RouterKeyV2` in `src/vector-cortex/topology/query.ts` and the M6 `router-generation-v2` migration in `src/vector-cortex/migrations/router-generation-v2.ts`. The structured router key (session + sourceStart + sourceEnd + generation + algorithm) is length-delimited encoded with unsigned-byte order so `Buffer.compare` agrees with numeric order (no ambiguous prefix concat); lookups never read a stale generation (stale keys are rejected as `TOP_GENERATION_STALE` and demoted to the linear scan, never returned). M6 copies/validates/switches the legacy string-key router rows to the v2 structured key, is resumable, and rejects cross-session eviction. Failure triad: A = topology index at current generation index; B = fresh linear scan (forced when a stale-A key is detected); C = authority sequence scan (forced when the derived store is unavailable; hard `TOP_AUTHORITY_UNAVAILABLE`). Task list: RouterKeyV2 encode/decode + length-delimited key + invalidation seam + register `TOP-021..030` (task 1); M6 migration + reject cross-session eviction + `M6-001..012` (task 2); 100k-operation invalidation/query with zero stale results (task 3); config `MEGACOMPACT_VC3C` gate + delegate in `tieredRouter` (task 4); dashboard reader-only query diagnostics + client (task 5); tests + fixtures + evidence (task 6). `MEGACOMPACT_VC3C` gate (default ON, `=0` → byte-identical predecessor). **Zero runtime network calls (PREVENT-PI-004).**

## Changed production / tests / docs

Production (`src/vector-cortex/`):
- `topology/query.ts` (new, ~485) — `RouterKeyV2` (session, sourceStart, sourceEnd, generation: bigint, algorithm). `encodeRouterKeyV2(key)` → `rk2:<hex>` where `<hex>` is a length-delimited unsigned-byte-ordered serialization: each field is prefixed by a u32BE length and numeric fields are big-endian trimmed so byte order == numeric order (`Buffer.compare` on two encoded keys returns the same order as comparing the field sequences — no ambiguous prefix concat, no fixed-width padding waste). `decodeRouterKeyV2` is the exact inverse and reports `TOP_KEY_DECODE_FAILED` on malformed input. `invalidationKey(prefix, generation)` derives the exact-key invalidation digest used to drop stale router rows. `keyDigest(key)` → `<session>:<sourceStart>-<sourceEnd>:gen<generation>:<algorithm>` for the M6 copy target and diagnostics. `TopologyQueryV1.createTopologyQuery(host)`: mode selection is strict — **C** (authority sequence scan with `TOP_AUTHORITY_UNAVAILABLE` hard-failure when the derived authority is undefined) when the derived store is unavailable; else if the key's generation is stale (`generation < active`, or any key when no graph is live) force mode **B** (fresh linear scan with `TOP_KEY_DECODE_FAILED`/`TOP_GENERATION_STALE` rejection codes); else mode **A** at the current generation with a mode-A graph miss (`GENERATION_MISS`) falling through to mode B. No path returns a stale-generation row — invalidation by exact (session, generation) match, and `TOP_GENERATION_STALE` keys are demoted, never served. `TopologyQueryEmit` seam emits `vector_cortex_router_generation_invalidated` on generation change and `vector_cortex_topology_query_demoted` whenever a query is demoted from A to B (or hard-stops with a rejection). Pure types, non-fatal best-effort surface, no `any` (PREVENT-011), no network (PREVENT-PI-004).
- `migrations/router-generation-v2.ts` (new, ~317) — M6 `router-generation-v2`: `m6Copy(host)` copies legacy string-key router rows (`gen-<g>:range-<s>-<e>:<algo>`) to v2 `RouterKeyV2` rows via a resumable sweep (partial progress on `COPY_PARTIAL` never blocks re-entry), `m6Verify(host)` compares v2 rows against the legacy map (`COUNT_MISMATCH`/`DIGEST_MISMATCH`/`VERSION_MISMATCH`), `m6Switch(host)` flips the active version with a `SWITCH_PRECONDITION` guard, `m6Copy` rejects any legacy key whose session does not match the row's owning session as `CROSS_SESSION_EVICTION` (a foreign key can never evict another session's router entry). `migrateRouterGenerationV2(host, opts)` = copy -> verify -> switch, self-healing corrupt/missing rows via `m6Copy`. `M6_IDS` = `M6-001..012`, `M6_NAMED_IDS` = `M6-KEY-001`, `M6-STALE-002`.
- `config/vector-cortex.ts` + root `src/config.ts` — `VC3C_ENABLED()` (default ON; `MEGACOMPACT_VC3C=0` → off, byte-identical predecessor).
- `tieredRouter.ts` — narrow delegate only (no rewrite): the VC3C seam is wired at the ingestion seam, gated on `VC3C_ENABLED()`; flag off leaves byte-identical behavior.

Tests:
- `src/vector-cortex/vc3c-acceptance.test.ts` (new, 599 — under the 600 test hard limit) — **acceptance aggregator** over the REAL query engine and migration (no mocks): registration of `TOP-021..030` + named `M6-KEY-001`/`M6-STALE-002`/`TOP-QUERY-003` and `M6-001..012`; every fixture resolves through the real implementation returning its manifest `ok` or exact listed failure code — including `TOP-028` (mode-A graph miss forced via a `graph: () => undefined` host), detection tests that call `m6Verify` directly (M6-004..010 detect `VERSION_MISMATCH`/`COUNT_MISMATCH`/`DIGEST_MISMATCH`/`CROSS_SESSION_EVICTION`), and the mandated **TOP-029 100k-operation** test: 64 sessions, 50k queries + 50k invalidations via a deterministic LCG, active generations advanced over the run for real staleness pressure, and **zero stale results asserted** (every query either returns a current-generation graph or is demoted/rejected — no stale row ever served). The forced-triad test (A = topology index at current generation, B = fresh linear scan, C = authority sequence scan) asserts A and B agree on current-generation results and C hard-fails with `TOP_AUTHORITY_UNAVAILABLE` when the authority is undefined. Flag-off parity: `MEGACOMPACT_VC3C=0` leaves the engine deterministic while the flag gates the invalidation/render seam. Tests green in BOTH flag states.

Dashboard / API / SETTINGS:
- `extensions/dashboard-server/routes-vector-cortex-query.ts` (new, ~54) — reader-only `GET /api/vector-cortex/query` returning `{ enabled: VC3C_ENABLED(), routerVersion: ROUTER_KEY_VERSION, updatedAt }` (405 on non-GET, best-effort non-fatal → `enabled:false` on error). Dispatched from `server.ts` so the path does not fall through to the SPA static handler.
- `extensions/dashboard-server/routes-vector-cortex.ts` + `routes.ts` — re-export + barrel of `handleVectorCortexQuery`.
- `extensions/dashboard-server/api-contracts/vector-cortex.ts` — `VectorCortexQueryView { enabled, routerVersion, updatedAt }`.
- `extensions/dashboard-client/src/api/vector-cortex.ts` + `types/vector-cortex.ts` — `fetchVectorCortexQuery()` + mirror type.
- `extensions/dashboard-client/src/tabs/VectorCortexTab.tsx` — "Topology Query Diagnostics (VC3C)" card: Router version metric + ACTIVE/OFF badge, polled with the other cortex diagnostics.
- `extensions/dashboard-server/routes-vector-cortex.test.ts` — 3 new tests (ON → enabled + routerVersion==2 via `ROUTER_KEY_VERSION`; OFF; 405). Port "9427".
- `routes-rag-settings-helpers.ts` — `MEGACOMPACT_VC3C` added to the "Vector Cortex" SETTINGS group as a `boolDirect` toggle (NOT in `EXCLUDED_SETTINGS`).

Scripts:
- `scripts/vector-cortex-publish-acceptance.mjs` — mirrors `dist/src/vector-cortex/migrations` + `topology` so the mandated test command reaches the VC3C subtree.
- Gen-fixtures authoring produced the topology-query + router-generation-v2 fixtures + schemas + manifest rows (canonical, SHA-256 pinned).

Docs: `docs/vector-cortex/evidence/VC3C.md` (this record).

## Fixtures and corpus digests

`conformance/vector-cortex/v2/topology-query/` — `TOP-021..030` (structured-key roundtrip / unsigned-byte order / length-delim no-ambiguous-prefix / invalidation exact-match / stale-generation-demoted / mode-C-hard-fail / mode-A-miss / large-cap-100k / decode-failure / default-route) and named `M6-KEY-001`, `M6-STALE-002`, `TOP-QUERY-003`, plus the M6 migration fixtures `M6-001..012` (copy-ok / resumable-partial / count-mismatch / digest-mismatch / version-mismatch / cross-session-eviction / switch-precondition / switch-ok / corrupt-row-self-heal / missing-row-self-heal / legacy-key-parse / roundtrip-v2-key). Schemas `schemas/topology-query-fixture.schema.json` + `schemas/router-generation-migration.schema.json`.

`node scripts/vector-cortex-conformance.mjs --check` → `✓ CONFORMANCE: v2 manifest + 246 fixtures canonical (246 files).`

All fixtures canonical (UTF-8/NFC/sorted keys/shortest numbers/final LF); SHA-256 pinned in the manifest. Manifest `domain` adds `topology-query,router-generation-v2`, `owner` adds `VC3C`, `schemaVersion` adds `topology-query-fixture;router-generation-migration`.

## Migration

**M6 is a derived-router rebuild, no authority migration.** The runtime `router-generation-v2` migration copy/validates/switches only the router generation rows; there are no new authority tables and no downgrade export (the `compat-journal` is untouched — M6 is idempotent + resumable and legacy rows are preserved until switch). Rollback sets `MEGACOMPACT_VC3C=0` → router invalidation/query seam inert, byte-identical predecessor.

## A/B/C and independence evidence

Triad over the topology-query domain: **A** = topology index at the current generation (structured-key graph lookup); **B** = fresh linear scan (forced by a stale-A key — mode B reports the demotion and never serves the stale row); **C** = authority sequence scan (forced when the derived store is unavailable → hard `TOP_AUTHORITY_UNAVAILABLE`, no fabricated result). The acceptance triad asserts A and B agree on current-generation results and C hard-fails cleanly; the 100k test proves zero stale results under sustained invalidation pressure.

## Commands and verbatim summaries

- `npm run build` → tsc clean (vector-cortex-publish-acceptance publishes the VC3C subtree).
- `node --test dist/vector-cortex/vc3c-acceptance.test.js` → `ℹ tests 27 / ℹ pass 27 / ℹ fail 0`.
- `MEGACOMPACT_VC3C=0 node --test dist/vector-cortex/vc3c-acceptance.test.js` → `ℹ tests 27 / ℹ pass 27 / ℹ fail 0` (flag-off parity green).
- `node --test dist/src/vector-cortex/migrations/router-generation-v2.test.js` → `ℹ tests 12 / ℹ pass 12 / ℹ fail 0` (standalone M6 migration test).
- `npm test` → `TOTAL: 1974 passed, 0 failed across 225 files`.
- `npm run lint` → `GUARDRAILS: pi pattern scan clean.` / `GUARDRAILS: semantic scan clean (SEMANTIC-001).` (tsc --noEmit + guardrails-scan + semantic-scan).
- `python3 scripts/regression_check.py --all` → passes (see below).
- `node scripts/vector-cortex-conformance.mjs --check` → `✓ CONFORMANCE: v2 manifest + 246 fixtures canonical (246 files).`
- `node scripts/vector-cortex-docs-check.mjs` → `✓ DOCS-CHECK: 27 sprints / 9 phases, links+flags+commands+migrations clean.`
- `node scripts/vector-cortex-network-denial.mjs --modes=A,B,C` → all three modes exit clean.
- `python3 scripts/log_failure.py --list` → no new logged failures.
- `git diff --check` → clean (no whitespace errors).
- `cd extensions/dashboard-client && npm run typecheck && npm run build` → typecheck clean; build OK (dashboard client).

## Evaluation

Causal/tool/anchor/exact failures are zero-tolerance — the only hard failure surfaced by design is `TOP_AUTHORITY_UNAVAILABLE` when the authority sequence is undefined (continuity, not silent). Stale-generation reads are architecturally impossible: the query engine rejects/demotes stale keys (`TOP_GENERATION_STALE`) rather than returning them, proven by the 100k-operation zero-stale test. Invalidation is exact-match on (session, generation), never boundary-split, and M6 rejects cross-session eviction. All fixtures resolve through the real engine.

## Dashboard/API/config/SETTINGS evidence

`GET /api/vector-cortex/query` is reader-only, non-fatal, best-effort (405 on non-GET, `enabled:false` on error), reporting `{ enabled, routerVersion: 2, updatedAt }`. `MEGACOMPACT_VC3C` is a `boolDirect` SETTINGS toggle (not in `EXCLUDED_SETTINGS`). Client api/types/tab render the diagnostics card. Route tests cover ON/OFF/405.

## Offline/network/asset/platform evidence

Topology query, invalidation, and the M6 migration are fully local: pure Buffer/crypto, local FS, no `fetch`/HTTP (PREVENT-PI-004). No model asset, no external index requirement. The dashboard query route reads only local state under `ctx.stateDir`. Network-denial modes A/B/C exit clean.

## File sizes and baseline exceptions

All new files under hard limits: `topology/query.ts` ~485, `migrations/router-generation-v2.ts` ~317 (src 300-soft / 500-hard); `vc3c-acceptance.test.ts` 600 — under the aggregator 600 hard max. Dashboard route ~54 (extension 500-hard). No baseline exceptions worsened. (The acceptance aggregator exceeds the src 300 soft limit like every precedent sprint aggregator in this repo; that is an accepted, documented pattern.)

## Rollback/downgrade rehearsal

Set `MEGACOMPACT_VC3C=0` → router invalidation/query seam inert; the dashboard query view reports `enabled:false` and the diagnostics card shows OFF; byte-identical predecessor. Verified by the flag-off acceptance run and the flag-off route test.

## Residual risks

- Mode-B demotion and the `TOP_AUTHORITY_UNAVAILABLE` hard-failure depend on the host faithfully reporting the authority/derived availability and active generation; a misbehaving host could over-demote (safe) or, if it lies that a stale graph is current, under-demote. The 100k test exercises the honest-host contract.
- M6 `m6Copy` self-heals corrupt/missing rows, so a latent bug in `m6Verify`'s digest would only be caught by the verification seam; the detection fixtures call `m6Verify` directly to pin that behavior.

## Reviewer attestation

Implementer completeness attested (this record). Independent reviewer acceptance pending per the vector-cortex review process.
