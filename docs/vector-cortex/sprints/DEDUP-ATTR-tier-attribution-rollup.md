# DEDUP-ATTR — Dedup tier attribution rollup

**Status:** planned | **Depends on:** external-audit #2 (dedup audit event stream, SHIPPED) | **Phase:** ATTR
**Flag:** `MEGACOMPACT_DEDUP_ATTR`, defined in `src/config/vector-cortex.ts` (extracted to the `vector-cortex-dedup-attr.ts` sibling), re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_DEDUP_ATTR=0` disables and must be byte-identical to the predecessor (no `/api/dedup-tier-attribution` endpoint — 404; no rollup writes). Registered in `VECTOR_CORTEX_SETTINGS` as a boolDirect, never in `EXCLUDED_SETTINGS`.

## Goal and inputs/outputs

Close the last open piece of external-audit item #6: per-tier dedup catch attribution. Inputs are the produced `dedup_audit` events in `stateDir/events.log` (shape `DedupAuditEvent` in `src/vectorStore/dedup-audit.ts:45-68`). Outputs: (a) a reader-only JSON endpoint `GET /api/dedup-tier-attribution` answering "L0/L1/L2/new percent of dedup decisions in window W", and (b) a `DedupTierRollupV1` snapshot JSON at `stateDir/dedup-tier-attribution.json` cached per query-window for bounded read latency.

Production ownership: `extensions/dashboard-server/routes-dedup-attribution.ts (new — GET /api/dedup-tier-attribution, reader-only, memoized); extensions/dashboard-server/routes-dedup-attribution.test.ts (new — unit tests over a synthetic events.log); extensions/dashboard-server/api-contracts/dedup-attribution.ts (new — DedupTierRollupV1 contract, explicit types, no any); extensions/dashboard-server/api-contracts/endpoints/registry-ext.ts (additive — dedup-tier-attribution group); extensions/dashboard-server/api-contracts.test/endpoints-registry.test.ts (EXPECTED_ENDPOINT_COUNT 55→56, mechanical registry-count reconciliation, added to Production ownership); extensions/dashboard-server/api-contracts/index.ts (additive — type re-export barrel entry for DedupTierRollupV1, same precedent as every other additive contract); extensions/dashboard-server/route-dispatch.ts (additive if-chain entry); extensions/dashboard-server/routes.ts (additive re-export); src/vector-cortex/dedup-attr/rollup.ts (new — pure function: read events.log lines → bucket by tier → compute shares; zero clock in contract-test mode, wall-clock injectable); src/vector-cortex/dedup-attr/rollup.test.ts (new — pure-fn unit tests); src/vector-cortex/dedup-attr-acceptance.test.ts (new — acceptance aggregator, flag-agnostic); src/config/vector-cortex-dedup-attr.ts (new — flag, sprintFlag pattern); src/config/vector-cortex.ts (additive re-export, ≤300 soft); src/config.ts (additive re-export, ≤300 soft); extensions/dashboard-server/routes-rag-settings-vector-cortex.ts (additive boolDirect toggle); conformance/vector-cortex/v2/dedup-attribution/ (fixtures DEDUP-ATTR-001..004); conformance/vector-cortex/v2/schemas/dedup-attribution-fixture.schema.json (new sibling schema, mirrors setup-cortex-action-fixture precedent); scripts/dedup-attr/gen-fixtures.mjs (new generator); conformance/vector-cortex/v2/manifest.json (additive rows); docs/vector-cortex/sprints/DEDUP-ATTR-tier-attribution-rollup.md (this file — bump EXPECTED_SPRINTS in scripts/vector-cortex-docs-check.mjs 44→45); docs/vector-cortex/evidence/DEDUP-ATTR.md (new); scripts/vector-cortex-docs-check.mjs (bump 44→45)`.

## Numbered implementation tasks

1. Define `DedupTierRollupV1` in `api-contracts/dedup-attribution.ts`: `{ schema:"dedup-tier-rollup-v1", windowStart: string, windowEnd: string, totalDecisions: number, byTier: { l0: {deduped:number; passed:number}, l1: {deduped:number; passed:number}, l2: {deduped:number; passed:number}, new: number }, l0Share: number, l1Share: number, l2Share: number, updateHz?: number, status: VcStatus }`. Shares are fractions of the window's total decisions (deduped+passed+stored), each in [0,1]. No `any`.
2. Add the `MEGACOMPACT_DEDUP_ATTR` flag (default ON, `=0` byte-identical) in `src/config/vector-cortex-dedup-attr.ts` (sprintFlag pattern from `src/config/vector-cortex-flag.ts`), re-exports in `vector-cortex.ts` + `config.ts`, registered as a boolDirect in `VECTOR_CORTEX_SETTINGS`, NEVER listed in `EXCLUDED_SETTINGS`.
3. Author the pure rollup `src/vector-cortex/dedup-attr/rollup.ts`: `computeDedupTierRollup(events: DedupAuditEvent[], windowMs: number, now: Date): DedupTierRollupV1`. Pure, no I/O, no Date.now() inside (the route passes new Date() at request time). Missing `similarity` is fine (L0/L1 are hash tiers). Never crash on malformed events — filter out non-`dedup_audit` types.
4. Implement `handleDedupTierAttribution` in `routes-dedup-attribution.ts`: resolves the per-repo stateDir from RouteContext, reads `events.log` once per request (bounded tail — last 8 MiB only, streaming), parses JSON lines, filters to type `dedup_audit`, calls the rollup with windowMs from a `?windowMs=<n>` query param (default 24h, capped at 30 days), and sends as JSON with `deriveVcStatus({enabled: DEDUP_ATTR_ENABLED(), hasData: events.length > 0, structuralOnly: false})`. Memoize by `{events.log mtime, windowMs}` for ≤5s per stateDir (mirrors `routes-vector-cortex-health.ts` memoized-facts pattern).
5. Register the route in `routes.ts` + `route-dispatch.ts`, register the contract endpoints in the additive `registry-ext.ts` group `dedup-attribution`, bump `EXPECTED_ENDPOINT_COUNT` 55→56 (the test file crosses into Production ownership mechanically).
6. Register the `MEGACOMPACT_DEDUP_ATTR` boolDirect toggle row in `routes-rag-settings-vector-cortex.ts` ("Dedup Tier Attribution Rollup" — additive, keeps file under its soft cap).
7. Generate+commit `conformance/vector-cortex/v2/dedup-attribution/DEDUP-ATTR-001..004.json` via `scripts/dedup-attr/gen-fixtures.mjs`; write+commit `conformance/vector-cortex/v2/schemas/dedup-attribution-fixture.schema.json`; register rows in the v2 manifest with algorithm `dedup-attribution`.
8. Add the route unit tests (`routes-dedup-attribution.test.ts`) + the acceptance aggregator `src/vector-cortex/dedup-attr-acceptance.test.ts`. Both flag-agnostic (same suite passes `node --test dist/vector-cortex/dedup-attr-acceptance.test.js` and `MEGACOMPACT_DEDUP_ATTR=0 node --test dist/vector-cortex/dedup-attr-acceptance.test.js`).
9. Evidence doc `docs/vector-cortex/evidence/DEDUP-ATTR.md`; bump `EXPECTED_SPRINTS` 44→45 in `scripts/vector-cortex-docs-check.mjs`. Note in evidence: dashboard-client NOT touched (server-only sprint).

## Failure triad and independence

A: window has events and tier shares are non-trivial (all three tiers + new). B: window is empty (no dedup decisions in the last 24h) — endpoint returns `totalDecisions:0`, shares 0, `status:"off"` from `deriveVcStatus(hasData:false)` — NOT a fabricated zero-share table. C: flag-off — endpoint 404s, byte-identical predecessor. A uses real parsed events; B is produced by the in-window filter on an empty input; C is produced purely by the flag gate.

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/dedup-attribution/`.

