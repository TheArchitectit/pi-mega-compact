# Prompt Cache Optimization Plan v2

**Date**: 2026-07-29
**Branch**: `feature/promptcache-stats`
**Status**: Draft — needs team review

---

## Executive Summary

Provider prompt caching is **the single biggest cost/latency lever** for long-running coding agents. Anthropic's pricing: cache reads cost **10% of full input**, cache writes cost **125%**. For a typical session with 80% cache hit rate, that's **~72% input cost reduction**.

Our current hit rate: **55-60%**. Target: **88-92%**.

This plan proposes two architectural changes:

1. **Message separation** — split conversation thread from tool results
2. **Vector-aware cache striping** — use pgvector to organize content by cache stability

Combined, these changes restructure the prompt from a flat message array into a **cache-optimized layered layout** where stable content comes first and volatile content appends at the end.

---

## Current State

### What We Have (Data Capture)

```
43 samples in perf_samples table:
- Total cacheRead:  850,886 tokens
- Total cacheWrite: 0 tokens
- Total input:      559,217 tokens
- Avg hit rate:     56% (range: 0% – 99.96%)
```

### Why Hit Rate Is 55-60% Instead of 80-90%

**Data pattern** (from real session):

| Turn | Cache Read | New Input | Hit Rate | What Happened |
| ------ | ----------- | ----------- | ---------- | --------------- |
| 1 | 28,608 | 250 | **99.1%** | Stable prefix |
| 2 | 28,800 | 1,210 | **96.0%** | Small change |
| 3 | 20,480 | 20,031 | **50.6%** | Prefix broke |
| 4 | 24,576 | 16,456 | **59.9%** | Still broken |
| 5 | 28,608 | 250 | **99.1%** | Back to stable |

The 60% turns have a **fixed ~16K of "new" content** that isn't matching the cache.

### Root Causes

**1. Tool results shift the message array**
When the agent calls a tool (read file, bash), the tool result is inserted into the message array. If it's a large result (~16K tokens), it pushes the cached prefix forward, breaking the cache match. Anthropic caches from the START of the prompt — if the first ~28K tokens are identical but a 16K tool result was inserted before the summary, the prefix hash changes.

**2. Re-compaction frequency**
The context handler re-compacts when context grows by ≥10% of window OR ≥50% of threshold. Each re-compaction generates a NEW summary with a different sentinel value, breaking the cache prefix. The v0.8.6 `trimCache` replay helps within an epoch, but when the epoch changes, the cache breaks.

**3. Summary message position**
The compact summary is prepended as `messages[0]`. If anything changes before it (system prompt prepend from `before_agent_start`, or tool results inserted at the start), the cache prefix shifts.

### What Competitors Show That We Don't

| Feature | Claude Code | VS Code Cache Explorer | Helicone/LangSmith | pi-megacompact |
| --------- | ------------ | ---------------------- | ------------------- | ---------------- |
| Cache read/write tokens | ✅ per-turn | ✅ per-turn | ✅ aggregate | ❌ captured, not shown |
| Cache hit rate % | ✅ | ✅ | ✅ | ❌ 0% displayed (wrong source) |
| $ Saved from caching | ✅ in `/usage` | ❌ | ✅ | ❌ shows "—" |
| Per-turn cache breakdown | ✅ | ✅ + diff view | ✅ traces | ❌ |
| Cache optimization guidance | ❌ | ✅ side-by-side diff | ❌ | ❌ |

Full competitive analysis: [docs/PROMPTCACHE_FULL_GAP_ANALYSIS.md](./PROMPTCACHE_FULL_GAP_ANALYSIS.md)

---

## Solution Architecture

### Overview: Vertical Cache Striping

Instead of one flat message array, we stripe the prompt into **cache stability layers**:

