# Sprint 15 — Release: benchmarks, DR, docs, tag v0.2.0

**Date:** 2026-07-13
**Archive date:** (set on completion)
**Focus:** Prove, document, ship
**Priority:** P0
**Effort:** M (≈1 day)
**Status:** READY
**Depends on:** Sprints 8–14 (full pipeline implemented)

---

## SAFETY PROTOCOLS

- Gate as Sprint 8 (this is the release gate — must be fully green).
- PREVENT-PI-004: DR drill reads local files only; no network.
- Do NOT bump `package.json` version without the tag step.
- NO FORCE PUSH; tag + GitHub release only (user-permission gate for push).

---

## PROBLEM STATEMENT

The pipeline is built but unproven at scale, has no disaster-recovery drill, and
the docs (README, RETENTION_POLICY, RUNBOOK) don't reflect v0.2.0 (pglite,
embedder modes, flags). Ship must be credible: benchmarks hit targets, DR drill
passes, guardrails + CI green.

**Root cause:** no scale proof; no DR; docs stale.

---

## SCOPE BOUNDARY

**IN SCOPE:**
- `scripts/dedup-restore-drill.sh` — validate pglite integrity + rebuild from JSON snapshots; sentinel recompute (dedup plan §6).
- End-to-end benchmarks at 100 / 1K / 10K checkpoints: dedup hit rate, compression ratio (≥5:1), per-tier p95, storage savings.
- `docs/RETENTION_POLICY.md` — TTL, soft-delete cleanup.
- `docs/DEDUP_RUNBOOK.md` — incident "first 15 min", SEV tiers.
- README + CHANGELOG update (storage backend, embedder modes, config, flags).
- `install.sh` notes pglite data dir.
- Guardrails audit green + `ci.yml`; tag `v0.2.0` + GitHub release.

**OUT OF SCOPE:** new features; any code change beyond docs/scripts.

---

## EXECUTION DIRECTIONS

```
1. BENCH   node scripts/bench-dedup.mjs (or inline): generate 100/1K/10K synthetic
           checkpoints; measure hitRate, compressionRatio, p95[L0/L1/L2], storageBytes
           assert compressionRatio >= 5:1, p95 within budgets (L0<50ms, L1<200ms, L2<300ms)
2. DR      scripts/dedup-restore-drill.sh:
           - validate pglite opens; context_chunks row count matches
           - recompute regionHash set; compare to storedRegionHashes
           - if pglite missing/corrupt: rebuild from <sess>.checkpoints.json.gz snapshots
3. DOCS    RETENTION_POLICY.md (TTL 90d, soft-delete via dedup_status='removed', VACUUM cadence)
           DEDUP_RUNBOOK.md (SEV-1 data loss/injection loop, SEV-2 FP/FN, first-15-min checklist)
           README: storage=pglite, embedder=trigram|minilm flag, flags table, MEGACOMPACT_* env
           CHANGELOG: v0.2.0 section
4. RELEASE npm version minor (0.1.1 -> 0.2.0); git tag v0.2.0; gh release
```

**Key details:**
- **Benchmarks are the release gate**: if compressionRatio < 5:1 or any p95 over budget, do NOT tag — fix or document the miss.
- **DR drill** (dedup plan §6): proves the JSON snapshots from Sprint 8 are a valid fallback; sentinel recompute catches state drift.
- **Docs under 500 lines each** (CLAUDE.md rule); split if needed.

---

## ACCEPTANCE CRITERIA

- [ ] Benchmarks at 100/1K/10K hit: dedupHitRate reported, compressionRatio ≥ 5:1, L0 p95 < 50ms, L1 p95 < 200ms, L2 p95 < 300ms, storage savings quantified.
- [ ] `scripts/dedup-restore-drill.sh` passes: pglite integrity OK + rebuild-from-JSON verified.
- [ ] `RETENTION_POLICY.md` + `DEDUP_RUNBOOK.md` written (< 500 lines each).
- [ ] README + CHANGELOG reflect v0.2.0 (pglite, embedder modes, flags).
- [ ] `ci.yml` green (build + lint + test + regression). NOTE: `npm run lint` has pre-existing `store.test.ts`/`engine.test.ts` failures (FAIL-2026071302) — must be fixed before claiming green, OR explicitly waived with the failure logged.
- [ ] `v0.2.0` tagged + GitHub release published (push requires user permission).
- [ ] `guardrails-scan` clean.

---

## ROLLBACK PROCEDURE

```bash
git tag -d v0.2.0 && git push origin :refs/tags/v0.2.0   # remove tag if release bad
git revert <this-commit-sha>                                 # docs/scripts revert
# v0.1.0 remains installable; pglite data dir is forward-compatible.
```
