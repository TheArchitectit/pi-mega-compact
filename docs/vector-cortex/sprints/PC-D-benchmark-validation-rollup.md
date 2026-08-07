# PC-D — Benchmark validation + conformance roll-up

**Status:** shipped | **Originally planned:** PC-D | **Phase:** PC
**Shipped:** v0.20.34
**Flag:** none (roll-up sprint — no new flag; validates the PC-A/PC-B/PC-C flags' cumulative effect)

## Goal and inputs/outputs

**Roll-up sprint.** (1) Run controlled benchmark sessions comparing prompt-cache hit rates across three flag states: both OFF (pre-PC baseline), messageSeparation ON only (PC-A state), both ON (PC-A+PC-B state). Measure `providerCachePct` from perf samples. (2) Document measured improvement vs the PLAN_V2 projections (60%→85% same-topic, 55%→82% new-tools, 30%→70% after re-compact). (3) Conformance roll-up: register the reserved fixture range `PC-001..019`; add final fixtures covering the benchmark methodology and evidence requirements. (4) Restate remaining work (if any) as permanent record.

Production ownership: `scripts/pc-prompt-cache/bench-hit-rate.mjs (new — controlled benchmark runner); scripts/pc-prompt-cache/gen-fixtures-pcd.mjs (new generator); conformance/vector-cortex/v2/prompt-cache/PC-016.json..019.json (new); conformance/vector-cortex/v2/manifest.json (additive — reserved range PC-001..019 fully documented); src/vector-cortex/pcd-acceptance.test.ts (new); scripts/vector-cortex-docs-check.mjs (EXPECTED_SPRINTS 36→37); docs/vector-cortex/sprints/PC-D-benchmark-validation-rollup.md (this spec); docs/vector-cortex/evidence/PC-D.md (new roll-up)`.

Algorithm: the benchmark runner (`bench-hit-rate.mjs`) uses the perf-samples store to compare `cacheRead / (cacheRead + input + cacheWrite)` ratios across controlled sessions. It does NOT need to run live LLM sessions — it can analyze existing perf-sample data filtered by flag state (the flag values at the time each sample was recorded are derivable from the events log timestamps vs the version deploy dates). For a controlled A/B, the runner can also replay a fixed message sequence through `buildSeparatedPrompt` / `buildCacheOptimizedPrompt` and compare the resulting stable-prefix ratios.

## Numbered implementation tasks

1. Add `scripts/pc-prompt-cache/bench-hit-rate.mjs`: reads perf samples from the SQLite store, groups by flag state (pre-PC vs PC-A vs PC-B), computes mean/median/p95 `providerCachePct` per group, prints a comparison table. Also supports `--synthetic` mode: replays a fixed message sequence through both builders and compares stable-prefix ratios.
2. Add `scripts/pc-prompt-cache/gen-fixtures-pcd.mjs` emitting `PC-016..019`, register them + owner `PC-D` in the v2 manifest; document the reserved range `PC-001..019` in the spec and manifest; bump `EXPECTED_SPRINTS` 36→37 in `scripts/vector-cortex-docs-check.mjs`.
3. Add the sprint acceptance aggregator `src/vector-cortex/pcd-acceptance.test.ts`, then evidence `PC-D.md` with the full PC phase roll-up.

## Failure triad and independence

A benchmark methodology: the benchmark runner correctly groups perf samples by flag state and computes valid hit-rate ratios (fixture 016). B synthetic replay: `--synthetic` mode replays a fixed sequence and produces deterministic stable-prefix ratios that match the expected improvement direction (separated > unseparated, striped > separated) (fixture 017). C evidence completeness: the PC-D evidence record contains measured values for all three flag states, the reserved fixture range is fully documented, and all prior PC evidence records are accepted (fixture 018). The conformance roll-up (manifest + reserved range documentation) is pinned by fixture 019. A is produced by the grouping/computation logic; B by the synthetic replay determinism; C by the evidence checklist. All three use independent inputs. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/prompt-cache/`. Reserved range `PC-001..019` — PC-A 001-004, PC-B 005-008, PC-C 009-015, PC-D 016-019.

- `PC-016: benchmark groups perf samples by flag state correctly` — `{ kind:"prompt-cache", benchmark:"flag-state-grouping", groups:["pre-pc","pc-a","pc-b"], ratios_computed:true }`.
- `PC-017: synthetic replay produces deterministic improvement direction` — `{ kind:"prompt-cache", benchmark:"synthetic-replay", deterministic:true, improvement_direction:"separated>unseparated" }`.
- `PC-018: evidence record contains measured values for all three flag states` — `{ kind:"prompt-cache", evidence:"PC-D", flag_states_measured:3, all_prior_evidence_accepted:true }`.
- `PC-019: conformance roll-up — reserved range PC-001..019 fully documented` — `{ kind:"prompt-cache", reserved_range:"PC-001..019", manifest_entries:19, roll_up:true }`.

Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/pcd-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/pcd-acceptance.test.js
```

Expected assertions: all `PC-016..019` rows registered with algorithm `prompt-cache` against the `prompt-cache-fixture` schema; 016 pins the grouping methodology; 017 pins synthetic determinism; 018 pins evidence completeness; 019 pins the conformance roll-up. The aggregator is flag-agnostic. Acceptance: no payload leakage (benchmark uses aggregate ratios only — EVAL-REDACT-002); no network (perf samples are local SQLite reads). Apply [EVALUATION](../EVALUATION.md) annotation/power rules; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure — no schema/state changes** (benchmark reads existing perf samples; no new tables). Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); benchmark output is aggregate ratios, never payload bytes (EVAL-REDACT-002). Dashboard: no changes.

No rollback needed — this is a read-only measurement sprint. The PC-A/PC-B flags remain independently toggleable for rollback.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/pcd-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all --soft-as-hard --soft-as-hard-base <PREV_TAG> --pre-commit`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, `node scripts/vector-cortex-scope-check.mjs PC-D <COMMIT_SHA>`, `node scripts/vector-cortex-evidence-check.mjs PC-D`, `git diff --check`. No permissive globs or warning-only scans count.

No client or dashboard server files are touched, so dashboard-client typecheck/build is NOT required.

This sprint adds a 37th sprint file, so `EXPECTED_SPRINTS` in `scripts/vector-cortex-docs-check.mjs` is bumped from 36 to 37.

## Workstream roll-up (PC-D doD)

- Both PLAN_V2 flags (`MEGACOMPACT_MESSAGE_SEPARATION`, `MEGACOMPACT_CACHE_STRIPING`) default ON with `=0` byte-identical rollback, registered in SETTINGS as visible toggles.
- The double-gate is eliminated: single config-driven gate at the call site for each flag; both builder functions are pure.
- The CacheTab shows stripe distribution, hit-rate trend, and per-turn prefix-stability breakdown.
- Measured hit-rate improvement is documented in the PC-D evidence record (or the lack thereof, with analysis).
- All four evidence records (PC-A/PC-B/PC-C/PC-D) accepted.
- Test suite count strictly grows (each sprint adds acceptance assertions).
- The conformance corpus grows to 795 + 19 = 814 fixtures.
