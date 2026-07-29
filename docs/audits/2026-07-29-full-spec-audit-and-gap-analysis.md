# Full Spec Audit + Gap Analysis — 2026-07-29

**Scope:** every spec under `docs/specs/`, cross-referenced against actual code on the
current branch (`s49-turn-db`, v0.9.0 + audit commit `f844ef1`) and `master` (v0.9.2).
**Purpose (per user request):** make sure we are not missing anything, that all findings
are addressed, then a full gap analysis.

---

## A. Spec inventory by status (51 specs)

| Bucket | Count | Specs |
| ------ | ----- | ----- |
| Shipped/DONE (verified in code) | 17 | fix-durable-trim, fix-pglite-lazy-import, s24, s27, s28, s29, sprint-08…14, sprint-009, sprint-27-db-mirror-implementation, s48-core, s49, s50, s51 |
| Partially shipped (remaining tracked) | 1 | s25-raptor-promote (cache + tests — **shipped on master, stale on this branch**) |
| Stale status marker (says implement-ready/PLANNED but actually shipped) | 4 | **s51**, **slice2**, **s49-program**, **s47** (see §C) |
| PLANNED / Draft / implement-ready (future, unstarted) | 22 | s25-cross-repo, s25-memory-db-roundtrip, s38, s39, s40B-rev, s41, s42B/D, s43, s44, s45, s46, sprint-15, sprint-26×2, sprint-27-agent-token-telemetry, sprint-27-db-mirror-cache-stability, sprint-A1…D3, sprint-T1 |
| "Fix not yet written" + UNTRACKED | 1 | **find-pressure-basis-oscillation** (see §D) |
| No status marker (needs one) | 2 | postmortem-already-compacted-race, game-mode-sprint-plan |
| Program sprint with NO spec written | 1 | **S52 (Dashboard Management + Rewind)** — see §E |

---

## B. 🔴 CRITICAL FINDING — Diverged feature branches (the real gap)

The project has **two parallel lines of development that have NOT been reconciled**:

```
            7592571 (common ancestor: S49 program spec)
            /        \
   s49-turn-db        master (→ raptor-promotion)
   (v0.9.0+audit)     (v0.9.2, contains v0.10.0 history)
   │                  │
   +17 commits        +60 commits
   S49A/B/C (our       S25-raptor-promote COMPLETION (raptorCache +
   design: turnStore   serve-gate.test.ts — the items ROADMAP/BACKLOG
   + migrations)        on this branch still list as "open")
   S50 (metrics+fork)  S42 multilevel FULL completion
   S51 (wiki/topics)   Doc-sync commits (BACKLOG/ROADMAP reflect
   audit fix f844ef1    shipped status)
```

- **`master` (v0.9.2) does NOT have S50 or S51** (no `src/metrics/`, no `src/fork.ts`, no `src/topics/`, no `src/wiki.ts`, no `/mega-fork`).
- **`master` has its OWN S49A design** ("contract-first TurnStore + sqlite + in-memory backends": `sqlite-store.ts`, `memory-store.ts`, `contract-compliance.test.ts`) — **a different architecture** from this branch's `turnStore.ts` + `migrations.ts`. Both branches independently created `src/store/turns/{connection,index,types}.ts` → these are **add/add merge conflicts**.
- **This branch (`s49-turn-db`) does NOT have** the S25 completion (raptorCache, serve-gate tests) or S42 completion that master absorbed from `raptor-promotion`.
- `git merge-tree master s49-turn-db` → **13 conflicts**, including architecture-level add/add on the turn-store spine + `package.json` (version 0.9.0 vs 0.9.2) + `extensions/mega-compact.ts`/`mega-config.ts` + spec docs + `RELEASE_NOTES.md`.

**Why the stale `dist/` artifacts I fixed earlier existed:** the working tree's `dist/` once held `sqlite-store.test.js` / `contract-compliance.test.js` / `memory-store.test.js` — master's S49A sources — left behind from a master-based build. The `prebuild` clean step I added (commit `f844ef1`) prevents recurrence.

### Gap B-1 (must resolve): Reconcile `s49-turn-db` with `master`

- Decide which S49 design wins (this branch's migration-based single store vs master's contract-first multi-backend).
- Port master's S25 completion (raptorCache + serve-gate tests) + S42 completion onto the chosen base.
- Port this branch's S50 + S51 onto master.
- Resolve the 13 conflicts (docs + version + extension wiring + turn-store spine).
- **This is a human decision**, not something to auto-resolve — two valid S49 architectures exist.

---

## C. Stale status markers (documentation hygiene gaps)

These specs are marked implement-ready/PLANNED but the work actually shipped. The
markers were never updated after shipping:

