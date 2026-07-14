# Plan: pi-mega-compact — best-in-class compaction extension

Goal: make pi-mega-compact the most trustworthy, observable, and powerful context
compaction extension — vs silent competitors (OpenClaw summarizer, Claude Code,
Gemini CLI, Aider repo-map). Built on a hard invariant (see below) and the repo's
local / sync / zero-network / better-sqlite3 / trigram-embedding constraints.

## Hard invariant (unchanged, must hold)
We NEVER lose user data. Every dropped region is preserved verbatim
(`compressed_original` gzip blob) + as a summary. "Drop" = remove from the live
context window only. Dedup removes DUPLICATE storage, not data. Anchor floor
(PREVENT-PI-001) keeps recent N verbatim. All new UI must make this visible.

## Constraints (from code review)
- `VectorStore.add()` is SYNC, returns one `AddResult{reason}`. Whole chain
  extension→compactSession→store.add is sync; PREVENT-PI-004 = no async/network.
  Per-tier live progress = **sync progress callback** (not await).
- `this.record(tier, action, kind, ms)` already fires per tier in add() — hook point.
- Toolbar repaints via `snapshot(ctx)`→`setWidget`; teal activity line = `currentActivity`.
- RAPTOR is shadow (built+persisted in `raptor_nodes`, never served). Serving = real.
- `compressed_original` persisted but never read back (no restore path yet).

## Inputs to this plan (reviews completed)
- Gap analysis of the repo (10 standout ideas; S-wins flagged).
- memory-mcp deep review (cathyos-plasma): auto-compact + checkpoints, RAPTOR +
  vector tech. Portable techniques identified below. Non-portable (FAISS/GPU/
  pgvector/Ollama-LLM/Postgres-CTE/stub vector_search_enhancement) explicitly excluded.

================================================================================
PHASE 0 — Make the invariant VISIBLE (trust foundation)            [effort: M]
================================================================================
Before features, prove we don't lose data.
- Dashboard + `/mega-status`: show "X regions dropped, Y bytes compressed-original
  retained, 0 bytes permanently deleted" + a "restore any" path.
- `/mega-restore <chkpt>` (from Phase 4) is the proof-of-trust action.
- This is the single biggest differentiator vs competitors that drop silently.

================================================================================
PHASE 1 — Live per-tier progress (sync callback)                   [effort: S]
================================================================================
- `AddInput.onTier?: (ev:{tier,status,detail?})=>void`. Fire in add() at L0
  (contentHash scan), L1 (minhash/LSH), L2 (cosine, detail=`sim.toFixed(2)`),
  RAPTOR (building), then outcome (stored / deduped:<reason>).
- `compactSession` forwards `onTier`. Extension passes a callback that updates
  `currentActivity` + calls `snapshot(ctx)` so the toolbar repaints live.
- Toolbar shows `⚙ L0 ✓ → L1 ✓ → L2 0.91 → stored` mid-compaction, settling to
  `🗜 chkpt_005 · files`. Small regions coalesce to outcome; large L2 scans show states.

================================================================================
PHASE 2 — RAPTOR served live (memory-mcp-proven approach)          [effort: M]
================================================================================
Port memory-mcp's PROVEN retrieval pattern, adapted to local/sync/sqlite:
- Build tree with **centroid-averaged** parent nodes (`skip_summarization`
  equivalent: parent embedding = mean of child embeddings). NO LLM — valid for
  L2-normalized trigram vectors. (memory-mcp: raptor.py `_build_level` np.mean.)
- Add **coherence gate**: reject clusters with mean intra-cluster sim < threshold
  (memory-mcp min_coherence_score=0.5).
- Retrieve with **level-weighted search** (prefer leaves, include clusters):
  weights {0:1.0,1:0.9,2:0.8,…} (memory-mcp `search()`).
