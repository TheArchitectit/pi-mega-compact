# Design — Compaction Continuity + Cross-Repo Recall + Memory-RAG

> **Date:** 2026-07-15
> **Branch:** `feat/durable-trim` → new branch for this work (e.g. `feat/continuity-crossrepo`)
> **Baseline:** v0.4.28 (published)
> **Status:** Draft (pending user review) → then writing-plans for the implementation plan
> **Scope:** Four workstreams, sprints S16–S23. This is a large plan; see §11 for an optional split.

---

## 1. Context — why now

The v0.4.x line shipped a lot of machinery but three things are broken or not delivering, found by auditing the *actual* call paths (not the sprint checkboxes):

### 1a. pi stops after a compaction (live bug, reported by user)
Our auto-trigger calls `ctx.compact()` from the `context` handler (`mega-events.ts`). `ctx.compact()` maps to pi's **manual** compaction path (`agent-session.js:1345`), which:
- calls `this._disconnectFromAgent()` + `await this.abort()` — **aborts the in-flight turn**;
- runs with `reason: "manual"`, `willRetry: false`;
- returns, and **pi stops and waits** for the user.

So our "auto-compact" halts the agent. The user sees "Compacted from 67,116 tokens" and the turn dies.

pi has a **second**, internal compaction path — `_runAutoCompaction` (`agent-session.js:1565`) — that fires at agent-end, does **not** abort, and continues via `return this.agent.hasQueuedMessages()`. It also emits `session_before_compact` (our `driveNativeCompaction` supplies the summary) and durably truncates the transcript. **This path compacts and continues.** It is not exposed as an extension trigger; `ctx.compact()` is the only trigger, and it's the stopping one.

### 1b. The "Nothing to compact" gate (v0.4.28) is a band-aid we can retire
v0.4.28 added `piCompactWouldNoop()` to skip `ctx.compact()` when pi would throw. It worked, but it was treating the symptom of 1a. The S16 redesign removes `ctx.compact()` from the auto-trigger entirely, so the no-op throw can no longer happen. The gate is kept only as a defensive check inside the legacy flag (§5).

### 1c. PGlite/pgvector cross-repo index is built and tested — but never read
- `vectorIndex.ts` (PGlite HNSW), `VectorStore.searchAsync`, `recallAndInlineAsync` all exist and pass tests (cross-repo HNSW, repoId scoping, dim guard, kill-switch).
- **Zero callers.** The extension and OpenClaw adapter call the **sync** `recallAndInline` → `search()` (per-session linear scan + RAPTOR merge). `recallAndInlineAsync` is exported and never imported. The index is mirrored on every compaction but no runtime path queries it. We pay to build it; it earns nothing.

### 1d. Multi-repo dashboard gap (Phase 5b, never built)
Each pi's dashboard binds to one repo's state dir. With multiple repos/pis open, each sees only its own data ("dashboard shows no data from any repo"). A machine-wide global index + Summary/All-repos tabs were planned (`multi-repo-dashboard.md`) but not built.

### 1e. Memory table is passive, not RAG (`memory-rag-auto-review.md`)
The `memories` table + `/mega-memory` shipped at 0.4.21, but:
- it's **passive** (you `/mega-memory save` by hand; no auto-review like Hermes);
- recall does **not** include the `memories` table — only `context_chunks` checkpoints. So saved memory is never injected as RAG context (the "reduce new token requests" lever is unloaded);
- no auto-consolidation/dedup of near-duplicate memories.

### 1f. Slice 3 packaging ~95% done — README missing
`package.json` (pglite deps, `engines>=22.13`), `.npmrc`, CLAUDE.md reflect the dual backend. README has **zero** mention of node:sqlite/PGlite. Docs-only close-out.

---

## 2. Goals

