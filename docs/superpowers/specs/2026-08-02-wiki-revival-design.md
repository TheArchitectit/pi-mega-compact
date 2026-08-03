# Design — Wiki Revival: Provenance + User Curation + Topic Evolution

> **Date:** 2026-08-02
> **Spec:** 3 of 3 (follows Spec 1 Visual Design Migration — all new UI uses Tailwind + shadcn/ui)
> **Baseline:** v0.13.5 (published)
> **Status:** Draft (pending review) → then writing-plans for the implementation plan
> **Branch:** new branch for this work (e.g. `feat/wiki-revival`)
> **Feature flag:** `MEGACOMPACT_WIKI_ENHANCED` (default ON, opt-out — see §10)
> **Builds on:** S51 (`src/topics/*` k-means+TF-IDF), S51C (`src/wiki.ts` extractive pages), S52 (TopicsTab), S46 (Memory Map D3)

---

## 1. Overview

### What we are doing

`src/wiki.ts` ships a **fully implemented and tested** extractive wiki-page engine
(`generateWikiPage`, `buildWikiIndex`, `extractiveSummary`) with **zero callers** —
no endpoint, no UI, no command invokes it. It has been dead code since S51C. This
spec revives that engine and layers three capabilities the read-only Topics tab
currently lacks:

1. **Wire the engine + provenance.** Surface the wiki through new endpoints and
   replace the read-only Topics table with a rich Wiki tab: extractive summary,
   key/recent memories, clickable related topics, and **turn/session provenance**
   showing which conversation turns / sessions produced each topic memory.
2. **User curation.** Let users **rename** a topic, **merge** two topics, and
   **split** a topic. User overrides persist in a new `topic_overrides` table that
   survives `replaceTopicModel` auto-rebuilds.
3. **Topic evolution visualizations.** A **per-topic timeline** (when memories were
   added to this topic, bucketed across sessions) on each wiki page, plus a
   **global topic evolution graph** — a D3 force-directed view of all topics sized
   by memory count with co-occurrence edges and a timeline scrubber, extending the
   existing Memory Map D3 infrastructure.

### Why now

The auto-categorizing wiki (`src/topics/*`) is fully durable and proven — the
`topics`/`memory_topics` tables are built every Nth compaction and served read-only
at `/api/topics`. But the value the wiki is supposed to deliver (a browsable,
curated, evolving memory index) is half-built: the page generator is unwired, users
can't fix mislabeled or over-fragmented topics, and there is no view of how topics
grow over time. This spec closes all three gaps without disturbing the durable,
authoritative topic model.

### Goals

1. Revive `generateWikiPage` / `buildWikiIndex` through 7 new endpoints (§4).
2. Add turn-level provenance: each topic memory shows the session + contributing
   turns behind it (§8).
3. Persistent user curation (rename / merge / split) that survives auto-rebuilds (§7).
4. Per-topic timeline + global topic evolution graph (§5, §6).
5. Non-fatal, feature-flagged, loopback-only, fully gated (§10).

### Non-goals

- Changing the durable topic model (`ClusterModel` / `buildTopicModel` mechanics).
- Replacing the authoritative sync node:sqlite store.
- Any model/network calls for wiki generation (stays extractive/local — PREVENT-PI-004).
- Editing `src/topics/cluster.ts` k-selection or TF-IDF labeling algorithms themselves.

---

## 2. Architecture

### Data flow

```
afterCompact rebuild (every Nth compaction)          autogen model
        │ buildTopicModel(context_chunks)            topics / memory_topics (+ session_id)
        ▼                                            │
   replaceTopicModel(model) ── preserves topic_overrides ─┐
        │ (writes topics, memory_topics, topic_evolution) │
        ▼                                                ▼
   src/wiki.ts (generateWikiPage / buildWikiIndex)   topic_overrides (user edits)
        │ reads topics + provenance + evolution             │
        ▼                                                  ▼
   routes-wiki.ts (new handlers) ── label display = override ?? autogen
        │
        ▼
   api-contracts/wiki.ts (+ registry)  ── SSE: wiki_rebuilt / wiki_topic_renamed / wiki_topics_merged / wiki_topic_split
        │
        ▼
   api/client.ts (fetchWikiIndex, fetchWikiTopic, renameTopic, mergeTopics, splitTopic, fetchTopicTimeline)
        │
        ▼
   WikiTab.tsx (list + page)   TopicEvolutionView.tsx (D3, extends Memory Map)
```

### Join chain for provenance

`memory_topics.memory_id` (+ new `session_id`) → `context_chunks.session_id` +
`timestamp` + `normalized_text` → `turns.session_id` (+ `conversation_id`,
`turn_index`, `epoch_id`, `model`) for the conversation turns that produced each
memory checkpoint. Because `context_chunks.id` is per-session, the `session_id`
column on `memory_topics` is **required** to disambiguate, not merely convenient
(see §3).

### New tables + override persistence model

Two new tables live in the isolated **turns.db** (same file as `topics` /
`memory_topics`), created idempotently in `initTurnSchema` (§3):

