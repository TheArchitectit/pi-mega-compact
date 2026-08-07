# Deferred-Sprint Program — 9 mapped sprints from external-audit #4

**Status:** active | **Started:** 2026-08-07 | **Branching:** per-sprint feature branch

This document is the canonical control-plane for the nine production sprints
mapped to the OPEN items of the 2026-07 external audit. It exists so the
program's order, dependency graph, and branching convention are discoverable
without re-deriving them from the audit memory.

## Sprint inventory (9)

| # | Sprint ID | Spec file | Audit item | Phase |
|---|-----------|-----------|------------|-------|
| 1 | DOC-0a | sprints/DOC-0a-evidence-and-planv2-drift.md | #2 evidence drift + PLAN_V2 default-ON | DOC |
| 2 | COS-FP-A | sprints/COS-FP-A-synthetic-fp-harness-and-threshold-calibration.md | #3 synthetic half | COS-FP |
| 3 | COS-FP-R | sprints/COS-FP-R-real-corpus-validation.md | #3 real half | COS-FP |
| 4 | REPO-A | sprints/REPO-A-cross-repo-corpus-prep.md | #5 cross-repo corpus | REPO |
| 5 | DASH-0a | sprints/DASH-0a-tab-audit-and-merge-plan.md | #9 tab audit + plan | DASH |
| 6 | DASH-0b | sprints/DASH-0b-merge-sessions-turns-and-cortex-infra.md | #9 merge pair 1 | DASH |
| 7 | DASH-0c | sprints/DASH-0c-merge-cache-metrics-and-admin-combine.md | #9 merge pair 2 | DASH |
| 8 | DASH-0d | sprints/DASH-0d-rollup-accessibility-lazyload-flags.md | #9 rollup | DASH |
| 9 | DOC-0b | sprints/DOC-0b-placeholder-scan-and-deferred-gate.md | #2 placeholder gate | DOC |

## Order rationale

**Sequential, in the inventory order above.** One sprint per feature branch,
merged to `master`, published via `./scripts/deploy.sh`, then the next sprint
starts from the new master. Never two implementation sprints parallel on the
same tree (see `~/memory/concurrent-agent-git-tangling.md`).

The ordering is not arbitrary:

1. **DOC-0a first** — it reconciles evidence + PLAN_V2 default-ON drift
   *before* new sprints land; running it after the chain would force a
   second drift sweep.
2. **COS-FP-A → COS-FP-R adjacent** — both share the `scripts/cosine-fp/`
   namespace and the threshold-report doc; keeping them adjacent minimizes
   cross-sprint ownership boundary churn. COS-FP-A produces the synthetic
   baseline that COS-FP-R appends to (never overwrites).
3. **REPO-A after COS-FP** — REPO-A is independent, but slotting it between
   the threshold chain and the dashboard chain keeps the heavier script-side
   work (consent store + builder) from mixing with the heavier client-side
   work (dashboard merges) on one sprint boundary.
4. **DASH-0a before 0b/0c/0d** — DASH-0a ships only the *plan* (typed merge
   map + deep-link map + a11y nav-map); 0b and 0c *execute* moves against
   that plan, and 0d rolls up (a11y audit + lazy-load + flag cleanup). The
   order is load-bearing.
5. **DOC-0b last** — its job is to run the placeholder-scan gate against the
   *final* state of the other eight; running it earlier would force re-running.

This order is written into the chain so the controller does not have to
rederive it between sprints. Deviating requires updating this file first.

## Dependency graph

```
DOC-0a     ───────────── (no deps)
COS-FP-A   ───────────── (no deps)         ┐ share cosine-fp namespace
COS-FP-R   ── depends on COS-FP-A          ┘
REPO-A     ───────────── (no deps)
DASH-0a    ───────────── (no deps)
DASH-0b    ── depends on DASH-0a (plan.ts)
DASH-0c    ── depends on DASH-0b
DASH-0d    ── depends on DASH-0c
DOC-0b     ── depends on ALL of the above (scans final state)
```

Soft dependency only: nothing in the code of one sprint imports the code of
the previous one — the dependency is on the *shipped order* (DOC-0a before
others so drift is zeroed; DASH-0a before 0b/0c so the plan exists; DOC-0b
after all so the scan is meaningful).

## Branching convention