1. **Compact and continue.** The agent never stops to compact. The model's context is trimmed continuously (every LLM call) and durably (on resume) with no abort.
2. **Cross-repo recall actually fires.** The PGlite HNSW index is read at runtime — on resume (auto-inline, augmenting when same-repo is thin) and via `/mega-recall --cross-repo`.
3. **Cross-repo injections are tracked and deduped machine-wide.** A global injected-set + `events.log`/dashboard tracking with source repo + score; never re-inject the same foreign checkpoint.
4. **Multi-repo dashboard.** One Summary tab + one All-repos tab over a machine-wide global index.
5. **Memory is auto-reviewed and RAG-injected.** Conversations auto-produce memories; recall includes them (capped, deduped); near-duplicate memories consolidate.
6. **No net token growth on read.** `recallMaxTokens` cap + `windowDedupe` + live trim guarantee the model's view never inflates from recall/compaction.
7. **Zero regression, degradable.** Every new path is best-effort and degrades to the current sync behavior on failure. `PREVENT-PI-004` (no network) honored throughout.

## 3. Non-goals

- Replacing the sync node:sqlite store as source of truth (stays authoritative).
- Removing RAPTOR (it works — keep it in the sync `search()` path).
- Changing the pi extension API (we work within `ctx.compact`/`context`/`before_agent_start`/`session_before_compact`).
- Building a network-based embedder (stays local TrigramEmbedder by default).
- Per-repo dashboard rewrite beyond adding the two new tabs.

---

## 4. Resolved decisions (from the user)

1. **Scope = everything outstanding.** All four workstreams in one plan.
2. **Cross-repo fires on resume + command** (auto-inline on resume AND `/mega-recall --cross-repo`). Async is allowed in `session_start` (safe) and the command (safe); **not** in the mid-turn `context` handler (keep hot path sync).
3. **Relevance bar = all measures + tracking.** Stricter cross-repo floor (`MEGACOMPACT_CROSSREPO_COSINE`, default 0.90 trigram), source-repo label in the recall block, AND machine-wide dedup markers for tracking injections.

---

## 5. Architecture — the compaction-continuity redesign (S16, foundation)

This is the load-bearing change; everything else rides on the "compact and continue" promise.

### Two layers, one pipeline

```
LIVE  (model view, every LLM call, ephemeral-but-per-call, NEVER aborts)
  context event ──> runCompact() persist checkpoint (recall vector)
                 └> return { messages: [recallSummary, ...recentAnchor] }
                       │ (sdk.js transformContext → agent-loop.js:180)
                       └> LLM sees the compacted window. Turn continues.

DURABLE (disk/resume, best-effort, NEVER via ctx.compact())
  pi native auto-compaction (agent-end, agent-session.js:1565, CONTINUES)
    └> emits session_before_compact ──> OUR driveNativeCompaction supplies summary
                                       └> pi truncates transcript from firstKeptEntryId
                                           └> resume reloads trimmed window.

PLAYBACK (resume)
  before_agent_start ──> prepend capped recall block (recallMaxTokens + windowDedupe)
                       └> summary re-surfaces, bounded, no growth.
```

**Key: we stop calling `ctx.compact()` from the auto-trigger.** The live layer bounds the model's context every call (no stop). The durable layer uses pi's *continuing* auto-compaction (which already calls our `session_before_compact` handler) for disk trim. `ctx.compact()` is the *stopping manual path*; we leave it for an explicit user `/compact` only (if ever wired), never for auto.

### Verified facts the design rests on

- `ctx.compact()` → pi manual `compact()` (`agent-session.js:1345`) → `abort()` + `willRetry:false` → **stops**.
- pi auto-compaction `_runAutoCompaction` (`agent-session.js:1565`) → no abort → `return hasQueuedMessages()` → **continues**; emits `session_before_compact` (1597) like the manual path.
- `context` event `{messages}` → `transformContext` (`sdk.js:226`) → `agent-loop.js:180` replaces the message list **for that LLM call** — ephemeral but fires before every call, so the model's view is continuously trimmed without any abort.
- `appendCompaction` (real compaction writer, `session-manager.js:742`) is **internal**; `pi.appendEntry` → `appendCustomEntry` only (`type:"custom"`). We cannot "append a compaction entry" to trick pi. (Confirmed — not assumed.)
- `before_agent_start` `{systemPrompt}` prepend is the recall injection point (PREVENT-PI-003).

