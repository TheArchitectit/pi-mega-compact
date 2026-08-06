# COS-FP-R — Real-corpus L2 cosine FP validation

**Status: deferred-exec — ships only when corpus exists.** This spec defines the real-corpus validation sprint; it is **not** executable now and must never run `deploy.sh`, create fixture files, or mark evidence accepted until the corpus condition in §Cannot-ship is met. Until then it is a frozen contract ready to execute the moment a valid donated corpus exists. | **Depends on:** external-audit #3 (real half), COS-FP-A (synthetic baseline + harness pattern) | **Phase:** COS-FP
**Flag:** `MEGACOMPACT_COSINE_FP_REAL`, defined in `src/config/vector-cortex-cosfp-real.ts` (sibling extract), re-exported by `src/config/vector-cortex.ts` + root `src/config.ts`, default ON; `MEGACOMPACT_COSINE_FP_REAL=0` disables and must be byte-identical to the pre-COS-FP-R state. Registered in `VECTOR_CORTEX_SETTINGS` as a visible boolDirect toggle, never in `EXCLUDED_SETTINGS`.

## Goal and inputs/outputs

Close the **real-session half of external-audit #3**: "Validate the 0.90 cosine threshold empirically against 100 real sessions, FP rate". Where COS-FP-A measured against a **synthetic** ground truth, COS-FP-R measures L2 cosine FP/FN against a **donated real-corpus** ground truth and reports content-type-aware threshold recommendations with properly powered confidence (Wilson intervals + session-grouped bootstrap), comparing against the synthetic baseline. It runs **only at execution time** — when a valid corpus exists — and its only artifacts are the execution script skeleton + the deferred evidence doc + append-only rows to the report.

Inputs: (a) a valid donated corpus (definition in §Corpus) with its manifest; (b) the COS-FP-A harness/embedding + report baseline. Outputs (all execution-time): (a) `scripts/cosine-fp/real-bench.mjs` results (grid sweep over real pairs, FP/FN with Wilson intervals + session-grouped bootstrap(10000)); (b) a content-type-aware threshold recommendation array vs the synthetic baseline; (c) `docs/vector-cortex/evidence/COS-FP-R.md` (created at execution only); (d) appended rows to `docs/vector-cortex/cosine-threshold-report.md` — **append-only, never overwriting the synthetic baseline block**.

**Scope boundary — this is not COS-FP-A:** COS-FP-R owns NO production runtime seam. It does not change `L2_COSINE` (that stays `MEGACOMPACT_L2_THRESHOLD=0.85` until a decision below), does not add a real-data dashboard card, does not wire content-type overrides ON. Adopting new defaults is a **decision** gated on acceptance criteria §Acceptance, upstream of any code. The exact ledger is never automatically training data — the corpus is built only from **voluntarily donated, consent-approved sessions** (§Corpus/§Consent), matching [EVALUATION](../EVALUATION.md) §Corpus and §Consent.

## Corpus — what is valid

A valid corpus for execution is: **100+ real sessions** (EVALUATION floor), each donated **voluntarily** by its session owner, with its record held in a corpus manifest `scripts/cosine-fp/corpus/corpus-manifest.json` that captures, **per session** and matching [EVALUATION](../EVALUATION.md) §Corpus: `sessionId` (or repo+session group), source digest, **provenance**, **license**, **consent record id**, repository group, language, content-type fraction (code/prose/mixed), duplicate/tool-use occurrences, anchors, and split assignment. The manifest records `consent` per the project's append-only consent line — see §Consent. The corpus is **session-grouped** such that splits never split one session across folds (EVALUATION §Corpus group rule; ML5-A §3 invariant).

## Consent (privacy gate — mandatory)

Privacy and consent follow [SECURITY_PRIVACY](../SECURITY_PRIVACY.md) **§Lifecycle** ("The exact ledger preserves truth but is **never automatically training data**. Learning defaults to no user-content inclusion. Opt-in consent is append-only and records subject/session scope, purposes, dataset version, timestamp, policy version, and revocation.") and **§Consent**. The corpus is built **only** from sessions whose owner gave explicit, append-only, revocable consent for dedup-threshold validation. Each session's consent record must exist before its bytes may be read for benchmarking. A corpus that includes any non-consented session is **invalid** and blocks execution entirely (see §Cannot-ship). Ledger bytes from non-donated or revoked sessions are **never** used.

## Numbered implementation tasks (deferred — execute in this order upon corpus availability)