```
┌─────────────────────────────────────────────────────────┐
│ Layer 0: System prompt (PERMANENT)                       │ ← always cached
│ Layer 1: Compact summary (PER-EPOCH)                     │ ← stable within epoch
│ Layer 2: Core context (TOPIC-STABLE)                     │ ← vector-optimized
│ Layer 3: Conversation thread (THREAD-STABLE)             │ ← user/assistant turns only
│ ── cache boundary ──                                     │
│ Layer 4: Tool results (VOLATILE)                         │ ← appended at END
│ Layer 5: New/recalled context (VOLATILE)                 │ ← vector-fetched
└─────────────────────────────────────────────────────────┘
```

**Key insight**: Tool results growing at the END don't break the cache prefix. Only re-compaction (once per epoch) breaks it, and that happens much less frequently.

### Layer Definitions

| Layer | Name | Content | Cache Lifetime | Update Frequency |
| ------- | ------ | --------- | ---------------- | ------------------ |
| 0 | PERMANENT | System prompt | Session | Never |
| 1 | PER-EPOCH | Compact summary | Compaction epoch | On re-compact (~every 10-20 turns) |
| 2 | TOPIC-STABLE | Vector-nearest context chunks | While topic is stable | On topic shift |
| 3 | THREAD-STABLE | User/assistant conversation turns | Per conversation | On new turn |
| 4 | VOLATILE | Tool results | Per tool call | Every tool call |
| 5 | VOLATILE | New/recalled context | Per recall | On recall/ingest |

### Part 1: Message Separation

#### Problem

Currently, all messages are in one flat array:

```
[user1, assistant1, tool_result1, user2, assistant2, tool_result2, ...]
```

When `tool_result2` is large, it shifts everything after it, breaking the cache prefix.

#### Solution

Split into two tables: conversation thread (stable) and tool results (volatile).

#### Schema

```sql
-- Stable conversation thread (user + assistant messages only)
CREATE TABLE conversation_thread (
  turn_index    INTEGER PRIMARY KEY,
  role          TEXT NOT NULL,  -- 'user' | 'assistant'
  content       TEXT NOT NULL,
  timestamp     INTEGER,
  epoch_id      TEXT,           -- which compact epoch this belongs to
  is_summarized BOOLEAN DEFAULT FALSE  -- TRUE if this turn was compacted away
);

-- Volatile tool results (appended at end of prompt)
CREATE TABLE tool_results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_index    INTEGER NOT NULL,  -- which conversation turn this belongs to
  tool_name     TEXT,
  input         TEXT,
  output        TEXT,
  timestamp     INTEGER,
  FOREIGN KEY (turn_index) REFERENCES conversation_thread(turn_index)
);
```

#### Prompt Construction

```typescript
function buildSeparatedPrompt(db: Database): Message[] {
  const messages: Message[] = [];
  
  // Layer 0: System prompt (permanent)
  messages.push({ role: 'system', content: systemPrompt });
  
  // Layer 1: Compact summary (per-epoch)
  const epoch = db.prepare('SELECT * FROM checkpoint_epochs ORDER BY created_at DESC LIMIT 1').get();
  if (epoch) {
    messages.push({ role: 'user', content: epoch.summary });
  }
  
  // Layer 3: Conversation thread (stable — only user/assistant turns)
  const turns = db.prepare(`
    SELECT * FROM conversation_thread 
    WHERE NOT is_summarized 
    ORDER BY turn_index
  `).all();
  messages.push(...turns);
  
  // Layer 4: Tool results (volatile — appended at END)
  const recentTools = db.prepare(`
    SELECT * FROM tool_results 
    WHERE turn_index >= ?
    ORDER BY turn_index, id
  `).all(epoch.cut_index);
  
  for (const tool of recentTools) {
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: tool.id, name: tool.tool_name, input: JSON.parse(tool.input) }]
    });
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: tool.id, content: tool.output }]
    });
  }
  
  return messages;
}
```

#### Expected Impact

| Scenario | Before | After |
| ---------- | -------- | ------- |
| Same topic, same files | 60% | **85%** |
| Same topic, new tools | 55% | **82%** |
| After re-compact | 30% | **70%** |

---

### Part 2: Vector-Aware Cache Striping

#### Problem

Not all content has equal cache value. Some context chunks are frequently relevant (high stability), while others are one-off references (low stability). Currently, they're all mixed together.

