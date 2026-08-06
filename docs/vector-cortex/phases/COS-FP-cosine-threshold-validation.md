# Phase COS-FP — Cosine Threshold Validation (Audit #3)

**Status:** planned | **Depends on:** external-audit #3 (validate the 0.90 cosine threshold), external-audit #2 dedup audit event stream (SHIPPED) | **Phase:** COS-FP
**Flag scope:** two flags with split scopes — `MEGACOMPACT_COSINE_FP_BENCH` (synthetic bench + endpoint + report regeneration, **default ON**, `=0` byte-identical) and `MEGACOMPACT_COSINE_FP_REAL` (real-corpus validation harness, **default ON**, `=0` byte-identical). Two additional content-type override constants are added to `src/config/dedup.ts` as single source of truth but stay **default OFF** until the synthetic report recommends: `MEGACOMPACT_L2_THRESHOLD_CODE` (suggested 0.93) + `MEGACOMPACT_L2_THRESHOLD_PROSE` (suggested 0.87). Both flags' registration into `VECTOR_CORTEX_SETTINGS` as boolDirect toggles is mandatory; neither appears in `EXCLUDED_SETTINGS`.

## Premise

External-audit item #3 flags that the L2 cosine dedup threshold — `DedupConfig.L2_COSINE = 0.85` (env var surface: `MEGACOMPACT_L2_THRESHOLD`, quoted in the audit as 0.90) — has never been measured against a real corpus. The pragmatic half is answerable now with a **synthetic** harness: build a deterministic code/prose/mixed generator with ground-truth `dup`/`near`/`clean` labels, sweep the threshold grid `0.80 → 0.98 step 0.005` (37 points), and emit a digest-stable eval report recommending a default. The deferred half — FP/FN measured against **100+ real donated sessions** — cannot ship until a consent-complete corpus exists.

COS-FP-A builds the harness, the report, and the synthetic reader endpoint. COS-FP-R defines the real-corpus sprint as a frozen contract, gated on the corpus: ≥ 100 real sessions, per-owner voluntary donation, append-only per-session consent, session-grouped splits, per-session provenance/license/consent-id metadata. Neither sprint changes the shipped default (`L2_COSINE = 0.85`); the content-type overrides land as declared seam config values and stay unset (→ `null` = no behavior change) until the synthetic report's recommendation is accepted and an adopting change is made.

## Architectural invariants (do not violate)

1. **No new runtime network calls** — the bench and the real-corpus harnesses are local-only (`scripts/cosine-fp/*.mjs`), embed via the shipped `TrigramEmbedder` (or an injectable embedder interface), never hit the network. PREVENT-PI-004 stays green.
2. **L2_COSINE unchanged this phase** — the single authoritative runtime firing point stays `envNum("MEGACOMPACT_L2_THRESHOLD", 0.85)` in `src/config/dedup.ts`. Content-type overrides land as constants (default unset → null → no effect) but **never** feed the live decision path in this phase. Their adoption is a separate gated change upstream of any code.
3. **Deterministic bench** — same corpus + same params → identical report digest (SHA-256) on every run. Seed `MEGACOMPACT_COSINE_FP_SEED` (default 20260806). A fabricated-bench run (gates.all false) must ALWAYS fail qualification; p95 alone cannot sweep a gated-off bench into pass.
4. **No-fabrication guarantee** — when the corpus collapses to zero signal or the embedding path fails, the harness reports `status:"no_data"` and writes nothing; the reader endpoint 404s/awaiting_data rather than fabricating a zero-FP result.
5. **Privacy norm** — synthetic corpus only in COS-FP-A; the corpus generator is a deterministic template generator with ground-truth labels. COS-FP-R consents per SECURITY_PRIVACY §Lifecycle + §Consent — the exact ledger is never automatically training data; consent is append-only + revocable, and a revoked session freezes its derived artifacts via instant-freeze + async-purge.
6. **Privacy of endpoint surface** — both endpoints report counts + fractions + digests only (EVAL-REDACT-002); no template text, no user payload, no canonicalRemote leaves the endpoint.

## Sprint chain (COS-FP-A → COS-FP-R — second is deferred-exec)

| Sprint | Title | Status |
|--------|-------|--------|
| COS-FP-A | Synthetic FP harness + threshold calibration | executes |
| COS-FP-R | Real-corpus validation | **deferred-exec** — frozen contract, runs only when a valid consented corpus exists |

### COS-FP-A — Synthetic FP harness + calibration

Authors `scripts/cosine-fp/{corpus.mjs,bench.mjs,README.md}` (synthetic corpus gen + grid sweep + stratified report), the reader endpoint `GET /api/cosine-fp-report` (memoized by report-file mtime), the client card `tabs/SetupTab/VectorCortexCosineFpCard.tsx` mounted in `CortexSetup.tsx`, the conformance fixtures `COS-FP-A-001..005` (stratified report correctness, determinism, no-fabrication fallback, off-by-one threshold boundary, flag-off byte-identity), and the digest-stable eval report at `docs/vector-cortex/cosine-threshold-report.md`. Adds the `MEGACOMPACT_L2_THRESHOLD_CODE`/`MEGACOMPACT_L2_THRESHOLD_PROSE` fields to `src/config/dedup.ts` default unset. **UI touch** — dashboard-client gate runs.

