# S51 — Auto-Categorizing Wiki (Contract-First, Re-targeted onto S49 Store)

**Date:** 2026-07-29
**Parent program:** `docs/specs/s49-program-per-turn-memory-platform.md`
**Original spec:** `docs/specs/s47-auto-categorizing-wiki.md` (re-planned, re-targeted)
**Depends on:** S49 (TurnStore reader interface for topic source data)
**Priority:** P2
**Status:** SPEC ONLY (implement after S49 lands)
**Reuse target:** `src/topics/` + `src/wiki.ts` are pure math + rendering, no store dependency

---

## GOAL

Build an auto-categorizing wiki over the turn store's recall data:

1. **Topic clustering** — k-means over real trigram embeddings (reusing `src/dedup/raptor/kmeans.ts`),
   producing topic centroids with TF-IDF labels. No LLM, no Ollama, no network (PREVENT-PI-004).
2. **Wiki page generation** — extractive summaries per topic (reusing
   `src/dedup/raptor/summarizer.ts`), formatted as wiki pages with member lists.
3. **Wiki tab** — dashboard tab showing topic tree, member lists, search.

---

## CONTRACT (what hosts get)

```ts
// src/topics/types.ts
interface Topic {
  id: string;
  label: string;           // TF-IDF top terms
  centroid: number[];      // embedding vector
  memberCount: number;
  confidence: number;      // 0–1, how tight the cluster is
}

interface TopicModel {
  topics: Topic[];
  build(options: TopicBuildOptions): TopicModel;
  assign(embedding: number[]): Topic;  // nearest centroid
}

interface TopicBuildOptions {
  k?: number;              // number of clusters (default: auto via elbow)
  minMembers?: number;     // minimum members per topic (default: 3)
  maxIterations?: number;  // k-means iterations (default: 50)
}

// src/wiki.ts
interface WikiPage {
  topic: Topic;
  summary: string;         // extractive summary of member content
  members: Array<{
    id: string;
    snippet: string;       // first 120 chars of the member's content
    score: number;          // similarity to centroid
  }>;
}

declare function buildWiki(model: TopicModel, contentSource: ContentReader): WikiPage[];
```

---

## SCOPE

### IN SCOPE — new files

| File | Responsibility | Est. lines |
| ---- | -------------- | ---------- |
| `src/topics/types.ts` | `Topic`, `TopicModel`, `TopicBuildOptions` interfaces | ~60 |
| `src/topics/cluster.ts` | k-means wrapper over existing `kmeanspp` | ~120 |
| `src/topics/label.ts` | TF-IDF label extraction | ~100 |
| `src/topics/build.ts` | `TopicModel.build()` — orchestrates cluster + label | ~80 |
| `src/wiki.ts` | `buildWiki` — extractive summaries per topic | ~120 |
| `src/topics/*.test.ts` | Clustering + labeling + wiki correctness | ~200 |
| `extensions/dashboard-server/routes-wiki.ts` | `/api/wiki` endpoints | ~100 |
| `extensions/dashboard-client/src/tabs/WikiTab.tsx` | React wiki tab | ~200 |

### IN SCOPE — modified files

- `src/store/turns/schema.ts` — pre-create `topics` / `memory_topics` tables (S49 already does this)
- `extensions/dashboard-client/src/App.tsx` — add Wiki tab
- `extensions/dashboard-server/routes.ts` — register wiki routes

### OUT OF SCOPE

- LLM-based classification (DELETED per S47 re-plan — PREVENT-PI-004)
- Fork / rewind (S50, S52)
- Per-turn metrics (S50)

---

## EXECUTION

### S51A: Topic Clustering + Labeling

- [ ] `src/topics/types.ts` — contract
- [ ] `src/topics/cluster.ts` — k-means over trigram embeddings
- [ ] `src/topics/label.ts` — TF-IDF labels
- [ ] `src/topics/build.ts` — orchestrator
- [ ] Tests
- [ ] GATE S51A

### S51B: Wiki Generation + Dashboard Tab

- [ ] `src/wiki.ts` — extractive wiki pages
- [ ] `extensions/dashboard-server/routes-wiki.ts`
- [ ] `extensions/dashboard-client/src/tabs/WikiTab.tsx`
- [ ] GATE S51B

---

## ACCEPTANCE

1. Topic clustering produces ≥2 topics for a seeded store with 20+ memories
2. TF-IDF labels are real terms from the content (not fabricated)
3. Wiki pages render in the dashboard without console errors
4. Zero network calls (PREVENT-PI-004 verified by guardrails-scan)
5. All `src/topics/` + `src/wiki.ts` files import nothing from `extensions/`
6. Full gate green

## ROLLBACK

Delete `src/topics/` + `src/wiki.ts` + wiki routes + wiki tab. S49 store is untouched.