#### Solution

Use the pgvector HNSW index to compute a **stability score** for each content chunk, then stripe them into the optimal cache position.

#### Stability Score

```typescript
interface StabilityScore {
  semantic: number;    // 0-1: cosine similarity to current topic embedding
  recency: number;     // 0-1: inverse of time since last reference
  frequency: number;   // 0-1: how often this chunk is referenced in recent turns
  combined: number;    // weighted average
}

function computeStabilityScore(
  chunk: ContextChunk,
  currentTopicEmbedding: Float32Array,
  recentTurns: Turn[]
): StabilityScore {
  // Semantic similarity to current topic
  const semantic = 1 - cosineSimilarity(chunk.embedding, currentTopicEmbedding);
  
  // Recency: how recently was this chunk referenced?
  const lastReferenced = findLastReference(chunk.id, recentTurns);
  const recency = lastReferenced ? 1 / (1 + daysSince(lastReferenced)) : 0;
  
  // Frequency: how often is this chunk relevant?
  const frequency = countReferences(chunk.id, recentTurns) / recentTurns.length;
  
  // Weighted combination
  const combined = (semantic * 0.5) + (recency * 0.3) + (frequency * 0.2);
  
  return { semantic, recency, frequency, combined };
}
```

#### Schema

```sql
-- Cache stripe assignments (persisted per session)
CREATE TABLE cache_stripes (
  chunk_id     TEXT PRIMARY KEY,  -- reference to context_chunks
  stripe       INTEGER NOT NULL,  -- 0=permanent, 1=epoch, 2=topic, 3=thread, 4=volatile
  stability    REAL NOT NULL,     -- 0.0-1.0, computed from vector similarity + recency
  assigned_at  INTEGER NOT NULL,
  epoch_id     TEXT
);

-- Vector stability cache (avoid recomputing embeddings)
CREATE TABLE embedding_cache (
  content_hash TEXT PRIMARY KEY,
  embedding    BLOB NOT NULL,  -- Float32Array
  computed_at  INTEGER NOT NULL
);
```

#### Cache-Optimized Prompt Builder

```typescript
async function buildCacheOptimizedPrompt(
  db: Store,
  pgvector: PGlite,
  currentTopicEmbedding: Float32Array
): Promise<Message[]> {
  const messages: Message[] = [];
  
  // Layer 0: System prompt (permanent)
  messages.push({ role: 'system', content: systemPrompt });
  
  // Layer 1: Compact summary (per-epoch)
  const epoch = db.getLatestEpoch();
  if (epoch) {
    messages.push({ role: 'user', content: epoch.summary });
  }
  
  // Layer 2: Vector-optimized stable context
  const stableChunks = await db.query(`
    SELECT c.chunk_text, cs.stability
    FROM cache_stripes cs
    JOIN context_chunks c ON cs.chunk_id = c.id
    WHERE cs.stripe = 2 AND cs.epoch_id = $1
    ORDER BY cs.stability DESC
    LIMIT 10
  `, [epoch?.epoch_id]);
  
  if (stableChunks.length > 0) {
    messages.push({
      role: 'user',
      content: stableChunks.map(c => c.chunk_text).join('\n\n---\n\n')
    });
  }
  
  // Layer 3: Conversation thread (user/assistant only)
  const turns = db.getConversationThread(epoch?.cut_index ?? 0);
  messages.push(...turns);
  
  // Layer 4: Volatile (tool results + new context)
  const volatile = db.getVolatileContent(epoch?.cut_index ?? 0);
  messages.push(...volatile);
  
  return messages;
}
```

#### Vector Stability Refresh

The stability scores are recomputed when:

1. **Topic shift detected** — cosine similarity between current and previous topic embedding drops below 0.7
2. **New context ingested** — chunks added to the store
3. **Epoch change** — re-compaction fires