1. (EXECUTION-GATE) Validate the corpus against §Corpus + §Consent: ≥100 consented sessions, complete per-session manifest metadata (provenance + license + consent id), session-grouped splits. If any session is missing consent or metadata → STOP here, record status `corpus_invalid`, do not proceed (the script exists to enforce this, see §Cannot-ship).
2. Author `scripts/cosine-fp/real-bench.mjs` (committed now, executes only when the corpus dir + manifest exist): reads the manifest, filters to consented sessions only, embeds the donated snippets via the shipped local embedder (loopback/self-contained; PREVENT-PI-004), scores pairs at the COS-FP-A grid (0.80–0.98 step 0.005) or the subset needed around the content-type operating points, and labels FP/FN against the **session-owner-annotated** ground truth in the manifest.
3. Report per-threshold FP/FN with **Wilson intervals** for the FP (proportion) and **session-grouped bootstrap(10000)** for the continuous/session-clustered metrics, per [EVALUATION](../EVALUATION.md) §Metrics. Output execution-time JSON under `scripts/cosine-fp/bench-run/real-<digest>.json`.
4. Build the content-type-aware recommendation array: compare per-type (code/prose/mixed) FP/FN + lower/upper CI against the COS-FP-A synthetic baseline; emit a recommendation (per-type threshold with its CI) only where the real CI is non-overlapping-with-failure and meets the FP-rate budget.
5. Append the real-corpus results as new rows to `docs/vector-cortex/cosine-threshold-report.md` — **append-only, never editing the synthetic baseline block**; record corpus manifest digest + session count + CI inputs (EVALUATION §Metrics "Evidence records sample/event/duration counts and CI inputs").
6. Emit `docs/vector-cortex/evidence/COS-FP-R.md` per [EVIDENCE_TEMPLATE](../EVIDENCE_TEMPLATE.md) at execution time only — the file is NOT created by this plan; it is created by the execution run (see §Cannot-ship: "does not mark evidence accepted" until then).
7. If a recommendation survives §Acceptance, the adopting change is a **separate post-COS-FP-R decision** (config default change upstream of any code), not part of this sprint's file set.

## Failure triad and independence

A real-corpus run + recommendation: with `MEGACOMPACT_COSINE_FP_REAL=1` (default) and a valid corpus present, `real-bench.mjs` produces CI-backed per-type FP/FN + a recommendation row, evidence + report append happen, status `ok`. B no/insufficient corpus (the ordinary pre-corpus state): the script reports `status:"no_corpus"` — it does NOT fabricate FP/FN, does NOT write evidence, does NOT mark accepted (fixture-equivalent pin: this is the baseline every day until a corpus exists). C flag-off: `MEGACOMPACT_COSINE_FP_REAL=0` is byte-identical to pre-COS-FP-R — nothing executes, no endpoints, no writes. A is produced by the real run; B by the corpus gate early-return; C purely by the flag branch. All three use independent inputs; common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Acceptance criteria for adopting new defaults

A new default (per-type override or overall `L2_COSINE`) is adoptable **only if all** hold (AND, no OR-logic shortcut per EVALUATION §Rollout): (1) corpus ≥100 consented sessions with complete manifests; (2) real-corpus FP-rate CI upper bound is at or under the FP budget (`FP_RATE_L1L2=0.05`) at the proposed threshold; (3) the real recommendation CI does not confirm the shipped `0.85` is worse than `0.90` beyond the non-inferiority margin where applicable; (4) per-type recommendations are disjoint-by-CI from failure, else the sprint adopts the overall conservative threshold only; (5) any adoption is a **separate** config change, TLS-flag reviewed, upstream of this sprint's file set — COS-FP-R itself never flips a default.

## Rollback

Rollback to the pre-COS-FP-R baseline sets `MEGACOMPACT_COSINE_FP_REAL=0` — execution stops, no further evidence/report writes, byte-identical predecessor. If (post-decision) new defaults were adopted, rollback **tombs-to** those thresholds (record them in a tombstone section of the report), deletes the adopted non-default content-type overrides via flag/env revert (back to `MEGACOMPACT_L2_THRESHOLD=0.85`), and **no dashboard live-data swap occurs until a fresh review** (the dashboard card — when one is ever added in a COS-FP follow-up — must never show real FP numbers as live truth before a reviewed decision; the report/digest is the only surfaced artifact). Rollback is non-destructive: the real-corpus reports + evidence stay on disk, reversibly.

## Cannot-ship condition

**Without the corpus this sprint does NOT**: create fixture files (COS-FP-R owns NO conformance fixtures — there are none to create), run `deploy.sh` or any publish gate (`deploy.sh` is the authoritative publish gate and is never invoked while COS-FP-R is deferred), or mark evidence accepted (`docs/vector-cortex/evidence/COS-FP-R.md` is created at execution time only, per EVIDENCE_TEMPLATE.md, and `vector-cortex-evidence-check.mjs COS-FP-R` is expected to FAIL while the corpus is absent — that failure is the correct deferred state, not a gate to paper over). The execution script itself enforces the corpus gate (status `no_corpus`/`corpus_invalid`, never fabricated). Only after a valid consented corpus exists does a maintainer flip this sprint from deferred-exec to executing.

