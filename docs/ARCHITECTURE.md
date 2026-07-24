# Architecture

## Overview

pi-mega-compact is a context compressor for the pi coding agent. It watches context pressure, compacts conversations in the background, and persists checkpoints to a local SQLite store with semantic dedup.

```
Layer 5  Recall          One local vector store → 3 entry points, 1 dedup engine
Layer 4  Persist         compactSession() → embed + store in SQLite
Layer 3  Cluster         Local vector index → semantic dedup + recall
Layer 2  Collapse        summarizeMessages() heuristic + agent summary
Layer 1  Supersede        Drop obsolete file-reads / superseded turns
─────────────────────────────────────────────────────────────────
Trigger   context → token fast-gate → autoCompactCheck → live trim (per call)
Durable   agent_end (idle + over threshold) → ctx.compact() → transcript truncated
Live      context handler returns { messages:[summary, …recent] } — compacted window per LLM call
Marker    insert compact-marker; dedupe so repeated triggers cost ~0 tokens
```

## Compaction Pipeline (Trident)

Three deterministic stages run over the conversation before anything is persisted:

1. **Supersede** — drops obsolete file reads and superseded turns. Zero cost, zero loss.
2. **Collapse** — summarizes messages using heuristics. On manual compact, uses an agent summary.
3. **Cluster** — vectorizes and deduplicates. Similar regions collapse to one row.

## Live vs. Durable Compaction

- **Live trim** — on every LLM call, returns a compacted view (summary + recent anchor). The model sees a smaller window. The on-disk transcript is untouched.
- **Durable checkpoint** — at agent settle during team runs, fires pi's native durable trim so the transcript is actually truncated. Context relieves mid-run, not just at the end.

A single **pressure signal** (`currentTokens / effectiveThreshold`) drives both. As context fills, the system reacts. As it's relieved, it backs off.

## Storage

Dual local backend — zero network, no native build step:

- **`node:sqlite`** (`DatabaseSync`, Node ≥22.13) — synchronous source of truth for checkpoints, session state, and the dedup index. No dependency, no install script.
- **PGlite + `@electric-sql/pglite-pgvector`** (WASM Postgres + HNSW) — optional async vector index for cross-repo recall at `~/.pi/mega-compact-vector`. Sync store stays authoritative; index degrades to sync scan on any failure.

Legacy `.checkpoints.json.gz` snapshots are retained as disaster-recovery fallbacks and auto-imported on first run.

## Dedup Cascade

Shared across all entry points:

- **L0 — exact:** SHA-256 content hash catches identical regions.
- **L1 — near-dup:** MinHash + LSH + trigrams catch rewordings.
- **L2 — semantic:** Cosine similarity collapses paraphrases; MMR diversifies results.
- **RAPTOR** — hierarchical summary tree (shadow mode by default).

Each tier has a feature flag. Each can run in `MARK_ONLY` mode for safe rollout or auto-degrade.

## Embedding

Default: **TrigramEmbedder** — deterministic hashed trigram bag (512-dim, L2-normalized). Zero dependencies, instant, fully offline.

Optional: BYO localhost embedder via `MEGACOMPACT_EMBEDDING_URL`. Loopback only. No model ships with the extension.

## Cross-Repo Recall

On resume, recall augments from other repos via the HNSW index. Cross-repo hits use a stricter cosine floor (`MEGACOMPACT_CROSSREPO_COSINE`, default 0.90) and are labeled with their source repo.

## Durable Memory

Auto-reviews conversation every 10 turns (more often under pressure) and writes durable memories to SQLite. Relevant memories are injected as RAG context on recall.

## Module Map

```
extensions/mega-compact.ts       Pi extension entry
extensions/mega-trim.ts          Live context-event trim
extensions/mega-conflict-cmds.ts Extension-conflict detector
extensions/dashboard-server.ts   Localhost dashboard

src/engine.ts           Trident pipeline + recall
src/vectorStore.ts      Local vector DB (add/search/dedupe)
src/embedder.ts         Default trigram embedder
src/httpEmbedder.ts     BYO localhost embedder seam
src/compact.ts          Summarize / merge / auto-compact
src/supersede.ts        Obsolete file-read pruning
src/memory.ts           Durable memories + auto-review
src/memoryRecall.ts     Memory recall + auto-inline (RAG)
src/store/sqlite.ts     Sync node:sqlite store
src/store/vectorIndex.ts Async PGlite/HNSW cross-repo index
src/monitoring.ts       Metrics + false-positive alerts
src/canary.ts           Rollout safety + auto-disable
src/config/dedup.ts     All dedup + threshold flags (single source of truth)
```

The `src/` directory is pi-agnostic and fully unit-tested. The extension entry in `extensions/` adapts between the engine and pi's runtime.
