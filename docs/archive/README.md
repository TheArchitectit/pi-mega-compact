# Archive — historical pi-mega-compact docs

These docs record **completed, shipped, or superseded** work. They are kept for
historical reference, not as active specs. Active/current docs live in
`docs/specs/`, `docs/`, and `docs/vector-cortex/`.

Moved here 2026-08-13 during a docs-staleness review (see
`docs/blog/2026-08-13-bridge-c2-the-bug-that-wasnt.md` for the surrounding C2
work). The active index (`docs/INDEX_MAP.md`) points at current docs; entries
that previously pointed at files now in this archive are noted there as
`(archived)`.

## What's here

- `specs/` — sprint specs for shipped sprints (sprint-08…15, S24/S25/S27,
  S26/S27, sprint-A1…D3 + T1, the three-way-failback sprint program, game-mode
  sprint plan, the older slice2 PGlite spec, plus shipped fix specs like the
  already-compacted-race postmortem and pressure-basis-oscillation).
- `audits/` — dated audits superseded by the current
  `docs/audits/2026-08-05-stub-gate-mock-audit.md`.
- top-level — old migration notes (v0.8.9), superseded designs
  (compaction-redesign, cache-stabilization-design, dedup-implementation-plan,
  PROMPTCACHE_PLAN_V2, game-mode-design), completed-sprint findings
  (AI_ERROR_RETRY_FINDINGS, AUDIT_FINDINGS), and a stale work-status snapshot
  (WORK_STATUS, frozen at v0.7.3).

## Not archived (deliberately kept, despite age)

- `docs/DEDUP_RUNBOOK.md` — kept as a live incident runbook (archive-leaning but
  may still be referenced during incidents).
- `docs/specs/dashboard-compaction-gate-fixes.md` — status "pending"; its
  blocker was superseded but some wiki/memory-map blank-state fixes may be
  unshipped. Kept pending review.
- `docs/specs/sprint-promptcache-stats.md` — Status: Ready (not DONE); still
  referenced actively.
- `docs/audits/2026-08-05-stub-gate-mock-audit.md` — the current authoritative
  audit with open HG items.
- All `docs/specs/s28-s53*.md`, `s39-s48*`, `s49-*`, `s50-s53`, PMA program,
  setup-flow, fix-durable-trim, fix-pglite-lazy-import — listed active in
  INDEX_MAP.
