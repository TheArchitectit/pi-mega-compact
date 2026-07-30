# Remote Branch Gap Analysis — 2026-07-29

**Base:** `origin/master` @ v0.11.0 (`f79d7ca`, S49–S52 per-turn memory platform shipped)
**Remote analyzed:** `origin` = github.com/TheArchitectit/pi-mega-compact
**Companion spec:** [specs/s53-prompt-cache-memory-program.md](specs/s53-prompt-cache-memory-program.md)

---

## 1. TL;DR

| Branch | Ahead | Behind | Content | Verdict |
| -------- | ------ | -------- | --------- | --------- |
| `feat/memory-system-enhancements` | 0 | 0 | **Nothing** — pointer at master tip | Empty placeholder; fill with S53B work or delete |
| `feature/promptcache-stats` | 1 | 0 | 3 docs, 887 lines (findings / gap analysis / plan v2) | Cherry-pick docs to master; implement via S53 program (plan v2 has 4 blocking issues, §3.2) |
| `s49-turn-db-foundation` | 2 | 29 | Prettier pass + map/CLAUDE.md updates | Superseded by the v0.11.0 reconcile merge; cherry-pick `25cd374` at most, then close |
| `worktree-benchmark-suite` | 1 | 148 | Synthetic TS benchmark suite (1,380 LOC) | Superseded by `worktree-real-repo-bench`; do not merge |
| `worktree-real-repo-bench` | 2 | 148 | Real-repo head-to-head bench vs pi-vcc + fair-comparison protocol | Valuable; merge after rebase; rerun one repo before quoting results |

**Net unshipped code across all five branches: ~750 LOC of benchmark tooling and zero feature code.** The prompt-cache branch is documentation only. The memory-system-enhancements branch has no commits at all.

**The empty Cache tab (user-reported) is fully explained by `feature/promptcache-stats`'s findings doc** and verified against master in §3.2: provider cache data is captured but never surfaced; the tab reads the wrong API.

---

## 2. Inventory

| Branch | Branch-only commits | Last commit | Author | Merge-base |
| -------- | -------------------- | ------------ | -------- | ------------ |
| `feat/memory-system-enhancements` | — | `f79d7ca` (= master tip) 2026-07-29 | TheArchitectit | master tip |
| `feature/promptcache-stats` | `b9a9519` | 2026-07-29 20:48 | TheArchitectit | master tip |
| `s49-turn-db-foundation` | `25cd374`, `a13676b` | 2026-07-29 14:49 | TheArchitectit | pre-v0.11.0 reconcile |
| `worktree-benchmark-suite` | `437f105` | 2026-07-23 20:38 | Claude | `af03d65` (v0.8.15 era) |
| `worktree-real-repo-bench` | `67351fc`, `0ebf58d` | 2026-07-23 23:13 | Claude | `af03d65` (v0.8.15 era) |

