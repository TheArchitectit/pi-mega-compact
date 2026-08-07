# REPO-A Evidence — Cross-repo corpus preparation

Status: **reviewer-accepted** — the consent-gated pseudo-anonymous cross-repo
corpus builder, its append-only consent ledger, the reader-only status route,
the Config surface, and the negative-consent enforcement are all implemented,
tested, and gate-clean. This is the REPO phase of the external-audit #5 work
(cross-repo recall): the corpus *preparation* path + consent enforcement is done;
the downstream real-world cross-repo recall validation remains a later sprint.

## Sprint meta

- **Spec:** docs/vector-cortex/sprints/REPO-A-cross-repo-corpus-prep.md
- **Sprint ID string:** `REPO-A` (all caps per conformance manifest)
- **Flag:** `MEGACOMPACT_REPO_CORPUS` — boolDirect, default ON, `=0` byte-identical predecessor (reader route 404s, builder refuses, no derived artifact written). Registered as a visible `VECTOR_CORTEX_SETTINGS` toggle, never in `EXCLUDED_SETTINGS`.

## Production ownership files (final state)

- `src/config/repo-corpus.ts` (23) — `REPO_CORPUS_ENABLED()` positive flag sibling, `sprintFlag` pattern from `src/config/vector-cortex-flag.ts`
- `src/config/vector-cortex.ts` (102) — barrel re-export of `REPO_CORPUS_ENABLED`
- `src/config.ts` (221) — root barrel re-export (≤300 soft)
- `src/vector-cortex/repo-corpus-acceptance.test.ts` (180) — acceptance aggregator: fixture registration + kind-closure (4), envelope posture (3), flag invariants (1), settings toggle (1) = 9 tests, flag-agnostic
- `src/vector-cortex/repo-corpus/consent.test.ts` (201) — consent-resolution determinism via the committed `consent.mjs` CLI over a real temp git repo (grant→resolve; revoke instant-freeze) + builder full-grant/revoke path + consent-state artifact assertion = 3 tests
- `src/vector-cortex/repo-corpus/negative.test.ts` (169) — negative missing-consent test driving the committed `build.mjs` against a revoked repo → `REPO_CORPUS_CONSENT_REQUIRED`, zero bytes, pseudonymous refusal audit = 1 test
- `scripts/repo-corpus/consent.mjs` (368) — append-only consent ledger: `canonicalRemote`/`repoPseudonymForRemote`/`repoPseudonymForGitRoot`, `makeConsentRecord`, `appendConsentRecord(s)`, `readConsentRecords`, `effectiveConsent`/`activeConsent`/`consentCoversCrossRepo`; CLI `append`/`resolve`. Repo pseudonym = `sha256("REPO-CORPUS-v1:" + canonicalRemote)[0..16 hex]`, pure + never persisted
- `scripts/repo-corpus/build.mjs` (440) — read-side corpus-builder CLI: per-repo `events.log` slice aggregation (IDs/counts only), `crossRepoOverlap`, manifest + consent-state build, consent-gated refusal (exit 3) with zero-bytes-freeze + pseudonymous `repo_corpus_consent_refused` audit
- `extensions/dashboard-server/api-contracts/repo-corpus.ts` (76) — `RepoCorpusStatusV1` / `RepoCorpusManifestV1` / `RepoCorpusConsentStateV1` / per-repo status contracts, explicit types, no `any`
- `extensions/dashboard-server/api-contracts/index.ts` (371) — additive type re-export barrel
- `extensions/dashboard-server/api-contracts/endpoints/registry-ext.ts` (194) — additive `repoCorpus` endpoint group
- `extensions/dashboard-server/api-contracts.test/endpoints-registry.test.ts` (202) — `EXPECTED_ENDPOINT_COUNT` 57→58 mechanical reconciliation
- `extensions/dashboard-server/routes-repo-corpus.ts` (286) — `GET /api/repo-corpus`, reader-only, memoized {mtime,size} 5s TTL; flag-off 404; absent corpus → awaiting_data; does NOT import builder scripts (CLI seam, `scripts/` not packaged)
- `extensions/dashboard-server/routes-repo-corpus.test.ts` (193) — flag-on full contract + missing-stateDir degrade + absent-corpus awaiting_data + flag-off 404 + non-GET 405 = 4 tests
- `extensions/dashboard-server/route-dispatch.ts` (168) — additive if-chain entry
- `extensions/dashboard-server/routes.ts` (71) — additive re-export
- `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts` (334) — boolDirect `MEGACOMPACT_REPO_CORPUS` toggle "Cross-Repo Corpus (REPO-A)"
- `extensions/dashboard-client/src/types/repo-corpus.ts` (25) — card row/view types
- `extensions/dashboard-client/src/tabs/SetupTab/VectorCortexRepoCorpusCard.tsx` (126) — reader-only consent status card (poll `/api/repo-corpus`, 5s), never submits consent
- `extensions/dashboard-client/src/tabs/SetupTab/CortexSetup.tsx` (60) — mount card
- `scripts/vector-cortex-publish-acceptance.mjs` (365) — mirror `repo-corpus.js` config sibling at the published `dist/config/` offset (exit-only add to the existing glob)
- `conformance/vector-cortex/v2/repo-corpus/REPO-A-001.json` — valid 3-repo full-consent corpus, 1 cross-repo overlap
- `conformance/vector-cortex/v2/repo-corpus/REPO-A-002.json` — single-repo corpus, empty cross-repo overlap
- `conformance/vector-cortex/v2/repo-corpus/REPO-A-003.json` — flag-off fixture (no manifest key, route off)
- `conformance/vector-cortex/v2/repo-corpus/test-consent/REPO-A-NEG-001.json` — synthetic revoked-consent corpus (negative test)
- `conformance/vector-cortex/v2/schemas/repo-corpus-manifest.schema.json` — fixture envelope schema
- `conformance/vector-cortex/v2/manifest.json` — owner CSV `REPO-A`, domain `repo-corpus`, 930 fixtures canonical (925 baseline + REPO-A-001..003 + REPO-A-NEG-001 + schema)
- `docs/vector-cortex/sprints/REPO-A-cross-repo-corpus-prep.md` — spec (Production-ownership amended; `EXPECTED_SPRINTS` stays 65 — REPO-A is one of the 15 deferred-audit specs already counted, NOT a new doc)

