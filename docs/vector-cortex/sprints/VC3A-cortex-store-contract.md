# VC3A — Capability-gated cortex store

**Status:** next | **Depends on:** VC2C | **Phase:** VC3
**Flag:** `MEGACOMPACT_VC3A`, defined in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_VC3A=0` disables and must be byte-identical to the predecessor. Add to dashboard `SETTINGS`, or record the immutable/security exclusion below.

## Goal and inputs/outputs

Consume only reviewer-accepted predecessor contracts and [common contracts](../CONTRACTS.md). Own **CortexReader/Writer/Admin / CortexRecordV1**. Production ownership: `src/vector-cortex/cortex/types.ts`; `src/vector-cortex/cortex/store.ts`; `src/vector-cortex/cortex/sqlite.ts`. Algorithm: Append derived records keyed `(sourceHighWater,algorithmVersion,id)`; writer cannot query/admin; no callbacks; writes nonfatal.

## Numbered implementation tasks

1. Define `CortexReader`, `CortexWriter`, `CortexAdmin`, and `CortexRecordV1` fields `sourceHighWater`, `algorithmVersion`, `id`, `kind`, `payloadDigest`; register `CTX-001..010`.
2. Implement `store.ts` capability views so writer exposes append only, reader exposes query only, and admin alone can rebuild/switch generations.
3. Implement `sqlite.ts` additive schema keyed `(source_high_water,algorithm_version,id)` with parameterized inserts and immutable derived records.
4. Make writes nonfatal and callbacks/subscriptions impossible; deterministic rebuild sorts keys and computes one root digest.
5. Emit `vector_cortex_record_append_failed` and `vector_cortex_generation_rebuilt`; expose topology summary through the stated reader-only GET without writer/admin leakage.
6. After types/store/sqlite production gates pass, add runtime and negative compile capability tests plus fixtures, then evidence `VC3A.md`.

## Failure triad and independence

A indexed store; B in-memory scan records; C ledger sequence scan. Each uses independent algorithms/assets/indexes as applicable. C states its loss of old semantic context; authority outage freezes derived high-water. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/cortex-store/`.

- `CTX-CAP-001: writer has no query or admin member`.
- `CTX-KEY-002: same id at different algorithm versions remains distinct`.
- `CTX-REBUILD-003: shuffled inserts yield identical root digest`.

Exact test sources: `src/vector-cortex/cortex/contract.test.ts`; `src/vector-cortex/cortex/sqlite.test.ts`. Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc3a-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc3a-acceptance.test.js
```

Expected assertions: all `CTX-001..010` conformance rows return their manifest bytes or exact listed failure code; generate records with shuffled insertion orders and repeated composite keys; invariant: accepted unique set and rebuild digest are order-independent. Unique failure injection: inject SQLITE_FULL on append then rebuild from authority; host continues and emits `vector_cortex_record_append_failed`. Forced triad: A=indexed SQLite reader; B=in-memory records rebuilt from accepted inputs; C=authority ledger sequence scan with no cortex store. Breaker recovery must follow the sprint triad contract. Exact flag-off comparison command: `MEGACOMPACT_VC3A=0 node --test dist/vector-cortex/vc3a-acceptance.test.js`; its outbound/predecessor golden bytes must match exactly. Acceptance: capability negative compile fixtures and rebuild digest equality. Apply [EVALUATION](../EVALUATION.md) annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure—new additive derived store, no authority migration**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); exact ledger is not training data. Dashboard: GET /api/vector-cortex/topology reader only. Dashboard work must own `extensions/dashboard-server/api-contracts/vector-cortex.ts`, registration in `routes.ts`, handler `routes-vector-cortex.ts`, client `api/vector-cortex.ts`, `types/vector-cortex.ts`, `tabs/VectorCortexTab.tsx`, route/client/component tests, reader-only GET capability, and run `cd extensions/dashboard-client && npm run typecheck && npm run build`.

Rollback sets `MEGACOMPACT_VC3A=0`, selects C, restores the prior derived pointer without deleting evidence, and verifies predecessor golden bytes. Next handoff: VC3B receives store factory and immutable VectorSet rows.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc3a-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, and `git diff --check`. Sprints that add or alter any runtime path also run `node scripts/vector-cortex-network-denial.mjs --modes=A,B,C`; asset/Rust/dashboard gates additionally apply when named by this sprint. No permissive globs or warning-only scans count.