## Tests, validation, and assertions

COS-FP-R is **deferred-exec**, so there are no conformance fixtures and no acceptance aggregator that must pass today. The execution script (`real-bench.mjs`, task 2) carries its own **write-time validation tests** (run when the corpus exists): (a) corpus-gate test — the script refuses to run on an empty/invalid manifest with status `no_corpus`/`corpus_invalid` and writes nothing; (b) consent-filter test — non-consented/revoked sessions are excluded from scoring and the denial is logged, never silently included; (c) CI test — Wilson interval bounds are in [0,1] and bootstrap(10000) is session-grouped (a session never straddles folds); (d) determinism test — same corpus + params → same result digest (mirrors COS-FP-A-002). Exact deferred-command (expected to report `no_corpus` today — this is correct, not a failure):

```bash
npm run build
MEGACOMPACT_COSINE_FP_REAL=0 node --test dist/vector-cortex/cosfp-acceptance.test.js   # flag-agnostic, passes now
node scripts/cosine-fp/real-bench.mjs --check-corpus   # prints no_corpus until a valid corpus exists
```

Expected assertions: the flag-agnostic aggregator `src/vector-cortex/cosfp-acceptance.test.ts` (shared with COS-FP-A) passes in both modes now; `--check-corpus` returns status `no_corpus` until execution. At execution time, assertions verify the §Acceptance criteria AND-gate and the §Consent filter (EVAL-REDACT-002 / SECURITY_PRIVACY §Consent). Apply [EVALUATION](../EVALUATION.md) §Metrics; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback gates

Migration disposition: **pure — no migration** (schema/state unchanged; no new SQLite columns, no events.log format change; bench artifacts live under `scripts/cosine-fp/`, outside the state dir). Privacy: conservation holds — the exact ledger is **never automatically training data** ([SECURITY_PRIVACY](../SECURITY_PRIVACY.md) **§Lifecycle**), and this corpus is built only from **voluntarily donated, per-session consent-approved** sessions ([SECURITY_PRIVACY](../SECURITY_PRIVACY.md) **§Consent**). The report/evidence carry counts, CIs, digests — never raw snippet text (EVAL-REDACT-002). Dashboard: **not touched by COS-FP-R** — no card, no endpoint; the "last synthetic bench recommendation" card is COS-FP-A's. The `cd extensions/dashboard-client && npm run typecheck && npm run build` gate is **N/A** (no client files change); note the skip in the evidence doc if/when created.

## Exit evidence (deferred-exec form)

Today, the exact gates that MUST pass: `npm run build`, `node --test dist/vector-cortex/cosfp-acceptance.test.js`, `MEGACOMPACT_COSINE_FP_REAL=0 node --test dist/vector-cortex/cosfp-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all --soft-as-hard --soft-as-hard-base <PREV_TAG> --pre-commit`, `node scripts/guardrails-scan.mjs`, `node scripts/vector-cortex-docs-check.mjs` (EXPECTED_SPRINTS 45→47 counted with COS-FP-A), `node scripts/vector-cortex-scope-check.mjs COS-FP-R <COMMIT_SHA>`, `git diff --check`.

Explicitly NOT run today (deferred-exec invariant): `deploy.sh` (never), `python3 scripts/log_failure.py --list`-evidence-adoption is moot, and `node scripts/vector-cortex-evidence-check.mjs COS-FP-R` is **expected to FAIL** (no evidence exists) — that is the correct deferred state, recorded in the plan, not resolved by fabricating evidence.

```bash
npm run build
node --test dist/vector-cortex/cosfp-acceptance.test.js
MEGACOMPACT_COSINE_FP_REAL=0 node --test dist/vector-cortex/cosfp-acceptance.test.js
npm test
npm run lint
python3 scripts/regression_check.py --all --soft-as-hard --soft-as-hard-base <PREV_TAG> --pre-commit
node scripts/guardrails-scan.mjs
node scripts/vector-cortex-docs-check.mjs
node scripts/vector-cortex-scope-check.mjs COS-FP-R <COMMIT_SHA>
```

The dashboard-client gate is **N/A** (no client files change); skip is declared by scope. This sprint is one of 15 new sprint docs in the program; the single docs-check reconciliation (owned by the integration step, not by any per-sprint commit) sets `EXPECTED_SPRINTS` to **60** in `scripts/vector-cortex-docs-check.mjs` (count at integration time). The script is included in Production ownership at the integration pass only; per-sprint commits leave it unchanged.
