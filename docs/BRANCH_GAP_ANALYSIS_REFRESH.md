# Branch Gap Analysis — Refresh (2026-07-30)

**Base:** `origin/master` @ v0.11.0 (`f79d7ca`)
**Refreshes:** `docs/BRANCH_GAP_ANALYSIS.md` (2026-07-29) — branches have moved since.
**Scope:** (1) re-verify branch state, (2) assess the in-flight **S53 prompt-cache/memory**
implementation on `fix-turnstore-divergence` against the upstream spec, (3) what remains
to actually fill the empty Cache tab + improve cache stability.

> **Headline:** the empty Cache tab is **already fixed** on the local S53 branch
> (`CacheTab.tsx` now fetches `/api/provider-cache`). Sub-sprints A (query+API) and B
> (pricing+card) are **done**. C is partial; **D (the actual cache-stability hit-rate fix)
> is mostly NOT done** — that's where the cost savings live.

---

## 1. Branch state vs the 07-29 analysis (what changed)

| Branch | 07-29 | Now (07-30) | Delta |
|--------|-------|-------------|-------|
| `feat/memory-system-enhancements` | empty (0/0) | **still empty (0/0)** | unchanged — still a bare pointer at master tip |
| `feature/promptcache-stats` | 1 commit (`b9a9519`, docs only) | **2 commits** — added `f2c085f`: 642-line sprint spec v2 + 233-line S53 recall-tail-injection spec | upstream evolved the plan; still **docs only, no impl code** |
| `s49-turn-db-foundation` | 2/29 (superseded) | unchanged (2/29) | superseded by v0.11.0 reconcile |
| `worktree-benchmark-suite` | 1/148 (superseded) | unchanged (1/148) | superseded by real-repo bench |
| `worktree-real-repo-bench` | 2/148 (valuable, needs rebase) | unchanged (2/148) | still valuable; still needs rebase + rerun |

**Net:** the only branch that moved is `feature/promptcache-stats`, and only with **more
planning docs** — zero feature code has shipped to any remote branch since the 07-29
analysis. The actual S53 implementation exists **only on the local `fix-turnstore-divergence`
branch** (commits `b672d7a` + `4f8d003`).

**The 07-29 analysis's verified claims STILL hold on master** (re-checked):
- `CacheTab.tsx` (master) fetches only `/api/snapshot` → dedup stats → zeros. ✔
- `perf-handler.ts` captures `{input, cacheRead, cacheWrite}` per turn. ✔
- `/api/perf` is rolling-window only, no lifetime token totals. ✔
- `mega-runtime/snapshot.ts` `cachePct = dedupHitRate * 100` (mislabeled). ✔

So master still has the empty-Cache-tab bug; the local S53 branch fixes it.

---

## 2. S53 implementation assessment (local branch vs the upstream spec)

The upstream spec (`docs/specs/sprint-promptcache-stats.md` on `feature/promptcache-stats`)
defines 4 sub-sprints. Status on the local branch:

### Sub-sprint A — Query + API layer ✅ DONE
- `/api/provider-cache[?minutes=N]` route exists (`extensions/dashboard-server/routes-cache.ts`). ✔
- `readProviderCacheStats()` query exists (`src/store/sqlite/perf-samples.ts:191`). ✔
  (Spec named it `readProviderCacheLifetime`; impl named it `readProviderCacheStats` —
  functionally equivalent, minor naming drift.)
- Wired into the server dispatch chain. ✔