- `topic_overrides` — append-only provenance of user curation (custom label,
  split-from, merged-into). **Immune to `replaceTopicModel`** because that function
  deletes only `topics` + `memory_topics`.
- `topic_evolution` — a per-assignment log of when each memory joined each topic
  (session_id + assigned_at + topic_id). Drives the per-topic timeline and the
  global growth scrubber. Also survives rebuilds.

### SQLite constraint

`node:sqlite` `DatabaseSync` is the single synchronous source of truth. All wiki
writes run inside the existing `withTx(db, ...)` helper from
`src/store/turns/connection.ts` and are parameterized (PREVENT-002). No network
(PREVENT-PI-004).

### Feature flag

All new endpoints + curation behavior gate on `MEGACOMPACT_WIKI_ENHANCED` (default
ON). Flag-OFF keeps the existing read-only `/api/topics` behavior byte-identical —
the new endpoints 404 and no curation runs.

---

## 3. Database Changes

All DDL added to `src/store/turns/schema.ts` inside `initTurnSchema` as
`CREATE TABLE IF NOT EXISTS` + index statements (idempotent, single statement per
`exec` — matching the existing pattern). `SCHEMA_VERSION` bumps `2 → 3`. **Coordination with Spec 2:** Spec 2 also adds columns to the `turns` table but does not stamp a separate SCHEMA_VERSION — both specs' migrations land in the same `initTurnSchema` call and share the `2 → 3` bump. If Spec 2 lands first, its columns are already covered by the v3 stamp; if Spec 3 lands first, Spec 2's columns are added by its own `ensureColumn` calls under the same v3 umbrella.

### 3.1 `topic_overrides`

Append-only provenance of user curation. A row records *one* user intent. Label
updates use `INSERT OR REPLACE` on the composite PK (same topic) so provenance is
kept by replacing, never mutating history in place; split/merge rows are plain
`INSERT` (unique per `topic_id` + `kind`).

```sql
CREATE TABLE IF NOT EXISTS topic_overrides (
  topic_id      TEXT NOT NULL,                -- topics.id (topic_0, ...)
  kind          TEXT NOT NULL CHECK(kind IN ('label','merge','split')),
  custom_label  TEXT,                          -- kind='label'
  merged_into   TEXT,                          -- kind='merge'  (targetTopicId)
  split_from    TEXT,                          -- kind='split'  (parent topic id)
  split_memory_ids TEXT,                       -- kind='split' (JSON array — the memories moved out)
  overridden_at INTEGER NOT NULL,
  PRIMARY KEY (topic_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_topic_overrides_topic ON topic_overrides(topic_id);
```

Semantics:
- **label**: `custom_label` set → display override; `custom_label` cleared ('' or
  NULL) → falls back to auto TF-IDF label (a user "un-rename").
- **merge**: `merged_into` = the surviving target topic id. The source topic is
  dissolved; its memories reassigned to the target (§7).
- **split**: `split_from` = the parent this topic was carved from; `split_memory_ids`
  records exactly which memories moved. On a subsequent auto-rebuild, split-created
  topics that were fully absorbed back into another cluster keep their row as
  historical provenance (harmless orphan).

### 3.2 `memory_topics` — add `session_id`

Today `memory_topics` has **no `session_id` column** (`storage/store.ts` fills
`TopicAssignment.sessionId` as empty for exactly this reason; `cluster.ts`
*does* capture `sessionId` into the in-memory assignment but `replaceTopicModel`
drops it — see `src/topics/store.ts` lines ~121-127). Since `context_chunks.id` is
`UNIQUE` only within a session (PK `(session_id, id)`), provenance resolution
requires the session. Decision: **add the column** (not query-time-only resolution),
because:

1. `replaceTopicModel` rebuilds from fresh embeddings and does not retain old chunks
   after compaction — query-time join cannot recover sessions already compacted away.
2. Storing it at build time is free (it's already on the in-memory assignment).

```sql
-- Additive column, idempotent (ensureColumn pattern used for existing ALTERs):
ALTER TABLE memory_topics ADD COLUMN session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_memory_topics_session ON memory_topics(session_id);
```

Because the existing table may already contain rows, the migration adds the column
with NULL backfill and only new `replaceTopicModel` writes populate it; historical
assignments show "unknown session" in provenance until the next rebuild (best-effort,
non-fatal). `memory_topics` PK stays `(memory_id, topic_id)` — do **not** add
`session_id` to the PK (a memory belongs to at most one session, so `(memory_id,
topic_id)` remains unique).

`src/topics/types.ts` `TopicAssignment.sessionId` stays optional for backward
compat, but `src/topics/store.ts` `replaceTopicModel` now writes it.

### 3.3 `topic_evolution`

Per-topic memory-addition log for the timeline + global growth scrubber. Written
every rebuild alongside `memory_topics` and appended on merge/split curation.

```sql
CREATE TABLE IF NOT EXISTS topic_evolution (
  topic_id     TEXT NOT NULL REFERENCES topics(id),
  memory_id    TEXT NOT NULL,
  session_id   TEXT,
  assigned_at  INTEGER NOT NULL,     -- epoch ms (cluster build OR curation event)
  method       TEXT NOT NULL CHECK(method IN ('kmeans+tfidf','merge','split','manual')),
  PRIMARY KEY (topic_id, memory_id)
);
CREATE INDEX IF NOT EXISTS idx_topic_evolution_topic ON topic_evolution(topic_id, assigned_at);
CREATE INDEX IF NOT EXISTS idx_topic_evolution_ts   ON topic_evolution(assigned_at);
```

The PK `(topic_id, memory_id)` prevents duplicate timeline points and lets
`INSERT OR REPLACE` idempotently refresh a memory's slot across rebuilds (keeps the
last assigned_at — "when did it most recently land here").

