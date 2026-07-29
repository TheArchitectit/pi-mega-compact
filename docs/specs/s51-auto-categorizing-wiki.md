# S51 — Auto-Categorizing Wiki (S47, re-targeted onto the S49 store)

**Date:** 2026-07-28
**Parent program:** `docs/specs/s49-program-per-turn-memory-platform.md` (§2, S51 row)
**Extends:** `docs/specs/s47-auto-categorizing-wiki.md` (implement-ready content spec — **the algorithms, acceptance criteria, and honest-boundary rules live there; this doc is the re-target delta**)
**Depends on:** S49 (shipped — `src/store/turns/`, incl. reserved `topics`/`memory_topics` shells), S50 (shipped — `src/metrics/turns.ts`)
**Priority:** P1
**Status:** SHIPPED — v0.9.x (topics + memory_topics tables + TopicStore + k-means+TF-IDF clustering + /api/topics + TopicsTab). See `src/topics/store.ts` + `extensions/mega-topics-cmds.ts` + `extensions/dashboard-server/routes-topics.ts`.
**Target version:** v0.9.2
**Reuse target:** `src/topics/` + `src/wiki.ts` are host-agnostic (pi-agnostic, embeddable; program §3).

---

## REUSE CONTRACT

Same invariant as S49/S50, tightened for S51's surface: **no module in `src/topics/` or
`src/wiki.ts` imports `ExtensionAPI` / `MegaRuntime` / `@earendil-works/*`.** The clustering +
labeling + wiki-generation logic consumes only:

- the `TurnStore` interface (for topic persistence — S49), and
- a plain `DatabaseSync` handle for the **main db** (for the embedding/text source —
  `context_chunks`), and
- pure-math primitives reused from `src/dedup/raptor/` (`kmeans.ts`, `summarizer.ts`) and
  `src/embedder.ts` (`Vector`, `cosineSimilarity`).

Hosts (own TUI / API gateway) wire the two db handles + a config object at the adapter edge.
Grep-asserted in tests (no `@earendil-works` / `extensions/` import in `src/topics/`,
`src/wiki.ts`).

---

## SAFETY PROTOCOLS

Carried from S47 verbatim; re-anchored here because they are non-negotiable:

- **PREVENT-PI-004 (zero network) — the load-bearing rule for S51.** Topic clustering is **pure
  local math** — k-means over stored embeddings + TF-IDF over stored text. **NO LLM, NO Ollama, NO
  `fetch`.** The existing `summarizeCluster` has an Ollama branch; S51 uses only
  `extractiveClusterSummary` / a local TF-IDF sentence ranker and MUST NOT call the Ollama path.
  Grep-asserted: no `ollama` / `llm` / `hybrid` / `fetch` in `src/topics/` or `src/wiki.ts`.
- **PREVENT-PI-001 / 002** (anchor floor / tool pairs): topics are a **derived, read-only view**
  over `context_chunks`. Building/replacing a topic model never drops, compacts, or alters any
  memory, checkpoint, or message. `replaceTopicModel` only rewrites `topics`/`memory_topics`.
- **PREVENT-PI-003**: no injection-path change.
- **PREVENT-002** (parameterized SQL): all topic/source queries use bound parameters.
- **Gate default ON**: `AUTO_WIKI_ENABLED` (env `MEGACOMPACT_AUTO_WIKI`, default `true`). OFF → no
  rebuild, no topic writes, `/mega-topics` reports disabled.
- **Non-fatal**: clustering/assignment/wiki failure logs and never breaks compaction, memory
  storage, recall, or the agent loop.
- Gate (every sub-sprint): `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all`.

---

## WHAT CHANGES VS S47 (the re-target delta)

S47 was written against the pre-S49 monolith. Four things moved; everything else in S47 stands.

