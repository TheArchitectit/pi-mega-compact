# PGlite Vector Index — Architecture & Self-Healing

The global HNSW vector index is an **optional, best-effort acceleration layer**
for nearest-neighbor recall across all repositories. It runs as a WASM Postgres
instance (PGlite + pgvector) — fully local, zero network, no native build
step. The authoritative dedup state always lives in `node:sqlite`; the index is
rebuildable from it at any time.

## How It Works

```
Compaction
  └─ runCompact()          # extensions/mega-pipeline.ts
       ├─ RAPTOR + compaction logic
       └─ indexUpsertEmbedding()   # once per compaction, fire-and-forget
            └─ PGlite (WASM)       # shared global dir (~/.mega-compact/vector-index/)
```

The index update fires **once per compaction** (not per checkpoint add). Only
the main runtime process touches the global directory — test workers never
concurrently initialize PGlite.

### Lifecycle

1. `initVectorIndex()` — called lazily on first search or upsert. Creates the
   data directory and boots PGlite.
2. `upsertEmbedding(repoId, sessionId, text, embedding)` — writes a vector row.
3. `searchAsync(queryEmbedding, opts)` — HNSW nearest-neighbor search.
4. `closeVectorIndex()` — tears down the instance and resets internal state.

## Self-Healing on Corruption

If the process is killed (SIGKILL, OOM) during a PGlite write, the `pg_control`
file can be left in an inconsistent state. On the next boot, `new PGlite({
dataDir })` throws a WASM `RuntimeError: terminated.aborted`.

`initVectorIndex()` handles this automatically:

```
Attempt 1: new PGlite({ dataDir })
  ↓ RuntimeError (corrupted pg_control)
  rmSync(dataDir, { recursive: true })
  mkdirSync(dataDir)
Attempt 2: new PGlite({ dataDir })   ← clean slate, succeeds
```

The retry runs in silence — no log spam, no user action needed. The index is
empty after a heal, but the next compaction repopulates it. Full rebuild from
the sqlite store is also possible via the reindex command.

## Kill-Switch

Disable the entire index with an environment variable:

```bash
MEGACOMPACT_PGLITE_DISABLED=1 pi mega ...
```

When disabled:
- `initVectorIndex()` returns `undefined` immediately.
- `searchAsync()` returns `[]` (caller falls back to the sync scan).
- `upsertEmbedding()` is a no-op.
- Zero PGlite imports, zero WASM overhead.

Check programmatically:

```typescript
import { isVectorIndexDisabled } from "./store/vectorIndex.js";
if (isVectorIndexDisabled()) { /* sync fallback only */ }
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `RuntimeError: terminated.aborted` on startup | Corrupted `pg_control` | Self-heals automatically. If persistent, `rm -rf ~/.mega-compact/vector-index/` |
| Index always empty | `MEGACOMPACT_PGLITE_DISABLED=1` set | Unset the env var |
| Tests fail with PGlite errors | Multiple workers hit global dir | Fixed in v0.4.26 — index now fires per-compaction, not per-add |
| `@electric-sql/pglite` not installed | Optional dep missing | `npm i @electric-sql/pglite @electric-sql/pglite/pgvector` — or set the kill-switch and ignore |

## Data Directory

Default: `~/.mega-compact/vector-index/`

Override:

```bash
MEGACOMPACT_VECTOR_INDEX_DIR=/tmp/test-index pi mega ...
```

Each test uses a fresh temp directory, so tests never collide with the real
index.
