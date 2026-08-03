# VC3C — Topology query and router invalidation

**Status:** planned | **Depends on:** VC3B | **Phase:** VC3
**Flag:** `MEGACOMPACT_VC3C`, defined in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_VC3C=0` disables and must be byte-identical to the predecessor. Add to dashboard `SETTINGS`, or record the immutable/security exclusion below.

## Goal and inputs/outputs

Consume only reviewer-accepted predecessor contracts and [common contracts](../CONTRACTS.md). Own **TopologyQueryV1 / RouterKeyV2**. Production ownership: `src/vector-cortex/topology/query.ts; src/vector-cortex/migrations/router-generation-v2.ts; src/tieredRouter.ts delegate`. Algorithm: Structured key includes session, source range, generation, algorithm; invalidate exact session generations, never string-prefix ambiguity.

## Numbered implementation tasks

1. Define `TopologyQueryV1` and structured `RouterKeyV2` fields `session`, `sourceStart`, `sourceEnd`, `generation`, `algorithm`; register `TOP-021..030`, `M6-001..012`.
2. Implement `query.ts` key encoding with length-delimited fields and unsigned-byte ordering; never concatenate ambiguous prefixes.
3. Implement invalidation by exact `(session,generation)` match and ensure query rejects stale generation with `TOP_GENERATION_STALE`.
4. Implement M6 copy/validate/switch, comparing old/new query sets before atomic pointer update, then delegate narrowly from `src/tieredRouter.ts`.
5. Emit `vector_cortex_router_generation_invalidated` and `vector_cortex_topology_query_demoted`; expose reader-only query diagnostic counts in the stated dashboard route.
6. After query/migration/delegate production gates pass, add 100k-operation and fixtures tests, then evidence `VC3C.md`.

## Failure triad and independence

A topology index; B fresh linear scan; C authority sequence scan. Each uses independent algorithms/assets/indexes as applicable. C states its loss of old semantic context; authority outage freezes derived high-water. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/topology-query/`.

- `M6-KEY-001: sessions a and aa cannot prefix-collide`.
- `M6-STALE-002: old generation misses immediately after switch`.
- `TOP-QUERY-003: equal scores return target-ID byte order`.

Exact test sources: `src/vector-cortex/topology/query.test.ts; src/vector-cortex/migrations/router-generation-v2.test.ts`. Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc3c-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc3c-acceptance.test.js
```

Expected assertions: all `TOP-021..030,M6-001..012` conformance rows return their manifest bytes or exact listed failure code; generate session byte strings, ranges, generations, and invalidate/query operations; invariant: a hit always matches every structured key field. Unique failure injection: crash after M6 validation and concurrently invalidate another session; restart switches once without cross-session eviction. Forced triad: A=topology index at current generation; B=fresh linear scan forced by stale A key; C=authority sequence scan forced when derived store unavailable. Breaker recovery must follow the sprint triad contract. Exact flag-off comparison command: `MEGACOMPACT_VC3C=0 node --test dist/vector-cortex/vc3c-acceptance.test.js`; its outbound/predecessor golden bytes must match exactly. Acceptance: zero stale results after 100k generation/invalidation operations. Apply [EVALUATION](../EVALUATION.md) annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **M6 router-generation-v2 copy/validate/switch**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); exact ledger is not training data. Dashboard: GET topology query diagnostics; reader-only. Dashboard work must own `extensions/dashboard-server/api-contracts/vector-cortex.ts`, registration in `routes.ts`, handler `routes-vector-cortex.ts`, client `api/vector-cortex.ts`, `types/vector-cortex.ts`, `tabs/VectorCortexTab.tsx`, route/client/component tests, reader-only GET capability, and run `cd extensions/dashboard-client && npm run typecheck && npm run build`.

Rollback sets `MEGACOMPACT_VC3C=0`, selects C, restores the prior derived pointer without deleting evidence, and verifies predecessor golden bytes. Next handoff: VC4A receives validated query result and dependency edges.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc3c-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, and `git diff --check`. Sprints that add or alter any runtime path also run `node scripts/vector-cortex-network-denial.mjs --modes=A,B,C`; asset/Rust/dashboard gates additionally apply when named by this sprint. No permissive globs or warning-only scans count.
