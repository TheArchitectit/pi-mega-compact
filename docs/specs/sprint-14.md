# Sprint 14 — Phase 7: Full Pipeline (flags, backfill, monitoring, canary)

**Date:** 2026-07-13
**Archive date:** (set on completion)
**Focus:** Wire all tiers with flags + monitoring + safe rollout
**Priority:** P1
**Effort:** L (≈2 days)
**Status:** READY
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

- [ ] `npm test` green.
- [ ] Flag matrix: each of L0/L1/L2/RAPTOR on/off (16 combos) doesn't crash `add()`/`search()`.
- [ ] `MARK_ONLY_L1=true` → L1 match recorded (`dedup_status='active'`) but not collapsed.
- [ ] Backfill resumes after a simulated interrupt (kill at batch 5, restart → continues from batch 6).
- [ ] Alert fires on an injected FP spike (fpRate breach → MARK_ONLY set + `events.log` warning).
- [ ] Canary auto-disables a tier whose p95 exceeds budget.
- [ ] `guardrails-scan` clean.

---

## ROLLBACK PROCEDURE

```bash
git revert <this-commit-sha>
```
Flags default to the Sprint 13 behavior (all tiers active). `DedupConfig` revert
returns to per-tier inline defaults. Monitoring files are additive.
