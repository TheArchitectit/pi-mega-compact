# REPO-A — Cross-repo corpus preparation (spec-only, deferred execution)

**Status: spec-only — execution deferred until donated corpus exists.** | **Depends on:** external-audit #5 (cross-repo recall real-world validation) | **Phase:** REPO

**Flag:** `MEGACOMPACT_REPO_CORPUS`, positive agent flag, defined in the new sprint-flag sibling `src/config/repo-corpus.ts`, re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_REPO_CORPUS=0` disables and must be byte-identical to the predecessor (the corpus-builder refuses to run and the reader route 404s; no derived artifact is written). Registered in the dashboard `SETTINGS` via the `MEGACOMPACT_REPO_*` positive line as a boolDirect toggle, never in `EXCLUDED_SETTINGS`.

## Deferred-execution contract (read first)

This sprint ships **the spec + consent plumbing + synthetic corpus validation harness + reader route ONLY**. It does NOT consume real user data. Real multi-repo execution is a separate **activation sprint REPO-B** that is named here as the downstream sibling but is **explicitly NOT specced now** — it is future work. REPO-B's preconditions (recorded here, not designed):

- ≥5 private repos donated by the same audit requester, with an **OWNER attestation per repo** (the audit-requester is the owner who genuinely worked across all of them).
- A corpus manifest approved by the owner.
- **No auto-enrollment** — every repo is explicitly donated.
- **No third-party sessions** — every session in the corpus is the owner's own.

Consequence: should REPO-A ever run against a repo lacking full required consent, all writes are refused (see Failure A + negative test below). This spec makes that refusal *testable* with a synthetic revoked-consent fixture now, so the enforcement is proven before any real corpus exists.

## Goal and inputs/outputs

Close the real-world-validation gap of external-audit item #5. The code (Slice-2 PGlite global topology, `repo_id` first-class columns in `src/store/sqlite/global-index.ts`, repo-scoping in `src/store/repoKey.ts`) already exists; what is missing is **a governed way to obtain real cross-repo sessions** plus the harness to prove the corpus path is consent-safe and byte-preserving before REPO-B runs.

Inputs: per-repo `events.log` slices under one owner consent (pseudonymous), read-only from each repo's `stateDir`. Outputs: (a) a validated **corpus manifest** (schema row + conformance-manifest rows), (b) a **reader-only JSON endpoint** `GET /api/repo-corpus` answering "which pseudonymous repos/sessions are in the corpus, what cross-repo overlap exists, is consent active for each" (counts + IDs + status only — never payload content), and (c) **synthetic pseudonymous corpus fixtures** plus a negative test proving missing consent → `REPO_CORPUS_CONSENT_REQUIRED` + zero bytes written.

Production ownership: `scripts/repo-corpus/build.mjs (new — read-side corpus-builder, pseudonymizes repo_id, refuses on missing/revoked consent); scripts/repo-corpus/consent.mjs (new — append-only consent record helpers: opt-in/revoke append, effective-state resolver, shared by builder + route + tests); extensions/dashboard-server/api-contracts/repo-corpus.ts (new — RepoCorpusManifestV1 + RepoCorpusStatusV1 contracts, explicit types, no any); extensions/dashboard-server/routes-repo-corpus.ts (new — GET /api/repo-corpus, reader-only, memoized); extensions/dashboard-server/routes-repo-corpus.test.ts (new — unit tests over a synthetic corpus dir + synthetic events.log); extensions/dashboard-server/api-contracts/endpoints/registry-ext.ts (additive — repo-corpus group); extensions/dashboard-server/api-contracts.test/endpoints-registry.test.ts (EXPECTED_ENDPOINT_COUNT bump, mechanical registry-count reconciliation, added to Production ownership); extensions/dashboard-server/api-contracts/index.ts (additive — type re-export barrel for RepoCorpusManifestV1/RepoCorpusStatusV1); extensions/dashboard-server/route-dispatch.ts (additive if-chain entry); extensions/dashboard-server/routes.ts (additive re-export); extensions/dashboard-server/routes-rag-settings-vector-cortex.ts (additive MEGACOMPACT_REPO_CORPUS boolDirect toggle — "Cross-Repo Corpus (REPO-A)"); src/config/repo-corpus.ts (new — positive flag, sprintFlag pattern from `src/config/vector-cortex-flag.ts`); src/config.ts (additive re-export, ≤300 soft); extensions/dashboard-server/api-contracts/repo-corpus-status-card schema (via api-contracts/repo-corpus.ts, consumed by the VC9-style Card component); extensions/dashboard-client/src/types/repo-corpus.ts (new); extensions/dashboard-client/src/tabs/VectorCortexRepoCorpusCard.tsx (new — consent status card); conformance/vector-cortex/v2/repo-corpus/ (synthetic fixtures REPO-A-001..003); conformance/vector-cortex/v2/repo-corpus/test-consent/ (synthetic revoked-consent corpus for the negative test); conformance/vector-cortex/v2/schemas/repo-corpus-manifest.schema.json (new — mirrors consent-fixture precedent); conformance/vector-cortex/v2/manifest.json (additive rows); docs/vector-cortex/sprints/REPO-A-cross-repo-corpus-prep.md (this file — bump EXPECTED_SPRINTS in scripts/vector-cortex-docs-check.mjs 45→46); docs/vector-cortex/evidence/REPO-A.md (new); scripts/vector-cortex-docs-check.mjs (bump 45→46)`.

## Numbered implementation tasks

1. **Consent record schema** (`scripts/repo-corpus/consent.mjs`): define append-only consent records, fields per SECURITY_PRIVACY.md §Lifecycle: `{ consentId, ownerPseudonym, repoPseudonym (hash-of-canonical-remote), scope: "single-repo"|"cross-repo", purpose, datasetVersion, ts, policyVersion, action: "grant"|"revoke", sourceEventId }` with a monotonic `effectiveSeq`. `repoPseudonym = sha256("REPO-CORPUS-v1:" + canonicalRemote)[0..16 hex]` where `canonicalRemote` is resolved from `repoKey()`'s git-root plus `git remote get-url origin` when present (local, read-only — guardrails-allow PREVENT-PI-004). Implement `appendConsentRecord` (strict-append, no UPDATE — matches §Lifecycle), `activeConsent(records, repoPseudonym, effectiveSeq)` (latest action per consentId wins; `revoke` subordinates a prior `grant` for the same scope from `effectiveSeq` onward — instant freeze), and `consentCoversCrossRepo(records, repoPseudonyms[], effectiveSeq)`. **No third-party sessions** — each record pins `scope:"cross-repo"` to require the owner's SAME session set.
2. **Corpus-builder read-side** (`scripts/repo-corpus/build.mjs`): a pure read-side CLI `node scripts/repo-corpus/build.mjs --corpus-out <dir>` that (a) accepts a `--manifest` JSON (repo pseudonyms + their per-repo stateDir + owner attestations), (b) for each repo resolves its `events.log` slice via the existing repo plumbing, (c) verifies `activeConsent(..., "cross-repo")` for EVERY repo before touching a byte, (d) writes a **pseudonymous** corpus manifest (repoPseudonym only — the canonicalRemote→pseudonym mapping is a pure function of the remote string and is NEVER written back into any production table; the builder maintains only in-memory mapping), (e) emits a `RepoCorpusManifestV1` to `--corpus-out/manifest.json`, and (f) **never reads or writes `conversation_thread`/`tool_results` payloads** — it aggregates IDs/counts/digests/cross-repo-overlap descriptors only. Reuse `repoKey()`/`stateDirForRepo()`/`getRepoRegistry` from `src/store/repoKey.ts` + `src/store/sqlite/global-index.ts`; Slice-2 global topology is read as-is and left untouched. Zero writes on any consent failure.
3. **Synthetic fixture generator** (`scripts/repo-corpus/gen-fixtures.mjs` is NOT a new-ownership file — the fixtures are committed directly): author `conformance/vector-cortex/v2/repo-corpus/REPO-A-001..003.json` matching `schemas/repo-corpus-manifest.schema.json`. All fixtures are SYNTHETIC pseudonymous corpora — no user data, no real remotes, no private prompts (SECURITY_PRIVACY.md §Fixtures). `REPO-A-001`: a valid 3-repo corpus with full cross-repo consent, shared identifiers (a common session-id prefix) and a recorded cross-repo dedup hit. `REPO-A-002`: a single-repo corpus (no cross-repo consent) — manifest valid, cross-repo overlap empty. `REPO-A-003`: flag-off assertion (reader route 404, no writes).
4. **Negative test — missing consent** (acceptance task, `src/vector-cortex/repo-corpus/negative.test.ts`): build a corpus from `conformance/vector-cortex/v2/repo-corpus/test-consent/` where ONE repo has a revoked/absent cross-repo consent. Assert the builder returns `REPO_CORPUS_CONSENT_REQUIRED`, **zero bytes are written** (the `--corpus-out/manifest.json` does not exist), and an `event:"repo_corpus_consent_refused"` line is appended to the pseudonymous audit log **without payload content** (repoPseudonym + seq + refusal code only — never matched text/checkpoint paths).
5. **Dashboard consent status card** (`extensions/dashboard-client/src/tabs/VectorCortexRepoCorpusCard.tsx` + `src/types/repo-corpus.ts` + the reader route from Production ownership): `GET /api/repo-corpus` returns `RepoCorpusStatusV1` — `{ schema:"repo-corpus-status-v1", corpus: RepoCorpusManifestV1 | null, perRepo: [{ repoPseudonym, sessions:number, consentedCrossRepo:boolean, revokedAt?:string }], totalEvents:number, status: VcStatus }`. Card renders per-repo consent rows + a live/off status; it is a reader (never submits consent — consent is CLI/ops-only, append-only via `consent.mjs`).

## Failure triad and independence

A: consent-gated corpus path — a corpus builds only with full cross-repo consent; missing/revoked consent refuses (`REPO_CORPUS_CONSENT_REQUIRED`) and writes zero bytes. B: **flag-off prior single-repo recall** — `MEGACOMPACT_REPO_CORPUS=0` produces byte-identical behavior to the pre-sprint world: reader route 404s, builder refuses to run, and the existing single-repo recall path (Slice-2 + global-index) is untouched and byte-identical. C: error-complete freeze + pseudonymous audit log — on any consent failure or I/O error the builder freezes (no partial artifact), logs the refusal event WITHOUT payload content, and **no derived artifact (crystal/vector shard/LLM context) ever remains live from the failed build** — the corpus dir is emptied on failure. Each triad member uses independent assets (synthetic corpora vs. live single-repo store vs. flag gate); A and C are real executed paths; B is produced purely by the flag.

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/repo-corpus/` (+ `test-consent/` subdir).

