# Phase REPO — Cross-Repo Corpus Preparation (Audit #5 groundwork)

**Status:** planned | **Depends on:** external-audit #5 (cross-repo recall real-world validation); Slice-2 PGlite global topology (SHIPPED) | **Phase:** REPO
**Flag scope:** one positive flag — `MEGACOMPACT_REPO_CORPUS`, defined in the new sibling `src/config/repo-corpus.ts`, re-exported by root `src/config.ts`, **default ON**, `=0` byte-identical. Registered in `VECTOR_CORTEX_SETTINGS` as a boolDirect toggle, never in `EXCLUDED_SETTINGS`.

## Premise

External-audit item #5 calls out cross-repo recall: the global topology from Slice 2 (PGlite, `repo_id` first-class, cross-repo NN by default) already exists in code, but no **governed real-world validation** of cross-repo recall has ever been performed against an actual multi-repo corpus. The blocker is not code — it is the absence of (a) a consent-complete per-owner donation model, (b) a place to record that consent append-only, and (c) a harness that proves the consent gate works BEFORE any real bytes flow. REPO-A closes the groundwork: an append-only consent record schema, a read-side corpus builder (pseudonymized by hash-of-canonical-remote), a reader-only dashboard route, a synthetic fixture set proving the happy path, and a negative test proving missing/revoked consent refuses with zero bytes written.

REPO-A ships the complete working feature — nothing is deferred to a follow-up sprint. Running the builder against real donated repos later requires no new code: the owner appends consent records via `consent.mjs`, passes a manifest, and the same committed `build.mjs` executes. Real-data eligibility is a runtime consent gate, not a phase boundary.

## Architectural invariants (do not violate)

1. **No new runtime network calls** — corpus building is a developer-tooling read-side CLI (`scripts/repo-corpus/build.mjs`) resolving each repo's `events.log` via existing `src/store/repoKey.ts` + `src/store/sqlite/global-index.ts`. No `src/` runtime is changed; Slice-2 global topology is read as-is and left untouched. PREVENT-PI-004 stays green.
2. **Consent is append-only and revocable** — every consent record follows SECURITY_PRIVACY §Lifecycle: append-only, recording subject/session scope, purposes, dataset version, timestamp, policy version, and revocation. Revocation wins over prior grants for the same scope from the `effectiveSeq` of the revoke onward (instant freeze). A revoked session's derived artifacts are purged asynchronously; the builder never re-reads them.
3. **Pseudonymity by construction** — `repoPseudonym = sha256("REPO-CORPUS-v1:" + canonicalRemote)[0..16 hex]`. The canonicalRemote string is never written to any production table; the builder holds the in-memory mapping for the duration of one run only. The reader endpoint reports pseudonyms + counts + status only (EVAL-REDACT-002); never a canonicalRemote, never a matched snippet, never raw query text.
4. **Zero derived artifact on consent failure** — a failed consent check returns `REPO_CORPUS_CONSENT_REQUIRED` with no partial manifest written, no crystal/vector shard live, no LLM context derived. The corpus dir is emptied on failure.
5. **Reader-only dashboard** — the consent status card is a reader; it never submits consent (consent is CLI/ops-only via the append-only `consent.mjs`). Non-GET → 405; READER-ONLY capability.
6. **Privacy norm** — the exact ledger is never automatically training data; synthetic fixtures only in REPO-A's conformance set; the script writes digest/counts/pseudonyms only.

## Sprint chain (single sprint — REPO-A)

| Sprint | Title | Reachable surface |
|--------|-------|-------------------|
| REPO-A | Cross-repo corpus prep — complete working feature (consent store, resolver, builder, route, card, synthetic fixtures) | `GET /api/repo-corpus`, `VectorCortexRepoCorpusCard`, `scripts/repo-corpus/{consent.mjs,build.mjs}` |