### 3.4 Provenance resolution at query time

Even with `session_id` stored, the wiki needs *text* and *turn* provenance. That
join stays query-time because `context_chunks`/`turns` live in the main DB vs
turns.db respectively:

- `memory_topics.session_id + memory_id` → `context_chunks.(normalized_text,
  summary, topic_summary, timestamp)` (main sqlite.db).
- `memory_topics.session_id` → `turns.(conversation_id, turn_index, model,
  epoch_id)` (turns.db, same file as the wiki tables — single connection).

The wiki handler bridges the two DB handles using the already-open store helpers
(`openStore(ctx.stateDir)` in `src/store/sqlite.ts`, `openTurnStore` in
`src/store/turns/connection.ts`).

### 3.5 Migration plan

Follow the existing pattern — DDL is **idempotent** in `src/store/turns/schema.ts` `initTurnSchema` (safe on every open, no gate needed):
- The `memory_topics.session_id` column uses the **`ensureColumn`** idiom from
  `src/store/sqlite/schema.ts` (lines 43-48) — `PRAGMA table_info` guard then
  `ALTER TABLE ADD COLUMN`, wrapped so a failure logs and is non-fatal.
- `SCHEMA_VERSION` bump to 3 is stamped in `turns_meta`; `migrations.test.ts`
  gains assertions that the new columns/tables exist after init.

---

## 4. API Endpoints

### 4.1 Contract types — `extensions/dashboard-server/api-contracts/wiki.ts` (new)

```ts
/** GET /api/wiki/index */
export interface WikiIndexEntry {
  readonly id: string;
  /** User override ?? auto label. */
  readonly label: string;
  /** True when label came from topic_overrides (shown as "edited"). */
  readonly edited: boolean;
  readonly memoryCount: number;
  readonly lastUpdated: number;
  /** First ~140 chars of the extractive summary (client list snippet). */
  readonly summarySnippet: string;
  /** Detection: split/merged provenance flags for UI badges. */
  readonly overrideKinds: ReadonlyArray<'label' | 'merge' | 'split'>;
}
export interface WikiIndexResponse {
  readonly updatedAt: string;
  readonly totalTopics: number;
  readonly totalMemories: number;
  readonly lastRebuildAt: number | null;
  readonly featureEnabled: boolean;
  readonly topics: WikiIndexEntry[];
}

/** Provenance for one topic memory. */
export interface MemoryProvenance {
  readonly memoryId: string;
  readonly sessionId: string | null;
  readonly content: string;                 // COALESCE(normalized_text, summary, topic_summary)
  readonly timestamp: number | null;
  readonly importance: number;              // memory_topics.confidence (no S40 importance column exists on context_chunks)
  readonly turns: ReadonlyArray<{
    readonly conversationId: string;
    readonly turnIndex: number;
    readonly role: string;
    readonly model: string | null;
    readonly epochId: string | null;
  }>;
}

/** GET /api/wiki/topic/:topicId */
export interface WikiPageResponse {
  readonly topicId: string;
  readonly label: string;
  readonly edited: boolean;
  readonly summary: string;
  readonly keyMemories: ReadonlyArray<Omit<MemoryProvenance, 'turns'>>;
  readonly recentMemories: ReadonlyArray<Omit<MemoryProvenance, 'turns'>>;
  readonly memberMemories: ReadonlyArray<MemoryProvenance>;
  readonly relatedTopics: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly edited: boolean;
    readonly memoryCount: number;
  }>;
  readonly timeline: ReadonlyArray<{ readonly ts: number; readonly count: number }>;
  readonly generatedAt: number;
}

/** PUT /api/wiki/topic/:topicId/label — body */
export interface RenameTopicRequest { readonly label: string; }
/** Response (mirror of the page's label fields). */
export interface CurationResult {
  readonly ok: boolean;
  readonly topicId: string;
  readonly label: string;
  readonly edited: boolean;
  readonly merged: boolean;
  readonly split: boolean;
}

/** POST /api/wiki/merge — body */
export interface MergeTopicsRequest {
  readonly sourceTopicId: string;
  readonly targetTopicId: string;
}

/** POST /api/wiki/topic/:topicId/split — body */
export interface SplitTopicRequest { readonly memoryIds: string[]; }

/** GET /api/wiki/topic/:topicId/timeline */
export interface TopicTimelineResponse {
  readonly topicId: string;
  readonly label: string;
  /** Bucketed [ts, count] for the horizontal timeline — all sessions. */
  readonly buckets: ReadonlyArray<{ readonly ts: number; readonly count: number; readonly sessionId: string | null }>;
}

/** GET /api/wiki/evolution — feeds the global D3 graph. */
export interface TopicEvolutionResponse {
  readonly updatedAt: string;
  readonly nodes: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly edited: boolean;
    readonly memoryCount: number;
    readonly firstSeen: number;
    readonly lastSeen: number;
  }>;
  /** Co-occurrence edges (topics sharing member memories), with weight. */
  readonly edges: ReadonlyArray<{ readonly source: string; readonly target: string; readonly weight: number }>;
  /** Bucket boundaries (epoch ms) for the scrubber. */
  readonly timeBuckets: number[];
}
```

