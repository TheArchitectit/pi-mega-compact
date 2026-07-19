# Plan: "Fully Context-Aware" mega-compact — auto memory + read-context cache + auto-compact tuning

> Date: 2026-07-14. Scope: build on the existing extension (pi-mega-compact v0.4.21).
> Goal from user: (1) make mega-compact **fully context aware** — it should **save memories** automatically; (2) be able to **"save a read / skip a read if it already has the context"**; (3) **build in auto-compact** (does it already do that?).

## TL;DR — what already exists vs. what we add

Surveying the actual code (not the README) before writing anything:

| Capability | Status today | Work needed |
|---|---|---|
| **Auto-compact** | ✅ **Already implemented & ON by default.** `extensions/mega-events.ts:123` `context` handler → fast-gate (`thresholdTokens`) → `autoCompactCheck` → `runCompact` → `dropCompactedRange`, 2s debounce, and `session_before_compact` cancels pi's native compaction to avoid double-compact. | Just **verify it's wired** end-to-end + **expose/confirm tuning knobs**. Not a rebuild. |
| **Durable memory store** | ⚠️ **Schema + CRUD exist but are inert.** `src/store/sqlite.ts:421` has a `memories` table + `addMemory/listMemories/searchMemories/recallMemory`, but it is wired ONLY to the manual `/mega-memory save` command (`extensions/mega-conflict-cmds.ts`). Nothing auto-saves or auto-recalls it. | **Auto-capture** memory from each compaction; **auto-recall** memories on resume. |
| **Recall/inject path** | ✅ Proven. `before_agent_start` prepends a `systemPrompt` block (`mega-events.ts:75`); auto-inline on resume/branch already works for checkpoints (`doRecall`). | Reuse it for memories + read-cache. |

**Hard API constraint discovered** (`@earendil-works/pi-coding-agent` types.d.ts):
- `tool_call` event fires *before* a tool runs and CAN `block: true` it, but **cannot supply replacement content** (`ToolCallEventResult` has only `block?` + `reason?`).
- `tool_result` fires *after* execution.
- Therefore an extension **cannot transparently substitute cached file bytes** into a `read`. "Save a read / skip a read" is implemented as **persist + auto-recall**, with an *optional, feature-flagged* same-session block of redundant re-reads (the uncertain `block:true` path).
- `session_before_compact` CAN return a `compaction` result (`types.d.ts:799`) — the real lever to keep file context through compaction.

User decisions captured:
- **Save-a-read = "Both"**: cache+auto-recall **AND** block redundant same-session re-reads.
- **Memory = "Extract from compaction"**: on each compaction, auto-save keyDecisions/nextSteps/facts as kind-tagged memories, plus keep manual `/mega-memory save`.

---

## Goal / Definition of Done

1. mega-compact **automatically accumulates durable memory** from real work (decisions, next steps, facts), and **inlines relevant memories** into new sessions so it starts "context aware."
2. mega-compact **caches every file you read** locally; on resume, if the query relates to a cached file, the cached content is **inlined so you don't re-read it**. Optionally, within a session, **redundant re-reads of an unchanged file are blocked** and served from cache.
3. A **clear, already-working auto-compact** story: verify the trigger, document the knobs, add a `/mega-autocompact [on|off]` toggle for the current session, and ensure the existing cancel-native logic stays intact.
4. All of it stays **local, synchronous, zero-network** (PREVENT-PI-004), with the existing guardrails (anchor floor, tool-pair boundary, data-safety invariant) and tests passing.

## Non-goals