- `REPO-A-001: valid 3-repo corpus with full cross-repo consent builds; manifest lists 3 pseudonymous repos, total events > 0, cross-repo overlap descriptor present, all consentedCrossRepo true`.
- `REPO-A-002: single-repo corpus (scope:"single-repo") builds as a valid manifest with empty cross-repo overlap — no cross-repo recall claims are made`.
- `REPO-A-003: flag-off returns 404 + no manifest writes (byte-identical to predecessor, no derived artifact)`.

Exact test sources: `extensions/dashboard-server/routes-repo-corpus.test.ts`, `src/vector-cortex/repo-corpus/consent.test.ts` (pure consent-resolution determinism), `src/vector-cortex/repo-corpus/negative.test.ts` (missing-consent refusal). Sprint acceptance aggregator: `src/vector-cortex/repo-corpus-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/repo-corpus-acceptance.test.js
```

Expected assertions: all REPO-A-001..003 registered with algorithm `repo-corpus`, path `repo-corpus/<id>.json`, schema `schemas/repo-corpus-manifest.schema.json`, expected `ok`. Route tests: flag-on 200 with the full status contract; flag-off 404; non-GET 405; a repo whose stateDir is missing degrades (repo listed with `consentedCrossRepo:false`, not a crash). Negative test: `REPO_CORPUS_CONSENT_REQUIRED` + zero bytes written + `repo_corpus_consent_refused` logged without payload content. Exact flag-off comparison: `MEGACOMPACT_REPO_CORPUS=0 node --test dist/vector-cortex/repo-corpus-acceptance.test.js`; the aggregator is flag-agnostic. Acceptance: **zero payload leakage** (endpoint reports repoPseudonym/session counts/overlap descriptors/status only — never matched text, never raw query text, never canonicalRemote), reader-only, every endpoint returns a non-empty `status` from `deriveVcStatus`. Apply EVALUATION annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance. Unique failure injection: build a corpus from a repo whose consent flips from grant→revoke between builder passes → second pass writes nothing, `repo_corpus_consent_refused` logged, and a previously-staged derived artifact (simulated crystal/shard) is dropped from the live set (async purge after instant freeze).

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure — no migration of existing tables**. `plan-v2.ts` and `global-index.ts` columns already exist and are unchanged; repo_id first-class recall plumbing is reused as-is. The only new storage is the append-only consent record list held by `scripts/repo-corpus/consent.mjs` — **new append-only table, no legacy migration** (strict-append, no UPDATE). Every migration follows compatibility journal/copy-validate-switch when it does apply; this sprint writes none.