- `DEDUP-ATTR-001: non-empty window returns shares summing to 1.0, status live`.
- `DEDUP-ATTR-002: empty window returns totalDecisions 0 + shares 0 + status awaiting_data (NOT fabricated zeros presented as real)`. Blocks the dashboards-zero bug class.
- `DEDUP-ATTR-003: flag-off returns 404 + no file writes (no rollup cache write, byte-identical to predecessor)`.
- `DEDUP-ATTR-004: rollup is pure — two calls with the same events + window + now are deep-equal (determinism)`.

Exact test sources: `extensions/dashboard-server/routes-dedup-attribution.test.ts`, `src/vector-cortex/dedup-attr/rollup.test.ts`. Sprint acceptance aggregator: `src/vector-cortex/dedup-attr-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/dedup-attr-acceptance.test.js
```

Expected assertions: all DEDUP-ATTR-001..004 registered with algorithm `dedup-attribution`, path `dedup-attribution/<id>.json`, schema `schemas/dedup-attribution-fixture.schema.json`, expected `ok`. Route tests: flag-on 200 with the full contract shape; flag-off 404; non-GET 405; malformed events.log lines skipped silently (no throw). Rollup tests: pure-determinism pinned (DEDUP-ATTR-004); L0/L1 `similarity: undefined` is carried through honestly (the fixtures omit the field for L0/L1 decisions). Exact flag-off comparison: `MEGACOMPACT_DEDUP_ATTR=0 node --test dist/vector-cortex/dedup-attr-acceptance.test.js`; the aggregator is flag-agnostic. Acceptance: zero payload leakage (the endpoint reports counts + shares only, never matched entry contents, never raw query text); reader-only; every endpoint returns a non-empty `status` from `deriveVcStatus`. Apply [EVALUATION](../EVALUATION.md) rules; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Pure — no schema/state change (the events.log format is unchanged; we only READ it). Privacy: the endpoint emits tier counts + shares, never matched checkpoint paths/text; never raw user query. Dashboard: server-only; the client Cards/Overview surfaces can poll this later but VC9-style card work is out of scope for DEDUP-ATTR. Rollback: `MEGACOMPACT_DEDUP_ATTR=0` — 404 + no cache file + byte-identical predecessor. No operator migration.

## Exit evidence

Run the standard gates:

```bash
npm run build
node --test dist/vector-cortex/dedup-attr-acceptance.test.js
MEGACOMPACT_DEDUP_ATTR=0 node --test dist/vector-cortex/dedup-attr-acceptance.test.js
npm test
npm run lint
python3 scripts/regression_check.py --all
node scripts/guardrails-scan.mjs
python3 scripts/log_failure.py --list
node scripts/vector-cortex-conformance.mjs --check
node scripts/vector-cortex-docs-check.mjs
node scripts/vector-cortex-scope-check.mjs DEDUP-ATTR <COMMIT_SHA>
node scripts/vector-cortex-evidence-check.mjs DEDUP-ATTR
git diff --check
```

Dashboard-client NOT touched (server-only) — the `cd extensions/dashboard-client && npm run typecheck && npm run build` gate is SKIPPED by scope declaration. Note the skip in the evidence doc.

This sprint adds the 45th sprint doc; `EXPECTED_SPRINTS` in `scripts/vector-cortex-docs-check.mjs` is bumped from 44 to 45 and the script is included in Production ownership (docs-check reconciliation, not scope drift).
