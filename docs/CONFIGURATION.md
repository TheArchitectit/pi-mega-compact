# Configuration

All defaults are in `src/config/dedup.ts`. Set env vars before starting pi.

## Core

| Variable | Default | Description |
|---|---|---|
| `MEGACOMPACT_TIER` | `low` | Compaction threshold as % of context window. `low`=50%, `medium`=60%, `high`=70%, `ultra`=70%, `mega`=75%. Fire point = `tierPct × contextWindow`, always below pi's native ~80% auto-compaction. |
| `MEGACOMPACT_THRESHOLD_TOKENS` | _(tier default)_ | Set an absolute token budget instead of a percentage. Overrides `MEGACOMPACT_TIER`. Never percent-scaled. |
| `MEGACOMPACT_FAST_GATE_PCT` | `70` | Context-usage % that arms the auto-trigger. Defaults to the tier's %. Override raises the arming floor. |
| `MEGACOMPACT_AUTO` | `true` | Enable auto-compaction. |
| `MEGACOMPACT_ANCHOR_USER_MESSAGES` | `3` | Never drop the most recent N user messages. |
| `MEGACOMPACT_PRESERVE_RECENT` | `4` | Preserve the most recent N messages verbatim. |
| `MEGACOMPACT_STATE_DIR` | _(per-repo)_ | Override the store location. Default is `<repo>/.pi/mega-compact/`. |

## Recall and Memory

| Variable | Default | Description |
|---|---|---|
| `MEGACOMPACT_AUTO_INLINE` | `true` | Auto-inline checkpoints on resume/branch. |
| `MEGACOMPACT_AUTO_INLINE_K` | `3` | Top-K checkpoints to auto-inline. |
| `MEGACOMPACT_DEDUP_SIM` | `0.90` | Cosine threshold to collapse near-dupes. |
| `MEGACOMPACT_MEMORY_AUTO_REVIEW` | `true` | Auto-review conversation for durable memories. |
| `MEGACOMPACT_MEMORY_REVIEW_INTERVAL` | `10` | Turns between memory reviews. Shortens under pressure. |
| `MEGACOMPACT_CROSSREPO_ENABLED` | `true` | Cross-repo recall on resume + `/mega-recall --cross-repo`. |
| `MEGACOMPACT_CROSSREPO_COSINE` | `0.90` | Stricter cosine floor for cross-repo hits (vs 0.85 same-repo). |
| `MEGACOMPACT_PGLITE_DISABLED` | _(unset)_ | Kill-switch for PGlite/HNSW cross-repo index. Set `1` to disable (falls back to sync scan). |

## Dedup Pipeline

Each tier can be put in `MARK_ONLY` mode (record the decision, don't collapse) for safe rollout or auto-degrade.

| Variable | Default | Description |
|---|---|---|
| `MEGACOMPACT_L0_ENABLED` | `true` | L0 exact content-hash dedup. |
| `MEGACOMPACT_L1_ENABLED` | `true` | L1 MinHash/LSH near-dup verification. |
| `MEGACOMPACT_L2_ENABLED` | `true` | L2 semantic cosine dedup + MMR diversity. |
| `MEGACOMPACT_RAPTOR_ENABLED` | `false` | RAPTOR tree (shadow mode — builds + logs, does not serve retrieval). |
| `MEGACOMPACT_MARK_ONLY_L0` | `false` | L0: record without collapsing. |
| `MEGACOMPACT_MARK_ONLY_L1` | `false` | L1: record without collapsing. |
| `MEGACOMPACT_MARK_ONLY_L2` | `false` | L2: record without collapsing. |
| `MEGACOMPACT_L2_THRESHOLD` | `0.85` | L2 cosine firing point. |
| `MEGACOMPACT_L1_JACCARD` | `0.8` | L1 MinHash/LSH near-dup Jaccard threshold. |
| `MEGACOMPACT_MMR_LAMBDA` | `0.5` | MMR retrieval diversity weight. |
| `MEGACOMPACT_SEMDEDUP_COSINE` | `0.95` | Offline SemDeDup pair threshold. |
| `MEGACOMPACT_FP_RATE_L0` | `0.01` | L0 false-positive alert threshold (auto → MARK_ONLY). |
| `MEGACOMPACT_FP_RATE_L1L2` | `0.05` | L1/L2 false-positive alert threshold. |
| `MEGACOMPACT_ALERT_WINDOW_MS` | `600000` | FP-rate rolling window (10 min). |
| `MEGACOMPACT_P95_BUDGET_MS` | `100` | Per-tier p95 latency budget; canary auto-disables on breach. |

## Embedding

| Variable | Default | Description |
|---|---|---|
| `MEGACOMPACT_EMBEDDING_URL` | _(unset)_ | BYO localhost embedder endpoint (loopback only — remote hosts rejected). |
| `MEGACOMPACT_EMBEDDING_KEY` | _(unset)_ | API key for BYO embedder. |
| `MEGACOMPACT_EMBEDDING_HEADERS` | _(unset)_ | Custom headers for BYO embedder. |
| `MEGACOMPACT_EMBEDDING_DIM` | _(unset)_ | Dimension override for BYO embedder. |
| `MEGACOMPACT_MINILM` | `false` | MiniLM flag — off, not shipped. BYO via `MEGACOMPACT_EMBEDDING_URL` instead. |

## Continuity

| Variable | Default | Description |
|---|---|---|
| `MEGACOMPACT_LEGACY_DURABLE_TRIM` | `false` | Restore legacy auto-trigger that stops the agent. Default uses live trim + pi native auto-compaction (compact-and-continue). |

See also: [`docs/DEDUP_RUNBOOK.md`](DEDUP_RUNBOOK.md) for incident response and [`docs/RETENTION_POLICY.md`](RETENTION_POLICY.md) for TTL/VACUUM policies.
