# Sprint 14 — Phase 7: Full Pipeline (flags, backfill, monitoring, canary)

**Date:** 2026-07-13
**Archive date:** 2026-07-13
**Focus:** Wire all tiers with flags + monitoring + safe rollout
**Priority:** P1
**Effort:** L (≈2 days)
**Status:** DONE
**Depends on:** Sprints 9–13 (all dedup tiers implemented)

---

## SAFETY PROTOCOLS

- Gate as Sprint 8.
- PREVENT-PI-004: metrics go to `dashboard.json` + `events.log` — NO Prometheus port, NO network listener.
- QA #18/#19 (local re-map): alerting is a `MARK_ONLY` auto-downgrade + `events.log` warning, not a remote alertmanager.
- HALT if a flag-disabled tier still runs, or a flag-enabled tier crashes the add() path.

---

## PROBLEM STATEMENT

Each tier (L0/L1/L2/RAPTOR) was built in isolation. `PLAN.md` Phase 7 needs them
wired behind independent feature flags, a unified backfill orchestrator, local
monitoring, and a canary rollout that auto-disables a degraded tier. Without
this, a bad threshold in one tier can silently corrupt dedup for all sessions.

**Root cause:** no single config source; no monitoring; no safe rollout.

---

## SCOPE BOUNDARY

**IN SCOPE:**
- `src/config/dedup.ts` — single source of truth: `L0_ENABLED`, `L1_ENABLED`, `L2_ENABLED`, `RAPTOR_ENABLED`, `MARK_ONLY_L1`, `MARK_ONLY_L2`, `MINILM_EMBEDDER`, plus thresholds (cosine, jaccard, mmr λ, bloom, caps).
- `vectorStore.add()` — honor flags; `MARK_ONLY` → insert with `dedup_status` but don't collapse.
- Backfill orchestrator (`src/store/backfill.ts`) — batch loop (1000/batch, throttled), progress table, resumable, per-phase integrity.
- Monitoring: structured `events.log` per dedup decision (tier, result, latency); `dashboard.json` metrics (hit rate, FP rate, per-tier p95, storage).
- Alerting (local): FP > 1% (L0) / > 5% (L1/L2) over 10m → auto `MARK_ONLY` + warning.
- Canary: enable L0 → L1 → L2 → RAPTOR sequentially; auto-disable on degradation.
- `extensions/mega-compact.ts` — load flags from config; report metrics.

**OUT OF SCOPE:** benchmarks/DR/docs (Sprint 15); SQLite internals (Sprint 8).

---

## EXECUTION DIRECTIONS

```
1. config   src/config/dedup.ts: export const DedupConfig = {...}  (single source of truth)
            flags read from env (MEGACOMPACT_*), defaults in file
2. flags    add(): if !L0_ENABLED skip L0; if MARK_ONLY_L1 -> insert, mark 'active', no collapse
            search(): if !L2_ENABLED skip MMR; if !RAPTOR_ENABLED skip raptor_nodes
3. backfill  orchestrator: for each phase [L0 hashes, L1 sigs, L2 embeds, RAPTOR]:
            SELECT unprocessed WHERE status='pending' LIMIT 1000;
            process; UPDATE status='done'; log progress; resume from last id
4. monitor  on each add() decision: events.log.append({ts, tier, result, latencyMs})
            dashboard.json: aggregate hitRate, fpRate, p95[tier], storageBytes
5. alert    rollup 10m window: if fpRate[tier] > threshold -> set MARK_ONLY[tier]=true,
            events.log.warn("DEDUP FP BREACH tier=L1 -> MARK_ONLY")
6. canary   startup: enable L0; after N sessions stable, enable L1; ... auto-disable on p95 breach
```

