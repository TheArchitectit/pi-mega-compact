# S25 — Cross-repo Recall + Durable Memory (headless two-repo E2E)

**Date:** 2026-07-16
**Parent plan:** `.claude/plans/split-mega-compact.md` (cross-repo recall + memory track)
**Depends on:** Slice 2 (PGlite checkpoint HNSW, `src/store/vectorIndex.ts` ✅), S21 (durable memory store ✅), S24 (unified pressure + memory review ✅)
**Priority:** P1 (the headline "start in repo B, recall repo A" capability has no automated two-repo proof today)
**Status:** SPEC (expanding the S24 stub)

---

## SAFETY PROTOCOLS

- **PREVENT-PI-004 (critical):** zero network at runtime. Both PGlite indexes are WASM Postgres, fully local. Guardrails-scan must stay green; any new localhost code needs a `// guardrails-allow PREVENT-PI-004: <reason>` annotation.
- **Best-effort / non-fatal (inviolable):** every PGlite init, write, and search is wrapped so a failure logs once + degrades to the sync path. PGlite failure must NEVER break `add()`, `compactSession()`, `applyMemoryOps()`, extension load, or `session_start`. The Kill-switch `MEGACOMPACT_PGLITE_DISABLED=true` forces full disable with zero code change.
- **No async cascade into the sync store.** `node:sqlite` (VectorStore, engine, recall, memory) stays 100% synchronous. PGlite is an additive, async, redundant index.
- **PREVENT-002 / PREVENT-PI-003:** parameterized queries only; recalled blocks are prepended via `before_agent_start` `systemPrompt` (never injected as `role:"system"`). The memory content stored inline in the index is model-visible text — bounded by `MEMORY_MAX_CHARS` (sqlite.ts:723, 4000) so it can never blow a downstream buffer.
- **Verify gate (every commit):** `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all` all green.
- NO FORCE PUSH; branch + PR only.

---

## PROBLEM / MOTIVATION

Two global PGlite HNSW indexes now exist (landed in Slice 2 / S21 / S24):

1. **Checkpoint index** — `src/store/vectorIndex.ts` (`vector_index` table): cross-repo recall of compacted checkpoints on `session_start` resume (wired `doRecallAsync` in extensions/mega-pipeline.ts:446, called from extensions/mega-events.ts:61).
2. **Memory index** — `src/store/memoryIndex.ts` (`memory_index` table): cross-repo durable-memory RAG augmentation (wired `recallMemoriesAndInline` in extensions/mega-events.ts:72 → `src/recall.ts:186` → `recallMemoriesCrossRepo` in `src/memoryRecall.ts:95`).

Both paths are individually unit-tested, **but no test exercises them end-to-end through the real handler chain across two distinct repos.** The current "two-repo" tests fake one half: `memoryRecall.test.ts:103` seeds repo A's memory then calls `recallMemoriesAndInline` directly (no `session_start` handler, no real `MEGACOMPACT_INDEX_DIR`-isolated process pair, no `VectorStore.searchAsync` hydration). `recall.test.ts` mocks `searchAsync` entirely. So the contract "a decision saved in repo A surfaces as RAG context when you start a session in repo B" is **believed-working but unproven through the real driver.**

This spec adds a **headless two-repo driver** that proves the contract through the actual `registerEventHandlers` / `doRecallAsync` / `recallMemoriesAndInline` code — covering the happy path, the memory augmentation path, and the disabled/corrupt fallback.

---

## DECISIONS (locked with user, 2026-07-16)

1. **Index topology = one global PGlite per index, `repo_id` first-class.**
   - Checkpoint index dir: `MEGACOMPACT_VECTOR_INDEX_DIR` else `~/.pi/mega-compact-vector` (vectorIndex.ts:46).
   - Memory index dir: `MEGACOMPACT_INDEX_DIR/memory` else `~/.pi/mega-compact-vector/memory` (memoryIndex.ts:51).
   - `searchAsync(q, k, {repoId?})` / `searchMemoriesAsync(q, k, {repoId?})`: omit `repoId` → cross-repo NN; pass `repoId` → single-repo WHERE filter.
