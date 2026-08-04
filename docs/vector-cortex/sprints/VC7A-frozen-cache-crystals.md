# VC7A — Frozen range crystals

**Status:** planned | **Depends on:** VC6C | **Phase:** VC7
**Flag:** `MEGACOMPACT_VC7A`, defined in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_VC7A=0` disables and must be byte-identical to the predecessor. Add to dashboard `SETTINGS`, or record the immutable/security exclusion below.

## Goal and inputs/outputs

Consume only reviewer-accepted predecessor contracts and [common contracts](../CONTRACTS.md). Own **CrystalV1 / CrystalKeyV1**. Production ownership: `src/vector-cortex/cache/types.ts`; `src/vector-cortex/cache/crystal.ts`; `src/vector-cortex/cache/store.ts`. Algorithm: Immutable key uses covered ranges/digest+validated dependency high-water+renderer/profile; never global frontier; content-addressed write once.

## Numbered implementation tasks

1. Define `CrystalV1` immutable bytes/manifest and `CrystalKeyV1` covered ranges/digest/dependency high-water/renderer/profile; register `PRO-016..023`, `CRY-001..015`.
2. Implement `crystal.ts` canonical key encoding from only covered ranges, their digest, validated dependency high-water, renderer version, and profile digest.
3. Exclude global frontier from identity; sort ranges by source start and reject overlap as `CRY_RANGE_OVERLAP`.
4. Implement `store.ts` content-addressed write-once semantics; an existing key with different bytes returns `CRY_KEY_COLLISION` and is never overwritten.
5. Emit `vector_cortex_crystal_written` and `vector_cortex_crystal_collision`; expose reader-only cache-crystal counts/hit bytes at the stated GET.
6. After crystal/store production and dashboard gates pass, add key/invalidation fixtures/tests, then evidence `VC7A.md`.

## Failure triad and independence

A crystal store; B fresh deterministic render; C bypass cache. Each uses independent algorithms/assets/indexes as applicable. C states its loss of old semantic context; authority outage freezes derived high-water. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/cache-crystals/`.

- `CRY-FRONTIER-001: unrelated append leaves key unchanged`.
- `CRY-COVERED-002: one covered byte change invalidates key`.
- `CRY-DEP-003: dependency high-water advance invalidates key`.

Exact test sources: `src/vector-cortex/cache/crystal.test.ts`; `src/vector-cortex/cache/store.test.ts`. Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc7a-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc7a-acceptance.test.js
```

Expected assertions: all `PRO-016..023,CRY-001..015` conformance rows return their manifest bytes or exact listed failure code; generate disjoint ranges, digests, profiles, and unrelated frontier values; invariant: key changes iff an identity field changes. Unique failure injection: interrupt content-addressed temp write before rename; restart ignores temp file and fresh write produces one valid crystal. Forced triad: A=crystal store hit; B=fresh deterministic render forced by miss/collision; C=cache bypass forced by store unavailability. Breaker recovery must follow the sprint triad contract. Exact flag-off comparison command: `MEGACOMPACT_VC7A=0 node --test dist/vector-cortex/vc7a-acceptance.test.js`; its outbound/predecessor golden bytes must match exactly. Acceptance: unrelated frontier append preserves key; covered/dependency change invalidates 100%. Apply [EVALUATION](../EVALUATION.md) annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure—new derived cache**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); exact ledger is not training data. Dashboard: GET /api/vector-cortex/cache-crystals reader summary. Dashboard work must own `extensions/dashboard-server/api-contracts/vector-cortex.ts`, registration in `routes.ts`, handler `routes-vector-cortex.ts`, client `api/vector-cortex.ts`, `types/vector-cortex.ts`, `tabs/VectorCortexTab.tsx`, route/client/component tests, reader-only GET capability, and run `cd extensions/dashboard-client && npm run typecheck && npm run build`.

Rollback sets `MEGACOMPACT_VC7A=0`, selects C, restores the prior derived pointer without deleting evidence, and verifies predecessor golden bytes. Next handoff: VC7B receives immutable crystal/key and request digest.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc7a-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, and `git diff --check`. asset/Rust/dashboard gates additionally apply when named by this sprint. No permissive globs or warning-only scans count.