**Key details:**
- **Single config source** (QA #8-era): no threshold duplicated across modules; `DedupConfig` is the only definition.
- **MARK_ONLY** (QA ops): a degraded tier still records the decision (so we keep data + can replay) but doesn't collapse — safe partial rollout.
- **Local monitoring** (QA #18/#19): `events.log` + `dashboard.json` only; no port, no network (PREVENT-PI-004).
- **Canary** (QA #19-era): sequential enablement; auto-disable on breach — no human-in-loop needed for safe degradation.

---

## ACCEPTANCE CRITERIA

- [x] `npm test` green (12 new S14 tests; full suite 192 pass).
- [x] Flag matrix: all 16 L0/L1/L2/RAPTOR enable combos don't crash `add()`/`search()`.
- [x] `MARK_ONLY_L1=true` → L1 match recorded (`dedup_status='active'`) but not collapsed (new checkpoint stored).
- [x] Backfill resumes after a simulated interrupt (kill at batch 5, restart → continues from batch 6 via cursor).
- [x] Alert fires on an injected FP spike (fpRate breach → MARK_ONLY flagged + `events.log` warning).
- [x] Canary auto-disables a tier whose p95 exceeds budget.
- [x] `guardrails-scan` clean.

### Implementation notes / addendum

- **Single config source** (`src/config/dedup.ts`): `DedupConfig`/`loadDedupConfig()` —
  every tier flag (L0/L1/L2/RAPTOR), MARK_ONLY per tier, MINILM_EMBEDDER, and all
  thresholds (L2_COSINE, L1_JACCARD, DEDUP_SIM, MMR_LAMBDA, SEMDEDUP_COSINE, budgets,
  FP/alert/p95) read from `MEGACOMPACT_*` env with file defaults. No threshold is
  duplicated across modules (QA #8). `VectorStore.add()`/`search()` honor it; the
  legacy `l2Enabled`/`dedupSim` opts are accepted but `cfg` is authoritative.
- **MARK_ONLY** (QA ops): a tier in MARK_ONLY still RUNS and RECORDS its decision
  (events.log carries `result:"mark_only"`) but does NOT collapse — the region is
  stored as a new active checkpoint. Implemented by falling through to the "new"
  path instead of returning early on a match.
- **Monitoring** (`src/monitoring.ts`): per-decision `events.log` (ts/tier/result/
  latency) + `dashboard.json` aggregate metrics (decisions, deduped, FP count,
  per-tier latency samples, storage). `recordDecision` caps latency samples at 1000.
  `evaluateAlerts` flips a breached tier to MARK_ONLY + writes a warning (local
  re-map of alertmanager, QA #18/#19). NO port, NO network (PREVENT-PI-004).
- **Backfill** (`src/store/backfill.ts`): existing L0 hash backfill extended with
  resumable `backfillPhase("L1"|"L2")` (batched, cursor in `backfill_progress`,
  `interruptAfterBatches` for resume testing) + `backfillRaptor` (single pass
  builds + persists `raptor_nodes`). Resume verified: interrupt at batch 1
  (cursor chkpt_005) → restart continues to 12.
- **Canary** (`src/canary.ts`): `CanaryController` starts L0-only, `stepForward()`
  enables L0→L1→L2→RAPTOR in order; `evaluate(metrics)` auto-disables any tier
  whose p95 > `P95_BUDGET_MS`. `runCanary(feed)` drives the full rollout. No
  human-in-the-loop (QA #19).
- **VectorStore** gained optional `eventsPath` (decision events). `search()` skips
  MMR when `L2_ENABLED` is false (QA #10 tier gating); `semDedup` defaults its
  threshold from `cfg.SEMDEDUP_COSINE`.
- **Schema**: `raptor_nodes` (Sprint 13) + `backfill_progress` (Sprint 10) carry
  the new state. All additive; retrieval (`context_chunks`) unchanged.

---

## ROLLBACK PROCEDURE

```bash
git revert <this-commit-sha>
```
Flags default to the Sprint 13 behavior (all tiers active). `DedupConfig` revert
returns to per-tier inline defaults. Monitoring files are additive.
