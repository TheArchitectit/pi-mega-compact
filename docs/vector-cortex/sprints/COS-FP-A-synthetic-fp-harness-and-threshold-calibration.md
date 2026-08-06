# COS-FP-A — Synthetic FP harness + L2 cosine threshold calibration

**Status:** planned | **Depends on:** external-audit #3 (validate 0.90 cosine empirically), external-audit #2 dedup audit event stream (SHIPPED) | **Phase:** COS-FP
**Flag:** `MEGACOMPACT_COSINE_FP_BENCH`, defined in `src/config/vector-cortex-cosfp.ts` (sibling extract, sprintFlag pattern), re-exported by `src/config/vector-cortex.ts` + root `src/config.ts`, default ON; `MEGACOMPACT_COSINE_FP_BENCH=0` disables and must be byte-identical to the pre-COS-FP-A state. Registered in `VECTOR_CORTEX_SETTINGS` as a visible boolDirect toggle, never in `EXCLUDED_SETTINGS`.

## Goal and inputs/outputs

Close **external-audit #3** (the pragmatic, synthetic half): empirically validate the L2 cosine dedup threshold — today `DedupConfig.L2_COSINE = 0.85` from `MEGACOMPACT_L2_THRESHOLD`, quoted in the audit as "0.90" against real sessions that do not yet exist. This sprint builds a **synthetic FP harness** that measures L2 cosine false-positive rates across a candidate threshold grid and emits a **recommended default**, so the threshold is evidence-backed rather than an unvalidated constant. The real-corpus half (100+ donated sessions) is the sibling spec `docs/vector-cortex/sprints/COS-FP-R-real-corpus-validation.md` — it ships its full harness in that sprint and runs the moment a consented corpus exists; `no_corpus` is a valid completed state, not a deferral.

Inputs: (a) the synthetic corpus generated at bench time from templates (code / prose / mixed content types, each carrying known duplicates, near-duplicates, and clean singletons), and (b) the existing L2 cosine scoring + `DedupAuditEvent` decision semantics (threshold firing = cosine `>=` grid threshold → `deduped`, near-miss → `passed`, clean → `stored`) established by `src/vectorStore/dedup-audit.ts`. Outputs: (a) `scripts/cosine-fp/bench-run/*.json` per-run results (grid sweep, per-content-type FP/FN), (b) a digest-stable **eval report** `docs/vector-cortex/cosine-threshold-report.md` recommending a default, and (c) a reader-only dashboard endpoint `GET /api/cosine-fp-report`. Neither the grid sweep nor the report writes to the extension state dir or mutates any prod corpus.

The harness is Node-only (`scripts/cosine-fp/bench.mjs`), deterministic, and **synthetic-corpus-only** — it never reads, embeds, or ships real session/ledger bytes. It sits adjacent to `scripts/dedup-benchmark.mjs` but is a separate tool: `dedup-benchmark.mjs` measures latency/throughput on real-ish input; `bench.mjs` measures **accuracy (FP/FN) against ground-truth** on a synthetic corpus.

**Scope boundary — this sprint is not COS-FP-R:** COS-FP-A does NOT collect, solicit, or consume any real donated session; it does NOT change the shipped default (still `0.85`); it only builds the harness, runs the synthetic sweep, and emits a **recommendation** in the report. Adopting any new default (content-type overrides ON) is gated on the report landing and is itself reversible via flag-off. The `MEGACOMPACT_L2_THRESHOLD_*` overrides are **added but default OFF** until the report recommends values — a bootstrap gate, not an adoption.

## Flag + config wiring

`MEGACOMPACT_COSINE_FP_BENCH` (default ON, `=0` byte-identical) gates the **harness + endpoint + report regeneration** only. When OFF: `scripts/cosine-fp/bench.mjs` is inert (still parses/runs but gates report emission + endpoint to 404/absent), the endpoint 404s, no report is (re)written, and `L2_COSINE` continues to be plain `MEGACOMPACT_L2_THRESHOLD` — byte-identical to pre-sprint. Registration in `VECTOR_CORTEX_SETTINGS` as a boolDirect "Cosine FP Synthetic Bench" toggle.

Hard constraints (multi-line):
- `L2_COSINE` stays `envNum("MEGACOMPACT_L2_THRESHOLD", 0.85)` — the single authoritative runtime firing point (config/dedup.ts single source of truth).
- Two **optional, default-OFF** content-type overrides are added to `config/dedup.ts`: `MEGACOMPACT_L2_THRESHOLD_CODE` (suggested 0.93) and `MEGACOMPACT_L2_THRESHOLD_PROSE` (suggested 0.87). They are NOT wired into the live L2 decision path this sprint (that wiring is a COS-FP follow-up gated on the report); their presence is a declared seam so the report's per-content-type recommendation has a landing slot. `=off`/unset → no behavior change. These new fields keep `config/dedup.ts` under its 300-line soft cap by ~20 lines headroom; if the file crosses the soft cap the threshold block extracts to a `src/config/dedup-cosine.ts` sibling (delegate-shell) — do NOT squeeze comments.