| # | S47 assumed | S51 reality (shipped S49/S50) | S51 action |
| - | ----------- | ----------------------------- | ---------- |
| 1 | Topic tables created in the **main db** (`src/store/sqlite/topics.ts`, new migration) | `topics` + `memory_topics` **already exist** as reserved shells in `src/store/turns/schema.ts` (S49, program §3 "one schema module owns all turn-side tables") | **No new tables, no migration.** Implement `src/topics/store.ts` CRUD against the existing turns.db tables via the `TurnStore` handle (or a thin `TopicStore` over the same connection). |
| 2 | Embedding/text source = `context_chunks.embedding_blob` + `content` (main db) | `context_chunks` **still exists** in the main db with `embedding_blob` (float32) + `normalized_text`/`summary` (S49 did not retire it — it retired the *turn* tables). | Source is unchanged: **`context_chunks`** in the main db. Read `embedding_blob` + best-available text (`COALESCE(normalized_text, summary, topic_summary)`). |
| 3 | Rebuild trigger in `extensions/mega-events/compact-handlers.ts` | The compaction path lives in `extensions/mega-events/context-handler.ts` (`runCompact` + `writeCheckpointEpoch`); there is no separate `compact-handlers.ts`. | Wire the every-Nth-compaction rebuild trigger in **`context-handler.ts`** at the compact-commit point (alongside S50B's epoch stamp). Counter persisted in `turns_meta` (S49 key-value table), not main-db `session_state`. |
| 4 | Dashboard Wiki tab is **S47D** (same sprint) | Program splits dashboard work into **S52** (Wiki tab + Turns tab + rewind handshake). | **Wiki tab / API endpoints are OUT OF SCOPE for S51** (deferred to S52). S51 ships the data layer + a `/mega-topics` CLI command so the categorization is reviewable before the dashboard lands. |

Everything else in S47 — k selection (elbow/silhouette), TF-IDF labeling, real-membership
confidence, extractive-only summaries, the error-logging contract, and the 14 acceptance criteria —
is adopted unchanged, with `context_chunks` as the confirmed source and the turns.db `topics`/
`memory_topics` tables as the confirmed sink.

---

## PROBLEM

Memory accumulates as flat checkpoints + notes with no topical organization. The user asked for a
**Wiki tab to review memories by category** (cache hits, dedup, compression by turn/conversation —
the S50 metrics — plus topical buckets). S51 builds the **categorization layer** that tab renders:
derive topic clusters from real stored embeddings, label them from real TF-IDF, assign memories to
them with a real confidence, and generate extractive wiki pages — all local, all honest (no
fabricated taxonomy, no LLM).

---

## SCOPE

File-size discipline: every new module < 300 lines; single responsibility; thin barrels.

### IN SCOPE (new files)

| File | Responsibility | Est. lines |
| ---- | -------------- | ---------- |
| `src/topics/types.ts` | `Topic`, `TopicAssignment`, `ClusterModel` (S47 §S47A.1 verbatim). | ~40 |
| `src/topics/cluster.ts` | `loadEmbeddings(mainDb)` over `context_chunks`; k selection (elbow/silhouette); `buildTopicModel(mainDb, config)`. Reuses `kmeanspp`/`cosineDistance`/`meanVector` from `src/dedup/raptor/kmeans.ts`. | ~180 |
| `src/topics/labels.ts` | TF-IDF term extraction + cluster labeling + membership confidence (S47 §S47A.5–6). | ~120 |
| `src/topics/store.ts` | `TopicStore` CRUD over the turns.db `topics`/`memory_topics` shells: `replaceTopicModel`, `getTopics`, `getMemoriesForTopic`, `getTopicForMemory`, `getTopicStats` (S47 §S47B.2). Atomic replace in a transaction. | ~140 |
| `src/topics/index.ts` | Barrel. | ~12 |
| `src/wiki.ts` | `generateWikiPage`, `getWikiIndex` — extractive summary (local TF-IDF sentence rank), key/recent memories, related topics by co-occurrence (S47 §S47C). | ~160 |
| `src/topics/cluster.test.ts` | k selection, labeling, confidence, degenerate corpus, determinism, **grep-assert no ollama/llm/fetch/keyword-literals**. | ~200 |
| `src/topics/store.test.ts` | Schema-present (shells), atomic replace, CRUD round-trip. | ~120 |
| `src/wiki.test.ts` | Page completeness, extractive-only summary (verbatim sentences), related topics, empty topic. | ~140 |
| `extensions/mega-topics-cmds.ts` | `/mega-topics` (list clusters + counts) + `/mega-topic <id>` (show a wiki page) — pi-coupled edge so the layer is reviewable pre-dashboard. | ~120 |

### IN SCOPE (modified files)

- `src/config/dedup.ts` — add `AUTO_WIKI_ENABLED`, `WIKI_K_RANGE`, `WIKI_LABEL_TOP_TERMS`,
  `WIKI_REBUILD_EVERY_N_COMPACTS` (S47 §S47B.4; the DELETED LLM/taxonomy flags stay deleted).
- `src/config/turns.ts` (or the active config surface) — surface the wiki flags to the extension.
- `extensions/mega-events/context-handler.ts` — every-Nth-compaction rebuild trigger at
  compact-commit (counter in `turns_meta`), best-effort + non-fatal, gated on `AUTO_WIKI_ENABLED`
  AND `turnsDbEnabled`.
- `extensions/mega-compact.ts` — register `mega-topics-cmds.ts`.
- `src/store/turns/turnStore.ts` — expose a `runInTx`/raw-handle accessor **only if** `TopicStore`
  needs the underlying `DatabaseSync` (prefer `TopicStore` taking the same stateDir and opening via
  the shared `connection.ts` cache — keeps `TurnStore` interface unchanged).

### OUT OF SCOPE (deferred)

- **Dashboard Wiki tab + `/api/wiki/*` endpoints → S52** (with the Turns tab + rewind handshake).
- Real-time topic updates (rebuild is every-Nth-compaction only, per S47).
- User-editable topics; full-text search within the wiki; topic hierarchy (flat clusters only).
- LLM/Ollama summarization — **hard no** (S47 honest boundary; extractive only).
- Changing compaction/dedup/recall behavior — S51 only *derives + reads* a topic view.

---

## EXECUTION

Three gated sub-sprints (S47's S47A→S51A, S47B→S51B, S47C→S51C; S47D is S52).

### Sprint S51A: Clustering + TF-IDF labeling (pure math, host-agnostic)

**Goal:** `buildTopicModel(mainDb, config)` returns a `ClusterModel` whose k was chosen by a real
criterion over real `context_chunks` embeddings, each cluster labeled by real TF-IDF terms.

**Tasks:**

- [ ] **S51A-1** `src/topics/types.ts` — `Topic` / `TopicAssignment` / `ClusterModel` (S47 §S47A.1).
- [ ] **S51A-2** `loadEmbeddings(mainDb)`: read `id`, `session_id`, `embedding_blob`, and
  `COALESCE(normalized_text, summary, topic_summary) AS text` from `context_chunks`; skip
  null/empty embeddings; decode float32 blob → `Vector`. If `< WIKI_K_RANGE[0]` rows have
  embeddings → return empty (caller falls back to a single `general` cluster).
- [ ] **S51A-3** k selection: for `k` in `WIKI_K_RANGE`, run `kmeanspp` (seeded); compute WCSS +
  mean silhouette; pick elbow k (max curvature) or silhouette k (highest mean) per corpus size;
  degenerate corpus → single `general` cluster + warn.
- [ ] **S51A-4** `labels.ts`: TF-IDF over the real corpus; label = top `WIKI_LABEL_TOP_TERMS`;
  confidence = normalized cosine to assigned centroid in [0,1]; low-margin flag (non-fatal).
- [ ] **S51A-5** `buildTopicModel` orchestrator.
- [ ] **S51A-6** tests + grep-asserts (no `ollama`/`llm`/`fetch`; no fabricated keyword literals).
- [ ] **GATE S51A** — full gate green. Commit `feat(topics): S51A k-means clustering + TF-IDF labels`.

### Sprint S51B: Topic persistence (turns.db) + rebuild trigger

**Goal:** persist the model in the existing `topics`/`memory_topics` shells; rebuild on every Nth
compaction.

**Tasks:**

- [ ] **S51B-1** `src/topics/store.ts` — CRUD over the S49 turns.db tables (atomic
  `replaceTopicModel` in a transaction; old model fully replaced). Opens via the shared
  `connection.ts` cache for the same stateDir (no second file handle).
- [ ] **S51B-2** config flags (`AUTO_WIKI_ENABLED` default ON, `WIKI_K_RANGE`, `WIKI_LABEL_TOP_TERMS`,
  `WIKI_REBUILD_EVERY_N_COMPACTS` default 10) in `src/config/dedup.ts` + surfaced to the extension.
- [ ] **S51B-3** rebuild trigger in `context-handler.ts`: compaction counter in `turns_meta`; when
  `counter % N === 0` AND `AUTO_WIKI_ENABLED` AND `turnsDbEnabled` → `buildTopicModel` +
  `replaceTopicModel`; log `wiki_rebuild` per the S47 error-logging contract; non-fatal.
- [ ] **S51B-4** tests: atomic replace, counter fires every Nth, `AUTO_WIKI_ENABLED=false` → no
  writes, failure rolls back (existing model intact).
- [ ] **GATE S51B** — full gate green. Commit `feat(topics): S51B topic persistence + rebuild trigger`.

### Sprint S51C: Extractive wiki pages + `/mega-topics` command

**Goal:** `generateWikiPage` + `getWikiIndex` (extractive only); a CLI command to review topics
before the dashboard exists.

**Tasks:**

- [ ] **S51C-1** `src/wiki.ts` — `WikiPage` / `WikiIndex`; extractive summary via a local TF-IDF
  sentence ranker (verbatim member sentences only — reuse the S42/RAPTOR extractive boundary, NOT
  the Ollama path); `keyMemories` by importance; `recentMemories` by timestamp; `relatedTopics` by
  `memory_topics` co-occurrence.
- [ ] **S51C-2** `extensions/mega-topics-cmds.ts` — `/mega-topics` lists clusters (label, count,
  last rebuild); `/mega-topic <id>` renders a wiki page via `ctx.ui.notify`. Flag OFF → notify
  disabled. Register in `mega-compact.ts`.
- [ ] **S51C-3** tests: page completeness; summary is verbatim-extractive; empty topic no-crash;
  related topics correct; index sorted by memory_count; grep-assert no `ollama`/`llm`.
- [ ] **GATE S51C** — full gate green. Commit `feat(wiki): S51C extractive wiki pages + /mega-topics`.

---

## ACCEPTANCE CRITERIA

Adopt S47's 14 criteria verbatim, re-anchored:

1–9, 11, 13, 14: unchanged (see S47) — with `context_chunks` as the confirmed source (criterion 5)
and the turns.db `topics`/`memory_topics` shells as the sink.

- **10 (rebuild trigger)**: fires every Nth compaction via the counter in `turns_meta` — no timer.
- **12 (navigable topic list)**: satisfied in S51 by `/mega-topics`; the dashboard Wiki tab is S52.
- **15 (new) Reuse-clean**: `grep -r "@earendil-works\|extensions/" src/topics/ src/wiki.ts` → nothing.
- **16 (new) No schema drift**: S51 creates **no** new tables/migrations — it writes only the
  pre-existing S49 `topics`/`memory_topics` shells and the `turns_meta` counter.

## ROLLBACK

1. `MEGACOMPACT_AUTO_WIKI=false` → no rebuild, no topic writes, `/mega-topics` reports disabled.
2. Topic rows are derived data in the reserved shells — `DELETE FROM memory_topics; DELETE FROM topics;` clears the view; no schema rollback (tables stay, per S49).
3. Remove the `context-handler.ts` rebuild hunk + unregister `mega-topics-cmds.ts`.
4. All S51 code is new files (`src/topics/`, `src/wiki.ts`) + two small wiring hunks.

## RISKS

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| `context_chunks.embedding_blob` sparse (embedder off / MiniLM off) → few vectors → degenerate corpus | Medium | Medium | Fall back to single `general` cluster + warn; wiki still lists all memories under it. Never blocks compaction. |
| Rebuild on the compaction hot path adds latency | Low | Low | Runs only every Nth (default 10) compaction; clustering is O(N·k·restarts·iter) over stored chunks; non-fatal + off the turn path. |
| Two writers to turns.db (turn store + topic store) | Low | Low | Shared `connection.ts` cache → one WAL connection; atomic `replaceTopicModel` in a single transaction. |
| `context_chunks` retired in a future sprint → source moves | Low | Medium | `loadEmbeddings` is one function behind a narrow query; re-point to the successor source in one place. |
