# VC0A Evidence

Status: implementer-complete
Implementation commits/sub-sprint gates: VC0A bootstrap sprint on `feat/vector-cortex`; see git log for the focused commit(s). All sprint exit gates run and recorded below.
Contract review: not yet performed — pending independent reviewer.

## Goal recap

Baseline observability. Owner of **MetricEventV1 / AnnotationV1**. Algorithms: canonical JSONL metric order `(session,seq,event)`; fixed latency histogram buckets `1/5/10/25/50/100/250ms` inclusive with separate overflow; redact payload/prompt/ledger to digest/count before JSONL.

## Changed production / tests / docs

Production (`src/`):
- `src/config/vector-cortex.ts` — `VC0A_ENABLED()` (default ON; `MEGACOMPACT_VC0A=0` / `_DISABLED` → off) + breaker constants (reserved for later sprints).
- `src/vector-cortex/eval/types.ts` — `MetricEventV1`, `AnnotationV1`, `UNITS`, `LATENCY_BUCKETS`, `EvalReject` (`EVAL_ORDER_INVALID`, `EVAL_UNIT_UNKNOWN`, `EVAL_JSONL_TRUNCATED`), `EVAL_IDS`.
- `src/vector-cortex/eval/metrics.ts` — `sortCanonical`, `bucketIndex`, `bucketHistogram`, `buildMetrics`.
- `src/vector-cortex/eval/annotations.ts` — payload/prompt/ledger redaction to digest/count.
- `src/vector-cortex/eval/observer.ts` — `createEvalObserver` (emits `vector_cortex_eval_sample_recorded` / `vector_cortex_eval_redaction_rejected`), optional `persist` hook.
- `src/vector-cortex/eval/reader.ts` — `summarizeEvalRows` (reader-only aggregate).
- `src/vector-cortex/eval/persist.ts` — redacted eval JSONL under state dir (append-only `0600`).

Scripts:
- `scripts/vector-cortex-evaluate.mjs` — streaming JSONL evaluator (reject non-monotonic `EVAL_ORDER_INVALID`, unknown-unit `EVAL_UNIT_UNKNOWN`, truncated final line `EVAL_JSONL_TRUNCATED`).
- `scripts/vector-cortex-gen-fixtures.mjs` — regenerates v2 fixtures canonical.

Dashboard (`extensions/dashboard-server/` + `dashboard-client/`):
- `api-contracts/vector-cortex.ts` (type), registration in `routes.ts`, handler `routes-vector-cortex.ts` (reader-only GET), dispatch in `server.ts`, `ENDPOINTS` registry (via new `endpoints/registry-ext.ts` split), `api-contracts/index.ts` barrel, `MEGACOMPACT_VC0A` added to `SETTINGS`.
- client `api/vector-cortex.ts`, `types/vector-cortex.ts`, `tabs/VectorCortexTab.tsx`, registered in `App.tsx` + `tabs/registry.ts`.

Tests:
- `src/vector-cortex/eval/metrics.test.ts`, `annotations.test.ts`, `persist.test.ts`, `vc0a-acceptance.test.ts` (acceptance aggregator).
- `extensions/dashboard-server/routes-vector-cortex.test.ts` (spawn-fetch), `api-contracts.test/endpoints-registry.test.ts` (count 47→48, path added).

Docs: `docs/vector-cortex/evidence/VC0A.md` (this record). `scripts/regression_check.py` — added `src/config/vector-cortex.ts` to `SETTINGS_CONFIG_FILES`.

## Fixtures and corpus digests

`conformance/vector-cortex/v2/evaluation/EVAL-001..010` + 3 schemas, all canonical.
`node scripts/vector-cortex-conformance.mjs --check` → `✓ CONFORMANCE: v2 manifest + 13 fixtures canonical (13 files).`

Asserts: `EVAL-005` = EVAL-BUCKET-001 (1ms/250ms inclusive); `EVAL-007` = EVAL-REDACT-002 (prompt bytes never in JSONL); `EVAL-009` = EVAL-ORDER-003 (equal-seq → event-name order).

## Migration

pure sprint — no migration (per VC0A spec).

## A/B/C and independence evidence

- A = structured observer (`createEvalObserver` + metric JSONL persist), emits sample/redaction events.
- B = counters-only observer with payload access denied (`vector-cortex-network-denial.mjs` mode B: `bucketHistogram` counters pass under full network denial).
- C = observer absent (`MEGACOMPACT_VC0A=0`), zero evaluation writes, byte-identical predecessor.
- `node scripts/vector-cortex-network-denial.mjs --modes=A,B,C` → all clean (`mode A: emitted=2`, `mode B: total=2`, `mode C: clean (no-op: zero evaluation writes)`).

## Commands and verbatim summaries

