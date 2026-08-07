# COS-FP-R Evidence

Status: implementer-complete
Implementation commits/sub-sprint gates: `feat(COS-FP-R): real-corpus L2 cosine FP validation harness + flag` (a755132) + `docs(COS-FP-R): record no_corpus execution evidence` (<EVD_SHA>) on `feat/COS-FP-R`; full gate run on the working tree (build / test / lint / regression / guardrails / conformance / docs-check / scope-check / evidence-check).
Contract review: implementer self-review — every touched file read (flag sibling extract `vector-cortex-cosfp-real.ts` sprintFlag pattern + `vector-cortex.ts`/`config.ts` additive re-exports; `src/config.ts` exactly ONE additive export line with the BREAKER lines byte-identical to master; flag registered in `VECTOR_CORTEX_SETTINGS` as a visible boolDirect toggle via the auto-allowed routes-rag-settings seam, never in `EXCLUDED_SETTINGS`; corpus-gated execution harness `scripts/cosine-fp/real-bench.mjs` with the PREVENT-PI-004 local-only header reusing the byte-identical trigram/`cosineSimilarity`/`classifyPair`/`makeGrid`/`canonicalJson`/`sha256Hex`/`mulberry32` helpers imported from `./bench.mjs` (no duplication); `--check-corpus` gate path returns `no_corpus` today; digest-keyed `real-<digest>.json` output never overwritten; append-only real-corpus report block; write-time structural tests `real-bench.test.mjs`; additive COSINE_FP_REAL_ENABLED live-boolean assertion in the flag-agnostic acceptance aggregator), mutation scan clean, per-gate re-runs green. No forced deviation on the implementation; the corpus-gate + consent filter + Wilson/bootstrap were validated end-to-end on a synthetic temp corpus (determinism + never-overwrite repruned). `real-bench.mjs` is 592 lines: it is a `scripts/` file, which the regression_check size gate does NOT subject to the src/ext soft caps (returns `(None, None)`); the COS-FP-A sibling `bench.mjs` is 395 and is the closest precedent. HG-1/HG-3/HG-4/HG-5 remain OPEN (not closed in-workstream); this sprint recommends no adoption of a new default, so no HG closes here.

Changed production/tests/docs:
`src/config/vector-cortex-cosfp-real.ts` (new), `src/config/vector-cortex.ts`, `src/config.ts`, `src/vector-cortex/cosfp-acceptance.test.ts`, `scripts/cosine-fp/real-bench.mjs` (new), `scripts/cosine-fp/real-bench.test.mjs` (new), `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts` (auto-allowed seam), `docs/vector-cortex/sprints/COS-FP-R-real-corpus-validation.md` (Production ownership field added, auto-allowed own-spec), `docs/vector-cortex/evidence/COS-FP-R.md` (this record).

Note: `scripts/vector-cortex-docs-check.mjs` is unchanged — `EXPECTED_SPRINTS` is already 65 with COS-FP×2 counted; no bump made. No conformance fixtures were added: COS-FP-R owns **no** fixtures by spec (real corpus only, no synthetic substitute; the shared `cosfp-acceptance.test.ts` aggregator stays green in both flag states).

Fixtures and corpus digests: none (COS-FP-R owns no conformance fixtures — real-corpus-only per spec). The corpus dir `scripts/cosine-fp/corpus/` is absent (commit tree), so `--check-corpus` returns `no_corpus`.

Migration: pure sprint — no migration (no SQLite columns, no events.log format change; bench artifacts live under `scripts/cosine-fp/`, outside the state dir).

