# C2 Findings 3 + 4 — health-dashboard observability gap + `drift warn` clarity

Sprint: **H** (health observability). Branch: `fix/c2-findings`. Repo: pi-mega-compact.

## §1 — Finding 3: internal store-write errors are invisible to `errorRate`

### Problem

mega's `errorRate` context-health sub-score read **`1.0` (the healthy extreme)**
the entire time 557 `turn_write_failed` (DuplicateTurnError) events were
accumulating. The health dashboard showed green while the log showed red. They
were looking at different things, and only one was wired to the UI.

### Root cause

- `computeErrorEscalation(recentErrorCategories)` (`src/contextHealth/drift.ts:50`)
  returns `1 - (non-null / total)`.
- `recentErrorCategories` is a ring buffer fed by `runtime.lastErrorCategory`
  (`extensions/mega-events/health-handler.ts:198`).
- `lastErrorCategory` is set to `null` at the start of every turn
  (`turnEndHandler.ts:32`) and only set to a non-null category in the **API-error
  retry path** (`turnEndHandler/errorRetry.ts:51`).
- `turn_write_failed` is emitted by `recordTurnRow`'s catch
  (`recordTurnRow.ts:54`) and **does not touch `lastErrorCategory`**.

So internal store-write errors (and any other non-API-error failure) never
reach the error-rate signal. `errorRate` only reflects API retry errors.

### Fix options

**Option A — broaden `lastErrorCategory`.** Set `lastErrorCategory` in the
`turn_write_failed` catch (and sibling internal-error catches) to a category
like `"store_write"`. Minimal, but couples the turn-write path to the health
ring buffer and only covers errors we remember to categorize.

**Option B — new "internal errors" sub-score (RECOMMENDED).** Add a fifth
health axis (or fold into `errorRate` as a second input): count recent
`*_failed` events (`turn_write_failed`, and any others — `recall_failed`,
`fork_failed`, etc.) from `events.log` / an in-memory ring, and feed a
`storeErrorRate` sub-score. Surface it in the dashboard Health tab alongside
`errorRate`. This covers ALL internal errors, not just the ones we categorize
by hand, and doesn't entangle the turn-write path with the health ring.

**Recommendation: Option B**, with a small ring buffer of recent internal-error
events in `MegaRuntime` (mirroring `recentErrorCategories`) that the health
handler reads.

### Files (Option B)

- `extensions/mega-runtime/runtime.ts` — add `recentInternalErrors: string[]`
  ring (mirrors `recentErrorCategories`).
- `extensions/mega-events/health-handler.ts` — read the ring, compute a
  `storeErrorRate` sub-score; fold into composite or add to the row.
- `src/contextHealth.ts` + `src/store/sqlite/context-health.ts` — extend the
  `context_health` row + `computeHealthScore` weights if a new axis is added
  (re-balance weights; document the change).
- `extensions/dashboard-client/src/tabs/HealthTab.tsx` — surface the new
  signal; turn `errorRate` amber/red when internal errors are accumulating.
- `extensions/mega-events/agent-handlers/turnEndHandler/recordTurnRow.ts` —
  push to the ring on `turn_write_failed` (and audit sibling `*_failed`
  emits).

### Test plan

- **Unit:** `computeHealthScore` with the new axis; ring buffer behavior.
- **Integration:** simulate a `turn_write_failed` storm; assert the dashboard
  health view reflects it (not `1.0`).
- **Regression:** existing health tests + dashboard snapshot tests.

---

## §2 — Finding 4: `drift warn` conflates `compaction_lag` with error drift

### Problem

The status-line `drift warn` indicator looked like it was related to the 557
errors. It wasn't. It is produced by `driftStatusImpl`
(`extensions/mega-runtime/runtime-helpers.ts:98`) → `detectCrossRepoDrift()`
(`src/driftDetection.ts`), which flags a repo `warn` when it is **active but
not compacted** (the `compaction_lag` signal: "never compacted" / "Nh behind
last activity"). For `RADOPENCODE` it was simply true — the repo had never been
compacted (the status line said so: `compact never`).

`drift warn` (cross-repo compaction lag) and `errorRate` (API retry errors) are
**different axes**, but the status line presents "drift" as if it were one
thing, so a user (and the investigating agent) reasonably conflated them.

### Fix

- **Dashboard:** in the Health tab, label the cross-repo drift signal as
  `compaction lag` (what it is), not just `drift`. Keep the status-line chip
  but make its tooltip/detail explicit ("repo active but not compacted").
- **Docs:** a short note in the Health tab help that `drift` here =
  compaction-lag across repos, distinct from the `errorRate` sub-score.
- No behavior change — this is a clarity/labeling fix so the indicator doesn't
  mislead during incident triage.

### Files

- `extensions/dashboard-client/src/tabs/HealthTab.tsx` (+ the cross-repo drift
  card if separate).
- `extensions/mega-runtime/widget.ts:132` — consider relabeling the chip text
  or adding detail (keep the `ok|warn` semantics).

### Test plan

- Dashboard snapshot test for the relabeled signal.
- No logic change → no behavior regression to test.

---

## Sprint H steps

1. Implement §1 Option B (internal-errors ring + sub-score + dashboard
   surface). Land first — it's the substantive fix.
2. Implement §2 (labeling). Small; bundle into the same sprint.
3. Tests (above). Gate: build + `node --test dist/**/*.test.js` + lint +
   regression_check + guardrails-scan + (dashboard build: `npm run
   build:dashboard`).
4. Review (controller) — file limits, no disabled health gates.
5. Deploy via `./scripts/deploy.sh <next-patch>` (explicit version arg).
6. Device verify: `pi update --extensions`; trigger a store-write failure (or
   resume to reproduce Finding 2 pre-fix); confirm the Health tab shows the
   internal-error signal (not a flat 1.0) and the `drift` chip reads as
   compaction-lag.

## Note on ordering vs Sprint R

Sprint H (observability) is most valuable **after** Sprint R (resume fix) lands:
once R stops the duplicate errors, H's internal-error signal should go quiet —
a clean way to verify R worked. But H is independently shippable and lower
risk (telemetry/display only), so it can land first if R's audit runs long.