### Trade-off (documented, accepted)

The live `context`-event trim suppresses pi's native auto-compaction *when pi accounts the trimmed (smaller) LLM usage* — so **durable trim becomes best-effort**: it fires near pi's own limit (and on the zero-usage estimation path, `agent-session.js:1536–1558`), not at our threshold. This is acceptable because:
- The model's context is bounded by the **live** trim regardless (the actual token-growth bug is fixed).
- Resume re-trims via the context event + the capped recall block.
- pi's native auto-compaction still does real durable trim when it fires.
- Our `runCompact` persists the recall checkpoint (the durable *value*) at our threshold regardless.

Net: we trade "aggressive durable trim at our threshold (but pi stops)" for "continuous live trim + best-effort durable (but pi never stops)." This is the trade the user asked for ("auto compacting and continuing").

### Legacy/rollback flag

`MEGACOMPACT_LEGACY_DURABLE_TRIM=true` restores the v0.4.28 behavior (auto-trigger calls `ctx.compact()` with the `piCompactWouldNoop` gate). Default `false` (new behavior). Kept for one release as rollback; removed in the release after.

### Continuation fallback

If a turn settles idle after compaction with queued work pending, `pi.sendUserMessage()` can inject a resume nudge. With the live-layer trim the turn continues on its own, so this is a fallback only — wire it but it should rarely fire.

---

## 6. Workstream breakdown — sprints S16–S23