Privacy follows SECURITY_PRIVACY.md; normative clause on consent append-only + revocation, verbatim: *"Opt-in consent is append-only and records subject/session scope, purposes, dataset version, timestamp, policy version, and revocation. Revocation excludes future datasets and records affected digest manifests; immutable released datasets require documented withdrawal handling."* The exact ledger is never automatically training data. Repo pseudonyms are hash-of-canonical-remote and are a pure read-side function — never persisted back into production tables. Revocation propagates through derived artifacts (crystals, vector shards, LLM-generated context): instant freeze of builder/route, async purge of affected derived artifacts (digest manifests recorded per §Lifecycle), and the audit log is pseudonymous (IDs/counts/digests only). Dashboard: `VectorCortexRepoCorpusCard` is reader-only and gated on the flag (OFF → status off, no card content). Dashboard work must own `api-contracts/repo-corpus.ts`, registration in `routes.ts` + `route-dispatch.ts`, handler `routes-repo-corpus.ts`, client `types/repo-corpus.ts`, `tabs/VectorCortexRepoCorpusCard.tsx` (under the dashboard-client `src/` tree), route/component tests, reader-only GET capability, and run `cd extensions/dashboard-client && npm run typecheck && npm run build`.

Rollback sets `MEGACOMPACT_REPO_CORPUS=0`, selects B, restores the prior single-repo recall derived pointer without deleting evidence, and verifies predecessor golden bytes. No operator migration; consent records remain append-only and inert. Next handoff: REPO-B (activation — NOT specced; preconditions listed at the top).