REPO-A is a single-sprint phase and ships everything. Real-corpus runs use the same committed `build.mjs` once the owner appends consent records — no follow-up sprint is needed for activation.

### REPO-A — Cross-repo corpus preparation

Ships the append-only consent record schema + effective-state resolver (`scripts/repo-corpus/consent.mjs`), the read-side corpus builder (`scripts/repo-corpus/build.mjs`) pseudonymizing repo IDs and refusing on missing/revoked consent, the contracts (`extensions/dashboard-server/api-contracts/repo-corpus.ts`), the reader-only route (`extensions/dashboard-server/routes-repo-corpus.ts` handling `GET /api/repo-corpus`), the client reader card (`extensions/dashboard-client/src/tabs/VectorCortexRepoCorpusCard.tsx`), and the conformance fixtures `REPO-A-001..003` (happy-path 3-repo corpus with shared session-id prefix + recorded cross-repo dedup hit; single-repo corpus with empty cross-repo overlap; flag-off 404). The **negative test** (`src/vector-cortex/repo-corpus/negative.test.ts`) asserts revoked/absent consent returns the exact refusal code, writes zero bytes, and logs `repo_corpus_consent_refused` pseudonymously (never payload content). **UI touch** — dashboard-client gate runs.

**Ownership:** `scripts/repo-corpus/{build.mjs,consent.mjs}; src/config/{repo-corpus.ts,config.ts}; extensions/dashboard-server/{api-contracts/repo-corpus.ts,routes-repo-corpus.ts,routes-repo-corpus.test.ts,api-contracts/endpoints/registry-ext.ts,api-contracts.test/endpoints-registry.test.ts,api-contracts/index.ts,route-dispatch.ts,routes.ts,routes-rag-settings-vector-cortex.ts}; extensions/dashboard-client/src/{types/repo-corpus.ts,tabs/VectorCortexRepoCorpusCard.tsx}; conformance/vector-cortex/v2/repo-corpus/ (+ test-consent/); conformance/vector-cortex/v2/schemas/repo-corpus-manifest.schema.json; conformance/vector-cortex/v2/manifest.json; docs/vector-cortex/evidence/REPO-A.md`.

## Conformance fixtures — REPO reserved family

One algorithm family `repo-corpus`, three fixtures + one negative corpus:

| Fixture range | Owner | Purpose |
|---------------|-------|---------|
| `REPO-A-001` | REPO-A | valid 3-repo corpus, full cross-repo consent, overlap descriptor present |
| `REPO-A-002` | REPO-A | single-repo corpus, valid manifest, empty cross-repo overlap |
| `REPO-A-003` | REPO-A | flag-off returns 404, byte-identical predecessor |

The `test-consent/` sibling directory holds the synthetic revoked-consent corpus used by the negative test. Conformance root: `conformance/vector-cortex/v2/repo-corpus/`; schema sibling at `schemas/repo-corpus-manifest.schema.json`.

## Exit evidence

REPO-A runs the mandatory gates plus the dashboard-client gate (the consent card is touched) plus the route unit tests + negative consent test + acceptance aggregator with flag-on and flag-off runs (`node --test dist/vector-cortex/repo-corpus-acceptance.test.js` and `MEGACOMPACT_REPO_CORPUS=0 node --test dist/vector-cortex/repo-corpus-acceptance.test.js`). The evidence doc `docs/vector-cortex/evidence/REPO-A.md` records the synthetic-fixture status, the negative-consent test result, and whether the builder ran against real donated repos at execution time (absent donations, the builder reports consent-absent and writes nothing — a valid completed state, not a deferral).

REPO-A additionally runs the **mandatory live Playwright validation**: the `VectorCortexRepoCorpusCard` consent-status card must render live on the dashboard, displaying pseudonymous consent status from `GET /api/repo-corpus` with zero console errors, plus the flag-off path (endpoint 404, card absent). If no reachable dashboard host exists (default `http://localhost:9320`), the sprint pauses at implementer-complete until one is available.