| Spec | Marker says | Reality | Evidence |
| ---- | ----------- | ------- | ------- |
| **s51-auto-categorizing-wiki.md** | "implement-ready" | **SHIPPED** (S51A `d397494`, S51B `6cae7b1`, S51C `3dbc307`) | `src/topics/cluster.ts`, `src/wiki.ts`, `/mega-topics` all present + tested |
| **slice2-pglite-vector-index.md** | "PLANNED" | **SHIPPED v0.4.25** | BACKLOG "Shipped Items" + CLAUDE.md §5 "Slice 2 v0.4.25" |
| **s49-program-per-turn-memory-platform.md** | "Program plan → S49 spec implement-ready" | S49/S50/S51 ALL **SHIPPED**; only S52 remains | commits `ee5a0ed`…`31200b7` |
| **s47-auto-categorizing-wiki.md** | "Draft → implement-ready" | **SHIPPED via S51** (s51 is the re-target; s47's 14 criteria adopted) | s51 doc §"WHAT CHANGES VS S47" |
| **s42-raptor-multilevel-retrieval.md** (this branch) | "S42A shipped → S42B/D implement-ready" | **FULLY SHIPPED on master** (stale on this branch because master not merged) | master has `serve-gate.test.ts`, full raptor |

### Gap C-1: update the 5 stale status markers to SHIPPED (after the §B merge lands, so the truth is consistent on one branch)

---

## D. 🔴 UNTRACKED unfinished work — `find-pressure-basis-oscillation`

- Spec status: **"Confirmed root cause (code-path analysis); fix not yet written"**.
- Code search: **no reference to `pressureBasis`/`pressure_basis`/`oscillation` in `src/` or `extensions/`** on this branch **or master**.
- ROADMAP/BACKLOG: **not listed** in either.
- Only mention: a cross-ref in `s27-tiered-percent-threshold.md`.

### Gap D-1: this is a confirmed diagnosis with no fix and no backlog entry. Either (a) write the fix, or (b) add it to BACKLOG.md explicitly, or (c) mark the spec "won't fix" with rationale. Currently it is invisible to planning

---

## E. Missing S52 spec (program incomplete)

The program (`s49-program-per-turn-memory-platform.md` §2) defines four sprints:

| Sprint | Capability | Spec exists? | Status |
| ------ | ---------- | ------------ | ------ |
| S49 | Turn-DB Foundation | ✅ `s49-turn-db-foundation.md` | shipped |
| S50 | Per-Turn Metrics + Fork | ✅ `s50-per-turn-metrics-fork.md` | shipped |
| S51 | Auto-Categorizing Wiki | ✅ `s51-auto-categorizing-wiki.md` | shipped |
| **S52** | **Dashboard Management + Rewind** | ❌ **NO spec** | **unspecced** |

S50 explicitly defers to S52: "dashboard tab is S52, out of scope here." S51 likewise
defers the Wiki tab + rewind handshake to S52. The `pending_fork` table was pre-created
in S49's schema for S52's rewind handshake. **None of S52 is specced or started.**

### Gap E-1: write `docs/specs/s52-dashboard-rewind.md` before implementing the dashboard Turns tab + Wiki tab + rewind-intent handshake. The program is 3/4 specced

---

## F. Partial implementations with remaining work (TRACKED — not gaps, but status)

These are tracked in ROADMAP.md / BACKLOG.md; listed for completeness:

- **s25-cross-repo E2E** — NOT STARTED (P1, tracked). Feature shipped v0.5.0 but no automated two-repo proof.
- **s25-memory-db-roundtrip** — NOT STARTED (P1, tracked).
- **Phase 2/3/4** (zstd tiers, content-addressable dedup, Tier-1 MinHash+LSH) — NOT STARTED (P2, tracked). Note: `src/dedup/l1-minhash.ts`, `l1-lsh.ts`, `l1-verify.ts`, `bloom.ts` already exist per CLAUDE.md §5 — partial Phase 3/4 scaffolding may already be in tree; verify before re-listing.

---

## G. Audit-fix verification (this branch, commit `f844ef1`)

The 3 corner-cuts found in the prior sprint audit are all fixed and verified:

| Fix | Verification |
| --- | --- |
| S49 VACUUM reclaim-space test added | `turnStore.test.ts` "VACUUM reclaims file space after prune (S49C-2)" passes |
| S51 `cluster.ts` split into `cluster.ts` (187) + `kselection.ts` (174) | both < 300-line cap; 8 cluster tests pass; grep-assert still covers `src/topics/` |
| `prebuild` clean step kills stale `dist/` artifacts | `npm run build` auto-cleans; phantom failures 5 → 1 |

Rejected (correct): unspec'd `checkpoint/restore/conversationStats/pruneTurnsReport` reverted (spec-first).

Not loosened (correct): `vector-search-cache` perf-budget flake is pre-existing (`f65e477`) and unrelated — needs its own task, not a budget cut.

---

## H. Summary — gaps by priority

| # | Priority | Gap | Type | Action |
| - | -------- | --- | ---- | ------ |
| B-1 | 🔴 CRITICAL | `s49-turn-db` and `master` diverged; two S49 architectures; S50/S51 not on master; S25/S42 completion not on this branch | Branch reconciliation | Human decision: pick S49 design, merge, resolve 13 conflicts, port both sides' work |
| D-1 | 🔴 HIGH | `find-pressure-basis-oscillation` fix not written + untracked | Untracked unfinished work | Write fix OR add to BACKLOG OR mark won't-fix |
| E-1 | 🟡 MEDIUM | S52 (Dashboard + Rewind) has no spec | Missing spec | Write `s52-dashboard-rewind.md` before implementing |
| C-1 | 🟡 MEDIUM | 5 stale status markers (s51, slice2, s49-program, s47, s42) | Doc hygiene | Update markers to SHIPPED after §B merge |
| F | 🟢 LOW | s25-cross-repo, s25-roundtrip, Phase 2/3/4 | Tracked future work | No action (already in BACKLOG) |

**The audit fixes from the prior review (§G) are complete and correct.** The remaining
gaps are pre-existing project-structure issues (diverged branches, untracked diagnosis,
missing program-final spec), not corner-cuts in the S49/S50/S51 work itself.