```typescript
async function refreshStripeAssignments(
  db: Store,
  pgvector: PGlite,
  currentTopicEmbedding: Float32Array,
  epochId: string
): Promise<void> {
  // Get all chunks for this repo
  const chunks = await db.query(`
    SELECT id, chunk_text FROM context_chunks WHERE repo_id = $1
  `, [repoId]);
  
  // Compute stability scores
  const scored = chunks.map(chunk => ({
    chunkId: chunk.id,
    stability: computeStabilityScore(chunk, currentTopicEmbedding, recentTurns)
  }));
  
  // Assign stripes based on stability thresholds
  const assignments = scored.map(s => ({
    chunkId: s.chunkId,
    stripe: s.stability.combined >= 0.7 ? 2 :  // TOPIC-STABLE
            s.stability.combined >= 0.4 ? 3 :  // THREAD-STABLE
            4,                                   // VOLATILE
    stability: s.stability.combined,
    epochId
  }));
  
  // Batch upsert
  await db.batch(`
    INSERT INTO cache_stripes (chunk_id, stripe, stability, assigned_at, epoch_id)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (chunk_id) DO UPDATE SET
      stripe = $2, stability = $3, assigned_at = $4, epoch_id = $5
  `, assignments);
}
```

#### Expected Impact

| Scenario | Part 1 Only | Part 1 + Part 2 |
| ---------- | ------------- | ----------------- |
| Same topic, same files | 85% | **92%** |
| Same topic, new tools | 82% | **88%** |
| Topic shift | 60% | 65% (graceful degradation) |
| After re-compact | 70% | **80%** (vector-stable layer survives) |

---

## Implementation Plan

### Phase 1: Display What We Have (1-2 days)

Show the cache data we're already capturing.

| Step | What | File | Effort |
| ------ | ------ | ------ | -------- |
| 1.1 | Add `readProviderCacheStats()` aggregate query | `src/store/sqlite/perf-samples.ts` | 30 min |
| 1.2 | Add `/api/provider-cache` endpoint | `extensions/dashboard-server/routes-game.ts` | 30 min |
| 1.3 | Fetch + display in CacheTab | `extensions/dashboard-client/src/tabs/CacheTab.tsx` | 1 hour |
| 1.4 | Fix `cachePct` in TUI (swap from dedup to provider cache) | `extensions/mega-runtime/snapshot.ts` | 30 min |
| 1.5 | Add provider cache columns to Active Repos | `extensions/dashboard-client/` | 1 hour |
| 1.6 | Add cache columns to Savings by Model | `extensions/dashboard-client/` | 1 hour |
| 1.7 | Add pricing constants + $ saved calculation | `src/pricing.ts` (new) | 1 hour |

### Phase 2: Message Separation (2-3 days)

Split conversation thread from tool results.

| Step | What | File | Effort |
| ------ | ------ | ------ | -------- |
| 2.1 | Add `conversation_thread` + `tool_results` tables | `src/store/sqlite/` | 1 hour |
| 2.2 | Write split-insert logic (route user/assistant → thread, tool → results) | `extensions/mega-events/context-handler.ts` | 2 hours |
| 2.3 | Write `buildSeparatedPrompt()` | `extensions/prompt-builder.ts` (new) | 2 hours |
| 2.4 | Wire into context handler's `return { messages }` | `extensions/mega-events/context-handler.ts` | 1 hour |
| 2.5 | Add cache hit rate tracking to prompt builder | `extensions/mega-events/perf-handler.ts` | 30 min |
| 2.6 | Tests for separated prompt construction | `tests/prompt-builder.test.ts` | 2 hours |

### Phase 3: Vector-Aware Cache Striping (3-4 days)

Use pgvector to organize content by cache stability.

| Step | What | File | Effort |
| ------ | ------ | ------ | -------- |
| 3.1 | Add `cache_stripes` + `embedding_cache` tables | `src/store/sqlite/` | 30 min |
| 3.2 | Add `computeStabilityScore()` | `src/cache-stripe.ts` (new) | 1 hour |
| 3.3 | Add `buildCacheOptimizedPrompt()` | `extensions/prompt-builder.ts` | 2 hours |
| 3.4 | Wire stability computation into context handler | `extensions/mega-events/context-handler.ts` | 1 hour |
| 3.5 | Add vector stability refresh on topic change | `extensions/mega-events/agent-handlers.ts` | 1 hour |
| 3.6 | Tests for stability scoring + stripe assignment | `tests/cache-stripe.test.ts` | 2 hours |
| 3.7 | Integration tests for cache-optimized prompt | `tests/prompt-builder.test.ts` | 2 hours |