Production ownership (`extensions/dashboard-server/` files are cross-cutting seams auto-allowed): `src/config/vector-cortex-cosfp.ts (new — MEGACOMPACT_COSINE_FP_BENCH flag, sprintFlag pattern); src/config/vector-cortex.ts (additive re-export, stays ≤ 300); src/config.ts (additive re-export, stays ≤ 200); src/config/dedup.ts (additive — two default-OFF content-type override fields, single source of truth); scripts/cosine-fp/bench.mjs (new — synthetic corpus gen + grid sweep + stratified report, deterministic); scripts/cosine-fp/corpus.mjs (new — template generators for code/prose/mixed + known-dup annotation, imported by bench.mjs); scripts/cosine-fp/README.md (new — how to run/extend); docs/vector-cortex/cosine-threshold-report.md (new — digest-stable eval report, recommendation); conformance/vector-cortex/v2/cosine-fp/ (new — fixtures COS-FP-A-001..005); conformance/vector-cortex/v2/schemas/cosfp-fixture.schema.json (new); conformance/vector-cortex/v2/manifest.json (additive rows, owner COS-FP-A); extensions/dashboard-server/routes-cosine-fp.ts (new — GET /api/cosine-fp-report, reader-only, memoized); extensions/dashboard-server/routes-cosine-fp.test.ts (new); extensions/dashboard-server/api-contracts/cosine-fp.ts (new — CosineFpReportV1 contract, no any); extensions/dashboard-server/api-contracts/endpoints/registry-ext.ts (additive — cosine-fp-report group); extensions/dashboard-server/api-contracts/endpoints/registry.test.ts (EXPECTED_ENDPOINT_COUNT 1-step mechanical reconciliaton — this file crosses into Production ownership); extensions/dashboard-server/api-contracts/index.ts (additive re-export barrel); extensions/dashboard-server/route-dispatch.ts (additive if-chain); extensions/dashboard-server/routes.ts (additive re-export); extensions/dashboard-client/src/tabs/SetupTab/VectorCortexCosineFpCard.tsx (new — "Last synthetic bench threshold recommendation" card); extensions/dashboard-client/src/tabs/SetupTab/CortexSetup.tsx (additive — mount card); src/vector-cortex/cosfp-acceptance.test.ts (new — acceptance aggregator); scripts/vector-cortex-docs-check.mjs (EXPECTED_SPRINTS 45→47)`

## Numbered implementation tasks

