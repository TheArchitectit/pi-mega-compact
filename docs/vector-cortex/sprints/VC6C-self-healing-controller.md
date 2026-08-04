# VC6C — Self-healing derived controller

**Status:** planned | **Depends on:** VC6B | **Phase:** VC6
**Flag:** `MEGACOMPACT_VC6C`, defined in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_VC6C=0` disables and must be byte-identical to the predecessor. Add to dashboard `SETTINGS`, or record the immutable/security exclusion below.

## Goal and inputs/outputs

Consume only reviewer-accepted predecessor contracts and [common contracts](../CONTRACTS.md). Own **RepairPlanV1 / RepairEventV1**. Production ownership: `src/vector-cortex/heal/controller.ts`; `src/vector-cortex/heal/rebuild.ts`. Algorithm: Detect derived gaps vs durable high-water; rebuild copy, verify root digest, atomic pointer switch; max one rebuild/subsystem/5min and exponential backoff.

## Numbered implementation tasks

1. Define `RepairPlanV1` subsystem/range/generation/backoff and `RepairEventV1`; register `HEAL-031..045`.
2. Implement `controller.ts` gap detection by comparing each derived source high-water to durable authority high-water without writing authority.
3. Implement `rebuild.ts` into a new generation, verify root digest, then atomically switch pointer; failed verification deletes no evidence and keeps old pointer.
4. Rate-limit to one rebuild per subsystem per 5min and apply deterministic exponential backoff capped by TRIAD_RESILIENCE rules.
5. Emit `vector_cortex_repair_planned`, `vector_cortex_repair_pointer_switched`, and `vector_cortex_repair_backoff`; own health repair state plus audited admin rebuild endpoint.
6. After controller/rebuild/dashboard production gates pass, add fake-clock restart fixtures/tests, then evidence `VC6C.md`.

## Failure triad and independence

A targeted rebuild; B full deterministic rebuild; C disable derived state. Each uses independent algorithms/assets/indexes as applicable. C states its loss of old semantic context; authority outage freezes derived high-water. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/healing-controller/`.

- `HEAL-GAP-001: topology high-water 8 vs authority 10 plans range 9..10`.
- `HEAL-RATE-002: second rebuild inside 5min is suppressed`.
- `HEAL-SWITCH-003: verified root changes pointer exactly once`.

Exact test sources: `src/vector-cortex/heal/controller.test.ts`; `src/vector-cortex/heal/rebuild-chaos.test.ts`. Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc6c-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc6c-acceptance.test.js
```

Expected assertions: all `HEAL-031..045` conformance rows return their manifest bytes or exact listed failure code; generate subsystem frontiers, generations, and fake-clock schedules; invariant: authority is never mutated and successful pointer generations strictly increase. Unique failure injection: kill after new generation fsync but before pointer switch, then corrupt new root; restart retains prior generation. Forced triad: A=targeted subsystem rebuild; B=full deterministic rebuild forced by ambiguous gap; C=disable all derived state after both rebuild paths fail. Breaker recovery must follow the sprint triad contract. Exact flag-off comparison command: `MEGACOMPACT_VC6C=0 node --test dist/vector-cortex/vc6c-acceptance.test.js`; its outbound/predecessor golden bytes must match exactly. Acceptance: recover all injected derived corruptions without authority writes; no oscillation. Apply [EVALUATION](../EVALUATION.md) annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure—derived pointer generations only**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); exact ledger is not training data. Dashboard: health tab repair state; admin rebuild endpoint. Dashboard work must own `extensions/dashboard-server/api-contracts/vector-cortex.ts`, registration in `routes.ts`, handler `routes-vector-cortex.ts`, client `api/vector-cortex.ts`, `types/vector-cortex.ts`, `tabs/VectorCortexTab.tsx`, route/client/component tests, reader-only GET capability, and run `cd extensions/dashboard-client && npm run typecheck && npm run build`.

Rollback sets `MEGACOMPACT_VC6C=0`, selects C, restores the prior derived pointer without deleting evidence, and verifies predecessor golden bytes. Next handoff: VC7A receives stable range/digest and repair generation.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc6c-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, and `git diff --check`. asset/Rust/dashboard gates additionally apply when named by this sprint. No permissive globs or warning-only scans count.
