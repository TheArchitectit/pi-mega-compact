# VC1C Evidence

Status: implementer-complete
Implementation commits/sub-sprint gates: VC1C sprint on `feat/vector-cortex`; git log for the focused commit. All sprint exit gates run and recorded below.
Contract review: not yet performed — pending independent reviewer.

## Goal recap

Cross-language conformance v2 (VC1C). Ships `FixtureManifestV2` (canonical manifest validator), `DowngradeReport` (deterministic downgrade export), and `MinHashV2` (exact big-integer minhash signatures) plus the M4 `copy/validate/switch` minhash-v2 migration. MinHashV2 freezes a **cross-language deterministic, byte-exact** scheme: the 256 published `(a_i, b_i)` seed pairs (stored as decimal strings because values exceed 2^53), 5-code-point shingles hashed with 64-bit FNV-1a, `p = 2^61-1` with exact BigInt multiply/modulo (a_i·x can reach ~2^124 where Number math would corrupt), 256×u64-LE signature bytes (2048 total), banded 64×4 into LSH bucket keys scoped by session + frozen version tag. Cross-version compare is rejected (`MINHASH_VERSION_MISMATCH`). M4 copies v2 rows beside v1, verifies exact-once counts/digests/version, and only then switches the active pointer — interruption keeps v1 authority and resumes idempotently. `FixtureManifestV2` validates a corpus is canonical (sorted UTF-8 keys, shortest numbers, final LF) and rejects extra/missing/drift with the frozen codes; canonical valid manifests converge to ONE digest. `MEGACOMPACT_VC1C` gate (default ON, `=0` → byte-identical predecessor) and the `vector_cortex_minhash_v2_backfilled` / `vector_cortex_conformance_case_checked` / `vector_cortex_downgrade_copy_written` emit seam.

## Changed production / tests / docs

