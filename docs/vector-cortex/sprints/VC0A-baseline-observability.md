# VC0A — Baseline observability

**Status:** planned | **Depends on:** none | **Phase:** VC0
**Flag:** `MEGACOMPACT_VC0A`, defined in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_VC0A=0` disables and must be byte-identical to the predecessor. Add to dashboard `SETTINGS`, or record the immutable/security exclusion below.

## Goal and inputs/outputs

Consume only reviewer-accepted predecessor contracts and [common contracts](../CONTRACTS.md). Own **MetricEventV1 / AnnotationV1**. Production ownership: `src/vector-cortex/eval/{types,metrics,annotations}.ts; scripts/vector-cortex-evaluate.mjs`. Algorithm: Canonical JSONL metric order `(session,seq,event)`; fixed histogram buckets 1/5/10/25/50/100/250ms; redact payloads.

## Numbered implementation tasks

1. Define `MetricEventV1` fields `session`, `seq`, `event`, `value`, `unit`, `mode` and `AnnotationV1` redaction metadata in `eval/types.ts`; register `EVAL-001..010` before logic.
2. Implement `metrics.ts` to order rows by `(session,seq,event)` and bucket latency at exactly `1/5/10/25/50/100/250ms`, with overflow kept separate.
3. Implement `annotations.ts` so payload bytes, prompts, and exact ledger text are replaced by digest/count metadata before JSONL serialization.
4. Implement `scripts/vector-cortex-evaluate.mjs` to stream canonical JSONL and reject non-monotonic sequence or unknown units with `EVAL_ORDER_INVALID`/`EVAL_UNIT_UNKNOWN`.
5. Connect the observer to the evaluation reader and emit `vector_cortex_eval_sample_recorded` and `vector_cortex_eval_redaction_rejected`; expose only aggregate `GET /api/vector-cortex/evaluation` through the stated reader-only dashboard files.
6. After production gates pass, add the exact tests and fixtures below, then write `docs/vector-cortex/evidence/VC0A.md` and rehearse flag-off rollback.

## Failure triad and independence

A structured observer; B counters; C no observer. Each uses independent algorithms/assets/indexes as applicable. C states its loss of old semantic context; authority outage freezes derived high-water. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/evaluation/`.

- `EVAL-BUCKET-001: values at 1ms and 250ms land on inclusive boundaries`.
- `EVAL-REDACT-002: prompt bytes never appear in JSONL`.
- `EVAL-ORDER-003: equal seq rows use event-name order`.

Exact test sources: `src/vector-cortex/eval/metrics.test.ts`; `src/vector-cortex/eval/annotations.test.ts`. Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc0a-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc0a-acceptance.test.js
```

Expected assertions: all `EVAL-001..010` conformance rows return their manifest bytes or exact listed failure code; generate sessions, monotonic seqs, finite latencies; invariant: canonical JSONL and histogram totals are permutation-stable. Unique failure injection: truncate the final JSONL record during observer restart; reject only that record as `EVAL_JSONL_TRUNCATED`. Forced triad: A=structured observer enabled; B=counters-only observer with payload access denied; C=observer absent and zero evaluation writes. Breaker recovery must follow the sprint triad contract. Exact flag-off comparison command: `MEGACOMPACT_VC0A=0 node --test dist/vector-cortex/vc0a-acceptance.test.js`; its outbound/predecessor golden bytes must match exactly. Acceptance: 100% metric schema validity; observer overhead p95 <=2ms. Apply [EVALUATION](../EVALUATION.md) annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure—no migration**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); exact ledger is not training data. Dashboard: GET /api/vector-cortex/evaluation summary. Dashboard work must own `extensions/dashboard-server/api-contracts/vector-cortex.ts`, registration in `routes.ts`, handler `routes-vector-cortex.ts`, client `api/vector-cortex.ts`, `types/vector-cortex.ts`, `tabs/VectorCortexTab.tsx`, route/client/component tests, reader-only GET capability, and run `cd extensions/dashboard-client && npm run typecheck && npm run build`.

Rollback sets `MEGACOMPACT_VC0A=0`, selects C, restores the prior derived pointer without deleting evidence, and verifies predecessor golden bytes. Next handoff: VC0B receives frozen corpus digest and metric API.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc0a-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, and `git diff --check`. Sprints that add or alter any runtime path also run `node scripts/vector-cortex-network-denial.mjs --modes=A,B,C`; asset/Rust/dashboard gates additionally apply when named by this sprint. No permissive globs or warning-only scans count.