### Sub-sprint B — Pricing + dashboard cards ✅ DONE
- `ProviderCacheCard.tsx` exists. ✔
- `MemoryEffectivenessCard.tsx` exists (the S53B memory-side card). ✔
- `src/pricing.ts` implements `$ saved` from `inputRatePerToken` (cacheRead×0.9 save,
  cacheWrite×0.25 premium — matches spec D3). ✔
  - **Deviation:** the spec struck `pricing.ts` ("pricing comes from model_snapshots, no new
    module"). A `pricing.ts` was built anyway. Functionally fine; just wider than spec.

### Sub-sprint C — TUI snapshot fix ⚠️ PARTIAL
- `mega-runtime/snapshot.ts:189-192`: `cachePct` now **conditionally** reads the provider hit pct:
  `(p.lastProviderCacheHitPct ?? st.dedupHitRate * 100)` — falls back to dedup rate when no
  provider sample. ✔ (better than spec — spec said always-provider; impl degrades gracefully)
- **D5 (MEGA CACHE flare gate) ❌ NOT FIXED.** `widget.ts:79` and `:103` still gate the flare
  on `cachePct >= 100`. After sub-sprint C, `cachePct` is the provider hit pct (bounded 0–100),
  so the dedup flare (which legitimately exceeds 100%) is **silently dead**. Spec D5 says gate
  on `wd.megaCacheFlare && wd.megaCacheFlarePct >= 100` instead. One-line fix, two sites.

### Sub-sprint D — Cache-stability (the hit-rate fix) ❌ MOSTLY NOT DONE
This is the sub-sprint that actually raises the cache hit rate (and thus the cost savings).
Of the 3 verified bugs:
- **Bug #4 (`RECOMPACT_PCT_DELTA` 10→50) ❌ NOT FIXED.** `context-handler.ts:316` still hardcodes
  `const RECOMPACT_PCT_DELTA = 10`. Every 10% window growth triggers a full prefix rebuild.
  Spec: env-overridable (`MEGACOMPACT_RECOMPACT_PCT_DELTA`, default 50).
- **Bug #5 (debounce before replay) ✅ ALREADY CORRECT.** The replay check at
  `context-handler.ts:312` sits *above* where a debounce would gate fresh compaction — the
  ordering the spec wants. (Either the codebase already had it right, or an earlier fix landed.)
- **Bug #6 (skip paths revert to full transcript) ❌ NOT VERIFIED FIXED.** The `ran.skipped`
  fallback path needs an audit against spec D7 ("fall back to replay when trimCache valid,
  never to the full transcript").

### Also landed (beyond the spec): S53B memory
- `memoryStats()` + `/api/memory-status` endpoint + `embedder-cache.ts` (FIFO 256, `MEGACOMPACT_EMBED_CACHE`).
  This is the work intended for the (still-empty) `feat/memory-system-enhancements` branch.

---

## 3. What remains to fill the Cache tab + improve cache stability

Ordered by impact (cost/visibility first):

| # | Item | Where | Effort | Impact |
|---|------|-------|--------|--------|
| 1 | **Fix `RECOMPACT_PCT_DELTA` 10→50** (env-overridable) | `context-handler.ts:316` + `mega-config.ts` | S | **High** — the actual cache-stability fix; raises hit rate toward the 80% target |
| 2 | **Fix MEGA CACHE flare gate** (D5) | `widget.ts:79,103` → `megaCacheFlarePct` | XS | Medium — restores the dedup flare game-mode reward |
| 3 | **Audit skip-path fallback** (D7) | `context-handler.ts` `ran.skipped` branch | S | Medium — prevents full-transcript cache misses on skipped compactions |
| 4 | **Verify the Cache tab end-to-end** | manual: run extension, open dashboard, confirm provider card populates | S | confirms items A/B actually render live data |
| 5 | Land S53 on a branch off master + open PR | git | S | unblocks merge |

**Out of scope (per spec, future sprints):**
- Recall injection relocation (systemPrompt → tail user-role message) — 2 cache misses per recall; needs its own sprint (the `s53-recall-tail-injection.md` spec on the remote branch is the planning doc).
- DB-mirror high-water mark (O(n²) hot path).
- PLAN_V2 Phases 2–4 (message separation / vector-aware striping).

---

## 4. Recommended next actions

1. **Land issue #9 + #10 + S53A/B/C-partial** as a PR off master (the local branch is green:
   902 tests, build, lint). The Cache tab will render real provider-cache data + $ savings.
2. **Implement S53 sub-sprint D** (item #1 above) as the immediate follow-up — it's the
   highest-value remaining work (real cost reduction, ~S effort).
3. **Refresh + supersede** `docs/BRANCH_GAP_ANALYSIS.md` with this doc (or fold it in).
4. Cherry-pick the `feature/promptcache-stats` planning docs (`b9a9519`, `f2c085f`) onto
   master as analysis-of-record — they're docs only, zero risk.
5. The `feat/memory-system-enhancements` branch is still empty; either land the S53B memory
   work there or delete it (an empty feature branch misleads).

---

**Authored:** 2026-07-30 · **Verified against:** `origin/master` @ `f79d7ca` + local
`fix-turnstore-divergence` @ `641199e` · **Status:** findings verified by reading current code