1. Add the `MEGACOMPACT_COSINE_FP_BENCH` flag (default ON, `=0` byte-identical) in `src/config/vector-cortex-cosfp.ts` + the `vector-cortex.ts`/`src/config.ts` re-exports, and the `VECTOR_CORTEX_SETTINGS` boolDirect toggle in `routes-rag-settings-vector-cortex.ts` (additive row, keeps file under soft cap). Flag-off → harmless, no endpoint, no report writes.
2. Add the two default-OFF content-type override fields to `config/dedup.ts`: `L2_COSINE_CODE: envNum("MEGACOMPACT_L2_THRESHOLD_CODE", <unset→null>)` and `L2_COSINE_PROSE: envNum("MEGACOMPACT_L2_THRESHOLD_PROSE", <unset→null>)`. Both `null` when unset (no behavior change); the live L2 decision path is NOT touched this sprint. Extend `DedupConfigShape` with two nullable members.
3. Author `scripts/cosine-fp/corpus.mjs`: synthetic generator with three content types — **code** (function/class/template templates over an identifier vocabulary), **prose** (documentation/readme-style templates), **mixed** (interleaved code+prose). Each produced item carries a ground-truth `label`: `dup` (exact or template-permutation duplicate of a canon), `near` (controlled perturbation — comment/identifier/word changes), or `clean` (unique). Deterministic RNG seed (default 20260806, overridable via `MEGACOMPACT_COSINE_FP_SEED`). Corpus manifest records per-item `{id, contentType, label, canonId}` — the bench's ground truth.
4. Author `scripts/cosine-fp/bench.mjs`: builds the corpus, embeds via the shipped `TrigramEmbedder` (or an injectable embedder interface mirroring `src/embedder.ts` — no new runtime dep), scores every unique pair's cosine, and for each candidate threshold in the grid **0.80 → 0.98 step 0.005** (37 points) labels each pair FP (label `clean`/`near` but cosine `>=` threshold → deduped) / FN (label `dup` but cosine `<` threshold → passed). Aggregates per-content-type FP rate + FN rate + F1. Determinism: **same corpus + same params → identical report digest SHA-256** (pin in fixture COS-FP-A-002). Emits per-run JSON under `scripts/cosine-fp/bench-run/` and the aggregated markdown report.
5. Emit the eval report `docs/vector-cortex/cosine-threshold-report.md`: grid table (threshold, overall FP, per-type FP, per-type FN, F1), the recommended **default** (the threshold minimizing overall F1-loss subject to FP-rate budget, stated alongside the shipped `0.85`), per-content-type recommended overrides (CODE/PROSE columns), corpus manifest summary (counts, seed, digest), and the recommendation's digest. Report is **append-only relative to COS-FP-R** — COS-FP-A is the first writer; COS-FP-R may append more rows but never edits the synthetic baseline block.
6. Wire the reader-only `GET /api/cosine-fp-report`: `routes-cosine-fp.ts` returns the **last written** bench-run aggregate + report digest + recommendation (memoized by report-file mtime, mirrors `routes-vector-cortex-health.ts` memoized-facts). Flag-off → 404. Contract `CosineFpReportV1` in `api-contracts/cosine-fp.ts`; register the endpoint group in `registry-ext.ts`, bump the registry-count test one step (mechanical), and re-export via `api-contracts/index.ts`.
7. Surface the recommendation in the client: `VectorCortexCosineFpCard.tsx` in `SetupTab/` ("Last synthetic bench threshold recommendation") polling `/api/cosine-fp-report`, showing default + per-type overrides + report digest, preserving the flag-gated Off state (card renders "bench disabled" per deriveVcStatus). Client gate: `cd extensions/dashboard-client && npm run typecheck && npm run build`.
8. Generate + commit conformance fixtures `COS-FP-A-001..005` under `conformance/vector-cortex/v2/cosine-fp/` via a small `scripts/cosine-fp/gen-fixtures.mjs` (or inline in bench.mjs `--fixtures-only`), write `schemas/cosfp-fixture.schema.json`, register rows in the v2 manifest, and bump `EXPECTED_SPRINTS` 45→47 in `scripts/vector-cortex-docs-check.mjs`.
9. Add the acceptance aggregator `src/vector-cortex/cosfp-acceptance.test.ts` (flag-agnostic) and the evidence doc `docs/vector-cortex/evidence/COS-FP-A.md`.

## Failure triad and independence

A benchmark runs + report written: with `MEGACOMPACT_COSINE_FP_BENCH=1` (default), `bench.mjs` drives a full grid sweep to a real recommendation, the report + digest are emitted, the endpoint serves it, all five fixtures pass (fixture COS-FP-A-001). B no recommendation signal / empty grid (e.g. corpus collapses to zero clean items or embedding fails): the bench reports an explicit `status:"no_data"` outcome — it does NOT fabricate a threshold or fake FP=0 — the endpoint 404s/returns `awaiting_data`, and no report block is written (fixture COS-FP-A-003 guards the no-fabrication branch). C flag-off: `MEGACOMPACT_COSINE_FP_BENCH=0` is byte-identical to pre-sprint — endpoint 404s, no report/write, `L2_COSINE` plain `MEGACOMPACT_L2_THRESHOLD` (fixture COS-FP-A-005 pins flag-off byte-identity; COS-FP-A-003 stays the no-fabrication fallback inside the flag-on tree and must not double as the flag-off case). Additional pins: determinism (COS-FP-A-002), off-by-one threshold boundary (COS-FP-A-004: `0.899` vs `0.900` split exactness), content-type stratification (COS-FP-A-001). A is produced by the real sweep; B by the empty/embed-failed early return; C purely by the flag branch. All three use independent inputs; common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/cosine-fp/`, schema `conformance/vector-cortex/v2/schemas/cosfp-fixture.schema.json`.

- `COS-FP-A-001: stratified report correctness` — `{ kind:"cosfp", flag:"MEGACOMPACT_COSINE_FP_BENCH", flag_enabled:true, content_types:["code","prose","mixed"], grid:{lo:0.80,hi:0.98,step:0.005,points:37}, per_type_fp_fractions:[0,1], status:"ok" }`.
- `COS-FP-A-002: determinism` — `{ kind:"cosfp", seed_invariant:true, report_digest_sha256:"<hex>", same_corpus_same_digest:true }` — identical run twice yields byte-identical report digest.
- `COS-FP-A-003: no-fabrication fallback` — `{ kind:"cosfp", no_data:"explicit", status:"no_data", fabricated_threshold:false, fabricated_fp:false }` (+ the flag-off branch `flag_enabled:false`, `endpoint_404:true`, `report_written:false`).
- `COS-FP-A-004: off-by-one threshold boundary` — `{ kind:"cosfp", boundary:{lo:0.899,hi:0.900}, strict_straddle:true }` — a pair at cosine `0.8995` is `passed` at `0.900` and `deduped` at `0.899` (exact `<` vs `>=` semantics), never both.
- `COS-FP-A-005: flag-off byte-identical` — `{ kind:"cosfp", flag_enabled:false, l2_cosine:"MEGACOMPACT_L2_THRESHOLD=0.85", override_enabled:false, byte_identical:true }`.

Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/cosfp-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/cosfp-acceptance.test.js
```

