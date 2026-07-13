# Dedup Incident Runbook — pi-mega-compact

**Applies to:** v0.2.0 dedup pipeline (L0/L1/L2/RAPTOR tiers, Sprint 9–14)
**Owner:** pi-mega-compact on-call
**Status:** DONE

Companion to `RETENTION_POLICY.md`. Use this for live dedup incidents: data
loss, false-positive collapse, or an injection loop.

---

## 1. Severity tiers

| SEV | Definition | Examples |
|---|---|---|
| **SEV-1** | Data loss or injection loop | Checkpoints hard-deleted; same region re-inserted every compact (infinite growth / loop); anchor floor violated; SQLite corruption. |
| **SEV-2** | False-positive / false-negative dedup | A distinct region wrongly collapsed (`deduped`), or a true duplicate kept (`new`) — wrong tier firing point. |
| **SEV-3** | Monitoring gap | `events.log` / `dashboard.json` stale or missing; FP alert not firing; canary not stepping. |

---

## 2. First 15 minutes — checklist

1. **Stop the bleeding (SEV-1 loop/data-loss).**
   - If an injection loop is suspected, flip the offending tier(s) to
     `MARK_ONLY` (record, don't collapse) — see §4. This stops new collapses
     while preserving data + replay.
   - If hard deletion is suspected, **do not run `VACUUM`** — leave rows in
     place for recovery. Pull a copy of `~/.pi/agent/extensions/pi-mega-compact`
     first.
2. **Confirm scope.** Read `/mega-status` (store stats) and the live state:
   ```bash
   tail -f ~/.pi/agent/extensions/pi-mega-compact/events.log | jq .
   ```
3. **Triage the signal.** In `events.log` each decision is
   `{ts, tier, result, latencyMs, falsePositive?}`. Look for:
   - `result:"deduped"` on regions that should be distinct → SEV-2 FP.
   - `result:"new"` on near-identical regions → SEV-2 FN.
   - Repeated `result:"new"` with identical `regionHash` → SEV-1 loop.
4. **Check the FP alert / canary (SEV-2 / SEV-3).** A breached tier auto-flips
   to `MARK_ONLY` and writes `DEDUP FP BREACH tier=<T> rate=<r> > <limit>` to
   `events.log` (see §5). Confirm the alert fired; if not, you have a SEV-3.
5. **Verify the store is intact (SEV-1).**
   ```bash
   sqlite3 ~/.pi/agent/extensions/pi-mega-compact/sqlite.db \
     "PRAGMA integrity_check;"
   ```
   Expect `ok`. If corrupt, run the DR restore drill (§6).
6. **Contain + notify.** For SEV-1/SEV-2, set the offending tier flag to a safe
   value (env / config) and open an issue with `/mega-status` output + a slice
   of `events.log`.

> All signals are **local files** — `events.log` and `dashboard.json` — never a
> network port (PREVENT-PI-004). There is no remote alertmanager; alerts are
> in-process and written to disk.

---

## 3. Tier reference

| Tier | Flag | What it does | Threshold (default) |
|---|---|---|---|
| L0 | `MEGACOMPACT_L0_ENABLED` | Exact content-hash dedup. | `DEDUP_SIM` (0.90) fallback; `MARK_ONLY_L0`. |
| L1 | `MEGACOMPACT_L1_ENABLED` | MinHash/LSH near-dup. | `L1_JACCARD` (0.8); `MARK_ONLY_L1`. |
| L2 | `MEGACOMPACT_L2_ENABLED` | Semantic cosine + MMR. | `L2_COSINE` (0.85); `MARK_ONLY_L2`. |
| RAPTOR | `MEGACOMPACT_RAPTOR_ENABLED` | Pre-compression summary tree. | `false` (shadow by default). |

Thresholds and flags are defined **once** in `src/config/dedup.ts`
(`DedupConfig` / `loadDedupConfig()`) — the single source of truth.

---

## 4. MARK_ONLY — safe partial degrade

`MARK_ONLY_L0` / `MARK_ONLY_L1` / `MARK_ONLY_L2` let a tier **run and record its
decision** (the row gets `dedup_status` set, `events.log` carries
`result:"mark_only"`) but **does not collapse** the region — the checkpoint is
stored as a new `active` row. This is the safe partial-rollout / auto-degrade
state: no data is lost, and the decision is kept for replay.

**When to use it:**
- First 15 min of a SEV-1/SEV-2: flip the suspect tier to `MARK_ONLY` to stop
  collapses immediately while you investigate.
- Canary auto-downgrade (§5): a p95 breach flips the tier to `MARK_ONLY`
  automatically.
- Phased rollout: enable a tier first as `MARK_ONLY`, confirm FP rate is calm,
  then set it fully active.

`MARK_ONLY` is **not** available for RAPTOR — RAPTOR has its own shadow mode
(`RAPTOR_ENABLED=false` by default builds + logs to `events.log` but does not
serve retrieval).

---

## 5. Monitoring & canary (local, no network)

**Monitoring (`src/monitoring.ts`)**
- Per-decision `events.log` (append-only JSON): `{ts, tier, result, latencyMs}`.
- Aggregate `dashboard.json`: `decisions`, `deduped`, `falsePositives`,
  per-tier `latency` samples (capped at 1000), `storageBytes`.
- `evaluateAlerts(metrics, cfg)`: if FP rate over the window exceeds
  `FP_RATE_L0` (default 0.01 / 1%) for L0 or `FP_RATE_L1L2` (default 0.05 / 5%)
  for L1/L2, the tier is auto-flipped to `MARK_ONLY` and a warning is written to
  `events.log`. Window = `ALERT_WINDOW_MS` (default 600000 ms = 10 min).

**Canary (`src/canary.ts`)**
- `CanaryController` starts **L0 only**, then `stepForward()` enables
  L0 → L1 → L2 → RAPTOR in order.
- `evaluate(metrics)`: any enabled tier whose **p95 latency > `P95_BUDGET_MS`**
  (default 100 ms) is **auto-disabled** (no human-in-the-loop, QA #19).
- Degraded tiers go to `MARK_ONLY` (graceful) rather than fully off.

**SEV-3 detection:** if `events.log` stops appending or `dashboard.json` is
stale, the alert path isn't running — verify the extension is loaded
(`/mega-status`) and that monitoring write paths are writable.

---

## 6. DR restore drill (SEV-1 corruption)

`scripts/dedup-restore-drill.sh` (Sprint 15):

1. `PRAGMA integrity_check` → assert `ok`.
2. `SELECT COUNT(*) FROM context_chunks` → compare to the legacy JSON snapshot
   checkpoint count.
3. Recompute the `region_hash` set; compare to stored hashes (catch state drift).
4. If `sqlite.db` missing/corrupt: rebuild from
   `<sessionId>.checkpoints.json.gz` via `migrateJsonToSqlite(stateDir)`. The
   JSON snapshots are retained as a fallback (see `RETENTION_POLICY.md` §5).

---

## 7. Rollback cheat-sheet

| Symptom | Immediate action |
|---|---|
| Injection loop | Set suspect tier `MARK_ONLY_*` = `true`; copy state dir; investigate. |
| Wrong collapse (FP) | `MARK_ONLY_*` = `true`; check `events.log` for `DEDUP FP BREACH`. |
| FP alert not firing (SEV-3) | Verify extension loaded; check `events.log`/`dashboard.json` writable. |
| p95 breach | Canary auto-disables; if manual, set `MEGACOMPACT_*_ENABLED=false`. |
| SQLite corrupt | Restore from `*.checkpoints.json.gz` via `migrateJsonToSqlite`. |
