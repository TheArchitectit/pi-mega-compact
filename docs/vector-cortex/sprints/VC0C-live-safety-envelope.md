# VC0C — Live safety envelope

**Status:** planned | **Depends on:** VC0B | **Phase:** VC0
**Flag:** `MEGACOMPACT_VC0C`, defined in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_VC0C=0` disables and must be byte-identical to the predecessor. Add to dashboard `SETTINGS`, or record the immutable/security exclusion below.

## Goal and inputs/outputs

Consume only reviewer-accepted predecessor contracts and [common contracts](../CONTRACTS.md). Own **TriadResult / BreakerRecord / KillDecision**. Production ownership: `src/vector-cortex/resilience/{types,breaker,spool}.ts; extensions/mega-runtime/vector-cortex-safety.ts`. Algorithm: Use normative 60s/20-attempt breaker, 30s exponential cooldown, N=3 probes, 5min healthy residence; freeze frontier on outage.

## Numbered implementation tasks

1. Define `TriadResult`, `BreakerRecord`, and `KillDecision` with mode, window start, attempts, failures, cooldown, probe count, and frozen frontier; register `TRI-001..030`.
2. Implement `breaker.ts` with a 60s/20-attempt window, 30s exponential cooldown, exactly 3 recovery probes, and 5min healthy residence before promotion.
3. Implement `spool.ts` as append/fsync/ack records keyed by session and seq; restart must replay only unacknowledged records and freeze the authority frontier.
4. Implement `vector-cortex-safety.ts` to select A, then independent B, then unchanged C before provider invocation; manual reset clears cooldown but never evidence.
5. Emit `vector_cortex_breaker_opened`, `vector_cortex_probe_promoted`, and `vector_cortex_frontier_frozen`; own the stated health/reset API and VectorCortexTab shell with reader GET plus audited admin reset.
6. After production and dashboard typecheck/build pass, add fake-clock and restart tests, fixtures, evidence `VC0C.md`, then verify exact flag-off bytes.

## Failure triad and independence

A common breaker; B spool/deterministic; C unchanged transcript. Each uses independent algorithms/assets/indexes as applicable. C states its loss of old semantic context; authority outage freezes derived high-water. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/resilience/`.

- `TRI-WINDOW-001: twentieth failed attempt inside 60s opens breaker`.
- `TRI-PROBE-002: three successful probes enter healthy residence`.
- `TRI-FREEZE-003: authority outage preserves prior frontier`.

Exact test sources: `src/vector-cortex/resilience/breaker.test.ts`; `src/vector-cortex/resilience/spool.test.ts`. Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc0c-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc0c-acceptance.test.js
```

Expected assertions: all `TRI-001..030` conformance rows return their manifest bytes or exact listed failure code; generate timestamped success/failure traces; invariant: promotion never precedes cooldown, 3 probes, and 5min residence. Unique failure injection: kill between spool fsync and ack, skew wall clock backward 90s, then restart from monotonic elapsed time. Forced triad: A=common breaker path healthy; B=spool replay forced by A exception; C=both A and B unavailable before provider call. Breaker recovery must follow the sprint triad contract. Exact flag-off comparison command: `MEGACOMPACT_VC0C=0 node --test dist/vector-cortex/vc0c-acceptance.test.js`; its outbound/predecessor golden bytes must match exactly. Acceptance: correctness demotion before provider invocation in 100% chaos cases. Apply [EVALUATION](../EVALUATION.md) annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure—no migration**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); exact ledger is not training data. Dashboard: health/reset API contract, routes and VectorCortexTab shell. Dashboard work must own `extensions/dashboard-server/api-contracts/vector-cortex.ts`, registration in `routes.ts`, handler `routes-vector-cortex.ts`, client `api/vector-cortex.ts`, `types/vector-cortex.ts`, `tabs/VectorCortexTab.tsx`, route/client/component tests, reader-only GET capability, and run `cd extensions/dashboard-client && npm run typecheck && npm run build`.

Rollback sets `MEGACOMPACT_VC0C=0`, selects C, restores the prior derived pointer without deleting evidence, and verifies predecessor golden bytes. Next handoff: VC1A receives enforced triad and authority high-water.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc0c-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, and `git diff --check`. Sprints that add or alter any runtime path also run `node scripts/vector-cortex-network-denial.mjs --modes=A,B,C`; asset/Rust/dashboard gates additionally apply when named by this sprint. No permissive globs or warning-only scans count.