## Behavior enforced (the sprint's hard guarantees)

1. **Consent gate** — a corpus builds only with full cross-repo consent. Missing/
   revoked consent for ANY repo refuses the whole build with `REPO_CORPUS_CONSENT_REQUIRED`
   (exit 3) and writes **zero bytes** (the `--corpus-out/manifest.json` does not exist).
2. **Pseudonymous audit, no payload** — the refusal appends one
   `event:"repo_corpus_consent_refused"` line with exactly `{ts, event, repoPseudonym,
   effectiveSeq, refusalCode}` — never matched text, checkpoint, or events paths.
3. **Flag-off byte-identical** — `MEGACOMPACT_REPO_CORPUS=0`: reader route 404s, builder
   refuses, no derived artifact; the single-repo recall path is untouched.
4. **Reader-only surface, no silent inclusion** — the route serves counts + IDs + status
   only; a repo whose consent can't be confirmed degrades to `consentedCrossRepo:false`,
   never a crash, never a silent inclusion.

## Negative-consent test (missing consent)

Drives the committed `scripts/repo-corpus/build.mjs` against a synthetic 2-repo
set where repo B is granted then **revoked**:

- Builder returns exit 3 and names `REPO_CORPUS_CONSENT_REQUIRED`.
- `--corpus-out/manifest.json` does NOT exist (zero bytes written).
- The audit log contains one `repo_corpus_consent_refused` line for repo B with
  only `{ts, event, repoPseudonym, effectiveSeq, refusalCode}` — assert on the
  exact key set, so no payload content can ever be appended.

Real donated corpus at execution time: **none available at implement time** — the
builder was exercised against synthetic consented corpora (REPO-A-001/002) and the
revoked-negative set. Per the spec, absent donated repos the run reports
consent-absent and writes nothing — a valid completed state, not a deferral; the
enforcement itself is proven by the negative test before any real corpus exists.

## Conformance fixtures

- `REPO-A-001` — 3-repo full-consent corpus, 1 recorded cross-repo overlap, route live.
- `REPO-A-002` — single-repo corpus, overlap 0, route live.
- `REPO-A-003` — flag-off, NO manifest key, route off.
- `REPO-A-NEG-001` — negative (no schema), used by the consent-negative test.
- All canonical + sha256-pinned in the manifest (930 fixtures canonical).

## Test outcomes (HEAD, flag-agnostic)

- [x] `node --test dist/vector-cortex/repo-corpus-acceptance.test.js` → **9 pass / 0 fail**
- [x] `node --test dist/extensions/dashboard-server/routes-repo-corpus.test.js` → **4 pass / 0 fail**
- [x] `MEGACOMPACT_REPO_CORPUS=0 node --test dist/vector-cortex/repo-corpus-acceptance.test.js` → **9 pass / 0 fail** (flag-off same-pass parity)
- [x] `node --test dist/src/vector-cortex/repo-corpus/consent.test.js` → **3 pass / 0 fail**
- [x] `node --test dist/src/vector-cortex/repo-corpus/negative.test.js` → **1 pass / 0 fail**
- [x] `node --test dist/extensions/dashboard-server/api-contracts.test/endpoints-registry.test.js` → **4 pass / 0 fail**
- [x] `npm test` → **4082 passed, 0 failed across 405 files** (full suite, clean run)
- [x] `npm run lint` → clean (`tsc --noEmit` + guardrails-scan + semantic-scan)
- [x] `python3 scripts/regression_check.py --all` → **0 blocking** (7 dev-only/moderate npm audit warnings unchanged)
- [x] `node scripts/guardrails-scan.mjs` → clean (pi pattern + semantic scan clean)
- [x] `node scripts/vector-cortex-conformance.mjs --check` → **930 fixtures canonical**
- [x] `node scripts/vector-cortex-docs-check.mjs` → **65 sprints / 16 phases clean** (no bump — REPO-A pre-counted)
- [x] `cd extensions/dashboard-client && npm run typecheck && npm run build` → clean (card bundles in SetupTab chunk)
- [x] `git diff --check` → clean

