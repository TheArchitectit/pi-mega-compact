# DEDUP-ATTR Evidence

Status: REVIEWED + COMMITTED (impl commit `62e1a08`, spec-amendment commit `92d259a`)
Sprint: [DEDUP-ATTR tier attribution rollup](../sprints/DEDUP-ATTR-tier-attribution-rollup.md) — closes the last open piece of external-audit item #6 (per-tier dedup catch attribution).

## Deliverables

Reader-only `GET /api/dedup-tier-attribution` answering "L0/L1/L2/new percent of dedup decisions in window W", backed by a pure rollup over the local `events.log` `dedup_audit` stream, plus a durable `stateDir/dedup-tier-attribution.json` snapshot and a bounded in-memory memo (≤5s, keyed on events.log mtime+size+windowMs — mirrors the routes-vector-cortex-health memoized-facts pattern). Reuses `DedupAuditEvent` (`src/vectorStore/dedup-audit.ts`), `deriveVcStatus` (`extensions/dashboard-server/vc-status.ts`) and the memoized-facts pattern — none re-implemented.

## File list and line counts

Production / config / tests / docs / conformance (all under soft caps; `src` 300, `extensions` 400, `tests` 600):

- `src/config/vector-cortex-dedup-attr.ts` (16) — new `DEDUP_ATTR_ENABLED` sprintFlag extract.
- `src/config/vector-cortex.ts` (300) — additive re-export; kept at exactly the 300 soft cap by condensing the sibling-extracts comment to one line (see Deviations).
- `src/config.ts` (205) — additive re-export.
- `src/vector-cortex/dedup-attr/rollup.ts` (136) — new PURE rollup (no I/O, no clock, wall-clock injected at request time).
- `src/vector-cortex/dedup-attr/rollup.test.ts` (133) — new pure-fn unit tests.
- `src/vector-cortex/dedup-attr-acceptance.test.ts` (155) — new acceptance aggregator (flag-agnostic).
- `extensions/dashboard-server/routes-dedup-attribution.ts` (166) — new reader-only route (bounded 8 MiB tail, memoized, deriveVcStatus, flag-gated). Controller-applied querystring-split fix added 1 line (impl: 165).
- `extensions/dashboard-server/routes-dedup-attribution.test.ts` (289) — new route unit tests.
- `extensions/dashboard-server/api-contracts/dedup-attribution.ts` (69) — new `DedupTierRollupV1` / `DedupTierCounts` / `DedupTierAttributionResponse` contract (no `any`).
- `extensions/dashboard-server/api-contracts/endpoints/registry-ext.ts` (172) — additive `dedupTierAttribution` endpoint group.
- `extensions/dashboard-server/api-contracts.test/endpoints-registry.test.ts` (200) — `EXPECTED_ENDPOINT_COUNT` 55→56 + `/api/dedup-tier-attribution` path (mechanical reconciliation).
- `extensions/dashboard-server/api-contracts/index.ts` (345) — additive type re-export barrel entry.
- `extensions/dashboard-server/routes.ts` (69) — additive route re-export.
- `extensions/dashboard-server/route-dispatch.ts` (164) — additive if-chain entry + import.
- `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts` (255) — additive `MEGACOMPACT_DEDUP_ATTR` boolDirect toggle (visible, never EXCLUDED_SETTINGS).
- `scripts/dedup-attr/gen-fixtures.mjs` (199) — new idempotent conformance generator.
- `scripts/vector-cortex-docs-check.mjs` — `EXPECTED_SPRINTS` 44→45 (docs-check reconciliation, in Production ownership).
- `conformance/vector-cortex/v2/dedup-attribution/DEDUP-ATTR-001..004.json` (1 each, canonical JSON) — new fixtures.
- `conformance/vector-cortex/v2/schemas/dedup-attribution-fixture.schema.json` (1, canonical JSON) — new sibling schema.
- `conformance/vector-cortex/v2/manifest.json` — additive rows (algorithm `dedup-attribution` ×4 + schema; owner += DEDUP-ATTR; domain += dedup-attribution).
- `docs/vector-cortex/evidence/DEDUP-ATTR.md` — this record.

## Failure triad and independence

- **A (non-empty window, all tiers + new):** real parsed events drive per-tier counts + shares; shares sum to 1.0 when the window has no `new` (DEDUP-ATTR-001), status `live`.
- **B (empty window):** in-window filter on an empty input → `totalDecisions:0`, zero shares, `awaiting_data` from `deriveVcStatus(hasData:false)` — NOT a fabricated zero-share table (DEDUP-ATTR-002, blocks the dashboards-zero bug class).
- **C (flag-off):** `MEGACOMPACT_DEDUP_ATTR=0` → endpoint 404 + no durable cache write, byte-identical predecessor (DEDUP-ATTR-003).
- **D (pure determinism):** same events+window+now is deep-equal (DEDUP-ATTR-004).

## Gate results (implementer-permitted)

