# VC1B — Occurrence ledger and tool identity

**Status:** planned | **Depends on:** VC1A | **Phase:** VC1
**Flag:** `MEGACOMPACT_VC1B`, defined in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_VC1B=0` disables and must be byte-identical to the predecessor. Add to dashboard `SETTINGS`, or record the immutable/security exclusion below.

## Goal and inputs/outputs

Consume only reviewer-accepted predecessor contracts and [common contracts](../CONTRACTS.md). Own **LedgerReader/Writer/Admin / CompatJournalV1**. Production ownership: `src/vector-cortex/ledger/{store,sqlite,compat-journal}.ts; src/vector-cortex/migrations/occurrence-v2.ts`. Algorithm: Append every occurrence; monotonic seq; tool result references one earlier call; atomic compatibility journal; duplicates by eventId+digest only.

## Numbered implementation tasks

1. Define capability-separated `LedgerReader`, `LedgerWriter`, `LedgerAdmin` and `CompatJournalV1`; register `EVT-016..030`, `M2-001..015`, `MIG-DOWN-001`.
2. Create occurrence-v2 rows with `session`, `seq`, `event_id`, `digest`, `kind`, `tool_call_id`, `source_bytes`; enforce uniqueness only on `(event_id,digest)`.
3. Implement append so seq is monotonic per session and each tool result names exactly one earlier call; return `EVT_TOOL_CALL_MISSING` or `EVT_SEQ_REGRESSION`.
4. Implement `compat-journal.ts` prepare/copied/validated/switched records atomically and make downgrade export create a new legacy copy with unrepresentable rows listed.
5. Wire only writer capability to ingestion and reader capability to `GET /api/vector-cortex/ledger`; emit `vector_cortex_occurrence_appended` and `vector_cortex_compat_switch_committed`.
6. After schema/store/export production gates pass, add SQLite and old-binary fixtures/tests, then evidence `VC1B.md` and rollback rehearsal.

## Failure triad and independence

A SQLite append; B fsync spool; C transcript, derived frozen. Each uses independent algorithms/assets/indexes as applicable. C states its loss of old semantic context; authority outage freezes derived high-water. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/ledger/`.

- `M2-DUP-001: same bytes at two seq values creates two occurrences`.
- `M2-TOOL-002: result references earlier call c9 exactly once`.
- `MIG-DOWN-003: invalid UTF-8 row is listed unrepresentable in legacy copy`.

Exact test sources: `src/vector-cortex/ledger/sqlite.test.ts`; `src/vector-cortex/ledger/compat-journal.test.ts`. Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc1b-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc1b-acceptance.test.js
```

Expected assertions: all `EVT-016..030,M2-001..015,MIG-DOWN-001` conformance rows return their manifest bytes or exact listed failure code; generate append streams with duplicate contents and balanced tool IDs; invariant: read count/order/digests equal accepted source occurrences. Unique failure injection: terminate after journal state `validated` and before `switched`; restart switches once without duplicate rows. Forced triad: A=SQLite occurrence append; B=fsync spool replay into a fresh reader; C=host transcript while derived frontier is frozen. Breaker recovery must follow the sprint triad contract. Exact flag-off comparison command: `MEGACOMPACT_VC1B=0 node --test dist/vector-cortex/vc1b-acceptance.test.js`; its outbound/predecessor golden bytes must match exactly. Acceptance: counts/order/digests equal source; old-binary export test passes. Apply [EVALUATION](../EVALUATION.md) annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **M2 occurrence-v2 plus compatibility journal**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); exact ledger is not training data. Dashboard: GET /api/vector-cortex/ledger uses reader only. Dashboard work must own `extensions/dashboard-server/api-contracts/vector-cortex.ts`, registration in `routes.ts`, handler `routes-vector-cortex.ts`, client `api/vector-cortex.ts`, `types/vector-cortex.ts`, `tabs/VectorCortexTab.tsx`, route/client/component tests, reader-only GET capability, and run `cd extensions/dashboard-client && npm run typecheck && npm run build`.

Rollback sets `MEGACOMPACT_VC1B=0`, selects C, restores the prior derived pointer without deleting evidence, and verifies predecessor golden bytes. Next handoff: VC1C receives durable high-water and journal exporter seam.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc1b-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, and `git diff --check`. Sprints that add or alter any runtime path also run `node scripts/vector-cortex-network-denial.mjs --modes=A,B,C`; asset/Rust/dashboard gates additionally apply when named by this sprint. No permissive globs or warning-only scans count.