Expected assertions: all `COS-FP-A-001..005` registered with algorithm `cosfp`, path `cosine-fp/<id>.json`, schema `schemas/cosfp-fixture.schema.json`, expected `ok`. Route test: flag-on 200 with the full `CosineFpReportV1` shape incl. recommendation + digest; flag-off 404; non-GET 405; missing report file → `awaiting_data`, never a fabricated zero row. Bench tests (production ownership is the `.test.ts`; `bench.mjs` is exercised script-side + via fixtures): grid bounds inclusive 0.80/0.98, step 0.005 → exactly 37 points; content-type stratification sums to corpus totals; malformed corpus (bad template / empty canon) → ejected with `status:"no_data"`, never a crash. Exact flag-off comparison command: `MEGACOMPACT_COSINE_FP_BENCH=0 node --test dist/vector-cortex/cosfp-acceptance.test.js` — the aggregator is flag-agnostic. Acceptance: synthetic-corpus-only — the harness **never reads or embeds real ledger/session bytes** (EVAL-REDACT-002), no network calls (PREVENT-PI-004, local embedder only), report carries aggregate fractions + digest only, never any substring of a template text. Apply [EVALUATION](../EVALUATION.md) annotation/power rules; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure — no migration** (schema/state unchanged: no new SQLite columns, no events.log format change; benchmarks run in `scripts/cosine-fp/bench-run/`, outside the state dir). Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md): **fixtures are synthetic** — template-generated, secret-scanned, contain no credentials/personal data/real user ledger; the bench reads NO ledger bytes; the report/digest/endpoint emit counts + fractions + digest only, never template text (EVAL-REDACT-002). Dashboard: **client IS touched** — new `VectorCortexCosineFpCard.tsx` in `SetupTab/`; gate `cd extensions/dashboard-client && npm run typecheck && npm run build`.

Rollback sets `MEGACOMPACT_COSINE_FP_BENCH=0` — endpoint 404s, no report (re)write, `L2_COSINE` plain `MEGACOMPACT_L2_THRESHOLD`, byte-identical predecessor; the already-written report + fixtures + evidence remain on disk (reversible, non-destructive). Content-type overrides were added default-OFF so no runtime behavior changed; adopting them is a **separate** gated decision never made by this sprint. No operator migration.

## Exit evidence

Run exact project gates:

```bash
npm run build
node --test dist/vector-cortex/cosfp-acceptance.test.js
MEGACOMPACT_COSINE_FP_BENCH=0 node --test dist/vector-cortex/cosfp-acceptance.test.js
CLEAN=1 MEGACOMPACT_COSINE_FP_SEED=20260806 node scripts/cosine-fp/bench.mjs >/dev/null   # determinism smoke, digest printed
npm test
npm run lint
python3 scripts/regression_check.py --all --soft-as-hard --soft-as-hard-base <PREV_TAG> --pre-commit
node scripts/guardrails-scan.mjs
python3 scripts/log_failure.py --list
node scripts/vector-cortex-conformance.mjs --check
node scripts/vector-cortex-docs-check.mjs
node scripts/vector-cortex-scope-check.mjs COS-FP-A <COMMIT_SHA>
node scripts/vector-cortex-evidence-check.mjs COS-FP-A
git diff --check
```

The dashboard-client gate runs (client files change):

```bash
cd extensions/dashboard-client && npm run typecheck && npm run build
```

## Live Playwright validation (MANDATORY)

The `VectorCortexCosineFpCard` must be exercised live: launch the dashboard (default `http://localhost:9320`), navigate to the Setup surface, render the cosine-FP card, and assert it displays the report digest + grid summary from `GET /api/cosine-fp-report` with zero console errors. Also exercise the flag-off path (`MEGACOMPACT_COSINE_FP_BENCH=0`): card hidden or absent, byte-identical surface. If no reachable dashboard host exists, the sprint pauses at implementer-complete until a live host is available; evidence names the host and the rendered card output.

---

This sprint is one of 15 new sprint docs in the program; the single docs-check reconciliation (owned by the integration step, not by any per-sprint commit) sets `EXPECTED_SPRINTS` to **60** in `scripts/vector-cortex-docs-check.mjs` (count at integration time). The script is included in Production ownership at the integration pass only; per-sprint commits leave it unchanged.
