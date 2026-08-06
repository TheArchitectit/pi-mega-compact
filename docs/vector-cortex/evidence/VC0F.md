# VC0F — Dashboard Restart-on-Upgrade (session_start auto-restart)

Status: implementer-complete
Implementation commits/sub-sprint gates: single commit (see git log); full gate run on the working tree (build / test / lint / regression / guardrails / conformance / dashboard-client tsc+build).
Contract review: pending controller review (this record is implementer-complete, not reviewer-accepted).
Changed production/tests/docs: `extensions/mega-dashboard-cmds.ts`, `extensions/mega-dashboard-bounce.ts`, `extensions/mega-dashboard-cmds.test.ts`, `extensions/dashboard-server/server.ts`, `docs/vector-cortex/sprints/VC0F-dashboard-restart-on-upgrade.md`, `docs/vector-cortex/evidence/VC0F.md`.
Fixtures and corpus digests: none changed — VC0F is a lifecycle/process sprint; conformance corpus untouched (771 fixtures canonical).
Migration: pure sprint — no migration.
A/B/C and independence evidence: Wave A (extract + once-per-process gate + session_start trigger), Wave B (runner + port.pid version stamping), Wave C (unit tests). The bounce primitive is dependency-injected, so each decision is unit-tested independently of the live server.
Commands and verbatim summaries: see Gate Results + unit-test claims below.

## File sizes
All touched files under the extensions soft limit (400) / tests hard limit (600):

- `extensions/mega-dashboard-cmds.ts` (352)
- `extensions/mega-dashboard-bounce.ts` (97)
- `extensions/mega-dashboard-cmds.test.ts` (177)
- `extensions/dashboard-server/server.ts` (354)
- `docs/vector-cortex/sprints/VC0F-dashboard-restart-on-upgrade.md` (175)

The new `mega-dashboard-bounce.ts` is a delegate of `mega-dashboard-cmds.ts` (which was at the pre-sprint 313 lines and would have crossed the 400 soft limit with the ~76-line bounce extraction), keeping the parent under the soft cap per the delegate-shell split rule.

## Gate Results

| Gate | Result |
|------|--------|
| `npm run build` | PASS |
| `npm test` | 3330 passed / 0 failed across 329 files (baseline 3295+) |
| `npm run lint` | PASS (tsc + guardrails + semantic) |
| `python3 scripts/regression_check.py --all` | PASS (0 hard violations; no changed file over soft limit) |
| `node scripts/guardrails-scan.mjs` | PASS (pi pattern scan clean) |
| `python3 scripts/log_failure.py --list` | PASS (only resolved entries) |
| `node scripts/vector-cortex-conformance.mjs --check` | PASS (771 fixtures canonical) |
| `cd extensions/dashboard-client && npm run typecheck` | PASS |
| `cd extensions/dashboard-client && npm run build` | PASS |
| `git diff --check` | PASS |

## VC0F unit tests

VC0F unit-test claims (bounce logic C1 / once-per-process C2 / multi-repo isolation C3 / marker-version B2):

`node --test dist/extensions/mega-dashboard-cmds.test.js` → `ℹ tests 10` `ℹ pass 10` `ℹ fail 0`

`MEGACOMPACT_VC0F=0 node --test dist/extensions/mega-dashboard-cmds.test.js` → `ℹ tests 10` `ℹ pass 10` `ℹ fail 0` (flag-off parity)

VC0F introduces no new `MEGACOMPACT_*` flag — it extends the existing dashboard lifecycle, so `MEGACOMPACT_VC0F=0` (an undefined env var) is byte-identical by construction and the suite stays green.

## Evaluation

- `bounceStaleRunnerIfAny` extracted into `mega-dashboard-bounce.ts` (delegate), called first by the `/mega-dashboard` handler (interactive — still notifies the user) and by a new silent `session_start` hook (VC0F A3) — the durable fix for the orphan-runner staleness after `pi update --extensions`.
- Once-per-process gate (`stalenessCheckedThisProcess`) set after the FIRST successful probe regardless of outcome, bounding cost to one probe per extension load.
- Wave B: `_dashboard-runner.mjs` stamps the bundle version at write time; `port.pid` writes `{port, pid, version}`; `bounceStaleRunnerIfAny` reads the marker first and only falls back to the HTTP probe when the marker is missing or lacks a version.
- Non-fatal: every failure path returns `{bounced:false}` and never throws.

## Residual risks

- The once-per-process gate is shared across repos within one extension process: because it is set after the first probe, a later repo bind in the same process will not re-probe that repo's dashboard. Production survival is preserved (only the current repo's marker/port is ever killed), but a repo that gains a stale runner after the process's first probe is only healed on a fresh pi process. Accepted per spec A2 (probe cost bounded to once per process).
- `scripts/vector-cortex-docs-check.mjs` reports two PRE-EXISTING, out-of-scope failures unrelated to VC0F: `expected 27 sprint docs, found 29` (the chain now has 29 sprints; `EXPECTED_SPRINTS` was not bumped when VC0E/VC0F extended the plan) and `VC0E has no positive MEGACOMPACT_* flag line`. These require a cross-cutting reconciliation by the controller; VC0F itself now satisfies the flag-line check.
- No runtime flame-out expected from the extra `session_start` probe: it is best-effort and error-masked.

## Rollback/downgrade rehearsal

Reversible by removing the `session_start` hook and the bounce call from `/mega-dashboard` (the original inline stale-replace block remains behaviorally equivalent). No schema/state change.

## Reviewer attestation

Name/date/status: pending — controller review required to set `reviewer-accepted` and update SPRINT_PLAN status.