2. **Enable gate = default-on, best-effort.** No flag required to turn on. `MEGACOMPACT_PGLITE_DISABLED=true|1` is the emergency kill-switch (shared, honored by both `isVectorIndexDisabled` and `isMemoryIndexDisabled`).
3. **Scope-key convention (MUST BE UNIFIED — see RISKS #3).** The checkpoint index keys on `stateDir` (`vectorStore.ts:136` `this.repoId = opts.repoId ?? this.stateDir`), while the memory index keys on the **resolved git root** (`memoryOps.ts:48` `resolveRepoRootLocal(stateDir) ?? stateDir`). These two scopes are NOT interchangeable and currently diverge. S25 does NOT silently re-key; it documents the divergence and adds a single `repoKey()` helper (see EXECUTION) so both indexes + hydration agree.
4. **Write is fire-and-forget, never awaited on the sync path.** Checkpoint mirror fires once per compaction in `doCompact` (mega-pipeline.ts:264). Memory mirror fires per memory write in `applyMemoryOps` / conflict-cmds (memoryOps.ts:51, mega-conflict-cmds.ts:90,165).

---

## ARCHITECTURE

```
 add(checkpoint) ──sync──▶ node:sqlite (authoritative, embedding_blob)
       │                         ▲ hydrate cross-repo hits by (repoId=stateDir, session, cpId)
       └─fire-and-forget─▶ vector_index (PGlite HNSW, repo_id=stateDir)

 applyMemoryOps(add) ──sync──▶ memories (node:sqlite, scoped by stateDir)
       │                          ▲ recallMemoriesCrossRepo reads content INLINE (can't open other repos)
       └─fire-and-forget─▶ memory_index (PGlite HNSW, repo_id=git-root, content stored inline)

 session_start(repo B) ──▶ doRecallAsync(same-repo sync FIRST; if <K → recallAndInlineAsync cross-repo)
                          ──▶ recallMemoriesAndInline(same-repo scan FIRST; if <limit → recallMemoriesCrossRepo)
                          ──▶ before_agent_start prepends composed block to systemPrompt
```

- **node:sqlite is the single source of truth.** Both PGlite indexes are redundant and rebuildable (`rebuildFromSqlite`, vectorIndex.ts:252; memory index mirrors from SQLite on every write).
- **Memory content is stored inline in `memory_index`** (memoryIndex.ts:18) *because* recall cannot open every other repo's SQLite dir — the only way to surface another repo's memory without its DB. Bounded by `MEMORY_MAX_CHARS`.

---

## SCOPE

**IN SCOPE**
- A headless two-repo driver harness (`scripts/cross-repo-e2e.mjs`) that:
  - spins up two isolated state dirs (repo A, repo B) sharing ONE temp `MEGACOMPACT_INDEX_DIR` + `MEGACOMPACT_VECTOR_INDEX_DIR`,
  - drives repo A: compress a session + save a decision memory (real `compactSession` + `applyMemoryOps`),
  - drives repo B: a synthetic `session_start` via the REAL `registerEventHandlers` path (`doRecallAsync` + `recallMemoriesAndInline`), asserting the composed `before_agent_start` systemPrompt contains repo A's checkpoint summary AND repo A's decision memory,
  - drives the kill-switch: same flow with `MEGACOMPACT_PGLITE_DISABLED=true` → asserts repo B degrades to same-repo-only (empty cross-repo) WITHOUT error,
  - drives corruption: pre-seed a torn PGlite dir → asserts self-heal (delete + one retry) OR graceful disable, never a crash.
- One shared `repoKey(stateDir)` helper (src/store/repoKey.ts) used by `VectorStore` (checkpoint repoId) AND `memoryOps.ts` (memory repoId) so the two indexes agree on scope. Default = git root, fallback = stateDir. (`resolveRepoRootLocal` is promoted to this shared helper; `vectorStore.ts:136` switches from `stateDir` to `repoKey`.)
- TESTER_GUIDE.md addition: a manual two-repo check block (A/B/C above) + kill-switch/corruption notes.

**OUT OF SCOPE**
- Changing the sync store to async (forbidden).
- Removing the sync linear scan (stays default).
- A distributed/multi-machine index (machine-wide injected-set in `~/.mega-compact-index` is local-only; cross-machine sync is not addressed).
- Slice 3 packaging polish.

---

## EXECUTION

### 1. Shared repo-key helper — `src/store/repoKey.ts` (new)
```ts
import { execSync } from "node:child_process"; // guardrails-allow PREVENT-PI-004: read-only git rev-parse
export function repoKey(stateDir: string): string {
  try {
    const out = execSync("git rev-parse --show-toplevel", { cwd: stateDir, encoding: "utf-8", stdio: ["ignore","pipe","ignore"] }).trim();
    return out || stateDir;
  } catch { return stateDir; }
}
```
- `src/memoryOps.ts:48` `resolveRepoRootLocal` → import + use `repoKey`.
- `src/vectorStore.ts:136` `this.repoId = opts.repoId ?? this.stateDir` → `this.repoId = opts.repoId ?? repoKey(this.stateDir)`.
- `extensions/mega-conflict-cmds.ts:90,165` already pass `repo` (git root) — leave; assert it equals `repoKey(stateDir)`.
- Confirm `vectorStore.searchAsync` hydration `getCheckpoint(..., h.repoId)` (vectorStore.ts:538) still matches: with `repoKey`, repoId becomes git-root, so `getCheckpoint` must be called with the STATE DIR for that repo. **Add a `stateDirForRepo(repoRoot)` resolver** (read from the machine-wide `repo_registry.state_dir`, sqlite.ts:173) so hydration resolves git-root → stateDir. If unresolvable, skip the hit (degrade).

### 2. Headless two-repo driver — `scripts/cross-repo-e2e.mjs` (new, run by `node --test` via a thin wrapper or standalone)
Isolate dirs:
```js
const TMP = mkdtempSync(join(tmpdir(), "mc-xrepo-e2e-"));
const IDX = join(TMP, "index");                 // shared MEGACOMPACT_INDEX_DIR
const VIDX = join(TMP, "vector");               // MEGACOMPACT_VECTOR_INDEX_DIR
const repoA = join(TMP, "repo-a/.pi/mega-compact");
const repoB = join(TMP, "repo-b/.pi/mega-compact");
process.env.MEGACOMPACT_INDEX_DIR = IDX;
process.env.MEGACOMPACT_VECTOR_INDEX_DIR = VIDX;
```
- **Phase A (checkpoint recall on resume):** build a `MegaRuntime` for repo A, run `compactSession` over a distinctive topic (e.g. "circuit breaker retry policy in apiClient.ts") so a checkpoint + embedding land in repo A's SQLite AND the checkpoint index (`doCompact` fires `indexUpsertEmbedding`, mega-pipeline.ts:264). For repo B, construct the real pi event surface (mock `pi`/`ctx` with `getSessionId`, `sessionManager.getEntries`, `getStateDir`). Call `registerEventHandlers` once, fire a `session_start` event with `reason:"resume"` and a query about the apiClient topic. Assert `runtime.pendingRecallBlock` (mega-events.ts:63) contains repo A's summary AND is labeled `from repo <a>`.
- **Phase B (memory augmentation):** via repo A's runtime, `applyMemoryOps([{op:"add", memory:{content:"we standardized on node:sqlite for the store backend", category:"decision", sourceTurn:0}}], repoA)` — this fires `upsertMemoryEmbedding` (memoryOps.ts:51). Re-fire `session_start` for repo B (fresh query "what store backend do we use?"). Assert `runtime.pendingMemoryRecallBlock` (mega-events.ts:77) is non-empty AND the block matches `/node:sqlite/` AND is labeled `from <a>`. Also assert `recallMemoriesAndInline` returns the cross-repo hit (mirrors memoryRecall.test.ts:103 but THROUGH the handler).
- **Phase C (disabled / corrupt fallback):**
  - C1: set `MEGACOMPACT_PGLITE_DISABLED=true`, re-run Phase A/B. Assert: no throw, `pendingRecallBlock`/`pendingMemoryRecallBlock` omit the repo-A hits (same-repo-only), `isVectorIndexDisabled()`/`isMemoryIndexDisabled()` true, `searchAsync`/`searchMemoriesAsync` return `[]`.
  - C2: pre-seed `VIDX` and `IDX/memory` with a torn/corrupt PGlite dir (e.g. a `data` file with garbage bytes). Re-run Phase A/B WITHOUT the kill-switch. Assert: index self-heals (vectorIndex.ts:124 `retryOnCorrupt` deletes + retries) OR, if self-heal fails, sets `disabled` and degrades — in BOTH cases no crash and the real handler returns normally (cross-repo simply empty).
- **Cleanup:** `closeVectorIndex()` + `closeMemoryIndex()` + `closeIndexStore()`, `rmSync(TMP, recursive)`.

### 3. Unit-test hardening (close the mocked gaps)
- `src/store/vectorIndex.test.ts` (exists): add a test asserting corrupt-dir self-heal (reuse the dir-injection trick from C2). Add a dimension-guard test (non-512 vector skipped, no throw) — currently only memoryIndex.test.ts covers it.
- `src/recall.test.ts`: replace the mock `searchAsync` in the S18 tests with the REAL `VectorStore.searchAsync` over two isolated state dirs sharing one `VIDX`, so the merge + global injected-set path is exercised against the actual HNSW hydration (not a hand-rolled mock).
- `src/memoryRecall.test.ts`: keep `:103` but rename intent to "through recallMemoriesCrossRepo" and add a `dedup by content` assertion (recallMemoriesCrossRepo:114 must NOT surface a memory repo B already has locally).

### 4. Docs
- `docs/INDEX_MAP.md` + `docs/HEADER_MAP.md`: add `docs/specs/s25-cross-repo.md` + `scripts/cross-repo-e2e.mjs`.
- `TESTER_GUIDE.md`: append a "Cross-repo two-repo manual check" section (see below).

---

## TESTER_GUIDE ADDITIONS (append to TESTER_GUIDE.md)

```markdown
### Cross-repo two-repo manual check

The headline capability is: a decision/checkpoint from repo A shows up as
context when you start a session in repo B. Validate it headlessly (no two
terminals needed):

  node scripts/cross-repo-e2e.mjs

Expect: Phase A (repo B resumes with repo A's checkpoint summary, labeled
"from repo a"), Phase B (repo B's memory block contains repo A's node:sqlite
decision, labeled "from repo a"), Phase C1 (with MEGACOMPACT_PGLITE_DISABLED=true
both blocks omit the cross-repo hit and the run does not error), Phase C2
(corrupting the PGlite dir self-heals or degrades gracefully — no crash).

Manual two-terminal variant (optional):
1. In repo A, work until a checkpoint persists (`/mega-status` shows checkpoints)
   and save a decision: `/memory add "we standardized on node:sqlite" --category decision`.
2. In repo B (same machine, same user), start a NEW session with a related query.
   The first agent turn's system prompt should contain "Recalled context ... from repo a"
   and "Recalled memory ... from repo a". Confirm via the status line
   (`mega-compact: recalled N chkpt (cross-repo)`) and `/mega-status`.

Kill-switch / degradation:
- `MEGACOMPACT_PGLITE_DISABLED=true` fully disables both indexes; recall
  degrades to same-repo-only, no error.
- The PGlite dirs (`~/.pi/mega-compact-vector` and `.../memory`) are safe to
  delete — they rebuild from node:sqlite on next use. Deleting them is a valid
  DR step, not data loss (node:sqlite stays authoritative).
```

---

## RISKS (and where they live in code)

1. **Index corruption / torn WAL.** Concurrency across repos/processes can tear the PGlite data dir. Mitigation already in place: `openPgLite(retryOnCorrupt=true)` (vectorIndex.ts:94 / memoryIndex.ts:98) catches `Aborted`/`RuntimeError`, deletes the dir, retries once; if that fails, sets `disabled` and `logWarn`. Driver Phase C2 proves this. Residual risk: the retry can lose the OTHER repo's vectors mid-rebuild if interrupted — acceptable because the index is rebuildable from SQLite and recall is a bonus.
2. **Inline memory content.** `memory_index` stores `content` inline (memoryIndex.ts:18) so cross-repo recall needs no other-repo DB. Bounded by `MEMORY_MAX_CHARS=4000` (sqlite.ts:723) via `capMemoryContent` (sqlite.ts:745) before it ever reaches the index. No unbounded growth. Stale content: a replaced/removed memory leaves a stale inline copy in the index until the next `upsertMemoryEmbedding` overwrites it (`ON CONFLICT DO UPDATE`, memoryIndex.ts:167). Acceptable — same-repo `recallMemories` reads authoritative SQLite and de-dups by content (memoryRecall.ts:114).
3. **repo_id scoping DIVERGENCE (must fix in S25).** Checkpoint index keys on `stateDir` (vectorStore.ts:136); memory index keys on **git root** (memoryOps.ts:48). Cross-repo checkpoint hydration `getCheckpoint(..., h.repoId)` (vectorStore.ts:538) assumes repoId == stateDir. If a future change makes the two scopes collide inconsistently, hydration silently misses hits. S25 unifies both on `repoKey()` and adds `stateDirForRepo()` so git-root repoIds resolve back to a stateDir. Until merged, the two indexes use DIFFERENT keys and that is a latent inconsistency — flag in release notes.
4. **Double-inject of cross-repo checkpoints.** Guarded two ways: per-session `wasInjected` (recall.ts:279) AND machine-wide `injected_global` (sqlite.ts:362, keyed `(checkpoint_id, session_id)`). `recallAndInlineAsync` checks `wasInjectedGlobal` before injecting and `markInjectedGlobal` after (recall.ts:284,307). The memory path has NO machine-wide marker yet — only same-repo content de-dup (memoryRecall.ts:114). Risk: a memory saved in both repo A and repo B could be surfaced twice (once per repo) to a third repo C; low impact (deduped by block assembly only within one call). S25 adds a `markInjectedGlobal` parity for memory cross-repo if Phase B shows duplication in the driver.
5. **Token inflation / net-inflate.** Both paths apply `recallMaxTokens` (config `MEGACOMPACT_RECALL_MAX_TOKENS=1500`) and incremental cap (recall.ts:128, 222) + window dedupe (recall.ts:120, 291). Cross-repo uses a STRICTER floor: checkpoint `crossRepoCosine` default 0.90 (mega-config.ts:140), memory `crossRepoCosine` default 0.30 (recall.ts:206). Cannot net-inflate because the same cap is re-applied to the MERGED set (mega-pipeline.ts:489 `formatRecallBlock(merged)`).
6. **`repo_id` as stateDir vs git-root in the machine-wide injected-set.** `markInjectedGlobal` stores `repo_id` = the source repo's stateDir (recall.ts:307) for source labels, while the memory index labels by git-root. Mixed provenance in `injected_global.repo_id` — fine for dedup (keyed on checkpoint_id+session), cosmetic for labels.

---

## FILES TO CHANGE

| File | Change | Status |
|------|--------|--------|
| `src/store/repoKey.ts` | new: shared `repoKey()` + `stateDirForRepo()` | ⬜ |
| `src/vectorStore.ts` | repoId = `repoKey(stateDir)`; hydrate via `stateDirForRepo` | ⬜ |
| `src/memoryOps.ts` | use `repoKey()` instead of local `resolveRepoRootLocal` | ⬜ |
| `extensions/mega-conflict-cmds.ts` | assert `repo` == `repoKey(stateDir)` | ⬜ |
| `scripts/cross-repo-e2e.mjs` | new: headless two-repo driver (A/B/C) | ⬜ |
| `src/store/vectorIndex.test.ts` | add corrupt-self-heal + dim-guard tests | ⬜ |
| `src/recall.test.ts` | replace mock `searchAsync` with real two-repo HNSW | ⬜ |
| `src/memoryRecall.test.ts` | assert content de-dup in cross-repo path | ⬜ |
| `TESTER_GUIDE.md` | append two-repo manual + kill-switch section | ⬜ |
| `docs/INDEX_MAP.md` / `docs/HEADER_MAP.md` | register this spec + script | ⬜ |

---

## ACCEPTANCE

1. `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all` all green; PREVENT-PI-004 green.
2. `node scripts/cross-repo-e2e.mjs` passes all three phases (A checkpoint-on-resume, B memory-augmentation, C disabled + corrupt fallback) with no thrown errors.
3. Sync store + same-repo recall is byte-identical when PGlite is disabled — no regression (sync scan still the default).
4. Both indexes share ONE `repoKey()` scope; checkpoint cross-repo hydration resolves git-root → stateDir via `stateDirForRepo()` and degrades (skips hit) when unresolvable.
5. Corrupting either PGlite dir self-heals (delete + retry) or disables gracefully — never crashes the handler; cross-repo simply empty.
6. `MEGACOMPACT_PGLITE_DISABLED=true` makes `searchAsync`/`searchMemoriesAsync` return `[]` and the real `session_start` handler returns normally (same-repo-only).

---

## ROLLBACK

- Feature is additive + default-on-but-degradable: `MEGACOMPACT_PGLITE_DISABLED=true` fully disables both indexes at runtime (falls back to sync scan) with zero code change.
- Per-commit revert; each commit independently green. node:sqlite stays authoritative, so dropping PGlite loses only the cross-repo index (rebuildable).
- NO FORCE PUSH; revert via PR only.
