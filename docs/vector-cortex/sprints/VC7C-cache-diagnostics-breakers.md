# VC7C — Cache diagnostics, M5 switch and breakers

**Status:** planned | **Depends on:** VC7B | **Phase:** VC7
**Flag:** `MEGACOMPACT_VC7C`, defined in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_VC7C=0` disables and must be byte-identical to the predecessor. Add to dashboard `SETTINGS`, or record the immutable/security exclusion below.

## Goal and inputs/outputs

Consume only reviewer-accepted predecessor contracts and [common contracts](../CONTRACTS.md). Own **CacheDiagnosticV1 / RequestHashV2**. Production ownership: `src/vector-cortex/cache/{diagnostics,breaker}.ts; src/vector-cortex/migrations/request-hash-v2.ts`. Algorithm: Classify profile/range/dependency/request/generation misses; switch M5 only after zero collisions; consume M6 structured invalidation.

## Numbered implementation tasks

1. Define `CacheDiagnosticV1` miss class/evidence and `RequestHashV2` full-request/profile/generation fields; register `CACHE-016..030`, `M5-001..020`.
2. Implement `diagnostics.ts` exclusive classification order: profile, range, dependency, request, generation, then unknown; retain no request payload.
3. Implement `breaker.ts` to demote before cache serve on collision, stale generation, digest failure, or profile mismatch.
4. Complete M5 copy/validate comparing v1/v2 rows, require zero collisions, atomically switch, and consume structured M6 invalidation keys.
5. Emit `vector_cortex_cache_miss_classified` and `vector_cortex_cache_serve_blocked`; own diagnostic API/client tests and breaker cards.
6. After diagnostics/breaker/M5/dashboard production gates pass, add poison/restart fixtures/tests, then evidence `VC7C.md`.

## Failure triad and independence

A crystals; B fresh render; C all-cache bypass. Each uses independent algorithms/assets/indexes as applicable. C states its loss of old semantic context; authority outage freezes derived high-water. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/cache-diagnostics/`.

- `CACHE-MISS-001: profile digest mismatch classifies profile only`.
- `M5-COLLIDE-002: two v1 rows mapping to one v2 hash block switch`.
- `CACHE-STALE-003: invalidated M6 generation cannot serve crystal`.

Exact test sources: `src/vector-cortex/cache/{diagnostics,breaker-chaos}.test.ts; src/vector-cortex/migrations/request-hash-v2.test.ts`. Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc7c-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc7c-acceptance.test.js
```

Expected assertions: all `CACHE-016..030,M5-001..020` conformance rows return their manifest bytes or exact listed failure code; generate request/profile/range/dependency/generation mutations one field at a time; invariant: exactly one deterministic miss class and no stale hit. Unique failure injection: crash after M5 validation then inject a collision before switch; resumed validation detects `M5_REQUEST_HASH_COLLISION`. Forced triad: A=crystal cache serve; B=fresh render forced by any breaker condition; C=all-cache bypass forced when render/cache diagnostics disagree. Breaker recovery must follow the sprint triad contract. Exact flag-off comparison command: `MEGACOMPACT_VC7C=0 node --test dist/vector-cortex/vc7c-acceptance.test.js`; its outbound/predecessor golden bytes must match exactly. Acceptance: poison corpus zero collisions/stale hits; demotion before cache serve. Apply [EVALUATION](../EVALUATION.md) annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **M5 request-hash-v2 validate/switch; M6 consumption only**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); exact ledger is not training data. Dashboard: cache diagnostic API, route/client tests and breaker cards. Dashboard work must own `extensions/dashboard-server/api-contracts/vector-cortex.ts`, registration in `routes.ts`, handler `routes-vector-cortex.ts`, client `api/vector-cortex.ts`, `types/vector-cortex.ts`, `tabs/VectorCortexTab.tsx`, route/client/component tests, reader-only GET capability, and run `cd extensions/dashboard-client && npm run typecheck && npm run build`.

Rollback sets `MEGACOMPACT_VC7C=0`, selects C, restores the prior derived pointer without deleting evidence, and verifies predecessor golden bytes. Next handoff: VC8A receives causal outcome fields and stable diagnostics.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc7c-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, and `git diff --check`. Sprints that add or alter any runtime path also run `node scripts/vector-cortex-network-denial.mjs --modes=A,B,C`; asset/Rust/dashboard gates additionally apply when named by this sprint. No permissive globs or warning-only scans count.
