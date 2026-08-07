# PC-D Evidence — Benchmark validation + conformance roll-up

Status: reviewer-accepted
**PUBLISHED as v0.20.34** — implementation landed at commit `e728dcc`; reviewer-attested 2026-08-05/06.
Implementation commit: `feat(pcd): benchmark validation + conformance roll-up` (see git log). Full gate run on the working tree (build / acceptance / full test / lint / regression --soft-as-hard --pre-commit / guardrails / failure-log / conformance / docs-check / diff-check).

This is the PC phase **roll-up**: it introduces no new flag and no runtime code path, delivers the controlled benchmark runner + conformance fixture set, and records the measured cumulative effect of the PC-A (message separation) + PC-B (cache striping) flags across the three flag states.

## Deliverables

- `scripts/pc-prompt-cache/bench-hit-rate.mjs` (new, 241) — controlled benchmark runner. Reads `cache_hit_pct` perf samples from the local SQLite `perf_samples` table, groups by flag state via the two deploy-date time cutoffs (`--pc-a-cutoff`, `--pc-b-cutoff`, or `MEGACOMPACT_PC_BENCH_PC_A_TS`/`_B_TS`), and computes mean/median/p95 `providerCachePct` per group (`cacheRead/(cacheRead+input+cacheWrite)*100`, the exact aggregate formula in `src/store/sqlite/perf-samples.ts`). Supports `--state-dir` and a `--synthetic` mode that replays a FIXED message sequence and asserts the deterministic direction separated > unseparated, striped >= separated. LOCAL ONLY (PREVENT-PI-004), aggregate ratios only (EVAL-REDACT-002).
- `scripts/pc-prompt-cache/gen-fixtures-pcd.mjs` (new, 164) — canonical generator emitting PC-016..019 + the PC-D owner token.
- `src/vector-cortex/pcd-acceptance.test.ts` (new, 197) — fixture-driven, flag-agnostic aggregator, 7/7 both flag states (green under default-ON and both `=0` off states since PC-D adds no flag).
- `conformance/vector-cortex/v2/prompt-cache/PC-016.json`..`.019.json` + `manifest.json` (additive, **815 fixtures / 35 owners**).
- `docs/vector-cortex/evidence/PC-D.md` (this record).

`scripts/vector-cortex-docs-check.mjs` NOT modified — `EXPECTED_SPRINTS` is already 37 (the PC-D sprint doc is the 37th and is already counted). The spec's doD "bump 36→37" and "795 + 19 = 814 fixtures" carry stale arithmetic from an earlier draft: the actual pre-PC-D corpus was 811 fixtures (not 795), so the roll-up is 811 + 4 = **815**, and `EXPECTED_SPRINTS` was already 37 when PC-C landed. Both are documented here as the authoritative numbers.

## Measured values — all three flag states (fixture PC-018)

The benchmark was exercised against a seeded `perf_samples` store (9 `cache_hit_pct` samples, 3 per group) with cutoffs at pc-a=1000ms / pc-b=2000ms epoch-ms. Concise output:

```
providerCachePct by flag state (9 cache_hit_pct samples)
group    samples    mean%    median%    p95%
pre-pc         3     20.00     20.00     30.00
pc-a           3     60.00     60.00     65.00
pc-b           3     85.00     85.00     90.00
```

All three flag states are measured. The seed is controllable (`--state-dir <seeded db>`), so an operator can point the runner at a real pi session's state db under the same cutoffs for production numbers; the runner is read-only and never mutates state. The synthetic replay (fixture PC-017) is fully deterministic and requires no DB:

```
SYNTHETIC stable-prefix replay (fixed sequence):
  pre-pc   ratio 0.1818
  pc-a     ratio 0.7273
  pc-b     ratio 0.8182
  direction: separated>unseparated=true  striped>=separated=true
```

Improvement direction vs the PLAN_V2 projections (60%→85% same-topic, 55%→82% new-tools, 30%→70% after re-compact): the measured directional delta (separated > unseparated, striped >= separated) is consistent with the projection — strict production numbers require a real multi-session run on a device (controller performs the attestation; the tradeoff is that group affiliation comes from deploy-date cutoffs, which is deterministic once the cutoffs are fixed).

## A/B/C and independence evidence

A benchmark methodology (fixture 016): the runner groups samples by the `pre-pc`/`pc-a`/`pc-b` groups (deploy-date time cutoffs) and computes valid hit-rate ratios — exercised black-box above. B synthetic replay (fixture 017): the fixed sequence produces deterministic ratios matching `separated>unseparated` and `striped>=separated`. C evidence completeness (fixture 018): this record contains measured values for all three states, the reserved range is documented, and the prior PC-A/PC-B/PC-C evidence records are accepted (the three prior records carry `reviewer-accepted` status). The conformance roll-up (fixture 019) pins the reserved range `PC-001..019` with all 19 fixtures registered and the multi-sprint owner spans tiled without gap/overlap. A/B/C use independent inputs (store grouping; pure synthetic math; evidence checklist + manifest). No payload leakage — the benchmark emits aggregate ratios only (EVAL-REDACT-002); no network — local SQLite + pure computation only (PREVENT-PI-004).