A/B/C and independence evidence: A the real-corpus run + recommendation — with `MEGACOMPACT_COSINE_FP_REAL=1` (default) and a valid consented corpus present, `real-bench.mjs` produces CI-backed per-type FP/FN + a recommendation row and appends evidence + report rows (validated end-to-end on a synthetic temp corpus, digest-keyed run JSON `real-<digest>.json` created once and never overwritten). B no/insufficient corpus (the ordinary pre-corpus state, and what this commit's tree records): the corpus gate returns `status:"no_corpus"` — it does NOT fabricate FP/FN, does NOT write evidence or report rows, does NOT mark accepted; `--check-corpus` prints `no_corpus` (verified: `real-corpus gate: no_corpus — corpus dir/manifest absent (normative pre-donation state, nothing written)`). C flag-off: `MEGACOMPACT_COSINE_FP_REAL=0` is byte-identical to pre-COS-FP-R — the script prints the one-line inert message and writes nothing (`MEGACOMPACT_COSINE_FP_REAL=0 — script inert (nothing executes, no writes).`). A is produced by the real run; B by the corpus-gate early-return; C purely by the flag branch. All three use independent inputs; the consent filter (task 2) is the belt-and-suspenders that never silently includes a non-consented/revoked session (tested structurally).

Commands and verbatim summaries: see Gate Results below.

## Corpus-gate outcome

`node scripts/cosine-fp/real-bench.mjs --check-corpus` → `real-corpus gate: no_corpus — corpus dir/manifest absent (normative pre-donation state, nothing written)` (exit 0). The corpus directory is absent on the commit tree, so this is the **no_corpus** outcome — a valid, completed sprint state recording that real-corpus execution was attempted and found no consented data (the normative pre-donation state). No bench-run JSON, no report rows, no evidence beyond this record were written.

## File sizes

- `src/config/vector-cortex-cosfp-real.ts` (37)
- `src/config/vector-cortex.ts` (99)
- `src/config.ts` (220)
- `src/vector-cortex/cosfp-acceptance.test.ts` (278)
- `scripts/cosine-fp/real-bench.mjs` (592)
- `scripts/cosine-fp/real-bench.test.mjs` (250)
- `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts` (328)
- `docs/vector-cortex/sprints/COS-FP-R-real-corpus-validation.md` (84)
- `docs/vector-cortex/evidence/COS-FP-R.md` (this record)

## Gate Results

| Gate | Result |
|------|--------|
| `npm run build` | PASS (incl. vector-cortex-publish-acceptance postbuild) |
| `node --test dist/vector-cortex/cosfp-acceptance.test.js` | PASS (10/10) |
| `MEGACOMPACT_COSINE_FP_REAL=0 node --test dist/vector-cortex/cosfp-acceptance.test.js` | PASS (10/10, flag-off parity) |
| `node --test scripts/cosine-fp/real-bench.test.mjs` | PASS (12/12) |
| `node scripts/cosine-fp/real-bench.mjs --check-corpus` | PASS — `no_corpus` (exit 0) |
| `MEGACOMPACT_COSINE_FP_REAL=0 node scripts/cosine-fp/real-bench.mjs` | PASS — inert one-line message, no writes |
| `npm test` | PASS (3919 passed / 0 failed / 400 files) |
| `npm run lint` | PASS (tsc + guardrails + semantic) |
| `python3 scripts/regression_check.py --all` | PASS (no regressions detected; 0 hard-limit blocks; all MEGACOMPACT_* env vars have settings entries) |
| `node scripts/guardrails-scan.mjs` | PASS |
| `node scripts/vector-cortex-conformance.mjs --check` | PASS (925 fixtures canonical) |
| `node scripts/vector-cortex-docs-check.mjs` | PASS (65 sprints, unchanged) |
| `node scripts/vector-cortex-scope-check.mjs COS-FP-R a755132` | PASS (8 committed files in ownership + seams) |
| `node scripts/vector-cortex-evidence-check.mjs COS-FP-R` | PASS |
| `git diff --check` | PASS |
| `cd extensions/dashboard-client && npm run typecheck` / `npm run build` | N/A — no client files change (skip declared by scope; COS-FP-R touches no `dashboard-client/` and adds no route/card) |

## COS-FP-R unit/acceptance tests

Write-time structural validation of the gates (run now, before any corpus is donated, on synthetic temp fixtures — NOT the donated corpus):

`node --test scripts/cosine-fp/real-bench.test.mjs` → `tests 12 · pass 12 · fail 0`. Covers (a) corpus gate: `no_corpus` on absent dir/empty dir and `corpus_invalid` on a non-consented / revoked / metadata-incomplete manifest; (b) the consent filter excludes non-consented/revoked sessions and LOGS each denial (never silently included); (c) Wilson interval bounds in [0,1] with lo ≤ hi (and null on n=0); session-grouped `drawSessionIndices` yields only whole integer session indices (never splits a session) and `bootstrapSessionMeans` CI in [0,1] and deterministic; (d) determinism — `computeReport` on the same sessions yields the same 64-hex digest, and a full `main` run on a temp corpus is deterministic and writes the digest-keyed `real-*.json` exactly once (never overwritten).

Acceptance aggregator (flag-agnostic, shared with COS-FP-A; additive COSINE_FP_REAL_ENABLED live-boolean block):

`node --test dist/vector-cortex/cosfp-acceptance.test.js` → `tests 10 · pass 10 · fail 0`
`MEGACOMPACT_COSINE_FP_REAL=0 node --test dist/vector-cortex/cosfp-acceptance.test.js` → `tests 10 · pass 10 · fail 0` (flag-off parity)

Full `npm test`: PASS on the merged tree (3919 passed / 0 failed / 400 files).

## Evaluation

Real-corpus validation is **pending donation** — the corpus dir is absent, so no FP/FN sample was computed today and no CI is recorded. The harness itself is validated structurally (see COS-FP-R unit/acceptance tests) and its statistics (Wilson interval, session-grouped bootstrap(10000)) are unit-tested. When a consented corpus is donated, execution emits counts, CIs, thresholds + digests only, never raw snippet text (EVAL-REDACT-002). Deterministic (same corpus + params → identical result digest; embedding is the deterministic trigramEmbed, the bootstrap is mulberry32-seeded from the corpus digest). No network (PREVENT-PI-004): every script performs only local filesystem reads.

## Dashboard/API/config/SETTINGS evidence

`MEGACOMPACT_COSINE_FP_REAL` is registered in `VECTOR_CORTEX_SETTINGS` as a visible boolDirect toggle titled "COS-FP-R Real-Corpus Validation" (mirroring the COS-FP-A entry), never in `EXCLUDED_SETTINGS`; the settings-registration regression check confirms every MEGACOMPACT_* env var has a settings entry. No API endpoint, no dashboard card, no client file is added by COS-FP-R. The dashboard-client typecheck/build gate is **N/A** (no client files change) — skip declared by scope.

## Offline/network/asset/platform evidence

`scripts/cosine-fp/real-bench.mjs` and `real-bench.test.mjs` are pure-local (fs + in-memory embed/RNG), each carrying the `PREVENT-PI-004` local-only header annotation. Corpus reads happen only under the consent gate; no network.

## Rollback/downgrade rehearsal

`MEGACOMPACT_COSINE_FP_REAL=0`: the script is inert — it prints a one-line message and writes nothing, byte-identical predecessor; no bench-run JSON, report rows, or evidence are written, and no dashboard live-data swap occurs. The committed harness + spec + this evidence record remain on disk (reversible, non-destructive). No threshold was adopted, so no tombstone is needed.

## Residual risks

- **Real-corpus validation is pending donation.** `no_corpus` records the pre-donation state; no real FP/FN CI or recommendation exists yet. The COS-FP-A synthetic baseline (default 0.815, per-type code 0.915/prose 0.95/mixed 0.955) remains advisory and unadopted; `L2_COSINE` stays `MEGACOMPACT_L2_THRESHOLD=0.85`. Adoption of any new default is a separate decision gated on §Acceptance (≥100 consented sessions, CI-upper ≤ 0.05 FP budget, disjoint-from-failure), upstream of any code change.
- **Real-corpus harness not exercised on donated data this sprint.** Its full run was validated end-to-end on a synthetic temp corpus (determinism, never-overwrite, report append), but the donated-corpus edge cases (real OCR/noise artifacts, heterogeneous content-type fractions, split assignment across folds) are only encountered once a corpus exists. The gates + consent filter + statistics are structurally tested.
- **HG-1/HG-3/HG-4/HG-5 remain OPEN**, restated (not closed in-workstream); this sprint recommends no adoption, so it does not resolve them.

## Reviewer attestation

pending — Claude (Opus controller) to review post-commit. The controller will set reviewer-accepted after verifying spec compliance (constructive per-method read of `real-bench.mjs` against `docs/vector-cortex/sprints/COS-FP-R-real-corpus-validation.md`, flag-off byte-parity, consent-gating, EVAL-REDACT-002, `src/config.ts` single-line no-churn diff) and the gate outputs above.
