# Commands

All commands are slash commands inside pi.

## Compaction

| Command | Description |
|---|---|
| `/mega-compact [summary]` | Manually compact the current session. A summary arg is used verbatim; otherwise heuristics build one. |
| `/mega-compact off` | Disable auto-compaction for this session. |
| `/mega-status` | Show config, context usage, store stats, installed version. |
| `/mega-restore <chkpt\|recent>` | Re-inject a checkpoint's verbatim original region into context. |
| `/mega-history` | List this session's checkpoints (id, date, files, tokens). |
| `/mega-view <chkpt\|recent>` | Show a checkpoint's verbatim original region. |
| `/mega-help` | Explain toolbar widget terms. |
| `/mega-compat-check` | Detect conflicts with other pi extensions. |

## Recall

| Command | Description |
|---|---|
| `/mega-recall [query]` | Semantic search the local store, dedupe against current window, inline top-K. No query uses your latest message. |
| `/mega-recall --cross-repo` | Search all repos via the HNSW index. Cross-repo hits use a stricter cosine floor and are labeled with source repo. |

## Memory

| Command | Description |
|---|---|
| `/mega-memory save <text>` | Save a durable memory. |
| `/mega-memory save <category> <text>` | Save with category (decision/fact/preference). |
| `/mega-memory list` | List all durable memories. |
| `/mega-memory search <query>` | Search memories. |
| `/mega-memory forget <text>` | Delete a memory. |
| `/mega-memory consolidate` | Merge related memories. |
| `/m` | Shortform for `/mega-memory`. |

## Dashboard

| Command | Description |
|---|---|
| `/mega-dashboard` | Start the localhost-only dashboard and open in browser. |
| `/mega-dashboard-status` | Report dashboard server status. |
| `/mega-dashboard-stop` | Stop the dashboard server. |

## Database Maintenance

| Command | Description |
|---|---|
| `/mega-db-stats` | Show SQLite stats: row counts, disk footprint, WAL, page count, freelist %. Read-only. |
| `/mega-db-prune [days]` | Delete old raw transcript + checkpoint rows (default 30 days). Reports deleted counts. |
| `/mega-db-vacuum` | VACUUM the DB to reclaim disk space. Briefly doubles disk usage. |
| `/mega-db-check` | Integrity check + WAL checkpoint. Use after a crash. |
| `/mega-db-reconcile` | Fix dedup ref count drift, delete orphan rows. Run after prune or crash. |

## Toolbar Widget

```
⚡ high v0.7.5 │ 142k/200k tokens (71%) │ 3 chkpts │ 🤖 2 agents │ turn 5
  ◐ armed │ dedup: 92% │ saved: 45k tok
```

- **Version** — installed npm version
- **Tier** — compaction pressure level (low/medium/high/ultra/mega), driven by `currentTokens / effectiveThreshold`
- **Token usage** — current / max context window
- **Checkpoints** — persisted checkpoints for this session
- **Trigger state** — ○ idle, ◐ armed, ● ready
- **Dedup rate** — % of checkpoints collapsed as duplicates
- **Agents / turn** — sub-agent count and conversation turn

The tier is a live pressure band that climbs as context fills and falls back as it's relieved. Not a manual setting.

A best-effort auto-maintenance pass runs on `session_start`: prunes rows older than 30d, checkpoints WAL over 10 MB, VACUUMs if DB is over 100 MB with >20% freelist. Never blocks session start.