### 4.2 Endpoints registry — `extensions/dashboard-server/api-contracts/endpoints/registry.ts`

Append 7 entries (6 read/write + 1 graph feed) in the existing object, each typed
with `EndpointDef`. `SseEndpointDef` is untouched here (SSE events are emitted, not
fetched). Paths (register in `ENDPOINTS`):

| key | method | path | request | response |
| --- | --- | --- | --- | --- |
| `wikiIndex` | GET | `/api/wiki/index` | – | `WikiIndexResponse` |
| `wikiTopic` | GET | `/api/wiki/topic/:topicId` | – | `WikiPageResponse` |
| `renameTopic` | PUT | `/api/wiki/topic/:topicId/label` | `RenameTopicRequest` | `CurationResult` |
| `mergeTopics` | POST | `/api/wiki/merge` | `MergeTopicsRequest` | `CurationResult` |
| `splitTopic` | POST | `/api/wiki/topic/:topicId/split` | `SplitTopicRequest` | `CurationResult` |
| `topicTimeline` | GET | `/api/wiki/topic/:topicId/timeline` | – | `TopicTimelineResponse` |
| `topicEvolution` | GET | `/api/wiki/evolution` | – | `TopicEvolutionResponse` |

All new types re-exported from `api-contracts/index.ts`.

### 4.3 Route handler — `extensions/dashboard-server/routes-wiki.ts` (new)

A single `handleWiki(req, res, ctx)` dispatch file mirroring
`routes-turns.ts`/`routes-topics.ts`: match method + `url.match` per path, use
`readJsonBody` for the three mutation bodies, wrap everything in try/catch returning
`500 {error}` and non-fatal — **a wiki failure never breaks the server or agent
loop**. Dispatch order in `server.ts` inserts `if (handleWiki(req, res, ctx)) return;`
before the SPA fallback (near the existing `handleTopics` / `handleTurns` calls at
~lines 238-247).

`handleWiki` composes:
- `createTopicStore(ctx.stateDir)` — getTopics / getMemoriesForTopic.
- `generateWikiPage` / `buildWikiIndex` from `src/wiki.ts` (the revived engine),
  passing real getters wired to provenance (§8).
- `openStore(ctx.stateDir)` for `context_chunks` text joins.
- New `src/wiki/` curation helpers (§7) — renamed/deleted label resolution and
  override writes.

Routing summary per endpoint:

- **GET /api/wiki/index** — build `WikiIndexResponse` from `buildWikiIndex` +
  per-topic override label/snippet. Lazy topic build on first access (reuse the
  `routes-topics.ts` pattern).
- **GET /api/wiki/topic/:topicId** — `generateWikiPage` + member provenance (§8) +
  timeline buckets.
- **PUT /api/wiki/topic/:topicId/label** — write `topic_overrides(kind='label')`,
  `INSERT OR REPLACE`, then return `CurationResult` with resolved label.
- **POST /api/wiki/merge** — §7 merge transaction.
- **POST /api/wiki/topic/:topicId/split** — §7 split transaction.
- **GET /api/wiki/topic/:topicId/timeline** — read `topic_evolution` grouped into
  buckets.
- **GET /api/wiki/evolution** — assemble D3 node/edge payload from
  `topic_evolution` + co-occurrence over `memory_topics`.

### 4.4 Client wrapper — `extensions/dashboard-client/src/api/client.ts`

Add `fetchWikiIndex()`, `fetchWikiTopic(topicId)`, `renameTopic(topicId, label)`
(`putJson`), `mergeTopics(source, target)` / `splitTopic(topicId, memoryIds)`
(`postJson`), `fetchTopicTimeline(topicId)`, `fetchTopicEvolution()`. Use
`ENDPOINTS.*.path.replace(':topicId', encodeURIComponent(...))` exactly as
`fetchTopicMemories` / `fetchConversationTurns` do.

---

## 5. Wiki Tab Design