- No remote/MCP memory server (decision already locked in repo).
- No LLM call to "summarize memory" — deterministic extraction only (matches repo's no-network-at-runtime rule). MEMORY.md-style prose is not auto-generated.
- No change to pi itself.

---

## Design

### Module layout (new files under repo conventions — `src/` is pi-agnostic & tested; `extensions/` adapts to pi)

```
src/store/sqlite.ts        (MODIFY) add file_context cache table + CRUD
src/memory.ts              (NEW, pi-agnostic) deriveMemory(messages) -> MemoryDraft[]; persist + recall helpers
src/readcache.ts           (NEW, pi-agnostic) read-cache CRUD (path, mtime, hash, content, embedding, size)
extensions/mega-events.ts  (MODIFY) on('tool_result') cache reads; on('session_start'/'before_agent_start') auto-recall memory+readcache; on('tool_call') optional block
extensions/mega-pipeline.ts(MODIFY) runCompact() calls memory auto-save
extensions/mega-commands.ts(MODIFY) add /mega-autocompact, enrich /mega-status, add /mega-memory list tweaks
src/memory.test.ts         (NEW) unit tests
src/readcache.test.ts      (NEW) unit tests
```

### 1. Auto memory (the "context aware" core)

**Seed source** — `extractiveSummarize()` (`src/extractive.ts:224`) already returns structured `keyDecisions: string[]`, `nextSteps: string[]`, `filesModified: string[]`. This is deterministic, LLM-free, and is exactly what's persisted as a checkpoint each compaction. We reuse it as the memory seed.

**New `src/memory.ts`** (pi-agnostic, unit-tested):
- `deriveMemoryDrafts(summary: { keyDecisions, nextSteps, topicSummary }, repo)` → `MemoryDraft[]`:
  - each `keyDecisions[i]` → `kind: "decision"`, content = decision, tag `#auto #decision`
  - each `nextSteps[i]` → `kind: "next"`, content, tag `#auto #next`
  - one `kind: "fact"` per notable `filesModified`/`topicSummary` headline → content like `"store backend: better-sqlite3"`, tag `#auto #fact`
  - **dedup guard**: hash(content+kind); skip if an identical memory already exists for this repo (use existing `searchMemories`/LIKE or a content hash column). Prevents memory bloat across many compactions. (Add a `content_hash` column to `memories` for O(1) dedup — additive migration via existing `ensureColumn` pattern.)
- `saveAutoMemory(drafts, repo, stateDir)` → inserts non-dup drafts via existing `addMemory`.
- `autoRecall(repo, stateDir, query, k)` → mixes memories into the recall block:
  - Use the **existing trigram embedder** to embed `query`, and cosine-compare against memory content (memories aren't currently embedded — add `embedding_blob` to `memories` table, populated on save, mirroring `context_chunks`).
  - Return top-K memories whose `kind` is decision/next/fact AND similarity ≥ a threshold (default 0.78, env `MEGACOMPACT_MEMORY_RECALL_SIM`).
  - Format as a `### Recalled memory [i] (kind, relevance X%)` block.

**Wire into compaction** — `extensions/mega-pipeline.ts: runCompact()` already computes `result` with `keyDecisions`/`nextSteps`. After persist, call `saveAutoMemory(deriveMemoryDrafts(result, ...), repo, runtime.currentStateDir)` best-effort (try/catch, non-fatal — never block compaction).

**Wire into auto-recall** — extend `doRecall` / the `session_start` + `before_agent_start` path: when staging the recall block, also `autoRecall(repo, query, k)` and **append** memory lines to `runtime.pendingRecallBlock` (memories first, then checkpoints — decisions are higher-value). Reuse the proven `before_agent_start` systemPrompt injection. Dedupe against already-injected (mark injected, reuse `markInjected` pattern keyed by `mem:<id>`).

### 2. Read-context cache ("save a read")

**New table `file_context` in `src/store/sqlite.ts`** (additive; reuse `ensureColumn`/idempotent schema):
```sql
CREATE TABLE IF NOT EXISTS file_context (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  repo          TEXT,
  path          TEXT NOT NULL,
  mtime_ms      INTEGER,        -- file mtime at read time
  content_hash  TEXT,           -- sha256 of content (for freshness check)
  content       BLOB,           -- raw text (or compressed via existing compressSmart)
  size_bytes    INTEGER,
  embedding_blob BLOB,          -- trigram embed of content (for semantic recall)
  read_at       INTEGER,
  UNIQUE(repo, path)
);
CREATE INDEX IF NOT EXISTS idx_file_context_repo ON file_context(repo, path);
```
- `upsertFileContext({repo,path,mtime,hash,content,embedding})`, `getFileContext(repo,path)`, `searchFileContext(repo,query,k,sim)` (cosine over `embedding_blob`), `recentFileContext(repo, k)`.

**Capture on read** — `extensions/mega-events.ts`:
- `on('tool_result', ...)` with `isReadToolResult(event)`: extract `path` from `event.input.path`, `mtime` via `fs.statSync` (best-effort), content from `event.content` text blocks, `embedding = defaultEmbedder.embed(content)`. Compress content via existing `compressSmart` and `upsertFileContext(...)`. Skip images / huge files (env `MEGACOMPACT_READCACHE_MAX_BYTES`, default 200KB) and `node_modules`/`.git`.
- **Throttle**: dedupe by (repo,path) — only rewrite if hash changed; cheap because the table is keyed.

**Auto-recall on resume (the "skip the read" win)** — in `session_start` (alongside existing checkpoint recall), call `searchFileContext(repo, recentUserQuery(ctx), k)` and, if hits ≥ threshold, append a `### Cached file context` block to `pendingRecallBlock` listing path + a truncated content excerpt so the model doesn't need to re-`read` it. Same `before_agent_start` injection.

**Optional same-session block (user chose "Both")** — `on('tool_call', ...)` with `isToolCallEventType('read', event)`:
- If `getFileContext(repo, event.input.path)` exists AND (cached `content_hash` matches current `fs` content OR we accept cache blindly) AND this file is "recently read this session" → `return { block: true, reason: "mega-compact: serving cached read (use /mega-read <path>)" }`.
- **Flagged + safe**: `MEGACOMPACT_READCACHE_BLOCK` (default **false** — off, because `block:true` behaviour is less certain in the API and could surprise the user). When off, we still cache + auto-recall but never block. Add `/mega-read <path>` command to explicitly fetch a cached file. Document the risk clearly in `/mega-help`.
- Guard: never block a read when `config.auto === false` (manual mode) and never block if the cache can't satisfy (no entry / hash mismatch + strict mode).

### 3. Auto-compact: verify + expose (NOT build from scratch)

- **Verify** the existing chain fires: `context` handler (`mega-events.ts:123`) → `autoCompactCheck` (`compact.ts:242`) → `runCompact` → `dropCompactedRange` → `session_before_compact` cancel (`mega-events.ts:167`). Add an **integration test** (`src/e2e.test.ts` style) that simulates a `context` event over threshold and asserts a checkpoint is persisted + a message-drop result is returned.
- **`/mega-autocompact [on|off]`** command (session-scoped toggle): sets `config.auto` (already read by the `context` handler) and updates status/widget. Mirrors `/mega-compact off` which already exists.
- **`/mega-status`** enrichment: show `autoCompact: on/off`, `readCache: on/off (block: on/off)`, `memory: N saved`.
- Knobs already present (keep): `MEGACOMPACT_AUTO`, `MEGACOMPACT_TIER`, `MEGACOMPACT_THRESHOLD_TOKENS`, `MEGACOMPACT_FAST_GATE_PCT`. Add `MEGACOMPACT_MEMORY_RECALL_SIM`, `MEGACOMPACT_READCACHE_BLOCK`, `MEGACOMPACT_READCACHE_MAX_BYTES` to `mega-config.ts` + README config table.
- Keep the existing `session_before_compact` cancel logic intact — it's what prevents double-compaction and is core to "auto compact already works."

### 4. Respect existing invariants

- Anchor floor (`anchorUserMessages`) + tool-pair boundary (`boundary.ts`) unchanged — read-cache/auto-recall only *add* to context via `before_agent_start`, never mutate live messages.
- Data-safety invariant (compressed_original retained, 0 bytes permanently deleted) unchanged — read-cache is a *separate* additive table.
- All new DB columns/tables added idempotently (mirror `ensureColumn`/`CREATE TABLE IF NOT EXISTS`).

---

## Implementation order (incremental, each compiles + tests green)

1. **`src/store/sqlite.ts`**: add `file_context` table + CRUD; add `content_hash` + `embedding_blob` columns to `memories`; add `listMemoriesByEmbedding`/`searchMemoriesSemantic`. (Backward-compatible migration.)
2. **`src/memory.ts`** (new, pi-agnostic): `deriveMemoryDrafts`, `saveAutoMemory`, `autoRecall` + **`src/memory.test.ts`**.
3. **`src/readcache.ts`** (new, pi-agnostic): embed + CRUD + semantic search + **`src/readcache.test.ts`**.
4. **`extensions/mega-pipeline.ts`**: call `saveAutoMemory` after `runCompact` (best-effort).
5. **`extensions/mega-events.ts`**: `tool_result` → cache read; `session_start`/`before_agent_start` → append auto-recalled memory + file context; optional `tool_call` block (flagged).
6. **`extensions/mega-commands.ts`**: `/mega-autocompact`, `/mega-read`, `/mega-status` enrichment; keep `/mega-memory save/list/search/recall`.
7. **`extensions/mega-config.ts`**: new env knobs + README config table update.
8. **Integration test** in `src/e2e.test.ts` for auto-compact-on-`context` + auto-recall-on-resume.
9. Run `npm run build`, `npm test`, `npm run lint` (guardrails scan) — all green.

## Verification

- `npm test` — new `memory.test.ts`, `readcache.test.ts`, plus existing suite; auto-compact e2e passing.
- `npm run lint` — guardrails-scan clean (no new PREVENT-PI-* violations; no network calls).
- Manual smoke (dev mode, symlinked repo): start pi in this repo, read a file, compact (`/mega-compact`), `/mega-status` shows memory count > 0 and readCache > 0; restart pi, ask about the read file, confirm the cached content is inlined (no new `read` tool call) and relevant memory preloaded.
- Confirm `MEGACOMPACT_READCACHE_BLOCK=true` blocks a redundant same-session re-read with the documented notice; `false` (default) never blocks but still caches + auto-recalls.

## Risks / open questions

- **`tool_call` block behaviour** is the one uncertain API surface. Plan defaults it OFF and isolates it behind a flag + a dedicated `/mega-read` escape hatch, so a surprise there can't break normal reads.
- Memory bloat: mitigated by content-hash dedup on save + similarity threshold on recall + `kind` scoping.
- Embedding cost for `memories`/`file_context`: trigram embedder is sync + cheap (already used for checkpoints); bounded by `READCACHE_MAX_BYTES` and per-repo scoping.

## Suggested commit(s)

- `feat(memory): auto-extract + auto-recall durable memory from compaction`
- `feat(readcache): persist read files + inline on resume; optional same-session block`
- `feat(autocompact): verify+expose auto-compact toggle + status`