## Exit evidence

Run the standard gates:

```bash
npm run build
node --test dist/vector-cortex/repo-corpus-acceptance.test.js
MEGACOMPACT_REPO_CORPUS=0 node --test dist/vector-cortex/repo-corpus-acceptance.test.js
npm test
npm run lint
python3 scripts/regression_check.py --all
node scripts/guardrails-scan.mjs
python3 scripts/log_failure.py --list
node scripts/vector-cortex-conformance.mjs --check
node scripts/vector-cortex-docs-check.mjs
node scripts/vector-cortex-scope-check.mjs REPO-A <COMMIT_SHA>
node scripts/vector-cortex-evidence-check.mjs REPO-A
git diff --check
```

Dashboard-client gate (`cd extensions/dashboard-client && npm run typecheck && npm run build`) applies because the consent status Card is in scope.

## Live Playwright validation (MANDATORY)

The `VectorCortexRepoCorpusCard` consent status card must be exercised live: launch the dashboard (default `http://localhost:9320`), navigate to the hosting surface, render the repo-corpus card, and assert it displays the pseudonymous consent status (granted/revoked/absent) from `GET /api/repo-corpus` with zero console errors. Also exercise the flag-off path (`MEGACOMPACT_REPO_CORPUS=0`): endpoint 404, card absent, byte-identical surface. If no reachable dashboard host exists, the sprint pauses at implementer-complete until a live host is available; evidence names the host and the rendered card output.

---

This sprint is one of 15 new sprint docs in the program; the single docs-check reconciliation (owned by the integration step, not by any per-sprint commit) sets `EXPECTED_SPRINTS` to **60** in `scripts/vector-cortex-docs-check.mjs` (count at integration time). The script is in Production ownership at the integration pass only; per-sprint commits leave it unchanged. Evidence doc `docs/vector-cortex/evidence/REPO-A.md` must record: synthetic-fixture status, the negative-consent test result, and an explicit note that NO real corpus was built (execution deferred to REPO-B).