**Ownership:** `scripts/cosine-fp/{corpus.mjs,bench.mjs,README.md,gen-fixtures.mjs}; src/config/{vector-cortex-cosfp.ts,vector-cortex.ts,config.ts,dedup.ts}; docs/vector-cortex/cosine-threshold-report.md; extensions/dashboard-server/{routes-cosine-fp.ts,routes-cosine-fp.test.ts,api-contracts/{cosine-fp.ts,endpoints/registry-ext.ts,endpoints/registry.test.ts,index.ts},route-dispatch.ts,routes.ts,routes-rag-settings-vector-cortex.ts}; extensions/dashboard-client/src/tabs/SetupTab/{VectorCortexCosineFpCard.tsx,CortexSetup.tsx}; conformance/vector-cortex/v2/{cosine-fp/,schemas/cosfp-fixture.schema.json,manifest.json}; src/vector-cortex/cosfp-acceptance.test.ts; docs/vector-cortex/evidence/COS-FP-A.md`.

### COS-FP-R — Real-corpus validation (deferred-exec)

Frozen contract, not executable now: validates the corpus (≥100 consented sessions, complete manifest, session-grouped splits); runs `scripts/cosine-fp/real-bench.mjs` (grid sweep over real pairs); emits Wilson intervals + session-grouped bootstrap(10000); appends rows to the cosine-threshold report **without touching the synthetic baseline block**; emits evidence `docs/vector-cortex/evidence/COS-FP-R.md`. Until the corpus exists the harness reports `status:"no_corpus"` and writes nothing. **Cannot-ship:** without the corpus this sprint does NOT create fixture files, run `deploy.sh`, or mark evidence accepted — `vector-cortex-evidence-check.mjs COS-FP-R` is expected to FAIL while deferred (correct state, not a gate to paper over).

**Ownership (execution-time):** `scripts/cosine-fp/real-bench.mjs; src/config/{vector-cortex-cosfp-real.ts,vector-cortex.ts,config.ts}; extensions/dashboard-server/routes-rag-settings-vector-cortex.ts (additive COSINE_FP_REAL toggle); docs/vector-cortex/evidence/COS-FP-R.md (at execution only); docs/vector-cortex/sprints/COS-FP-R-real-corpus-validation.md (this phase's contracted spec)`.

## Conformance fixtures — COS-FP reserved family

One algorithm family `cosfp`, five fixtures:

| Fixture range | Owner | Purpose |
|---------------|-------|---------|
| `COS-FP-A-001` | COS-FP-A | stratified report correctness (3 content types, 37 grid points) |
| `COS-FP-A-002` | COS-FP-A | determinism (same corpus + params → identical digest) |
| `COS-FP-A-003` | COS-FP-A | no-fabrication fallback (`status:"no_data"`, no fake FP=0) |
| `COS-FP-A-004` | COS-FP-A | threshold boundary (`0.899` vs `0.900` strict split at `cosine = 0.8995`) |
| `COS-FP-A-005` | COS-FP-A | flag-off byte-identity (`MEGACOMPACT_L2_THRESHOLD=0.85` plain) |

COS-FP-R owns **no conformance fixtures** — no synthetic-corpus substitute for a real corpus, so no fixture IDs are reserved for it. Conformance root: `conformance/vector-cortex/v2/cosine-fp/`; schema sibling at `schemas/cosfp-fixture.schema.json`.

## Exit evidence

COS-FP-A runs the mandatory gates plus the dashboard-client gate (client card is touched) plus the determinism smoke (`CLEAN=1 MEGACOMPACT_COSINE_FP_SEED=20260806 node scripts/cosine-fp/bench.mjs >/dev/null`). COS-FP-R's gate set is the base runtime gates minus the execution-only evidence/conformance steps (deferred-exec form): today's run is `npm run build`, `node --test dist/vector-cortex/cosfp-acceptance.test.js`, `MEGACOMPACT_COSINE_FP_REAL=0 node --test dist/vector-cortex/cosfp-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all --soft-as-hard --soft-as-hard-base <PREV_TAG> --pre-commit`, `node scripts/guardrails-scan.mjs`, `node scripts/vector-cortex-docs-check.mjs`, `node scripts/vector-cortex-scope-check.mjs COS-FP-R <COMMIT_SHA>`, `git diff --check`.

COS-FP-A additionally runs the **mandatory live Playwright validation**: the `VectorCortexCosineFpCard` must render live on the dashboard (Setup surface), displaying the report digest + grid summary from `GET /api/cosine-fp-report` with zero console errors, plus the flag-off path exercised (card absent, byte-identical surface). If no reachable dashboard host exists (default `http://localhost:9320`), the sprint pauses at implementer-complete until one is available. COS-FP-R has no client surface and no Playwright burden.
