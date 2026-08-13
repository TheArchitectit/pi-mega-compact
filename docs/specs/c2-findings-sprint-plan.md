# C2 findings — sprint plan (AM 2026-08-13)

Branch: `fix/c2-findings` (off `master` @ v0.21.3).

## Origin

The first real end-to-end validation (Sprint C2) of the bidirectional
pi-mega-compact ↔ ithacus bridge, run against a live pi session in the
`RADOPENCODE` repo (`pi-mega-compact@0.21.3` + `ithacus@0.6.16`). The bridge
itself passed (co-load + liveness confirmed — see
[`docs/blog/2026-08-13-bridge-c2-the-bug-that-wasnt.md`](../blog/2026-08-13-bridge-c2-the-bug-that-wasnt.md)),
but the investigation surfaced **three mega-compact findings**. Only one was
fixed in ithacus (v0.6.17, hygiene); the rest live here.

## Findings at a glance

| # | Finding | Severity | Repo | Spec |
|---|---|---|---|---|
| 2 | Session-resume re-records turns → 557 `DuplicateTurnError` | **bug** (log noise + fork-data risk) | mega-compact | [`c2-finding-resume-duplicate-turn.md`](./c2-finding-resume-duplicate-turn.md) |
| 3 | Internal store-write errors invisible to health dashboard (`errorRate` stayed 1.0) | **observability gap** | mega-compact | [`c2-finding-health-observability-gap.md`](./c2-finding-health-observability-gap.md) |
| 4 | `drift warn` status indicator conflates `compaction_lag` with error-rate drift | **clarity** (folded into #3) | mega-compact | §2 of the observability spec |

Finding 1 (ithacus redundant parent `recordTurn` echo) was fixed and shipped in
ithacus v0.6.17 — single-turn-recording-authority. It does NOT fix the 557
errors; those are Finding 2.

## Sprint sequence (AM)

**Sprint R (resume fix) — Finding 2.** Highest priority: it is the actual
source of the 557 `turn_write_failed` events and the only one with fork-data
risk. Spec: `c2-finding-resume-duplicate-turn.md`. Land + deploy first so the
live `RADOPENCODE` events.log stops accumulating duplicates.

**Sprint H (health observability) — Findings 3 + 4.** Surface internal
store-write errors in the health view so `errorRate` no longer reads 1.0 while
errors accumulate; disambiguate the `drift warn` indicator. Spec:
`c2-finding-health-observability-gap.md`. Lower risk (telemetry/display only),
land second.

**Sprint C2-cont (bridge validation continues).** Cross-repo, partly manual:
parent recall injection, memory write to `<repo>/.pi/mega-compact/sqlite.db`,
child dispatch with the second `-e mega-compact-child.js`, cross-dispatch
recall, fork after `recordTurn`s, `ITHACUS_MEGA_BRIDGE=false` byte-identity.
Track in the ithacus repo; gated on the device having `ithacus@0.6.17` +
`pi-mega-compact@R` installed.

## Rules of engagement (from project guardrails)

- One focused commit per task; deploy via `scripts/deploy.sh <version>` (mega-compact requires an explicit version arg — NOT no-arg).
- Every change passes `npm run lint` + `python3 scripts/regression_check.py --all` + `node scripts/guardrails-scan.mjs`.
- Impl via Sonnet agents; controller reviews + fixes only.
- `src/` 300 soft / 500 hard; `extensions/` 400 soft / 500 hard — split before crossing soft.
- Feature flags default ON, env-OFF; flag-OFF = byte-identical.
- Non-fatal stores: every store write is best-effort.