**Replace** the current `TopicsTab.tsx` with a new **Wiki** tab (keep the filename
convention; a new `WikiTab.tsx` added to the tab registry in `App.tsx`). Two
screens, both Tailwind + shadcn/ui per Spec 1.

**Legacy compatibility:** The existing `GET /api/topics` and `GET /api/topics/:topicId/memories`
endpoints remain untouched — they serve as the flag-off path when `MEGACOMPACT_WIKI_ENHANCED`
is disabled. The `TopicsTab` component is removed from the tab registry only; its
render logic is not deleted (available for reference). The `/mega-topics` slash
command (which calls `replaceTopicModel` in `mega-topics-cmds.ts:140`) must not
regress — `applyOverridesAfterRebuild` runs as a post-step, not a replacement.

### 5.1 List view (`WikiTab.tsx` — landing)

- Header: total topics, total assigned memories, last rebuild time.
- Search box (filters by label / term — reuse the client-side filter from
  `TopicsTab.tsx`).
- Card/table of `WikiIndexEntry`: **label** (with a small `edited` badge when
  `edited`), **memory count**, **summary snippet**, **provenance badges** for
  `split`/`merged`. Click → navigate to the page view (client-side route state).
- Empty state: keep the existing "Topics are auto-generated after every 3rd
  compaction" message.

### 5.2 Page view (`WikiPage.tsx`, new component; `WikiThreadProvider` state)

Arranged top-to-bottom as a shadcn `Card` stack:

1. **Header** — label (+ `edited` badge), memory count, generated time, and an
   overflow `DropdownMenu` with actions: **Rename**, **Merge into…**, **Split**.
2. **Extractive summary** — `summary` paragraph (from `generateWikiPage`).
3. **Key memories** — ranked by importance, each row shows content snippet +
   session provenance chip.
4. **Recent memories** — ordered by timestamp DESC.
5. **Related topics** — clickable `Link`-style chips (co-occurrence-top 3) that
   navigates to that topic's page.
6. **Per-topic timeline** — a horizontal bar/canvas (`recharts` `BarChart` or a
   lightweight SVG strip; `topic_evolution` buckets). X = time, Y = memories added.
   Buckets annotated by session where available.
7. **Member memories table** — full `memberMemories` with confidence, assigned ts,
   and a provenance toggle expanding to the contributing **turns** (§8).

### 5.3 Edit controls (dialog components)

- **Rename** — shadcn `Dialog` + `Input`; PUT; on success update label + `edited`.
  Empty → clears override (back to auto).
- **Merge** — `Dialog` with a topic `Select` (all other topics); confirm target;
  POST merge.
- **Split** — `Dialog` with checkbox-list of member memories; POST with the chosen
  `memoryIds`.

Each mutation is **optimistic-non-destructive**: the client refetches the topic
after a 2xx and paints the returned `CurationResult`; a failure shows a toast and
keeps the pre-mutation snapshot (no local partial apply).

---

## 6. Topic Evolution Graph

### 6.1 Global view (`TopicEvolutionView.tsx`, new)

A D3 force-directed graph, **extending the Memory Map infrastructure**
(`MemoryMapView.tsx` — the `d3-force` simulation + SVG rendering pattern already in
`extensions/dashboard-client/src/tabs/MemoryMapTab/MemoryMapView.tsx`, 476 lines of
D3). It is a sibling sub-tab under the Wiki tab (mirroring how `MemoryMapTab` hosts
`MemoryMap` / `RaptorTree` sub-tabs).

- **Nodes** = topics, radius ∝ `memoryCount`, label via `edited`-aware display, color
  per cluster model build (or per split-parent for forks).
- **Edges** = co-occurrence (weight from `TopicEvolutionResponse.edges`), drawn as
  force links — reuses the `type: "semantic"` edge-styling path from the memory map.
- **Data source**: `GET /api/wiki/evolution` (assembled from `topic_evolution` +
  `memory_topics` co-occurrence on the server; no client-side re-derivation).

### 6.2 Timeline scrubber

A horizontal slider over `timeBuckets` (epoch-ms boundaries derived from
`topic_evolution.assigned_at`). Dragging filters which nodes/edges are shown to
"topics with ≥1 memory added at or before scrubber time" and sizes nodes by the
cumulative count **up to** that time — producing a "grow over time" animation.
Implementation: a `useState<number>` scrubber index + `useMemo` on node radius/edge
weight; reuse the `useSSE` hook to live-refresh on `wiki_rebuilt`.

### 6.3 Integration

- Adds `topicEvolution` to `api/client.ts` and the D3 sub-tab to the Wiki tab.
- The Memory Map itself is **untouched** — the new graph is additive, sharing only
  the `d3-force` idioms, not the Memory Map's `/api/memory-map` data or its
  validation pipeline.

---

## 7. Curation System

### 7.1 New curation module — `src/wiki/curation.ts` (host-agnostic)

A small, focused module (kept under the 300-line soft limit) exposing three pure
transactions over an open turns.db handle + the topic store:

```ts
export interface WikiCurationStore {
  renameTopic(topicId: string, label: string): CurationResult;
  mergeTopics(sourceTopicId: string, targetTopicId: string): CurationResult;
  splitTopic(topicId: string, memoryIds: string[]): CurationResult;
  resolveLabel(topicId: string, autoLabel: string): { label: string; edited: boolean };
  overrideKinds(topicId: string): Array<"label" | "merge" | "split">;
}
```

- **renameTopic** — `INSERT OR REPLACE INTO topic_overrides (topic_id,'label',
  custom_label, overridden_at)`. `custom_label` '' clears to auto. Emits
  `wiki_topic_renamed`.
- **mergeTopics** — one transaction: validate both exist; do *not* delete the source
  row's `topics` row immediately if it has an override (keep history), but
  reassign all `memory_topics.*` where `topic_id = source` → `target`, upsert
  `topic_evolution` rows for those memories as `method='merge'`, write a
  `topic_overrides(kind='merge', merged_into=target)` row for the source, and
  decrement source `memory_count` to 0 / increment target. Target label refresh via
  `resolveLabel`. Emits `wiki_topics_merged`.
- **splitTopic** — one transaction: create a new topic row (`topic_N` next id,
  label = auto from the moved memories' top terms — reuse `labelFromScores`),
  move the listed `memory_topics` rows to the new topic, write
  `topic_overrides(kind='split', split_from=topicId, split_memory_ids=JSON)`, add
  `topic_evolution(method='split')` rows. Original topic's `memory_count` decreases
  by the moved count. Emits `wiki_topic_split`.

All three are `withTx`-wrapped and fully **non-fatal**: any DB error rolls back, is
logged, and returns a 500 — the agent loop is never affected (PREVENT-PI-001).

### 7.2 Override persistence across auto-rebuilds

`replaceTopicModel` (`src/topics/store.ts`) currently does:

```ts
DELETE FROM memory_topics;
DELETE FROM topics;
// reinsert model.topics + model.assignments
```

Because it touches **only** `topics` + `memory_topics`, the new `topic_overrides` and
`topic_evolution` tables are naturally preserved. The one required behavior change:
after the DELETE+reinsert, re-apply overrides so the UI keeps showing user labels.
`afterCompact.ts`'s rebuild call site gains a single post-step:

```ts
createTopicStore(stateDir).replaceTopicModel(model);
applyOverridesAfterRebuild(tdb);   // new: re-resolve labels; re-apply split/merge reassignment if the topics survived
```

`applyOverridesAfterRebuild` re-reads `topic_overrides` and:
- re-stamps `topics.label` = `custom_label` when present (else auto TF-IDF);
- if a previously merged/split topic id **still exists**, keeps its override kind
  badges; if it no longer exists (system re-clustered it away), the override row is
  left as historical provenance (harmless orphan) and the new auto topic shows clean.

### 7.3 Display

- `edited = true` → label renders with a small shadcn `Badge` (e.g. "edited").
- Auto labels render as-is.
- `split`/`merge` badges (from `overrideKinds`) shown in list + page header.

---

## 8. Provenance System

### 8.1 Memory → session → turn join chain

For each `memory_topics` row the wiki page shows `MemoryProvenance`:

1. `memory_topics.session_id` (new column, backfilled NULL for pre-migration rows).
2. **Text + timestamp**: `context_chunks` on `(session_id, id)` →
   `COALESCE(normalized_text, summary, topic_summary)` + `timestamp` (main
   sqlite.db, parameterized `WHERE session_id = ? AND id = ?`).
3. **Turns**: `turns` on `session_id` →
   `conversation_id`, `turn_index`, `role`, `model`, `epoch_id` (turns.db; same
   file — one connection via `openTurnStore`). Ordered by `turned_at`; cap to the
   most recent N (default 8) per memory so the response stays small.
4. **importance**: uses `memory_topics.confidence` directly (no separate importance
   column exists on `context_chunks`). Key-vs-recent ranking uses confidence DESC
   for "key" and timestamp DESC for "recent" — no new calibration needed.

### 8.2 Wiki page rendering

- **Key memories** show a session chip (`session_id` truncated) + turn hover tooltip
  listing the contributing conversation turns.
- **Member memories table** has a "provenance" expandable row listing each turn
  (conversation, turn_index, model, role).
- When `session_id` is NULL (pre-migration rows), render "unknown session" explicitly —
  no fabricated provenance.

### 8.3 Accuracy

Provenance is **always derived from stored rows** — never guessed. The join uses
bound parameters (PREVENT-002). Tests assert the correct turn/session is attached
for crafted `memory_topics` + `turns` + `context_chunks` fixtures (§11).

---

## 9. SSE Events

Four new typed events, appended to the `SseEvent` union in
`api-contracts/index.ts` and defined in `api-contracts/core.ts` following the
existing discriminated-union shape (`type` + `ts` + payload). Emitted via the
existing JSONL tail mechanism — `runtime.dashboard.event(type, data)` for the
server-side rebuild (see `extensions/mega-dashboard.ts:193`), and from the wiki
route handlers for the three curation actions. The client `useSSE` hook already
dispatches on `type`, so the Wiki tab listens for these to invalidate cache.

```ts
/** wiki_rebuilt — auto-rebuild completed (from afterCompact). */
export interface SseWikiRebuilt {
  type: 'wiki_rebuilt';
  ts: string;
  clusterCount: number;
  totalChunks: number;
  criterion: string;
}

/** wiki_topic_renamed — user renamed a topic. */
export interface SseWikiTopicRenamed {
  type: 'wiki_topic_renamed';
  ts: string;
  topicId: string;
  label: string;
}

/** wiki_topics_merged — user merged source into target. */
export interface SseWikiTopicsMerged {
  type: 'wiki_topics_merged';
  ts: string;
  sourceTopicId: string;
  targetTopicId: string;
}

/** wiki_topic_split — user split a topic into a new one. */
export interface SseWikiTopicSplit {
  type: 'wiki_topic_split';
  ts: string;
  topicId: string;        // source
  splitTopicId: string;   // new topic
  movedCount: number;
}
```

The `wiki_rebuilt` event is wired into the existing `afterCompact.ts` rebuild block
(currently only `runtime.logger.info("wiki_rebuild", {...})` — add the
`runtime.dashboard.event` emit alongside it).

---

## 10. Sprint Breakdown

Gate at every sprint boundary: `npm run build` + `npm test` + `npm run lint` +
`python3 scripts/regression_check.py --all` + `scripts/guardrails-scan.mjs`. Deploy
checkpoint per sprint via `./scripts/deploy.sh <patch-version>` (clean tree
required; per the per-sprint publish cadence memory).

### Sprint W1 — Schema + store + flag groundwork

**Files:**
- `src/store/turns/schema.ts` — add `topic_overrides`, `topic_evolution`,
  `memory_topics.session_id` (ensureColumn), bump `SCHEMA_VERSION` 2→3.
- `src/topics/store.ts` — write `session_id` in `replaceTopicModel`; add
  `applyOverridesAfterRebuild`.
- `src/config/turns.ts` — add `WIKI_ENHANCED_ENABLED` (`MEGACOMPACT_WIKI_ENHANCED`,
  default true).
- `src/store/turns/migrations.test.ts` — assert new tables/columns.
- `src/topics/store.test.ts` — session_id round-trip; override survival across
  `replaceTopicModel`.

**Acceptance:** migration idempotent; `replaceTopicModel` writes session_id; overrides
survive rebuild; `WIKI_ENHANCED_ENABLED` defaults ON; all existing tests green.
**Deploy checkpoint:** `./scripts/deploy.sh` patch bump.

### Sprint W2 — Curation module + endpoints

**Files:**
- `src/wiki/curation.ts` (new) — rename/merge/split/resolveLabel/overrideKinds.
- `src/wiki/curation.test.ts` (new).
- `extensions/dashboard-server/api-contracts/wiki.ts` (new) + registry entries.
- `extensions/dashboard-server/routes-wiki.ts` (new) + `routes.ts` barrel +
  `server.ts` dispatch.
- `extensions/dashboard-server/routes-wiki.test.ts` (new) — handler-level.

**Acceptance:** all 6 endpoints wired; mutations transactional + non-fatal; merge/split
reassign correctly; flag-OFF → endpoints 404; handler tests pass.
**Deploy checkpoint:** patch bump.

### Sprint W3 — Wiki tab (list + page + provenance + timeline)

**Files:**
- `extensions/dashboard-client/src/tabs/WikiTab.tsx` (list; replaces TopicsTab in
  `App.tsx` registry).
- `extensions/dashboard-client/src/tabs/WikiTab/WikiPage.tsx` (page view).
- `extensions/dashboard-client/src/tabs/WikiTab/WikiPageControls.tsx` (rename/merge/
  split dialogs).
- `extensions/dashboard-client/src/tabs/WikiTab/TopicTimeline.tsx` (per-topic
  timeline).
- `extensions/dashboard-client/src/api/client.ts` — wiki wrappers.
- `src/wiki.ts` — wire provenance getters into `generateWikiPage` (no signature
  break; add a provenance-aware call path).

**Acceptance:** list + page render from live `/api/wiki/*`; provenance rows show
turns; edit dialogs round-trip; timeline renders; empty states present.
**Deploy checkpoint:** patch bump.

### Sprint W4 — Topic evolution graph + SSE + polish

**Files:**
- `extensions/dashboard-client/src/tabs/WikiTab/TopicEvolutionView.tsx` (D3, extends
  Memory Map idioms).
- `extensions/dashboard-server/api-contracts/core.ts` + `index.ts` — 4 SSE types.
- `extensions/mega-events/context-handler/afterCompact.ts` — emit `wiki_rebuilt`.
- `extensions/dashboard-server/routes-wiki.ts` — add `wiki_topic_renamed/merged/
  split` emits; `/api/wiki/evolution` endpoint.
- `extensions/dashboard-client/src/tabs/WikiTab/TopicEvolutionView.tsx` + client
  wiring (`topicEvolution`, scrubber, `useSSE` refresh).

**Acceptance:** evolution graph renders with scrubber; SSE named events emitted and
consumed; no regression in Memory Map.
**Deploy checkpoint:** patch bump.

### Sprint W5 — QA, regression, docs, release

**Files:**
- Full `npm test` + regression_check + guardrails-scan + `npm run lint`.
- Per §11 checklist.
- `docs/INDEX_MAP.md` entry + `CHANGELOG.md` / `RELEASE_NOTES.md`.
- `./scripts/deploy.sh <final-version>` + GitHub release notes.

**Acceptance:** all §11 checks pass; curation persistence + provenance accuracy tests;
file-size check; final deploy with release notes.

---

## 11. QA Review Checklist

**Per-sprint:**
- `npm run build` + `npm test` + `npm run lint` clean.
- `python3 scripts/regression_check.py --all` — no regressions.
- `scripts/guardrails-scan.mjs` — no new PREVENT-* violations (prefer looping the
  scan after each sprint, not just once).

**File-size check (every sprint, per memory):**
- Read every new/edited file; `src/` < 500 (300 soft), `extensions/*.ts` < 500.
- `WikiPage.tsx`, `TopicEvolutionView.tsx` (D3) and `MemoryMapView.tsx`-size risk:
  keep the D3 surface as a thin shell + delegate (the file_size_POINTER_files rule).
  If `TopicEvolutionView.tsx` exceeds ~480 lines, split into `TopicEvolutionGraph.tsx`
  (simulation) + `TopicEvolutionScrubber.tsx` (input).

**Curation persistence tests:**
- `replaceTopicModel` twice with a rename in between → label persists as `edited`.
- Merge → rebuild → source not orphaned, target holds memories + counts consistent.
- Split → rebuild → split topic still listed (or clean auto label if re-absorbed);
  override row preserved as history.

**Provenance accuracy tests:**
- Crafted fixtures: `memory_topics(session_id)` → correct `context_chunks.text` +
  correct `turns` (conversation/turn_index/model). Assert no fabricated turns, and
  NULL-session rows render "unknown session".

**Mutation robustness:**
- Merge source==target and split with zero/unknown memory ids → 400, no partial write.
- Override label '' → falls back to auto; `edited` flips false.
- APIFlag OFF → all `/api/wiki/*` 404 and no curation executes.
- Dissolved-source topics (memory_count=0 after merge) filtered from list view but preserved in overrides.
- Mobile: D3 evolution graph scrubber works via touch drag; dialogs use full-screen sheet on <768px.

---

## 12. Risks + Mitigations

| Risk | Mitigation |
| --- | --- |
| **File-limit breach** in the wiki page / D3 evolution components | Pointer-file + delegate split at ~480 lines (§11); keep D3 in a dedicated impl file. |
| **Pre-migration `memory_topics` rows lack `session_id`** → provenance shows "unknown" | Additive column with NULL backfill; next rebuild repopulates; render unknown explicitly, never fabricate. |
| **Curation lost across auto-rebuild** (topics re-clustered away) | `topic_overrides` is separate from `topics`/`memory_topics`, so rows survive; `applyOverridesAfterRebuild` re-applies when the topic exists; orphans stay as provenance. |
| **Merge/split count drift** (memory_count desync) | All mutations inside one `withTx`; counts recomputed from `memory_topics` in the same transaction; test asserts consistency post-rebuild. |
| **SSE event volume from `wiki_rebuilt`** (every Nth compaction) | Rebuild cadence unchanged (default N=3); event is small; only emitted on actual rebuild, not polling. |
| **PREVENT-PI-004** (wiki/curation must stay local) | All logic pure local node:sqlite; no imports of pi runtime; handler `sendJson` annotations carry the `guardrails-allow` reason exactly as `routes-turns.ts`. |
| **PREVENT-002** (SQL injection) | Parameterized queries only; DDL identifiers are fixed literals (topic ids are data, bound via `?`). |
| **Flag-off parity** | `WIKI_ENHANCED_ENABLED` short-circuits all new endpoints/curation; existing `/api/topics` + TopicsTab behavior is byte-identical. |
| **Timeline query cost on large topics** | `topic_evolution` indexed on `(topic_id, assigned_at)`; buckets computed server-side with bounded rows (LIMIT + windowing). |

---

## 13. Out of Scope

- Altering the cluster algorithm (k-selection, TF-IDF, seeding) — out of scope.
- Real-time memory-to-topic streaming during a session; evolution reflects the Nth-
  compaction rebuild model only.
- Cross-repo topic merging in the graph (single-repo topics view; global index is a
  future workstream). Topics are per-repo (scoped to `stateDir` via `repoStateDir()`),
  matching the existing `TopicsTab` behavior. The evolution graph shows one repo at a
  time.
- Host-driven curation commands (this is dashboard-only; no new `/mega-*` slash
  commands).
- Rewriting the Memory Map tab itself.
- Any model/LLM-driven summary generation (remains extractive/local).