## Migration and rollback

**Migration:** pure — no store schema change (no new SQLite columns, no events.log
format change). Consent records live in append-only JSONL files
(`.mega-compact-repo-corpus.consent.jsonl`) beside each repo's stateDir; the
corpus manifest + consent-state are builder outputs under the resolved corpus
dir. Nothing is ever UPDATEd or deleted.

**Rollback:** set `MEGACOMPACT_REPO_CORPUS=0`. Reader route 404s byte-identical to
predecessor; builder refuses; Settings/Setup toggle hides; no derived artifact is
read. Existing single-repo recall is byte-identical either way.

## Spec-staleness deviations (rationale)

- **Card path** — the spec ownership text said `tabs/VectorCortexRepoCorpusCard.tsx`;
  the committed card lives at `tabs/SetupTab/VectorCortexRepoCorpusCard.tsx`,
  matching the sibling COS-FP-A cosine-FP card and the `CortexSetup.tsx` mount.
- **Additional owned files surfaced by the scope gate** — the three test suites under
  `src/vector-cortex/repo-corpus/` (+ the acceptance aggregator), the `CortexSetup.tsx`
  mount, and the publish-acceptance config-mirror edit are now listed explicitly in
  Production ownership (the spec never named them).
- **`EXPECTED_SPRINTS`** — the spec's ownership/prose quoted a 45→46 (later "60") bump.
  REPO-A is one of the 15 deferred-audit specs ALREADY counted; `EXPECTED_SPRINTS`
  stays **65**. The spec text was corrected to say this; no bump in this sprint.
- **Dist mirror** — `src/config/repo-corpus.ts` keeps its spec-named filename rather
  than the `vector-cortex-` prefix; the publish-acceptance glob was extended to also
  mirror `repo-corpus.js` so re-exports resolve at the published offset.

## Reviewer verdict

Claude (Opus controller) / 2026-08-07 / **reviewer-accepted**. Two-stage
review complete: spec-compliance verified by direct controller read against
`docs/vector-cortex/sprints/REPO-A-cross-repo-corpus-prep.md` (consent gate
refuses on missing/revoked, append-only consent ledger, pseudonymous
repoPseudonym = sha256("REPO-CORPUS-v1:"+remote)[0..16], reader-only route
counts+IDs+status only, EVAL-REDACT-002 compliance, flag-off byte-identical
404, no third-party sessions via ownerAttestation match, no conformance
fixture drift). Code-quality review: `consent.mjs` is pure + read-only
spawnSync (PREVENT-PI-004 headers on every git/remote call); `build.mjs`
verifies EVERY repo's cross-repo consent BEFORE touching a byte, zero-bytes-
freeze on refusal, pseudonymous `repo_corpus_consent_refused` audit with
exactly {ts,event,repoPseudonym,effectiveSeq,refusalCode} (asserted by the
negative test on the exact key set); `routes-repo-corpus.ts` is reader-only,
guarded JSON.parse (PREVENT-001), no `any` (PREVENT-011), memoized {mtime,size}
5s TTL, does NOT import builder scripts (CLI seam preserved, scripts/ excluded
from package.json files); `api-contracts/repo-corpus.ts` readonly interfaces;
the card is reader-only (never submits consent via the dashboard).

**Controller fix during review:** closed a producer-consumer gap — `build.mjs`
wrote only `manifest.json` to the corpus dir, but the reader route also
projects `consent-state.json` (perRepo consent rows). Without the producer
side, a built corpus showed all repos "not consented" in the dashboard (safe
under-disclosure, never over-disclosure) but the seam was non-functional.
Fixed by emitting `consent-state.json` alongside `manifest.json` at build time
(every repo in a successful build has active cross-repo consent → all rows
`consentedCrossRepo:true`), and extended `consent.test.ts` to assert the file
exists + has the right schema + perRepo shape. The evidence doc's "consent
state the CLI corpus-builder produced" claim (line 6) is now accurate.

Evidence claims re-verified: all 21 file line counts match `wc -l`; npm test
**4082 passed / 0 failed / 405 files** (corrected from implementer's stale
3960); conformance 930 fixtures canonical; scope-check 83 committed files in
ownership; npm pack ships `dist/config/repo-corpus.js` (1.1kB) + the dashboard
bundle at `extensions/dashboard-client/dist/index.html`; no MUTATION of
existing behavior; no rate limiters/security checks disabled.