### Phase 4: Display + Optimization (2-3 days)

Dashboard visibility and cache-friendly guidance.

| Step | What | File | Effort |
| ------ | ------ | ------ | -------- |
| 4.1 | Show stripe distribution in dashboard | `extensions/dashboard-client/` | 1 hour |
| 4.2 | Add per-turn cache breakdown in TUI widget | `extensions/mega-runtime/widget.ts` | 1 hour |
| 4.3 | Add cache hit rate trend chart | `extensions/dashboard-client/` | 2 hours |
| 4.4 | Add cache health scoring | `extensions/dashboard-client/` | 1 hour |
| 4.5 | Add alerting on cache degradation | `extensions/mega-events/perf-handler.ts` | 1 hour |
| 4.6 | Add cache-friendly prompt ordering guidance | `extensions/dashboard-client/` | 2 hours |

---

## Cost Impact Estimate

Based on current data (43 samples, ~60% hit rate):

| Metric | Current | Target (Phase 2) | Target (Phase 3) |
| -------- | --------- | ------------------ | ------------------ |
| Cache hit rate | 56% | 82% | 90% |
| Cache read tokens/session | 850K | 1.2M | 1.4M |
| Cache write tokens/session | 0 | 0 | 0 |
| Input cost/session | $1.68 | $0.50 | $0.30 |
| **Savings/session** | — | **$1.18 (70%)** | **$1.38 (82%)** |
| **Savings/day (20 sessions)** | — | **$23.60** | **$27.60** |

---

## Success Criteria

| Metric | Current | Phase 1 Target | Phase 2 Target | Phase 3 Target |
| -------- | --------- | ---------------- | ---------------- | ---------------- |
| Cache hit rate | 56% | 56% (display only) | 82% | 90% |
| Cache data visible | ❌ | ✅ | ✅ | ✅ |
| $ saved visible | ❌ | ✅ | ✅ | ✅ |
| Per-turn breakdown | ❌ | ❌ | ✅ | ✅ |
| Stripe optimization | ❌ | ❌ | ❌ | ✅ |

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
| ------ | -------- | ------------ |
| Schema migration breaks existing data | High | Add migration script, test on copy first |
| Vector computation adds latency | Medium | Cache embeddings, compute async |
| Topic detection is inaccurate | Medium | Start with conservative thresholds, tune later |
| pgvector index grows too large | Low | Already bounded by repo, add TTL for old stripes |
| Cache striping adds complexity | Medium | Keep Phase 1 + 2 simple, Phase 3 is opt-in |

---

## Open Questions

1. **Should we keep the flat message array as fallback?** Yes — if stripe computation fails, fall back to current behavior.

2. **How do we detect topic shifts?** Cosine similarity between current and previous topic embedding. Threshold: 0.7 (configurable).

3. **Should stripes be per-session or per-repo?** Per-session — different conversations have different topics.

4. **How often do we recompute stability?** On topic shift, new context ingest, or epoch change. Not every turn.

5. **What about cross-repo context?** Phase 3 can use pgvector's global topology to fetch relevant chunks from other repos, but this adds latency. Defer to Phase 4+.

---

## References

- [Prompt Cache Full Gap Analysis](./PROMPTCACHE_FULL_GAP_ANALYSIS.md)
- [Prompt Cache Investigation](./PROMPTCACHE_INVESTIGATION.md)
- [Anthropic Prompt Caching Docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
- [Claude Code Prompt Caching Architecture](https://code.claude.com/docs/en/prompt-caching.md)
- [VS Code Cache Explorer](https://code.visualstudio.com/docs/agents/agent-troubleshooting/cache-explorer)
- [Aider Cache Prompts](https://aider.chat/docs/usage/caching.html)
