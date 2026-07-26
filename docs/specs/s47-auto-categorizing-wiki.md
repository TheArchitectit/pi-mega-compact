# S47 — Auto-Categorizing Memory Wiki

**Date:** 2026-07-26
**Parent plan:** Memory RAG System (borrowed from radical-memory-mcp / R.A.D.1.C.A.1)
**Depends on:** S40 (importance scoring), S42 (RAPTOR multi-level retrieval), S46 (visual memory map), `src/store/sqlite.ts`, `extensions/dashboard-server/server.ts`
**Priority:** P2
**Status:** Draft → implement-ready
**Target version:** v0.9.x

---

## SAFETY PROTOCOLS

- **PREVENT-PI-004** (no network): topic assignment (rule-based) is pure in-process keyword matching. LLM-based classification (`WIKI_TOPIC_MODEL=llm|hybrid`) uses the configured localhost Ollama endpoint (same exception class as `src/dedup/raptor/summarizer.ts:12` — annotated with `guardrails-allow`). The wiki dashboard is localhost-only.
- **PREVENT-PI-001** (anchor floor): the wiki is a read-only presentation layer over stored memories. It does not modify message ordering, drop ranges, or checkpoint storage.
- **Feature flags default OFF**: `WIKI_ENABLED` defaults to `false`. No tables created, no topic assignment, no wiki generation when disabled.
- **Write-time assignment**: topics are assigned when memories are stored (during `memory-review` or checkpoint creation), not at query time. This ensures topic stability — a memory's topic doesn't change between queries.
- **Non-fatal**: topic assignment failure does not prevent memory storage. Memories without topics are simply uncategorized.
- Gate: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`.

---

## PROBLEM

Conversation memories accumulate as a flat list in the `memories` and `context_chunks` tables. There's **no organizational structure** beyond timestamps and RAPTOR clusters:

1. **No topical organization** — to find all memories about "authentication", the user must search by text. There's no browsable category. RAPTOR clusters (`src/dedup/raptor/`) group *similar* memories, but clusters are ephemeral (rebuilt on tree construction) and not user-navigable.

2. **No knowledge base** — memories are transactional (created, retrieved, injected). There's no way to browse a synthesized view of "what do I know about deployment?" or "what decisions were made about the database?"

3. **No topic hierarchy** — RAPTOR clusters are flat (leaf → level-1 → root). There's no semantic hierarchy like "infrastructure > deployment > Docker" or "code > authentication > JWT".

4. **No topic summaries** — even if memories were grouped, there's no auto-generated summary for each topic. The user would have to read every memory individually.

5. **Sprint S46 provides visual navigation** (memory map) but not *categorical* navigation. The wiki complements the map: the map shows relationships, the wiki shows categories.

---

## SCOPE

### IN SCOPE (new files):
- `src/topics.ts` — topic model: types, rule-based assignment, LLM classification
- `src/topics.test.ts` — unit tests for topic assignment
- `src/wiki.ts` — wiki page generation from topic memories
- `src/wiki.test.ts` — unit tests for wiki generation
- `src/store/sqlite/topics.ts` — SQLite topic storage (tables + CRUD)
- `src/store/sqlite/topics.test.ts` — unit tests for topic storage
- `extensions/dashboard-client/src/tabs/WikiTab.tsx` — wiki dashboard tab
- `extensions/dashboard-client/src/components/WikiPage.tsx` — wiki page renderer
- `extensions/dashboard-client/src/components/TopicTree.tsx` — topic hierarchy browser

### IN SCOPE (modified files):
- `extensions/mega-events/context-handler.ts` — trigger topic assignment on new checkpoints/memories
- `extensions/dashboard-server/server.ts` — add wiki API endpoints
- `extensions/dashboard-client/src/App.tsx` — add "Wiki" tab
- `src/store/sqlite.ts` — add barrel re-export for topics submodule
- `src/config/dedup.ts` — add wiki config flags

### OUT OF SCOPE:
- Real-time topic updates — topics are assigned at write time, not refreshed in-place.
- User-editable topics — wiki pages are auto-generated; manual editing is a future feature.
- Full-text search within wiki — the wiki is browsed by topic tree; search is via existing `/recall-context` endpoint.

---

## EXECUTION

### Sprint S47A: Topic Model (Rule-Based)

**Goal:** Implement rule-based topic assignment with keyword matching.

**Acceptance:** `assignTopic(memory)` returns a topic for clear cases (error → debugging, deploy → deployment). Ambiguous cases get `null`.

**Tasks:**

- [ ] **S47A.1** Create `src/topics.ts` with types
  - `Topic` type: `{ id: string; name: string; description: string; parentTopicId: string | null; memoryCount: number; lastUpdated: number }`
  - `TopicAssignment` type: `{ memoryId: string; topicId: string; confidence: number; assignedAt: number; method: "rule" | "llm" | "hybrid" }`
  - `TopicRule` type: `{ keywords: string[]; topicName: string; parentTopic: string | null; description: string }`

- [ ] **S47A.2** Define topic rules (hardcoded, extensible)
  - Parent topics: `code`, `infrastructure`, `process`, `debugging`
  - Sub-topics under `code`: `authentication` (keywords: auth, login, jwt, token, oauth, session, password), `database` (keywords: sql, sqlite, pg, migration, schema, query, index), `api` (keywords: endpoint, route, request, response, rest, graphql), `frontend` (keywords: ui, component, css, html, react, dashboard, tab)
  - Sub-topics under `infrastructure`: `deployment` (keywords: deploy, ship, release, ci/cd, docker, container, publish, npm), `monitoring` (keywords: metrics, alert, log, trace, perf, latency, error-rate), `storage` (keywords: disk, fs, file, backup, checkpoint, compress)
  - Sub-topics under `debugging`: `errors` (keywords: error, exception, crash, fail, bug, stacktrace, TypeError, ReferenceError), `performance` (keywords: slow, timeout, bottleneck, optimize, latency, p95)
  - Sub-topics under `process`: `decisions` (keywords: decided, chose, trade-off, rationale, design-decision), `testing` (keywords: test, spec, mock, coverage, regression, assert)

- [ ] **S47A.3** Implement `assignTopicRuleBased(memoryText: string): TopicAssignment | null`
  - Tokenize: lowercase, split on whitespace/punctuation
  - For each rule: count keyword matches in memory text
  - Select rule with highest match count (minimum 2 matches to assign)
  - If tie: prefer more specific (sub-topic) over general (parent)
  - If no rule matches ≥2 keywords: return `null`
  - Confidence = `min(1.0, matchCount / 5)` — 5 keyword matches = full confidence

- [ ] **S47A.4** Implement topic hierarchy constants
  - `TOPIC_HIERARCHY`: array of `{ id, name, parentId, description, keywords }`
  - Seed topics are created at schema migration time (idempotent INSERT OR IGNORE)
  - Topic IDs are stable slugs: `code-authentication`, `infra-deployment`, etc.

- [ ] **S47A.5** Add tests in `src/topics.test.ts`
  - Test: "authentication error with JWT token" → `code-authentication` (3 keyword matches)
  - Test: "deploy to production via Docker" → `infra-deployment` (3 matches)
  - Test: "TypeError at line 42" → `debugging-errors` (2 matches)
  - Test: "the quick brown fox" → `null` (no matches)
  - Test: ties prefer sub-topic over parent
  - Test: confidence scales with match count

- [ ] **S47A.6** Verify: `npm run build && npm test`

---

### Sprint S47B: Topic Storage + LLM Classification

**Goal:** Persist topics and assignments in SQLite; add LLM fallback for ambiguous cases.

**Acceptance:** Topics survive restart; LLM classification works for ambiguous memories.

**Tasks:**

- [ ] **S47B.1** Create `src/store/sqlite/topics.ts` with schema
  - `topics` table: `id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, parent_topic_id TEXT REFERENCES topics(id), memory_count INTEGER DEFAULT 0, last_updated INTEGER`
  - `memory_topics` table: `memory_id TEXT NOT NULL, topic_id TEXT NOT NULL REFERENCES topics(id), confidence REAL, assigned_at INTEGER, method TEXT CHECK(method IN ('rule','llm','hybrid')), PRIMARY KEY (memory_id, topic_id)`
  - Index: `CREATE INDEX idx_memory_topics_topic ON memory_topics(topic_id)`
  - Seed parent topics + sub-topics from `TOPIC_HIERARCHY` on first access

- [ ] **S47B.2** Implement CRUD operations
  - `getOrCreateTopic(db, id, name, description, parentId)` — idempotent upsert
  - `assignMemoryToTopic(db, memoryId, topicId, confidence, method)` — INSERT OR IGNORE
  - `getTopicsForMemory(db, memoryId)` → `TopicAssignment[]`
  - `getMemoriesForTopic(db, topicId, limit?, offset?)` → `{ memoryId, content, timestamp, importance }[]`
  - `getTopicHierarchy(db)` → `Topic[]` (tree structure)
  - `incrementTopicMemoryCount(db, topicId)` — update `memory_count` and `last_updated`

- [ ] **S47B.3** Add LLM classification for `WIKI_TOPIC_MODEL=llm|hybrid`
  - When rule-based returns `null` AND topic model is `llm` or `hybrid`:
    - Call localhost Ollama with prompt: "Classify this text into one of these topics: [list]. Text: {memory}. Topic:"
    - Parse response; match to known topic name
    - Assign with `method: "llm"`, confidence = 0.7 (lower than rule-based)
  - Guard: same `guardrails-allow PREVENT-PI-004: localhost Ollama` annotation as `src/dedup/raptor/summarizer.ts:12`
  - Fallback: if LLM call fails or timeout (2s), skip assignment (non-fatal)

- [ ] **S47B.4** Add barrel re-export in `src/store/sqlite.ts`
  - `export * from "./sqlite/topics.js";`

- [ ] **S47B.5** Add config flags to `src/config/dedup.ts`
  - `WIKI_ENABLED: boolean` (env: `MEGACOMPACT_WIKI`, default: `false`)
  - `WIKI_TOPIC_MODEL: string` (env: `MEGACOMPACT_WIKI_MODEL`, default: `"rule-based"`, options: `"rule-based" | "llm" | "hybrid"`)
  - `WIKI_MAX_TOPICS: number` (env: `MEGACOMPACT_WIKI_MAX_TOPICS`, default: `50`)
  - `WIKI_MIN_MEMORIES_PER_TOPIC: number` (env: `MEGACOMPACT_WIKI_MIN_MEMORIES`, default: `3`)

- [ ] **S47B.6** Add tests in `src/store/sqlite/topics.test.ts`
  - Test: topic table creation + seed data
  - Test: CRUD operations round-trip
  - Test: topic hierarchy is navigable
  - Test: memory_count increments correctly
  - Test: duplicate assignment is idempotent

- [ ] **S47B.7** Verify: `npm run build && npm test`

---

### Sprint S47C: Wiki Page Generation

**Goal:** Generate wiki pages from topic memories — summary, key decisions, recent memories.

**Acceptance:** `generateWikiPage(topicId)` returns a structured wiki page with all sections.

**Tasks:**

- [ ] **S47C.1** Create `src/wiki.ts` with types
  - `WikiPage` type: `{ topic: Topic; summary: string; keyDecisions: Array<{ content: string; timestamp: number }>; recentMemories: Array<{ content: string; timestamp: number; importance: number }>; relatedTopics: Topic[]; generatedAt: number }`
  - `WikiIndex` type: `{ topics: Array<{ id: string; name: string; memoryCount: number; childCount: number }> }`

- [ ] **S47C.2** Implement `generateWikiPage(topicId, db): WikiPage`
  - Fetch topic metadata
  - Fetch memories for topic (ordered by `timestamp DESC`, limit 50)
  - Extract key decisions: filter memories where `topicId` matches `process-decisions` OR content contains decision keywords
  - Recent memories: last 10 by timestamp
  - Related topics: topics that share ≥2 memory IDs with this topic (via `memory_topics` join)
  - Summary: concatenation of topic description + top-3 memory summaries (rule-based extractive)

- [ ] **S47C.3** Implement LLM summary generation (optional)
  - When `WIKI_TOPIC_MODEL=llm|hybrid`:
    - Feed top-10 memories to localhost Ollama with prompt: "Summarize these conversation excerpts about {topicName} in 2-3 paragraphs. Focus on key decisions and patterns. Excerpts: {memories}"
    - Use as wiki page summary
    - Fallback: if LLM fails, use extractive summary (non-fatal)

- [ ] **S47C.4** Implement `getWikiIndex(db): WikiIndex`
  - Query all topics with `memory_count >= WIKI_MIN_MEMORIES_PER_TOPIC`
  - Build tree structure (parent → children)
  - Return sorted by `memory_count DESC`

- [ ] **S47C.5** Implement write-time topic assignment
  - In `extensions/mega-events/context-handler.ts`: after a checkpoint or memory is stored, call `assignTopicAndStore()` if `WIKI_ENABLED=true`
  - `assignTopicAndStore(memoryId, text, db)`:
    1. Call `assignTopicRuleBased(text)`
    2. If null and model is `llm|hybrid`, call LLM classifier
    3. If topic assigned, call `assignMemoryToTopic()` + `incrementTopicMemoryCount()`
    4. Non-fatal: any failure logs warning, continues

- [ ] **S47C.6** Add tests in `src/wiki.test.ts`
  - Test: wiki page has all required sections (summary, decisions, memories, related)
  - Test: empty topic returns minimal page (no crash)
  - Test: related topics are correctly identified
  - Test: wiki index is sorted by memory count
  - Test: LLM summary falls back to extractive on failure
  - Test: write-time assignment triggers on checkpoint creation

- [ ] **S47C.7** Verify: `npm run build && npm test`

---

### Sprint S47D: Dashboard Wiki Tab

**Goal:** Add a browsable wiki interface to the dashboard.

**Acceptance:** Wiki tab shows topic tree; clicking a topic shows its wiki page.

**Tasks:**

- [ ] **S47D.1** Add API endpoints in `extensions/dashboard-server/server.ts`
  - `GET /api/wiki/index` — returns `WikiIndex` (topic tree with counts)
  - `GET /api/wiki/topic/:id` — returns `WikiPage` for a topic
  - `GET /api/wiki/search?q=term` — search topics by name/description (FTS5 on topic names)
  - All gated: return 404 when `WIKI_ENABLED=false`

- [ ] **S47D.2** Create `extensions/dashboard-client/src/components/TopicTree.tsx`
  - Recursive tree component: parent topics expand to show children
  - Each node: topic name, memory count badge
  - Click: load wiki page for that topic
  - Highlight: currently selected topic
  - Search input at top: filters tree by name

- [ ] **S47D.3** Create `extensions/dashboard-client/src/components/WikiPage.tsx`
  - Renders a `WikiPage` response:
    - Header: topic name + description
    - Summary section: rendered markdown-like (paragraphs)
    - Key Decisions section: list of decisions with timestamps
    - Recent Memories section: scrollable list with importance indicators
    - Related Topics section: clickable links to related wiki pages
  - "View in Memory Map" link (future: deep-link to S46 memory map focused on this topic)

- [ ] **S47D.4** Create `extensions/dashboard-client/src/tabs/WikiTab.tsx`
  - Layout: two-column (TopicTree on left, WikiPage on right)
  - Initial state: show wiki index overview (total topics, total memories, top topics)
  - Loading: show spinner while fetching wiki page
  - Empty state: "No topics yet — topics are assigned as memories are created"

- [ ] **S47D.5** Add "Wiki" tab to `extensions/dashboard-client/src/App.tsx`
  - Add `WikiTab` lazy import (~line 22)
  - Add `"wiki"` to `TabId` union (~line 36)
  - Add to `TABS` array (~line 48)
  - Add render case (~line 72)

- [ ] **S47D.6** Verify: `cd extensions/dashboard-client && npm run build && npm test`

- [ ] **S47D.7** Full regression test
  - `MEGACOMPACT_WIKI=false npm test` — zero behavior change
  - `MEGACOMPACT_WIKI=true npm test` — all new tests pass
  - `python3 scripts/regression_check.py --all` — green

---

## ACCEPTANCE CRITERIA

1. **Zero behavior change when OFF**: `WIKI_ENABLED=false` (default) creates no tables, runs no topic assignment, returns 404 on wiki endpoints.
2. **Rule-based assignment works**: memories with clear keywords (error, deploy, auth) are correctly categorized.
3. **LLM fallback works**: ambiguous memories are classified by localhost Ollama when `WIKI_TOPIC_MODEL=llm|hybrid`.
4. **Wiki pages are complete**: each page has summary, key decisions, recent memories, and related topics.
5. **Topic tree is navigable**: dashboard shows hierarchical topic tree; clicking a topic loads its page.
6. **Write-time assignment**: topics are assigned when memories are created, not at query time.
7. **Non-fatal**: topic assignment failure does not prevent memory storage or recall.
8. **Performance**: topic assignment adds <5ms (rule-based) or <3s (LLM) to checkpoint creation.

---

## ROLLBACK

1. Set `MEGACOMPACT_WIKI=false` to disable all wiki functionality.
2. Drop `topics` and `memory_topics` tables (SQLite migration not needed — tables are only created when enabled).
3. Remove "Wiki" tab from `TABS` in `App.tsx`.
4. All new code is in new files (`src/topics.ts`, `src/wiki.ts`, `src/store/sqlite/topics.ts`).
5. Integration point in `extensions/mega-events/context-handler.ts` is gated behind `if (config.WIKI_ENABLED)`.

---

## RISKS

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| LLM classification adds latency to checkpoint creation | Medium | Low | LLM calls are async, non-blocking; 2s timeout; fallback to uncategorized |
| Rule-based keywords are too rigid | Medium | Low | Extensible rules array; LLM hybrid mode covers edge cases |
| Topic hierarchy is too shallow | Low | Low | 2-level hierarchy is sufficient for v1; can extend to 3+ levels later |
| Wiki pages are stale after topic reorganization | Low | Medium | Pages are regenerated on-demand; `lastUpdated` timestamp tracks freshness |
| Ollama unavailable in some environments | Medium | Low | Default is `rule-based`; LLM is opt-in only; failure is non-fatal |
| Large number of uncategorized memories | Medium | Low | "Uncategorized" catch-all topic; minimum 3 memories per topic prevents noise |