- **Expand-to-leaves**: if a cluster scores >threshold, fetch its leaf
  descendants for detail (memory-mcp `search_with_expansion`). Reuse existing
  `stagedExpansion`/`listRaptorNodes`/`buildRaptorTree`.
- **CRAG-style adaptive expand** (memory-mcp `crag.py`): if top recall score <
  threshold → broaden (pull RAPTOR leaves / raise recall limit) instead of
  shipping weak context. Local-only, cosine-threshold, no LLM judge.
- Flip `RAPTOR_ENABLED` default true; canary still sequences it last.
- Budget-gated + safe-degrade to vector-only on timeout/empty.
- Tests: RAPTOR-served summaries appear in toInject when tree exists; vector-only
  fallback when absent.

================================================================================
PHASE 3 — Standout toolbar (ANSI, no deps)                         [effort: S]
================================================================================
1. **Compact progress bar** — ASCII bar fills as `rt.tokensSaved` accrues toward a
   rolling goal (`saved 45k ▓▓▓▓░ 38% of 120k`).
2. **Recall history ticker** — ring buffer (~5 events): `chkpt_005 +1.2k · 3 files`,
   `deduped · engine.ts`. Replaces single last-action line (MAX_WIDGET_LINES=10).
3. **Tier badge w/ score** — colored `[L2·0.91]` from `reason` + L2 `sim`.
4. **Live pulsing status** — cycling glyph (`◐◓◑◒`) on status line while a
   compaction is in flight (set on start, cleared on result).
5. **Explain-why line** (gap analysis #3, M→fold here as S via existing `dedupReason`:
   show `why: deduped@L2 0.91` / `superseded file-read` / `anchor-kept`).

================================================================================
PHASE 4 — Cheap standout commands (data already persisted)        [effort: S]
================================================================================
6. **`/mega-restore <chkpt>`** — decompress `compressed_original`, re-inject verbatim
   via before_agent_start. `restoreRecent()` for last. (Trust proof; see Phase 0.)
7. **`/mega-history` + `/mega-view <chkpt>`** — list checkpoints (summary/key files/
   date); decompress + show original region.
8. **Tangible-cost line** — `saved` → `≈ $X` + `context-days extended`
   (contextWindow ÷ savedRate). Concrete vs opaque counters.
9. **Recall quality badge** — FP-rate + per-tier p95 + hit-rate → trust score
   (`recall 92% relevant · 0 FP`). Data in monitoring.ts, never shown.
10. **`/mega-dr` + integrity badge** — surface existing dedup-restore-drill.sh as a
    command + dashboard "integrity: verified" badge.

================================================================================
PHASE 5 — Port memory-mcp compaction techniques                   [effort: S–M]
================================================================================
11. **Extractive collapse heuristic** (memory-mcp compact.py chatty-buffering +
    topic/action summary) — port as local `collapse()` stage. No LLM. [S]
12. **Supersede-by-file-path** (memory-mcp compact.py: drop stale reads before a
    write) — complements existing L0/L1 dedup. [S]
13. **Size-banded gzip** (memory-mcp compression.py: 0/4/6/9 by size, 10%-worth
    guard) for checkpoint blobs in SQLite. [S]
14. **`should_compact(tokens, threshold)` interface** (memory-mcp session_context) —
    adopt interface, drive threshold from pi's context-window signal (not 50k). [M]
15. **Sequential chkpt ids + soft-delete archive** (memory-mcp) — persist the
    counter in SQLite (fix their in-memory-counter bug); KEEP anchor floor. [M]
