# Mega-Compact Dashboard

A lightweight local web dashboard for monitoring mega-compact's live state — compactions, context usage, checkpoints, and recall hits.

Uses Node built-in modules (`http`, `fs`, `path`, `node:sqlite` — the project's
one-store DB backend) to read the machine-wide multi-repo index.

## Quick Start

From a pi session with mega-compact loaded:

```
/dashboard
```

This will:
1. Start a local HTTP server on a random port (3000–3999)
2. Show a confirm dialog asking if you'd like to open it in your browser
3. Write the dashboard URL to the terminal

## Commands

| Command | Description |
|---|---|
| `/dashboard` | Start the dashboard server (or reuse if already running) |
| `/dashboard-stop` | Stop the running server |
| `/dashboard-status` | Show the current server status and URL |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  pi session (mega-compact extension)                        │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  DashboardEmitter                                      │ │
│  │  • writes dashboard.json (full state snapshot)         │ │
│  │  • appends to events.log (JSONL tail)                  │ │
│  └────────────────────────────────────────────────────────┘ │
│           │ writes after each compaction                    │
└───────────┼─────────────────────────────────────────────────┘
            ▼
┌─────────────────────────────────────────────────────────────┐
│  dashboard-server (detached child process)                  │
│  • GET /           → single-page HTML dashboard             │
│  • GET /api/snapshot → JSON snapshot (reads dashboard.json) │
│  • GET /api/events   → SSE stream (watches events.log)     │
└─────────────────────────────────────────────────────────────┘
```

### Data Files

All files are written to the extension's state directory
(`~/.pi/agent/extensions/pi-mega-compact/`):

| File | Format | Description |
|---|---|---|
| `dashboard.json` | JSON | Full state snapshot, rewritten after each compaction |
| `events.log` | JSONL | Append-only event log (compact_start, compact_end, checkpoint_persisted, recall_inject) |
| `port.pid` | JSON | Server port and PID for process management |
| `runner.mjs` | ESM script | Auto-generated launcher for the dashboard server |

### Event Types

```json
{"ts":"...","type":"compact_start","trigger":"auto|command","tier":"medium","sessionId":"..."}
{"ts":"...","type":"compact_end","trigger":"auto|command","durationMs":1234,"mode":"mega","fromTokens":100000,"toTokens":5000}
{"ts":"...","type":"checkpoint_persisted","checkpointId":"chk_1","totalCheckpoints":3}
{"ts":"...","type":"recall_inject","count":2,"totalTokens":1200,"sources":["chk_1","chk_2"]}
```

### Server Process

The server runs as a detached child process, independent of the pi session. It:
- Auto-discovers the state directory from the `port.pid` file
- Cleans up stale `port.pid` files from dead processes
- Supports `SIGTERM`/`SIGINT` for graceful shutdown
- Serves static HTML; reads the multi-repo index from SQLite (`node:sqlite`)

## Browser UI

The dashboard is a single-page application that shows:

- **Status bar**: current tier, trigger state, context utilization
- **Compaction graph**: timeline of compaction events with token counts
- **Checkpoint list**: recent checkpoints with timestamps
- **Recall activity**: dedup hits and injection stats
- **Context gauge**: live token usage vs. threshold

The UI uses `EventSource` (SSE) for real-time updates — no polling required.

## Development

### Running tests

```bash
npm run build && node --test dist/extensions/dashboard-server.test.js
```

### Manual testing

```bash
# Start the server directly (for debugging)
node dist/extensions/dashboard-server.js

# Write a test snapshot
echo '{"updatedAt":"2025-01-01T00:00:00Z","tier":"medium","version":1}' > ~/.pi/agent/extensions/pi-mega-compact/dashboard.json

# Watch events in another terminal
tail -f ~/.pi/agent/extensions/pi-mega-compact/events.log | jq .
```

## Live Stats Widget

The extension displays a compact stats widget above the pi editor at all times:

```
 ⚡ medium │ 142k/200k tokens (71%) │ 3 chkpts │ 🤖 2 agents │ turn 5
   ◐ armed │ dedup: 92% │ saved: 45k tok
```

The widget shows:
- **Tier**: active compaction tier (low/medium/high/ultra/mega)
- **Token usage**: current / max context window and percentage
- **Checkpoints**: number of persisted checkpoints this session
- **Trigger state**: ○ idle (< gate %), ◐ armed (≥ gate %, below threshold), ● ready (≥ threshold)
- **Dedup hit rate**: percentage of compacted regions that were already stored
- **Tokens saved**: cumulative token savings from compaction
- **Active agents**: number of running sub-agents (shown when > 0)
- **Turn index**: current conversation turn number (shown when > 0)

The widget updates on every context event, session start, branch navigation, agent start/end, turn start/end, and compaction. It clears automatically on session shutdown.

### Agent Tracking

The extension tracks active sub-agents in real-time:

| Event | Behavior |
|-------|----------|
| `agent_start` | Increments active agent count, updates widget |
| `agent_end` | Decrements active agent count, updates widget |
| `turn_start` | Tracks current turn index, updates widget |
| `turn_end` | Logs turn completion, updates widget |
| `session_start` | Resets agent count and turn counter |
| `session_shutdown` | Resets agent count and turn counter |

## Security

- The server only listens on `127.0.0.1` (localhost)
- No authentication (local-only, not exposed to network)
- No write endpoints — all APIs are read-only

## Multi-Repo Index (Phase 5b)

The dashboard shows every repo that has run mega-compact on this machine, not
just the one it was launched from. The extension writes a machine-wide
`repo_registry` into a single SQLite DB (`<indexDir>/index.sqlite`, where
`indexDir` is `$MEGACOMPACT_INDEX_DIR` or `~/.mega-compact-index`), one row per
repo with checkpoint count, tokens saved, compressed-original bytes, and the
active model/provider (denormalized from `model_snapshots`). The dashboard
server opens that table read-only (`GET /api/index`) and renders the **All
repos** (per-repo table) and **Summary** (machine-wide aggregate) tabs. All
registry data lives in SQLite — there is no JSON mirror; the "one store"
invariant is preserved end-to-end.

## Troubleshooting

**Port already in use**: The server picks a port in 9320–9329. If all are taken, it will retry. Check `/dashboard-status` for the current port.

**Server won't start**: Check for stale `port.pid` files. Run `/dashboard-stop` to clean up, then try `/dashboard` again.

**No data showing**: The server reads `dashboard.json` and `events.log` from the state directory. These are created after the first compaction. If you haven't compacted yet, run `/megacompact` to trigger one.

**Browser doesn't open**: The server URL is always shown in the terminal. Copy it manually or use `xdg-open <url>` (Linux), `open <url>` (macOS), or `start <url>` (Windows).