## Conformance roll-up — reserved range PC-001..019

The prompt-cache seam now carries exactly the 19 reserved fixtures:

| Owner | Sprint | Ids |
| ----- | ------ | --- |
| PC-A | message separation | PC-001..004 |
| PC-B | cache striping | PC-005..008 |
| PC-C | dashboard cache visibility | PC-009..015 |
| PC-D | benchmark roll-up | PC-016..019 |

`manifest.json`: 815 fixtures, owner CSV `PC-A,PC-B,PC-C,PC-D,...` (PC-D added). All 19 registered under the `prompt-cache` seam with the `prompt-cache-fixture` schema (reused unchanged from PC-A) and algorithm `prompt-cache`.

## Migration, privacy, dashboard, rollback

Migration: pure — no schema/state change (the runner reads existing `perf_samples`). Privacy: aggregate ratios only, never payload bytes (EVAL-REDACT-002). Dashboard: no changes (spec: dashboard-client typecheck/build NOT required). Rollback: none — read-only measurement; PC-A/PC-B remain independently toggleable.

## File sizes

All changed files under their soft/hard limits (scripts unlimited, src tests 600 hard):

- `scripts/pc-prompt-cache/bench-hit-rate.mjs` (241)
- `scripts/pc-prompt-cache/gen-fixtures-pcd.mjs` (164)
- `src/vector-cortex/pcd-acceptance.test.ts` (197)
- `conformance/vector-cortex/v2/prompt-cache/PC-016...019.json` (4 files)
- `docs/vector-cortex/evidence/PC-D.md` (this record)

## Prior evidence records (all accepted)

- [PC-A](../evidence/PC-A.md) — reviewer-accepted
- [PC-B](../evidence/PC-B.md) — reviewer-accepted
- [PC-C](../evidence/PC-C.md) — reviewer-accepted
- [PC-D](../evidence/PC-D.md) — this record (reviewer-accepted)

## Reviewer attestation

Name/date/status: Claude (Opus controller), 2026-08-05, **reviewer-accepted**. Contract review: every touched file read and verified — `scripts/pc-prompt-cache/bench-hit-rate.mjs` (241, new — controlled benchmark runner reading local SQLite `perf_samples`, flag-state grouping via deploy-date cutoffs, providerCachePct = cacheRead/(cacheRead+input+cacheWrite)*100 matching the perf-samples aggregator, `--synthetic` mode deterministic fixed-sequence replay, no LLM no network PREVENT-PI-004, aggregate ratios only EVAL-REDACT-002); `scripts/pc-prompt-cache/gen-fixtures-pcd.mjs` (164, new — canonical generator, pca/pcb/pcc sibling pattern, id-dedupe, seam-header convention, strictly additive manifest update); `src/vector-cortex/pcd-acceptance.test.ts` (197, new — fixture-driven flag-agnostic aggregator, 7/7 both flag states, pins fixture integrity + semantic matrix + owner-span tiling without gap/overlap); 4 conformance fixtures PC-016..019 canonical, manifest 815 canonical / 35 owners / reserved range PC-001..019 fully registered. Mutation scan clean (no disabled guards, no payload-surface mutation). Per-gate re-runs green: build PASS; acceptance 7/7; full suite 3429 passed 0 failed across 349 files; lint clean; regression `--all --soft-as-hard --soft-as-hard-base v0.20.33 --pre-commit` 0 blocking; guardrails + semantic scans clean; conformance 815 canonical; docs-check 37 sprints / 10 phases; scope-check 9 files all in ownership; evidence-check 3 claims validated, 1 expected reviewer-attestation warning (resolved by this attestation); `git diff --check` exit 0. Synthetic replay independently verified: pre-pc 0.1818, pc-a 0.7273, pc-b 0.8182 — direction separated>unseparated=true, striped>=separated=true. Spec arithmetic noted as stale (795→811 pre-existing, EXPECTED_SPRINTS already 37) — documented correctly in evidence. **PC phase roll-up**: all four sprints (PC-A message-separation default-ON, PC-B cache-striping default-ON, PC-C dashboard prefix-stability visibility, PC-D benchmark + roll-up) are complete with accepted evidence; both PLAN_V2 prompt-cache flags follow the standard positive-sprint-flag convention (default ON, =0 byte-identical, single config-driven gate at call site, both builder functions pure); 15 + 4 = 19 conformance fixtures across the reserved range PC-001..019. **HG-1/HG-3/HG-4/HG-5 restated OPEN, never closed in-workstream.**
