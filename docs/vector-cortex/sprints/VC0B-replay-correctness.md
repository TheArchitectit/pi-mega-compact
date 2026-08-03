# VC0B — Replay correctness

**Status:** planned | **Depends on:** VC0A | **Phase:** VC0
**Flag:** `MEGACOMPACT_VC0B`, defined in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_VC0B=0` disables and must be byte-identical to the predecessor. Add to dashboard `SETTINGS`, or record the immutable/security exclusion below.

## Goal and inputs/outputs

Consume only reviewer-accepted predecessor contracts and [common contracts](../CONTRACTS.md). Own **ReplayCutV2 / ReplayReportV2**. Production ownership: `src/vector-cortex/replay/{types,cut,replay}.ts; src/vector-cortex/migrations/effective-cut-v2.ts`. Algorithm: Effective cut is min(boundary-safe cut, committed seq, captured high-water); ties retreat across entire tool pair and anchor floor.

## Numbered implementation tasks

1. Define `ReplayCutV2` fields `requestedSeq`, `boundarySafeSeq`, `committedSeq`, `capturedHighWater`, `effectiveSeq` and `ReplayReportV2` counts; register `CUT-001..020` and `M3-001..010`.
2. Implement `cut.ts` as `min(boundarySafeSeq, committedSeq, capturedHighWater)` and retreat to the call boundary whenever the candidate intersects a tool call/result pair.
3. Apply the anchor floor after pair retreat; when cuts tie, choose the lower source sequence and include the retreat reason in `ReplayReportV2`.
4. Implement `replay.ts` to scan EventV2 occurrences in ascending `(seq,eventId bytes)` and report `CUT_TOOL_PAIR_SPLIT` or `CUT_ANCHOR_FLOOR` before returning bytes.
5. Implement `effective-cut-v2.ts` copy/validate/switch and connect the replay caller; emit `vector_cortex_replay_cut_retreat` and `vector_cortex_replay_highwater_frozen`; no dashboard or API change is necessary.
6. Only after replay and migration production code passes build/lint/regression, add fixtures/tests, run the old-binary export rehearsal, and record `docs/vector-cortex/evidence/VC0B.md`.

## Failure triad and independence

A v2 replay; B exact sequential replay; C host transcript. Each uses independent algorithms/assets/indexes as applicable. C states its loss of old semantic context; authority outage freezes derived high-water. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/replay/`.

- `CUT-PAIR-001: requested cut between call c7 and result r7 retreats before c7`.
- `CUT-ANCHOR-002: retreat cannot cross the recent-anchor floor`.
- `CUT-HIGHWATER-003: captured high-water below committed seq wins`.

Exact test sources: `src/vector-cortex/replay/cut.test.ts`; `src/vector-cortex/replay/replay.test.ts`. Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc0b-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc0b-acceptance.test.js
```

Expected assertions: all `CUT-001..020,M3-001..010` conformance rows return their manifest bytes or exact listed failure code; generate balanced call/result streams and legal anchor floors; invariant: output is a source-order prefix with no orphan tool event. Unique failure injection: crash after M3 copy validation but before pointer switch; restart retains the old cut pointer and resumes idempotently. Forced triad: A=v2 effective-cut calculator; B=sequential boundary scan with no M3 index; C=unchanged host transcript with derived high-water frozen. Breaker recovery must follow the sprint triad contract. Exact flag-off comparison command: `MEGACOMPACT_VC0B=0 node --test dist/vector-cortex/vc0b-acceptance.test.js`; its outbound/predecessor golden bytes must match exactly. Acceptance: zero reordered/split pairs across 10,000 replay turns. Apply [EVALUATION](../EVALUATION.md) annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **M3 effective-cut-v2; copy/validate/switch**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); exact ledger is not training data. Dashboard: none—developer correctness seam. No dashboard or API change is necessary for this internal sprint.

Rollback sets `MEGACOMPACT_VC0B=0`, selects C, restores the prior derived pointer without deleting evidence, and verifies predecessor golden bytes. Next handoff: VC0C receives ReplayReportV2 and M3 manifest.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc0b-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, and `git diff --check`. Sprints that add or alter any runtime path also run `node scripts/vector-cortex-network-denial.mjs --modes=A,B,C`; asset/Rust/dashboard gates additionally apply when named by this sprint. No permissive globs or warning-only scans count.