Production (`src/`):
- `src/config/vector-cortex.ts` — `VC1C_ENABLED()` (default ON; `MEGACOMPACT_VC1C=0` → off). Re-exported by root `src/config.ts`.
- `src/dedup/l1-minhash-v2.ts` (187) — `MINHASH_VERSION=2`, `NUM_HASHES_V2=256`, `SHINGLE_CP=5`, `P_V2=(1n<<61n)-1n`, `U64_BYTES=8`, `SIGNATURE_BYTES_V2=2048`, `splitmix64`, `minhashV2Seeds`, `shinglesV2`, `minhashV2Signature`, `encodeSignatureV2`, `signatureSimilarityV2`. Exact BigInt FNV-1a-64, no Number corruption of high-bit products.
- `src/dedup/l1-lsh-v2.ts` (86) — `BANDS_V2=64`, `VALUES_PER_BAND_V2=4`, `BAND_BYTES_V2=32`, `lshBandsV2`, `bandsForTextV2`. Bucket keys FNV-1a-64 over the band's 32 LE bytes prefixed by `<sessionId>|v<version>|` — so v1/v2 never share buckets and cross-session keys never collide.
- `src/vector-cortex/migrations/minhash-v2.ts` (197) — **M4** copy/validate/switch: `computeV2Row`, `m4Backfill` (resumable by checkpoint id, no duplicate v2 rows), `m4Verify` (exact-once counts, digest re-hash, 64 buckets, version check), `m4Switch`, `migrateMinhashV2`. Failure codes `MINHASH_VERSION_MISMATCH`, `M4_BACKFILL_PARTIAL`, `M4_COUNT_MISMATCH`, `M4_DIGEST_MISMATCH`. `M4_IDS`/`M4_NAMED` conformance registries. Cross-version compare always rejected (`crossVersionError`).
- `src/vector-cortex/conformance/manifest.ts` (289) — `FixtureManifestEntry` (`expectedOutputDigest`)/`FixtureManifestV2`, `readFixtureManifestV2`, `validateCanonicalV2`, `canonicalManifestsConverge`, `domainOf`, `CONF_FAIL` (`CONF_EXTRA_FIXTURE`/`CONF_MISSING_FIXTURE`/`CONF_DIGEST_DRIFT`/`CONF_NONCANONICAL`/`CONF_UNKNOWN_DOMAIN`). A missing fixture reports `CONF_MISSING_FIXTURE` instead of throwing (robustness fix below).
- `src/vector-cortex/conformance/runner.ts` (165) — `ConformanceHandler`, `DowngradeReport` (schema `"downgrade-report-v1"`, `reportDigest`), `DowngradeExporter`, `runConformanceCase` (strict domain/version dispatch; unknown → reject WITHOUT partial output; then cross-checks the handler's outcome against the manifest entry: expected failure code → `CONF_EXPECTATION_MISMATCH`; expected success bytes → `CONF_DIGEST_DRIFT`), `handlerKey`, `runDowngradeExport`.
- `src/vector-cortex/conformance/emit.ts` (41) — `createConformanceReporter` emitting the three VC1C events, all gated on `MEGACOMPACT_VC1C`, non-fatal.

Dashboard (`extensions/dashboard-server/`):
- `routes-rag-settings-helpers.ts` — `MEGACOMPACT_VC1C` added to the "Vector Cortex" SETTINGS group as a `boolDirect` on/off toggle (NOT in `EXCLUDED_SETTINGS`).
- `routes-rag-settings.test.ts` — VC1C flag round-trip test (toggle OFF writes `MEGACOMPACT_VC1C="false"` and `VC1C_ENABLED()` → false; toggle ON restores).

Tests:
- `src/dedup/l1-minhash-v2.test.ts` (141) — 8 tests: frozen constants, exact-BigInt high-bit products, splitmix64 determinism, empty-sentinel signature, and byte-exact against `M4-HIGHBIT-001` (2048-byte LE signature, sha256 digest, 64 bucket keys).
- `src/dedup/l1-lsh-v2.test.ts` (75) — 6 tests: band geometry, determinism, session scoping, version-tagged keys (v1/v2 never share), wrapper parity, length rejection.
- `src/vector-cortex/migrations/minhash-v2.test.ts` (167) — 10 tests: M4 backfill/verify/switch, idempotent re-backfill, resume without duplicates, halt-before-switch keeps v1, partial/count/digest/version failure codes, cross-version rejection, `computeV2Row` shape.
- `src/vector-cortex/conformance/manifest.test.ts` (202) — 8 tests: canonical corpus passes + converges, shuffled-key reader normalization, real committed corpus converges, extra/missing/drift/noncanonical rejections, domain derivation.
- `src/vector-cortex/conformance/downgrade.test.ts` (79) — 3 tests: deterministic report digest + copy id across runs, unrepresentable ids listed, report digest covers the body.
- `src/vector-cortex/vc1c-acceptance.test.ts` (600, at the 600 test hard limit) — 31-test acceptance aggregator over the REAL algorithms + committed fixtures: manifest registration (M4-001..008, M4-HIGHBIT-001, M4-VERSION-002, M4-RESUME-003, M4-DUP-001, CONF-MANIFEST-001, CONF-EXTRA-002, CONF-DOWN-003, seeds-v2, owner VC1C); MinHashV2 exact vectors + independent reader (triad A/B); mixed-version rejection + no shared buckets; M4 lifecycle against every M4-00x fixture scenario; canonical manifest convergence + injected add/remove/drift mutations; triad A/B/C dispatch + runner cross-check of the expected failure code and expected success bytes; DowngradeReport determinism + read-only authority; flag-off parity. Runs green in BOTH flag states.

Scripts:
- `scripts/gen-fixtures/minhash.mjs` (211) — mirrors the TS MinHashV2 algorithm (splitmix64 seeds, FNV-1a-64, 5-CP shingles, exact BigInt, 2048-byte encode, 64 buckets) and emits `M4-HIGHBIT-001`, `M4-VERSION-002` + `seeds-v2.json` (seed pairs as `{a,b}` DECIMAL STRINGS, schema `schemas/minhash-seeds.schema.json`).
- `scripts/gen-fixtures/migrations.mjs` (102) — `M4-001..008`, `M4-DUP-001`, `M4-RESUME-003` (schema `schemas/minhash-migration.schema.json`, algorithm `minhash-v2-migration`).
- `scripts/gen-fixtures/conformance.mjs` (41) — `CONF-MANIFEST-001`, `CONF-EXTRA-002`, `CONF-DOWN-003` (schema `schemas/conformance-fixture.schema.json`, algorithm `conformance-v2`).
- `scripts/gen-fixtures/schemas.mjs` — appended `minhash-fixture`/`minhash-migration`/`conformance-fixture`/`minhash-seeds` schemas.
- `scripts/gen-fixtures/write.mjs` — `minhash`/`migrations`/`conformance` dirs, writes `seeds-v2.json` + new fixtures; manifest `domain` adds `minhash,migrations,conformance`, `owner` adds `VC1C`.
- `scripts/vector-cortex-gen-fixtures.mjs` — reports minhash/migration/conformance counts.
- `scripts/vector-cortex-publish-acceptance.mjs` — mirrors the `conformance/` subtree + `src/dedup` → `dist/dedup` so the acceptance aggregator's `./conformance/…` and `../dedup/…` imports resolve at the published `dist/vector-cortex/` offset.
- `scripts/vector-cortex-network-denial.mjs` — mode A exercises the MinHashV2 runner (signature + 64 buckets + digest), mode B adds an independent exact fixture reader (re-derives the high-bit signature and compares its digest), mode C confirms predecessor (v1) paths unchanged.
- `scripts/vector-cortex-downgrade-export.mjs` (NEW, 128) — deterministic downgrade export: writes a NEW legacy copy + `DowngradeReport` under `conformance/vector-cortex/downgrade/` (outside the v2 conformance root so `--check` stays clean), never mutates authority; a second run is byte-identical (CONF-DOWN-003).

Docs: `docs/vector-cortex/evidence/VC1C.md` (this record).

## Fixtures and corpus digests

`conformance/vector-cortex/v2/minhash/` — `M4-HIGHBIT-001.json`, `M4-VERSION-002.json`, `seeds-v2.json` (256 pairs as decimal strings, `p = 2305843009213693951`).
`conformance/vector-cortex/v2/migrations/` — `M4-001..008`, `M4-DUP-001`, `M4-RESUME-003`.
`conformance/vector-cortex/v2/conformance/` — `CONF-MANIFEST-001`, `CONF-EXTRA-002`, `CONF-DOWN-003`.
`conformance/vector-cortex/v2/schemas/` — `minhash-fixture`, `minhash-migration`, `conformance-fixture`, `minhash-seeds` schemas.

`node scripts/vector-cortex-conformance.mjs --check` → `✓ CONFORMANCE: v2 manifest + 149 fixtures canonical (149 files).`

All fixtures canonical (UTF-8/NFC/sorted keys/shortest numbers/final LF); SHA-256 pinned in the manifest. The behavior fixtures (CONF-EXTRA-002 etc.) declare scenarios the acceptance test executes against TEMP conformance roots so the committed corpus stays canonical (matching the prior M2-sprint precedent). `M4-HIGHBIT-001` pins the byte-exact 2048-byte signature (hex), its sha256 digest, and all 64 bucket keys; `M4-VERSION-002` pins `MINHASH_VERSION_MISMATCH`.

## Migration

M4 (`minhash-v2.ts`) copy → validate → switch, atomic + resumable: backfill writes v2 rows beside v1 by checkpoint id (idempotent — a re-run writes nothing); verify enforces exact-once counts (`M4_BACKFILL_PARTIAL`/`M4_COUNT_MISMATCH`), digest re-hash (`M4_DIGEST_MISMATCH`), and version (`MINHASH_VERSION_MISMATCH`); switch flips the active pointer to v2. A crash before switch leaves v1 active (old authority retained) and the next run resumes without duplicate signatures or pointer drift (M4-003/M4-RESUME-003). Cross-version compare never runs — it is always rejected with `MINHASH_VERSION_MISMATCH`.

## A/B/C and independence evidence

Triad over the MinHashV2 domain: **A** = the real v2 runner (`l1-minhash-v2.ts` + `l1-lsh-v2.ts`) reproducing every committed signature/bucket byte; **B** = an independent exact fixture reader that re-derives the high-bit signature directly from the committed text and compares its digest (no shared subroutine with the runner); **C** = reject any unknown domain/version WITHOUT partial output (`CONF_UNKNOWN_VERSION`). Cross-checked by the acceptance test ("A: runner reproduces", "B: independent exact reader", "C: unknown domain/version rejected"). Separately, the migrated M4 index is verified by independent re-hash in `m4Verify` (not the backfill path).

## Commands and verbatim summaries

- `npm run build` → tsc clean; postbuild `vector-cortex-publish-acceptance` → `published 6 acceptance + 6 eval + 5 replay + 3 migrations + 9 ledger + 6 resilience + 3 conformance files`.
- Acceptance, mandated command, both flag states:
  ```bash
  node --test dist/vector-cortex/vc1c-acceptance.test.js
  # → ℹ tests 31, ℹ pass 31, ℹ fail 0   (flag ON)
  MEGACOMPACT_VC1C=0 node --test dist/vector-cortex/vc1c-acceptance.test.js
  # → ℹ tests 31, ℹ pass 31, ℹ fail 0   (flag OFF: same 31 green — parity at the seam)
  ```
- Unit tests (each 0 fail): `dist/src/dedup/l1-minhash-v2.test.js` (8), `l1-lsh-v2.test.js` (6), `dist/src/vector-cortex/migrations/minhash-v2.test.js` (10), `conformance/manifest.test.js` (8), `conformance/downgrade.test.js` (3).
- `npm test` → full gate (see Evaluation: 0 failed).
- `npm run lint` → `tsc --noEmit` + `guardrails-scan` + `semantic-scan` all clean (`GUARDRAILS: pi pattern scan clean` / `semantic scan clean`).
- `python3 scripts/regression_check.py --all` → coverage of every `MEGACOMPACT_*` env var → `✓ All MEGACOMPACT_* env vars have dashboard settings entries`; 0 blocking vulns. (Pre-existing baseline note below.)
- `node scripts/vector-cortex-conformance.mjs --check` → `✓ CONFORMANCE: v2 manifest + 149 fixtures canonical (149 files).`
- `node scripts/vector-cortex-docs-check.mjs` → `✓ DOCS-CHECK: 27 sprints / 9 phases, links+flags+commands+migrations clean.`
- `node scripts/guardrails-scan.mjs` → `GUARDRAILS: pi pattern scan clean`.
- Network denial (this sprint runs VC1C runtime paths): `--modes=A` → `✓ NETWORK-DENIAL mode A: clean (roundtrip=21 breaker=OPEN_B vc1c=f51dc111)`; `--modes=B` → `✓ … mode B: clean (digest=… vc1c=60733c45)` (mode-B `vc1c=` digest matches `M4-HIGHBIT-001`'s signatureDigest prefix `60733c45`); `--modes=C` → `✓ … mode C: clean (no-op: zero event/spool writes, transcript codec unchanged)`. All exit 0.
- `scripts/vector-cortex-downgrade-export.mjs` → deterministic: two runs both report `256 seeds, copy c14fa79d47bc5770, digest 9dae67d3d09d9f01`; the report file is byte-identical across runs.
- `git diff --check` → clean (exit 0).

## Evaluation

All 31 acceptance tests pass in both flag states (0 failed each). MinHashV2 verified byte-exact against `M4-HIGHBIT-001`: the 2048-byte LE signature, its sha256 digest, and all 64 bucket keys match the committed fixture exactly under exact BigInt arithmetic (the fixture's `maxProduct` exceeds 2^110, which Number math would corrupt). Cross-version compare and bucket sharing are rejected (`M4-VERSION-002`, version-tagged keys never collide). M4 lifecycle verified through the real modules: full backfill/verify/switch (M4-001/008), idempotent repeat (M4-002), halt-before-switch keeps v1 (M4-003), partial/count/digest/version failure codes (M4-004..007), duplicate-content identity by checkpoint id (M4-DUP-001), interrupted-backfill resume without duplicates (M4-RESUME-003). Manifest validator verified on committed corpus (converges to one digest) and on temp roots with injected add/remove/drift mutations → `CONF_EXTRA_FIXTURE` / `CONF_MISSING_FIXTURE` / `CONF_DIGEST_DRIFT` / `CONF_NONCANONICAL`. DowngradeReport deterministic (CONF-DOWN-003) and read-only against authority. Full `npm test` gate: `TOTAL: 1544 passed, 0 failed across 199 files in 26.5s` (one pre-existing pool flake — `dist/src/store/sqlite/global-index.test.js` — passed its solo re-run with 6 pass/0 fail).

## Dashboard / API / config / SETTINGS evidence

- `MEGACOMPACT_VC1C` surfaced in the "Vector Cortex" SETTINGS group as a working `boolDirect` on/off toggle — NOT in `EXCLUDED_SETTINGS` (regression_check confirms every `MEGACOMPACT_*` var has a settings entry).
- Flag toggle round-trip verified in `routes-rag-settings.test.ts` ("VC1C flag round-trips through settings").
- No new dashboard API endpoint this sprint (manifest/migration/downgrade are local, engine-side; the observable surface is the emit seam).

## Offline / network / asset / platform evidence

Zero runtime network egress (PREVENT-PI-004): MinHashV2 is pure in-process BigInt compute; the manifest/downgrade/runner are pure FS reads/writes; no `fetch`/HTTP. No new third-party asset. `scripts/vector-cortex-network-denial.mjs` modes A/B/C confirm the VC1C runtime paths make no network calls (cleans pass under the network patch that fails any egress).

## File sizes and baseline exceptions

All new files within limits: l1-minhash-v2.ts 187, l1-lsh-v2.ts 86, migrations/minhash-v2.ts 197, conformance/manifest.ts 289, conformance/runner.ts 165, conformance/emit.ts 41, vc1c-acceptance.test.ts 600 (at the 600 test hard limit), l1-minhash-v2.test.ts 141, l1-lsh-v2.test.ts 75, migrations/minhash-v2.test.ts 167, conformance/manifest.test.ts 202, conformance/downgrade.test.ts 79, scripts/vector-cortex-downgrade-export.mjs 128, gen-fixtures/minhash.mjs 211, migrations.mjs 102, conformance.mjs 41. Pre-existing over-hard-limit `extensions/mega-events/context-handler.ts` remains a documented baseline exception (530 lines, UNTOUCHED this sprint — VC1C did not modify it).

## Rollback / downgrade rehearsal

`MEGACOMPACT_VC1C=0` → the VC1C emit seam emits zero events and the v1 sync dedup scan path is unchanged (byte-identical predecessor); the pure minhash/migration primitives remain functional (the test asserts the same exact signature with the flag off). Downgrade rehearsal: `vector-cortex-downgrade-export.mjs` writes a NEW legacy copy + deterministic report, never mutates authority (the committed corpus digest is read-only under validation/export) and a second run is byte-identical.

## Issues found during implementation

- **VC1C-I01 [type: robustness, state: fixed-in-this-sprint]**: `readFixtureManifestV2` eagerly hashed every listed fixture; a manifest entry with no on-disk file threw `ENOENT` part-way, so `validateCanonicalV2` could not reach its missing-check. Fixed: the per-file digest helper returns `""` for a missing file, letting the validator report `CONF_MISSING_FIXTURE` (verified by the temp-root remove/fixture tests).
- **VC1C-I02 [type: test, state: fixed-in-this-sprint]**: `memHost.putV2` initially deduped by checkpoint id, which hid the duplicate-row failure scenario (M4-006). Changed to append-without-dedup — backfill still avoids re-writing known ids via `storedV2`, preserving idempotency while letting duplicate/corrupt rows be injected for the failure cases.
- **VC1C-I03 [type: test, state: fixed-in-this-sprint]**: manifest unit tests initially wrote non-canonical (unsorted-key) temp manifests, which the strict validator correctly rejects. Fixed `tempRoot` to emit canonical key order; the "shuffled keys" test now verifies the READER normalizes arbitrary key order (not that the validator accepts a noncanonical manifest).
- **VC1C-I04 [type: conformance, state: fixed-in-this-sprint]**: reviewer S1 — the v2 runner dispatched by domain/version and rejected unknown domains without partial output but did not ITSELF cross-check a handler's returned success bytes / failure code against the manifest entry; the comparison lived in callers/handlers. Fixed: `runConformanceCase` now enforces the manifest entry's frozen expectation post-dispatch (expected failure code → `CONF_EXPECTATION_MISMATCH`; expected success bytes via the new `expectedOutputDigest` manifest field → `CONF_DIGEST_DRIFT`), with two acceptance tests guarding it. The minhash success fixture `M4-HIGHBIT-001` gained a manifest `outputDigest` (its canonical signature digest) so the runner can cross-check success bytes; all other corpus bytes are unchanged (verified by a semantic diff of manifest.json).

## Residual risks / carried-forward OPEN issues

- **Carried forward OPEN (VC1 family):** the writer/ledger producer hook-up and the toolCallId back-edge on the live path remain deferred to the VC1 producer-wiring sprint (unchanged from VC1B).
- MinHashV2 is shipped (algorithm + M4 migration + fixtures) but is NOT yet wired as the live L1 dedup path — the sync cosine/FTS scan remains authoritative; a later sprint wires the v2 index as the byte-exact dedup source. `MEGACOMPACT_VC1C` gates the observability seam.
- `vc1c-acceptance.test.ts` (600) exceeds the `tests/` 300-line SOFT limit — consistent single-file acceptance aggregator, AT the 600 HARD limit.

## Reviewer attestation

Not yet attested — pending independent reviewer.