The two `worktree-*` branches **diverged from each other** (same v0.8.15-era base; one adds a TS suite, the other adds an `.mjs` real-repo suite — neither contains the other's files). Merging both would create a pointless add/delete history.

---

## 3. Per-Branch Findings

### 3.1 `feat/memory-system-enhancements` — EMPTY

- `git log master..branch` → ∅. The branch is a tag on the master tip, pushed ~1h before this analysis.
- **Gap:** whatever "memory system enhancements" were intended never left the working tree. There is nothing to review.
- **Action:** treat as a task slot, not a work product. The S53B sub-sprint in the companion spec (memory-aware cache stability + memory effectiveness surfacing) is scoped to land **on this branch**. Otherwise delete it — an empty feature branch lies to the branch list.

### 3.2 `feature/promptcache-stats` — docs only, high value, 4 blocking issues

One commit (`b9a9519`), three docs:

| Doc | Lines | Content |
| --- | ------ | --------- |
| `docs/PROMPTCACHE_FINDINGS.md` | 56 | Root-cause of the empty Cache tab: capture works (43 `cache_hit_pct` samples, 60–98% hits in `perf_samples`), but `CacheTab.tsx` reads `/api/snapshot` (dedup stats), and `/api/perf`'s 30-min rolling window hides the data — latest sample was 68 min old |
| `docs/PROMPTCACHE_FULL_GAP_ANALYSIS.md` | 344 | Competitive matrix (Claude Code, VS Code Cache Explorer, Aider, Helicone, LangSmith, Portkey, LiteLLM), P0–P3 gap list, phased plan, cost math |
| `docs/PROMPTCACHE_PLAN_V2.md` | 487 | "Vertical cache striping" draft: message separation + vector-aware stripes, schemas, prompt builders, 4 implementation phases |

**Verified against master — every claim in FINDINGS checks out:**

- `extensions/mega-events/perf-handler.ts:70-76` captures `{input, cacheRead, cacheWrite}` per turn as `cache_hit_pct` samples. ✔
- `extensions/dashboard-client/src/tabs/CacheTab.tsx:17-28` fetches only `/api/snapshot` → dedup/compaction stats → zeros when no compaction has fired (threshold 50%). ✔
- `/api/perf` (`routes-game.ts:202-309`) is rolling-window only (default 30 min, clamped [1, 1440]) and returns `avg/latest/n` — **no token totals**. ✔
- TUI widget `cachePct = st.dedupHitRate * 100` (`mega-runtime/snapshot.ts:180`) — mislabeled source confirmed. ✔
- React `PerfCards.tsx:67` / `PerfChart.tsx:93-97` and the legacy HTML dashboard (`dashboard-client-game.ts:193-205`) do render provider `cache_hit_pct`, but only inside the 30-min window on other tabs — nothing on the Cache tab itself. ✔

**Blocking issues in PLAN_V2 (the implementing spec must fix these):**

1. **PREVENT-PI-002 violation (fatal for its Phase 2 as written).** The plan restructures the message array to append tool results "at the END" of the prompt. That separates each `tool_use`/`tool_result` pair from its conversation position — splitting a toolCall/toolResult pair is a scanner-enforced **error**, and every provider contract requires a `tool_result` to directly follow its `tool_use`. Needs a pair-atomic redesign (see S54 in the companion spec).
2. **Duplicates shipped tables.** Its new `conversation_thread` / `tool_results` tables re-implement what v0.11.0 already stores: `raw_transcript` (S27: role, tool_name, tool_call_id, content_hash, seq per message) and `turns` / `turn_recall` (S48–S52). New message tables are forbidden; read existing ones.
3. **PREVENT-002 violations in sample code.** Template-literal SQL bodies and mixed `?`/`$1` placeholder styles. Implementation must use existing store helpers with parameterized queries only (scanner-enforced).
4. **Stale paths.** `extensions/perf-handler.ts` → actual `extensions/mega-events/perf-handler.ts`; `routes-game.ts` is at 385 lines (400 soft limit) → new handlers go in a new `routes-cache.ts`; `api-contracts/endpoints.ts` is at 556 lines (over the 500 hard limit) → new contract types go in `api-contracts/cache.ts`.

**Action:** cherry-pick `b9a9519` onto master as the analysis-of-record; implement via the S53 program spec, which supersedes PLAN_V2 Phases 2–4.

### 3.3 `s49-turn-db-foundation` — superseded

- 27 of its 29 historical commits reached master via the `s49-master-reconcile` merge (v0.10.x–v0.11.0).
- Remaining 2 branch-only commits: `a13676b` (prettier pass on turns store + tests — formatting-only vs master's identical logic) and `25cd374` (docs: S49A entries in HEADER_MAP / INDEX_MAP / CLAUDE.md).
- **Action:** check whether master's maps already carry the S49A entries (v0.10.1/v0.11.0 shipped doc refreshes — likely yes); if not, cherry-pick `25cd374` only. Close the branch. A wholesale merge would re-import 29 behind-commits of divergence for a prettier diff.

### 3.4 `worktree-benchmark-suite` — superseded

- `437f105` adds a synthetic TS suite under `scripts/benchmark/` (compactors/corpus/extract/facts/run/score, 1,380 LOC) + `docs/BENCHMARKS.md`.
- Branched at v0.8.15 — predates the S49–S52 platform, the PGlite index, and multiple engine changes it claims to measure.
- **Action:** do not merge. The real-repo suite (§3.5) is the better instrument; neither master nor the other branch contains these TS files.

### 3.5 `worktree-real-repo-bench` — valuable, needs rebase

- `67351fc` adds `scripts/benchmark/{bench-mega.mjs, bench-vcc.mjs, README.md}` — 1M-token real-repo head-to-head mega-compact vs pi-vcc across 3 repos (rad-gateway, game04, pi-ithacus-agent-framework): compact output 35–64k tokens vs pi-vcc 1–4k (mega keeps ~15–40× more context at the same input scale — that delta is the marketing number, but see rerun caveats).
- `0ebf58d` adds `docs/REAL_REPO_BENCHMARKS.md` + fair-comparison protocol + BENCHMARKS.md/INDEX_MAP entries.
- **Gaps:** (a) `.gitignore` +5 lines and `docs/INDEX_MAP.md` +1 will conflict trivially on rebase; (b) **doc/code drift inside the branch** — repro commands say `npx tsx scripts/benchmark/real-repo-benchmark.ts`, but the branch ships `bench-mega.mjs`/`bench-vcc.mjs` (no such `.ts` file); fix commands to `node scripts/benchmark/bench-mega.mjs` style during rebase; (c) results predate v0.11.0 — rerun at least one repo before quoting in release notes; (d) not wired into the regression gate (fine — manual benchmark by design).
- **Action:** rebase onto master, fix repro commands, rerun one repo, merge, close both `worktree-*` branches.

### 3.6 Local (not remote): `fix-turnstore-divergence` — uncommitted, 16 files, +174/−18

In-flight on this machine: `DuplicateTurnError` typed error unified across `SqliteTurnStore` / `InMemoryTurnStore` (ISSUE #9 — SQLite stores threw raw `ERR_SQLITE_ERROR`, memory store silently appended duplicates), `disposePendingTimers` for the durable-trim recheck timer (RT2), l1-minhash / vectorStore tweaks, CI yaml touch. **Action:** finish, gate (build+test+lint+regression), land before branching S53 work.

---

## 4. Feature Gaps the Branches Expose (why the Cache tab is empty)

Cross-cutting state on master, independent of any branch:

| Layer | Provider prompt cache | Internal dedup cache | Gap |
| ------ | ---------------------- | --------------------- | ----- |
| Capture | ✅ `cache_hit_pct` + `{input,cacheRead,cacheWrite}` per turn | ✅ hit counters | none |
| Storage | ✅ `perf_samples` (kind, value, meta JSON, ts) | ✅ turns/context tables | none |
| Query | ⚠️ rolling-window only (≤24 h), avg/latest/n — **no lifetime totals, no token sums** | ✅ | `readProviderCacheStats()` missing |
| API | ⚠️ `/api/perf` only | ✅ `/api/snapshot` | aggregate endpoint missing |
| Cache tab | ❌ not rendered at all | ✅ (wrong tab identity — shows dedup under the name "Cache") | tab shows the wrong system's data |
| TUI footer | ❌ shows dedup rate labeled as cache % | ✅ (source of the mislabel) | swap source |
| Cost | ❌ all "$ saved" from caching = — | ⚠️ freed-tokens heuristic only | no pricing constants, no 10×/1.25× cache math |
| Per-repo | ❌ `perf_samples` has no `repo_id` column | ✅ per-repo elsewhere | provider cache is machine-wide only |
| Memory effectiveness | n/a | ⚠️ stored, no recall hit-rate/stability surfaced | the empty `feat/memory-system-enhancements` remit |

---

## 5. Landing Order (recommended)

1. Land local `fix-turnstore-divergence` (gate: build + test + lint + regression).
2. Cherry-pick `b9a9519` (prompt-cache docs) onto master — docs only, zero risk.
3. Verify master's maps vs `25cd374`; cherry-pick if needed; close `s49-turn-db-foundation`.
4. Rebase + fix repro commands + merge `worktree-real-repo-bench`; close both `worktree-*` branches.
5. Execute the S53 program on two branch slots: S53A/S53C (visibility + TUI) on `feature/promptcache-stats`-follow-up, S53B (memory) on `feat/memory-system-enhancements` — finally giving that branch content.
6. Release only via `./scripts/deploy.sh <version>` (PREVENT-DIST-001).

---

**Authored by:** analysis pass 2026-07-29
**Status:** findings verified against `origin/master` @ `f79d7ca`