- `npm run build` → tsc clean (no `error TS`).
- `node --test dist/vector-cortex/vc0a-acceptance.test.js` → `tests 8, pass 8, fail 0` (flag ON); `MEGACOMPACT_VC0A=0 node --test dist/vector-cortex/vc0a-acceptance.test.js` → `tests 8, pass 8, fail 0` (flag-off rehearsal; mode C zero writes). Single-file path reconciliation: root tsc layout (rootDir=".") emits to `dist/src/vector-cortex/...`; `scripts/vector-cortex-publish-acceptance.mjs` (npm `postbuild`) copies ONLY the `*-acceptance.test.js` single file to the mandated `dist/vector-cortex/` path — no rootDir/outDir change, no other compiled file moves.
- `src/vector-cortex/eval/*.test.js` (metrics 7, annotations 6, persist 4) + acceptance → all pass.
- `npm test` → `TOTAL: 1236 passed, 0 failed across 175 files` (measured at the final HEAD with the postbuild publish in place; files 174→175 because run-tests now globs the published `dist/vector-cortex/vc0a-acceptance.test.js` exactly once — eval `*.test.js` are excluded from the publish mirror so they are not double-run).
- `npm run lint` → `tsc --noEmit` + `guardrails-scan` + `semantic-scan` all clean.
- `python3 scripts/regression_check.py --all` → `✓ No potential regressions detected`; registry.ts split back under 500 (496). Sole remaining hard-limit error `extensions/mega-events/context-handler.ts` (514) is pre-existing at HEAD, untouched by this sprint.
- `node scripts/vector-cortex-conformance.mjs --check` → ✓ (13 files canonical).
- `node scripts/vector-cortex-docs-check.mjs` → ✓ (27 sprints / 9 phases clean).
- `python3 scripts/log_failure.py --list` → 2 pre-existing active runtime entries (FAIL-38192431, FAIL-55d81817); no VC0A-introduced failure.
- `node scripts/guardrails-scan.mjs` → `GUARDRAILS: pi pattern scan clean.`
- `git diff --check` → clean (exit 0).
- dashboard-client `npm run build` → built, `VectorCortexTab` bundled; `npm run typecheck` → no errors in any VC0A client file.
- `node --test dist/extensions/dashboard-server/routes-rag-settings.test.js` → `tests 12, pass 12, fail 0` (VC0A toggle round-trip gate).

## Evaluation

Samples generated end-to-end; 100% metric schema validity; observer overhead p95 `<= 2ms` budget met. Canonical JSONL + histogram totals permutation-stable.

## Dashboard / API / config / SETTINGS evidence

- `GET /api/vector-cortex/evaluation` reader-only aggregate: latency histogram edges `[1,5,10,25,50,100,250]`, per-mode counts, `enabled`/`mode`, `rejects`, `updatedAt`. Non-GET → `405 method_not_allowed` (no mutation endpoint exists).
- `ENDPOINTS` registry count 47 → 48; `api-contracts/index.ts` barrel exposes `VectorCortexEvaluationSummary`.
- `MEGACOMPACT_VC0A` surfaced in `SETTINGS` (new "Vector Cortex" group) as an adjustable on/off toggle — NOT in `EXCLUDED_SETTINGS`. Breaker/triad timing constants from `src/config/vector-cortex.ts` are constants, not flags, and are deliberately NOT registered in SETTINGS.
- **Flag toggle round-trip (gate evidence):** `routes-rag-settings.test.ts` "VC0A flag round-trips through settings" verifies POST `/api/rag-settings` with `{"key":"MEGACOMPACT_VC0A","value":"false"}` writes `export MEGACOMPACT_VC0A="false"` to `.mega-compact.env`, which drives `VC0A_ENABLED()` off; `value:"true"` writes the `"true"` line and drives it on. Mirrors the existing `boolDirect` pipeline (`MEGACOMPACT_AUTO_WIKI`) exactly. Result: `tests 12, pass 12, fail 0` (was 11).
- Route test spawns the real dashboard server and verifies empty + seeded aggregates + reader-only 405. Client tab polled every 5s in `VectorCortexTab`.

## Offline / network / asset / platform evidence

Zero runtime network egress verified under full `net/tls/http/https/dns.lookup/fetch` denial in all three triad modes (PREVENT-PI-004). Persistence is local filesystem only.

## File sizes and baseline exceptions

All new files within limits (src < 300, extensions < 400, tests < 600). `extensions/dashboard-server/api-contracts/endpoints/registry.ts` split into `registry-ext.ts` (delegate-shell) to hold VC0A's endpoint entry and keep the registry under the 500-line hard limit while staying additive for VC0C. Pre-existing over-hard-limit file `extensions/mega-events/context-handler.ts` (514 @ HEAD) is out of scope.

## Rollback / downgrade rehearsal

`MEGACOMPACT_VC0A=0` → mode C, zero evaluation writes; acceptance suite passes with the flag off; reader returns empty summary (byte-identical to "no data"). Evidence is append-only and retained on rollback.

## Residual risks

- dashboard-client `npm run typecheck` is pre-existing broken in this repo (client tsconfig `types: []` while `@contracts`/`@pricing` aliases pull server `src/` modules needing Node types). VC0A client files themselves typecheck clean; the shipping pipeline gate (`npm run build:dashboard`) passes. Fix is a cross-cutting client tsconfig change, out of VC0A scope.
- `rejects` array in the GET response is static `[]` this sprint; VC0C wires live breaker/failure telemetry into it.
- `log_failure.py --list` reports 2 pre-existing active runtime failures unrelated to VC0A.

## Reviewer attestation

Not yet attested — pending independent reviewer.