16. **Per-file compaction map** (gap #5) — dashboard heatmap of most-compacted
    files from `filesModified`. [M]

================================================================================
PHASE 6 — New ideas (not in any prior review) to make it fantastic [effort: varied]
================================================================================
17. **Compaction dry-run preview** (`/mega-preview`) — show exact message range that
    WOULD be dropped + the summary that WOULD be written, before any drop. Strong
    trust differentiator (competitors drop silently). [M]
18. **Session timeline / time-travel** (gap #9) — resume from a specific checkpoint
    using the already-written `sessions`/`daily_log` tables. "Rewind context."
    [L — the wow feature]
19. **Recall-to-request audit log** — which checkpoints were injected for WHICH user
    prompt (injectedCheckpointIds already tracked). "Why did the model know X?"
    [M]
20. **Smart auto-compact cadence** — replace fixed fast-gate with hysteresis: arm
    at 70%, but only compact after idle/quiet period (debounce) so we don't compact
    mid-stream; auto-inline on resume. (memory-mcp lacked debounce — we add it.)
    [M]
21. **Compression ratio SLA alert** — if a region's summary > X% of original
    (low compression), flag it (probably shouldn't have compacted). Feeds quality.
    [S]
22. **`/mega-bench` self-benchmark** — reuse scripts/dedup-benchmark.mjs as an
    in-extension command; shows dedup rate / compression / p95 for THIS repo.
    [S]
23. **Export/import store** — `mega-export` dumps the SQLite store (checkpoints +
    RAPTOR tree) to a portable JSON for backup/migration across machines. [M]

================================================================================
NON-GOALS (explicitly excluded — don't port)
================================================================================
- FAISS (GPU/CPU), pgvector, Ollama LLM summarization, Postgres CTE descendants,
  multi-GPU sharding — infra-heavy, violate local/sync/zero-network.
- memory-mcp's missing anchor floor (regression vs PREVENT-PI-001).
- `vector_search_enhancement.py` (stub — nothing real inside).
- MiniLM/remote embedders (see pi-no-minilm-decision memory; off, not shipped).

================================================================================
FILES TOUCH (likely)
================================================================================
- src/vectorStore.ts (onTier callback; size-banded gzip; coherence gate)
- src/engine.ts (forward onTier; extractive collapse; should_compact)
- src/recall.ts (RAPTOR serving: level-weighted + expand-to-leaves + CRAG-adaptive;
  restore; recall-to-request)
- src/store/sqlite.ts (restore/history/export readers; persist chkpt counter;
  soft-delete)
- src/dedup/raptor/{tree,retrieval,index}.ts (centroid-average build; level-weighted)
- src/config/dedup.ts (RAPTOR default on; coherence threshold)
- src/monitoring.ts (recall quality; compression-ratio SLA)
- src/compact.ts (extractive collapse; supersede-by-file-path; dry-run preview)
- extensions/mega-compact.ts (toolbar: bar/ticker/badge/pulse/why; commands:
  restore/history/view/dr/preview/bench/export; auto-compact cadence)
- extensions/dashboard-server.ts (integrity badge; per-file map; timeline)
- tests: vectorStore.test.ts, recall.test.ts, engine.test.ts, compact.test.ts,
  mega-compact.test.ts, sprint10.test.ts, dedup/raptor/*

================================================================================
VERIFICATION
================================================================================
- Gate: `npm run build && npm run lint && python3 scripts/regression_check.py --all
  && npm test` green.
- New tests: onTier ordering; RAPTOR centroid-average + level-weighted +
  expand-to-leaves + CRAG-adaptive fallback; restore/history roundtrip;
  size-banded gzip; soft-delete; should_compact hysteresis.
- Manual (per published version): `pi update --extensions`, compact, watch live
  tier progress + bar + ticker + badge; `/mega-restore`, `/mega-history`,
  `/mega-preview`, `/mega-dr`, `/mega-bench`, `/mega-export`.

================================================================================
ROLLOUT
================================================================================
Bump per phase (0→6) with its own version + RELEASE_NOTES + publish, OR batch into
a few drops (e.g. 0.4.8 = Phases 0–1, 0.4.9 = Phase 2, 0.5.0 = Phases 3–5,
0.5.x = Phase 6). Each publish validated via `pi update --extensions` before next.