Each sprint ships on its own feature branch:

| Sprint | Branch |
|--------|--------|
| DOC-0a | `feat/DOC-0a` |
| COS-FP-A | `feat/COS-FP-A` |
| COS-FP-R | `feat/COS-FP-R` |
| REPO-A | `feat/REPO-A` |
| DASH-0a | `feat/DASH-0a` |
| DASH-0b | `feat/DASH-0b` |
| DASH-0c | `feat/DASH-0c` |
| DASH-0d | `feat/DASH-0d` |
| DOC-0b | `feat/DOC-0b` |

Branch cut from current `master`, all sprint work on the branch, gates run on
the branch, merged to `master` when the spec's exit evidence gates pass, then
`./scripts/deploy.sh <next-patch>` publishes the version bump + tag + GitHub
release. After publish, the next sprint branches from the new `master`.

**Sole exception:** if the user lands an out-of-band hotfix on `master` while
a sprint branch is in flight, the sprint branch rebases before merging (not
mid-implementation) so the hotfix lands linearly.

## Audit status continuity

Deferred-sprint OPEN items and their current status:

- `#3 OPEN` — L2 cosine `0.85` threshold empirically unvalidated → COS-FP-A +
  COS-FP-R close both halves (synthetic + real once corpus exists).
- `#5 BLOCKED` — cross-repo recall not validated against real sessions →
  REPO-A ships the governed corpus machinery; real-corpus validation
  executes the moment a donated corpus exists.
- `#9 OPEN` — 13 dashboard top-level surfaces vs the 7-surface mandate →
  DASH-0a..0d close it in four stages.
- `#2 evidence drift` — PLAN_V2 default-ON vs evidence stamps stale → DOC-0a
  reconciles; DOC-0b installs the placeholder-scan gate so drift cannot
  recur silently.

Item `#6` (per-tier dedup rollup) has **no mapped sprint** in this program —
it is a separate workstream, scope to be built when prioritized. Do NOT
silently graft it onto any of the nine sprints above.

## Per-sprint execution contract

For each sprint, in order:

1. `git checkout master && git pull` (clean tree required)
2. `git checkout -b feat/<SPRINT-ID>`
3. Sonnet agent implements `docs/vector-cortex/sprints/<spec>.md` per the
   numbered implementation tasks (controller provides context from this
   document).
4. Controller reviews — spec compliance first, code quality second
   (two-stage review, fresh reviewers, controller never self-reviews).
5. Controller runs the sprint's exit-evidence gates locally.
6. `git checkout master && git merge feat/<SPRINT-ID>` (fast-forward or
   merge commit as deploy.sh prefers).
7. `./scripts/deploy.sh <next-patch>` — never hand-publish, never by npm
   alone; deploy.sh enforces the full gate + dashboard bundle verify + tag
   + push + GitHub release.
8. Mark the sprint command in this document with the landed SHA + published
   version, then `TaskUpdate` complete.

Steps 1–8 repeat per sprint until all nine ship.

## Landed sprints

| Sprint | Branch | Merge SHA | Published |
|--------|--------|-----------|-----------|
| DOC-0a | `feat/DOC-0a` | `692c78a` | v0.20.54 |
| COS-FP-A | `feat/COS-FP-A` | `87cc6d4` | v0.20.55 |
| COS-FP-R | `feat/COS-FP-R` | `b81620a` | v0.20.56 |
| REPO-A | `feat/REPO-A` | `81707f3` | v0.20.57 |
| DASH-0a | `feat/DASH-0a` | `4ad43b3` | v0.20.58 |
| DASH-0b | `feat/DASH-0b` | `3051cba` | v0.20.59 |

## Exit evidence for the program

The program is complete when all nine sprints above are merged to `master`
with their published versions, and `DOC-0b`'s placeholder-scan gate is green
against the final state. At that point the external-audit OPEN list reduces
to `#3` (real half — gated on corpus donation, not code) and any audit items
that never had a sprint mapped.

**Program completion is NOT the same as audit items being "done".** COS-FP-R
ships the harness but waits on a consented corpus; REPO-A ships the machinery
but waits on donated sessions. Neither is a deferral — both are "code ready,
executes when corpus exists". This document names those explicitly so the
program closing does not read as a silent sympathetic collapse of audit scope.