| Sprint | Workstream | Size | Depends on |
|---|---|---|---|
| **S16** | Compaction continuity (remove ctx.compact, live trim + native durable) | L | — (foundation) |
| **S17** | Cross-repo recall wire-up (searchAsync on resume + command) | M | S16 |
| **S18** | Cross-repo dedup markers + tracking (global injected-set, events/dashboard) | M | S17 |
| **S19** | Multi-repo dashboard (Phase 5b: Summary + All-repos tabs) | L | S18 (global index) |
| **S20** | Memory-RAG: auto-review (conversation → add/replace/remove ops) | L | — (independent thread) |
| **S21** | Memory-RAG: include memories in recall + auto-consolidate | M | S20 (and S17's recall path) |
| **S22** | Slice 3 docs close-out + polish (README dual-backend, maps, CHANGELOG) | S | all |
| **S23** | Release: benchmarks (cross-repo latency/quality, continuity), DR, tag + npm publish | M | all |

Threads: **A** = S16→S17→S18→S19 (compaction + cross-repo + dashboard). **B** = S20→S21 (memory). **C** = S22→S23 (docs + release). S16 first (everything rests on "compact and continue"). S20 can run in parallel with S17–S19.

---

## 7. Per-workstream design

### S16 — Compaction continuity
**Components:**
- `extensions/mega-events.ts` `context` handler: after `runCompact` (persist), build the live trimmed view `[recallSummary, ...recentAnchor]` and `return { messages }`. Honor anchor-floor + tool-pair guards (PREVENT-PI-001/002). No `ctx.compact()`.
- A `buildLiveTrimmedView(messages, runResult, config)` helper (pi-agnostic, testable) — collapse the compacted range to a summary + keep the recent anchor; reuse `src/boundary.ts` + `src/compact.ts`.
- Remove the `ctx.compact()` call + retire `piCompactWouldNoop` from the hot path (keep behind the legacy flag).
- `session_before_compact` handler unchanged — `driveNativeCompaction` still supplies our summary when pi's native auto-compaction fires.
- `MEGACOMPACT_LEGACY_DURABLE_TRIM` flag (default false).

**Interfaces:** `buildLiveTrimmedView(view, result, cfg): AgentMessage[]` (pure).
**Error handling:** live trim is non-destructive (disk untouched); a build failure → return the original messages (no trim this call, try next). Never throws into the context event.
**Testing (TDD):** turn-continues-after-compact (no `ctx.compact` call, no abort observed); model receives trimmed window (token count drops); durable trim still happens when pi native auto-compaction fires; no net token growth on simulated resume; legacy flag restores old behavior.

### S17 — Cross-repo recall wire-up
**Components:**
- `extensions/mega-pipeline.ts` `doRecall`: add an async path. On resume (`session_start`), run sync same-repo `recallAndInline` first; **if it returns < K hits** AND `crossRepo` enabled, `await recallAndInlineAsync({crossRepo:true})` and merge (source-labeled). Cap + window-dedupe apply to the merged set.
- `extensions/mega-commands.ts` `/mega-recall`: add `--cross-repo` flag → `await recallAndInlineAsync({crossRepo:true})`.
- New config: `MEGACOMPACT_CROSSREPO_ENABLED` (default true), `MEGACOMPACT_CROSSREPO_COSINE` (default 0.90 trigram / 0.95 MiniLM — stricter than same-repo 0.85).
- `src/recall.ts` `formatRecallBlock`: add an optional `sourceRepo` label per hit (`"from repo <name>"`).
- `searchAsync` already hydrates hits from node:sqlite by repoId — reuse as-is.

**Interfaces:** `doRecall` gains an async variant `doRecallAsync(runtime, config, ctx, query, source, {crossRepo})`.
**Async discipline:** the mid-turn `context` handler stays **sync** (no await). Cross-repo runs only in `session_start` (async-safe) and the command (async-safe). The live trim (S16) is unaffected.
**Error handling:** `searchAsync` failure → `hits = []` → falls back to same-repo (current behavior). Non-fatal.
**Testing:** resume with a thin same-repo store pulls a cross-repo checkpoint; `--cross-repo` command returns cross-repo hits; stricter floor drops a 0.87 trigram hit; source-repo label present; async never enters the mid-turn path (assert sync in `context`).

### S18 — Cross-repo dedup markers + tracking
**Components:**
- A **machine-wide global injected-set** (in the global index SQLite, keyed by `checkpointId + repoId + sessionId`) so a foreign checkpoint injected in repo A is not re-injected when repo B recalls it. `markInjected`/`wasInjected` gain a global variant.
- `events.log`: record every cross-repo injection `{sourceRepo, checkpointId, score, query}`.
- Dashboard/`/mega-status`: cross-repo recall stats (count, top source repos, avg score).
- This global index is the same store S19's dashboard reads → write it now, S19 reads it.

**Interfaces:** `markInjectedGlobal(checkpointId, repoId, sessionId)`, `wasInjectedGlobal(checkpointId, sessionId)`.
**Error handling:** global store failure → degrade to per-session injected-set (current behavior). Non-fatal.
**Testing:** a foreign checkpoint injected once is not re-injected on the next recall; `events.log` has the injection record; `/mega-status` shows cross-repo count; global-store failure degrades silently.

### S19 — Multi-repo dashboard (Phase 5b)
**Components:**
- The global index SQLite (from S18) is written by every pi on repo-switch + model-capture (`upsertRepoRegistry` already exists; extend with per-repo stats: tokensSaved, checkpointCount, lastActive).
- Dashboard server: new **Summary** tab (machine-wide totals: tokens saved across repos, checkpoint count, active repos) + **All-repos** tab (per-repo breakdown). Built on the existing `dashboard-server.ts`.
- Per-repo tab unchanged (current behavior preserved).

**Interfaces:** `globalRepoStats()` read API for the server.
**Error handling:** server can't read global index → Summary tab shows "data unavailable," per-repo tab unaffected.
**Testing:** two repos registered → Summary aggregates both; All-repos lists each; per-repo tab still works; server missing global index degrades gracefully.
**Ship:** npm publish (PREVENT-DIST-001 — no tarball).

### S20 — Memory-RAG: auto-review
**Components:**
- A local, hallucination-guarded conversation reviewer that runs every N turns (`MEGACOMPACT_MEMORY_REVIEW_INTERVAL`, default 10) → emits structured `add/replace/remove` ops against the `memories` table. Reuse RAPTOR guardrails patterns (`src/dedup/raptor/guardrails.ts`) + extractive fallback (no LLM by default; optional local Ollama like RAPTOR).
- `memories` table schema extended: add `category`, `target`, `last_referenced`, `source_turn` (non-breaking migration).
- New `MEGACOMPACT_MEMORY_AUTO_REVIEW` (default true).
- Conflicts with other extensions re-scanned (the conflict detector from 0.4.21).

**Interfaces:** `reviewConversation(messages, store): MemoryOp[]` (pure, testable).
**Error handling:** review failure → no ops written this cycle; non-fatal; never blocks a turn.
**Testing:** a fixture conversation yields sensible `add` ops; a superseded fact yields `replace`; a near-duplicate of an existing memory yields `remove`/merge; guardrails downgrade an un-grounded claim; review failure is non-fatal.

### S21 — Memory-RAG: include memories in recall + auto-consolidate
**Components:**
- `src/recall.ts` (and `recallAndInlineAsync`): include the `memories` table in recall — query memories by the same embedding/cosine, merge with checkpoint hits via MMR, label them as `"memory"` in the block. Capped by `recallMaxTokens`, window-deduped.
- Recency/category priority: `last_referenced` bumps on injection; category boosts (decision/preference over note).
- Auto-consolidate: a background (compaction-time) pass finds cosine > `SEMDEDUP_COSINE` memory pairs and merges into one (reuse `src/dedup/mmr.ts` + the SemDeDup pattern from `vectorStore.ts`).
- `/mega-memory list` shows recency; `/mega-memory forget` honors the global injected-set.

**Interfaces:** `recallMemories(query, store, k): MemoryHit[]` merged into the recall pipeline.
**Error handling:** memory recall failure → recall falls back to checkpoints only. Non-fatal.
**Testing:** a saved memory relevant to the query is injected (capped); a stale duplicate memory is consolidated; memory injection respects `recallMaxTokens`; memory failure degrades to checkpoints-only.

### S22 — Slice 3 docs close-out
- README: dual-backend section (node:sqlite primary + PGlite index), `engines>=22.13`, script-free install story, cross-repo recall + memory-RAG usage, the `MEGACOMPACT_*` knobs.
- `docs/INDEX_MAP.md` + `docs/HEADER_MAP.md` updated for any new docs.
- CHANGELOG entries for S16–S21.
- Guardrails audit (lint + regression + PREVENT-PI-004 grep).

### S23 — Release
- Benchmarks: cross-repo recall latency + quality (HNSW vs scan), compaction-continuity (no-stop, model-context-drops), memory-RAG recall hit rate. Targets in the implementation plan.
- DR drill (`scripts/dedup-restore-drill.sh`) + a new cross-repo/global-index DR check.
- Tag `v0.5.0`, GitHub release, **npm publish** (PREVENT-DIST-001 — no tarball; `pi update --extensions` on devices).

---

## 8. Risks / HALT

- **S16 is a partial revert of "Fix B"** (durable-trim-via-`ctx.compact`, v0.4.x). It's the right call — Fix B used the *stopping* path; S16 uses the *continuing* path + live trim. **TDD tightly; keep `MEGACOMPACT_LEGACY_DURABLE_TRIM` for one release.** Halt and re-evaluate if the live trim shows any net token growth on resume in tests.
- **Live trim suppresses durable trim** (§5 trade-off). Acceptable; the model's context is bounded by the live trim regardless. Monitor disk growth in S23; if a very-long-session storage issue appears, add a TTL/VACUUM cadence note (already exists in `RETENTION_POLICY.md`).
- **Async into `session_start`** (S17): must not block resume or throw into pi. Strict `try/catch` → empty hits → sync fallback. Assert the mid-turn `context` handler stays sync in tests.
- **Global index concurrency** (S18/S19): multiple pis writing the global index concurrently. node:sqlite handles multi-process with WAL + busy timeout; verify no corruption (the Slice-2 PGlite multi-process lesson — but that was WASM/PGlite; node:sqlite is WAL-safe). Halt if any concurrent-write corruption appears in tests.
- **Memory auto-review correctness** (S20): a bad review writes wrong memories. Guardrails (claim-grounding + extractive fallback) + auto-consolidate (S21) + `/mega-memory forget`. Default-on but easy to disable.
- **PREVENT-PI-004**: all new paths local (TrigramEmbedder, node:sqlite, PGlite WASM, optional localhost Ollama already loopback-only). Grep-verify in CI.
- **PREVENT-PI-001/002/003**: live trim preserves anchor-floor + tool-pair; recall prepends via `before_agent_start` (never `role:"system"`).
- **PREVENT-DIST-001**: ship via npm only; no tarball (`.gitignore` already rejects `*.tgz`).

---

## 9. Testing strategy

- **TDD per sprint** (superpowers:test-driven-development). Each sprint exits only when `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all` are green (the existing guardrails gate).
- **3-minute test timeout** (`--test-timeout=180000`, already in `package.json`).
- New tests: `buildLiveTrimmedView` unit; compaction-continuity integration (no-stop, trimmed-window, resume-no-growth) in `mega-compact.test.ts`; cross-repo recall + dedup-marker + global-injected-set in `vectorIndex.test.ts`/`recall.test.ts`; memory auto-review + RAG-injection in new `memory.test.ts`; dashboard Summary/All-repos in `mega-compact.test.ts`.
- Mock-pi harness (`mega-compact.test.ts`) extended: `getBranch()` (already added), `session_before_compact` with pi-native `reason:"threshold"` to prove the continuing durable path.

---

## 10. Rollback

- Per-sprint: each commit independently green; revert via PR only (no force-push).
- S16: `MEGACOMPACT_LEGACY_DURABLE_TRIM=true` restores v0.4.28 (ctx.compact + no-op gate).
- S17/S20: `MEGACOMPACT_CROSSREPO_ENABLED=false` / `MEGACOMPACT_MEMORY_AUTO_REVIEW=false` disable the new paths; recall + memory revert to current behavior.
- PGlite: `MEGACOMPACT_PGLITE_DISABLED=true` (existing) kills the cross-repo index; recall falls back to sync per-session scan.
- node:sqlite store + RAPTOR untouched as authoritative; dropping any new layer loses only the additive capability.

---

## 11. Optional split (if the plan feels too large in writing-plans)

This is 8 sprints / 4 workstreams. If the implementation plan gets unwieldy, split into two specs/plans:
- **Plan 1 (Thread A + C):** S16 → S17 → S18 → S19 → S22 → S23 (compaction continuity + cross-repo + dashboard + docs + release).
- **Plan 2 (Thread B):** S20 → S21 (memory-RAG), rolled into the next release.

Decision deferred to the writing-plans step based on plan length. Default: one plan, all sprints.

---

## 12. Open questions (none blocking — resolved by the user's answers)

- Cross-repo fire points → resume + command (resolved).
- Relevance bar → stricter floor + source label + dedup markers (resolved).
- Scope → everything (resolved).

---

## Next step

After user review of this design doc → invoke the **writing-plans** skill to produce the full sprint-by-sprint implementation plan (Header / Safety / Problem / Scope / Execution / Acceptance / Rollback per sprint, following the existing `SPRINT_GUIDE` structure), then implement S16 first.