| Gate | Result |
|------|--------|
| `npx tsc --noEmit` (whole project) | PASS — 0 errors across all files |
| `node scripts/dedup-attr/gen-fixtures.mjs` | PASS — 4 fixtures + 1 schema emitted; manifest updated; **re-run idempotent (byte-identical manifest)** |
| `node scripts/vector-cortex-conformance.mjs --check` | PASS — 852 fixtures canonical (847 + 4 fixtures + 1 schema) |
| `node scripts/vector-cortex-docs-check.mjs` | PASS — 45 sprints / 11 phases |
| `node scripts/guardrails-scan.mjs` | PASS — pi pattern scan clean |
| `node scripts/semantic-scan.mjs` | PASS — SEMANTIC-001 clean |
| `python3 scripts/regression_check.py --all` | PASS — trainer/python files compile; no blocking findings |
| `git diff --check` | (controller must run) |

## Gates the controller must run

`npm run build`; `node --test dist/vector-cortex/dedup-attr-acceptance.test.js`; `MEGACOMPACT_DEDUP_ATTR=0 node --test dist/vector-cortex/dedup-attr-acceptance.test.js` (flag-off parity); `node --test dist/vector-cortex/dedup-attr/rollup.test.js`; `node --test dist/extensions/dashboard-server/routes-dedup-attribution.test.js`; `npm test`; `npm run lint`; `python3 scripts/regression_check.py --all` (+ deploy's `--soft-as-hard`); `python3 scripts/log_failure.py --list`; `node scripts/vector-cortex-conformance.mjs --check`; `node scripts/vector-cortex-docs-check.mjs`; `node scripts/vector-cortex-scope-check.mjs DEDUP-ATTR <COMMIT_SHA>`; `node scripts/vector-cortex-evidence-check.mjs DEDUP-ATTR`; `git diff --check`.

**Dashboard-client gates SKIPPED by scope declaration** — DEDUP-ATTR is server-only; the dashboard CLIENT is not touched (`cd extensions/dashboard-client && npm run typecheck && npm run build` is skipped per the spec exit-evidence section).

## Deviations (and why)

1. **`src/config/vector-cortex.ts` comment condensed** — the file was already exactly at its 300 soft cap. Adding the required `DEDUP_ATTR_ENABLED` re-export line would push it to 301 and fail deploy's `--soft-as-hard` gate on the changed file. Removed the non-load-bearing one-line `// Sibling extracts: stay under the 300-line soft limit.` comment to keep the file at 300 (same condense-to-one-line accommodation the VC9A/VC9D sibling extracts use). No behavior change; verified via `wc -l` + `tsc` 0 errors.
2. **Durable snapshot write uses `DedupTierAttributionResponse`** (contract includes the derived `status`), matching the spec's "snapshot JSON at `stateDir/dedup-tier-attribution.json`". Best-effort write, never breaks the read path.
3. **Rollup status computed from the pure signal it owns** (`totalDecisions > 0 ? "live" : "awaiting_data"`) — the rollup only ever runs with the flag ON (off ⇒ 404 before the rollup), so this equals `deriveVcStatus({enabled:true, hasData})`; the route additionally derives the sent status via `deriveVcStatus` (reused, not re-implemented).
4. **(Controller fix) Route URL claim splits `?` before the strict path match** — the implementer's `if (url !== "/api/dedup-tier-attribution") return false;` rejected every request carrying a `?windowMs=` querystring (5 of 7 route tests failed pre-commit on `claimed === false`; only the querystring-less 405 + non-matching-URL tests passed). The route must claim `/api/dedup-tier-attribution` for ANY querystring variants because `resolveWindowMs(url)` reads the params later on the full `url`. Fix mirrors the `routes-vector-cortex-query.ts:33` precedent: `const path = url.split("?", 1)[0] ?? url;`. Also added the `dedup-attr` subtree to `scripts/vector-cortex-publish-acceptance.mjs` (`nDedupAttr` block after `nSupport`) so the acceptance aggregator's `./dedup-attr/rollup.js` import resolves at the published `dist/vector-cortex/` offset — same additive pattern as prior subtrees (tests excluded from the mirror to avoid double-runs; rollup unit tests run at `dist/src/vector-cortex/dedup-attr/rollup.test.js`).

## Rollback

`MEGACOMPACT_DEDUP_ATTR=0` — endpoint 404, no durable snapshot write, byte-identical predecessor. No schema/state change (events.log is only READ, format unchanged). No operator migration.

## Residual risks

- **Client not touched:** the client poll surface for this endpoint is VC9-style card work explicitly out of scope for DEDUP-ATTR.
- **Controller attestation (Opus):** gates replicated on controller — `npm run build`, acceptance flag-default + flag-off parity (7/7 both), rollup pure-fn (7/7 via `dist/src/vector-cortex/dedup-attr/rollup.test.js`), routes (7/7 after controller-applied Deviation-4 fix), npm test (3693 pass / 0 fail / 370 files), npm run lint (tsc --noEmit + guardrails + semantic scan), regression `--all --soft-as-hard --soft-as-hard-base v0.20.41 --pre-commit` (0 blocking; 7 dev-only non-blocking warnings), conformance 852 canonical, docs-check 45 sprints / 11 phases, log_failure --list all resolved, git diff --check clean, scope-check 62e1a08 + 92d259a both pass. Controller fixed Deviation 4 (querystring claim) + added the `nDedupAttr` publish-acceptance mirror block; Deviation 1 stays; Deviations 2–3 stand as implementer decisions. Impl commit `62e1a08`, spec-amendment `92d259a`.
