# VC1C — Cross-language conformance v2

**Status:** done | **Depends on:** VC1B | **Phase:** VC1
**Flag:** `MEGACOMPACT_VC1C`, defined in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_VC1C=0` disables and must be byte-identical to the predecessor. Add to dashboard `SETTINGS`, or record the immutable/security exclusion below.

## Goal and inputs/outputs

Consume only reviewer-accepted predecessor contracts and [common contracts](../CONTRACTS.md). Own **FixtureManifestV2 / DowngradeReport / MinHashV2**. Production ownership: `src/vector-cortex/conformance/{manifest,runner}.ts; src/dedup/{l1-minhash-v2,l1-lsh-v2}.ts; src/vector-cortex/migrations/minhash-v2.ts; scripts/vector-cortex-{conformance,downgrade-export}.mjs`. Algorithm: canonical JSON rules; manifest rejects extra/missing/drift; exporter writes a new legacy copy; M4 uses exact unsigned 64-bit modular arithmetic, frozen shingle/seed/signature/band versions, and never compares v1/v2 signatures.

## Numbered implementation tasks

1. Define `FixtureManifestV2` entries `id`, `domain`, `inputDigest`, `expectedDigest`, `failureCode`, `algorithmTuple` and `DowngradeReport`; include every EVT/M2/M3/M4 and `MIG-DOWN-001` case.
2. Freeze MinHashV2 normalization, 5-code-point shingles, 256 published unsigned seed pairs, `p=2^61-1`, exact `BigInt` multiply/modulo, 256×u64 little-endian signature bytes, and 64 bands of four values; publish the seed table in `conformance/vector-cortex/v2/minhash/seeds-v2.json`.
3. Implement `l1-minhash-v2.ts`/`l1-lsh-v2.ts` and `minhash-v2.ts`: write versioned signatures/buckets beside v1, batch/backfill by checkpoint ID, verify counts/digests, switch the active version, and reject cross-version compare with `MINHASH_VERSION_MISMATCH`.
4. Implement `manifest.ts` canonical key ordering and reject extra, missing, or digest-drifted fixture files as `CONF_EXTRA_FIXTURE`, `CONF_MISSING_FIXTURE`, or `CONF_DIGEST_DRIFT`.
5. Implement `runner.ts` to dispatch strictly by domain/version and compare both success bytes and expected failure code; implement conformance/downgrade scripts so a second run is byte-identical and exporter never edits authority data.
6. Emit `vector_cortex_minhash_v2_backfilled`, `vector_cortex_conformance_case_checked`, and `vector_cortex_downgrade_copy_written`; no dashboard or API change is necessary.
7. After M4/runner/exporter production gates pass, add MinHash/manifest/downgrade tests and packaged fixtures, interruption/resume evidence, then evidence `VC1C.md` and exact flag-off run.

## Failure triad and independence

A v2 runner; B exact fixture reader; C reject unknown. Each uses independent algorithms/assets/indexes as applicable. C states its loss of old semantic context; authority outage freezes derived high-water. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture roots: `conformance/vector-cortex/v2/conformance/`, `conformance/vector-cortex/v2/minhash/`, and `conformance/vector-cortex/v2/migrations/`.

- `CONF-MANIFEST-001: listed event fixture digest matches canonical bytes`.
- `CONF-EXTRA-002: unlisted file fails with CONF_EXTRA_FIXTURE`.
- `CONF-DOWN-003: repeated downgrade export has identical report digest`.
- `M4-HIGHBIT-001: products above 2^53 match published exact u64 signature and all 64 bucket bytes`.
- `M4-VERSION-002: v1-v2 comparison fails with MINHASH_VERSION_MISMATCH`.
- `M4-RESUME-003: interrupted backfill resumes without duplicate signatures or active-pointer drift`.

Exact test sources: `src/dedup/l1-minhash-v2.test.ts`; `src/dedup/l1-lsh-v2.test.ts`; `src/vector-cortex/migrations/minhash-v2.test.ts`; `src/vector-cortex/conformance/manifest.test.ts`; `src/vector-cortex/conformance/downgrade.test.ts`. Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc1c-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc1c-acceptance.test.js
```

Expected assertions: all EVT/M2/M3/M4 and `MIG-DOWN-001` rows return manifest bytes or the exact listed failure code; MinHashV2 vectors match every signature/band byte under exact arithmetic, mixed versions never compare/share buckets, and interruption leaves v1 active until verified switch; generate manifests with shuffled keys and one injected add/remove/drift mutation; invariant: canonical valid manifests converge to one digest. Unique failure injection: remove a fixture after manifest load but before execution; runner fails closed with `CONF_MISSING_FIXTURE`. Forced triad: A=v2 manifest runner; B=independent exact fixture reader; C=reject every unknown version without partial output. Breaker recovery must follow the sprint triad contract. Exact flag-off comparison command: `MEGACOMPACT_VC1C=0 node --test dist/vector-cortex/vc1c-acceptance.test.js`; its outbound/predecessor golden bytes must match exactly. Acceptance: TS consumes 100% listed fixtures; second migration/export byte-identical. Apply [EVALUATION](../EVALUATION.md) annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **M4 minhash-v2; finalize M2/M3 and downgrade exporter**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); exact ledger is not training data. Dashboard: none. No dashboard or API change is necessary for this internal sprint.

Rollback sets `MEGACOMPACT_VC1C=0`, selects C, restores the prior derived pointer without deleting evidence, and verifies predecessor golden bytes. Next handoff: VC2A receives neutral manifest and packaged fixture policy.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc1c-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, and `git diff --check`. asset/Rust/dashboard gates additionally apply when named by this sprint. No permissive globs or warning-only scans count.
