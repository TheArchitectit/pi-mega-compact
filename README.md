# pi-mega-compact

A **layered, local, vector-backed context compressor** for the
[pi coding agent](https://github.com/earendil-works/pi). It compacts long
sessions into a local vector database and offers **deduped inline recall** — all
running **locally inside the extension**, with **no remote MCP server** involved.

> Design constraint from day one: *we are not going to expose an MCP server, so
> it's all got to be local within the extension / SDK.* The reviewed memory-mcp /
> claw-code / neuralwatt-mcr code is used as **algorithmic reference**, not as a
> service we call.

---

## What it does

A Trident-style 3-stage compaction pipeline runs over your conversation, and the
resulting **checkpoints** are persisted to a local vector store under
`~/.pi/agent/extensions/mega-compact/`. One vector store powers **three entry
points** through **one dedup engine**:

| Entry point | Trigger | Behavior |
|---|---|---|
| **Auto-inline** (Layer 5) | `session_start` / `session_tree` | Resume → `recallAndInline(source:"resume")` prepends the most relevant checkpoints, deduped against current context. |
| **On-demand recall** | `/recall-context [query]` | Semantic search the store, dedupe, and inline the top-K. |
| **Dedup sentinel** | every compact | A lightweight `mega-compact-marker` entry lets auto-inline and recall skip re-injecting / re-vectorizing already-present regions. |

The compaction pipeline (mirrors the reviewed stack):

```
Layer 5  Recall / Inline      ONE vector store → 3 entry points, 1 dedup engine
Layer 4  Persist / Checkpoint  compactSession()  → gzip + embed + store (chkpt_xxx)
Layer 3  Cluster (vectorize)  local vector index → semantic dedup + recall
Layer 2  Collapse (summarize)  summarizeMessages() heuristic + agent summary on /megacompact
Layer 1  Supersede (prune)     drop obsolete file-reads / superseded turns (zero cost)
─────────────────────────────────────────────────────────────────────────
Trigger   context/turn_end → % gate → auto_compact_check → fire
Marker    insert compact-marker; dedupe so repeated triggers cost ~0 tokens
Cancel    session_before_compact → { cancel:true } once persisted (no double-compact)
```

### Dedup rules (shared across all entry points)

- Skip any checkpoint whose `regionHash` matches a marker already on the branch.
- Skip any checkpoint whose `checkpointId` was injected this session (tracked in
  `state.json`).
- Cosine **near-duplicate collapse**: two candidates scoring `> DEDUP_SIM`
  (default `0.90`) keep only the higher-ranked one.

---

## Installation

```bash
# From a checkout:
cd pi-mega-compact
npm install
npm run build

# Point pi at the extension. Either copy it:
cp -r . ~/.pi/agent/extensions/pi-mega-compact
# ...or add it to your pi config's extensions list:
#   "pi": { "extensions": ["./extensions/mega-compact.ts"] }
```

Requires **node >= 18**. No native build, no network, no API key.

### Quick install (git clone)

```bash
git clone https://github.com/TheArchitectit/pi-mega-compact.git ~/.pi/agent/extensions/pi-mega-compact
cd ~/.pi/agent/extensions/pi-mega-compact
npm install
npm run build
```

### Verify installation

```bash
cd ~/.pi/agent/extensions/pi-mega-compact
npm test          # Should report 85/85 pass
npm run lint      # Should be clean
```

### Live Stats Widget

The extension displays a compact stats widget above the pi editor:

```
 ⚡ medium │ 142k/200k tokens (71%) │ 3 chkpts │ 🤖 2 agents │ turn 5
   ◐ armed │ dedup: 92% │ saved: 45k tok
```

The widget shows:
- **Tier**: active compaction tier (low/medium/high/ultra/mega)
- **Token usage**: current / max context window and percentage
- **Checkpoints**: number of persisted checkpoints
- **Trigger state**: ○ idle, ◐ armed, ● ready
- **Dedup hit rate**: percentage of deduplicated checkpoints
- **Active agents**: number of running sub-agents (shown when > 0)
- **Turn index**: current conversation turn (shown when > 0)

### Beta Testing

1. Install the extension (see above)
2. Start a pi session and observe the toolbar widget
3. Use sub-agents (pi's Agent tool) and watch the 🤖 counter
4. Run `/megacompact-status` for detailed stats
5. Monitor events: `tail -f ~/.pi/agent/extensions/pi-mega-compact/events.log | jq .`
6. Test edge cases: multiple agents, branch navigation, session resume

### Configuration

After installation, add the extension to your pi config:

```jsonc
{
  "pi": {
    "extensions": ["~/.pi/agent/extensions/pi-mega-compact/extensions/mega-compact.ts"]
  }
}
```

Or set the compaction tier via environment variable:

```bash
export MEGACOMPACT_TIER=medium  # low | medium | high | ultra | mega
```

### Uninstall

```bash
rm -rf ~/.pi/agent/extensions/pi-mega-compact
```

Remove the extension path from your pi config.

---

## Beta testing

This extension is in **beta**. To participate in beta testing:

### 1. Install the latest release

```bash
git clone https://github.com/TheArchitectit/pi-mega-compact.git ~/.pi/agent/extensions/pi-mega-compact
cd ~/.pi/agent/extensions/pi-mega-compact
npm install && npm run build
```

### 2. Test the core flow

Start a pi session and work normally. After ~30-60 minutes of heavy usage (when context fills to 80%+), you should see:
- A compaction checkpoint persisted automatically
- Context dropping after confirmation
- The status bar showing the mega-compact status
- The live stats widget above the editor showing real-time token usage

### 3. Verify the widget

Look above the editor area in your pi terminal. You should see:

```
 ⚡ medium │ 142k/200k tokens (71%) │ 3 chkpts
   ◐ armed │ dedup: 92% │ saved: 45k tok
```

If the widget doesn't appear, check:
- Is the extension loaded? Run `/megacompact-status` — should report store stats
- Is context usage above the gate? Widget shows "○ idle" below `fastGatePct`

### 4. Test the dashboard

Run `/dashboard` to open the live dashboard in your browser. It shows:
- Token usage gauge (threshold vs current vs max)
- Session state and config
- Store stats (checkpoints, dedup, injected)
- Live event stream

### 5. Test recall

After compacting, restart pi. Ask a question about something you worked on previously. The extension should automatically recall relevant checkpoints and inject them into context.

### 6. Report issues

When reporting, include:
- Output of `/megacompact-status`
- Output of `/dashboard-status`
- Your pi version and OS
- The `state.json` file from `~/.pi/mega-compact/` (redact if needed)

Open issues at: https://github.com/TheArchitectit/pi-mega-compact/issues

---

## Commands

| Command | Description |
|---|---|
| `/megacompact` | Manual compaction of the current session |
| `/megacompact off` | Disable auto-compaction for this session |
| `/megacompact-status` | Display live store stats (count, dedup rate, supersedes) |
| `/megacompact-context` | Report per-agent context utilisation and context window |
| `/recall-context` | Inject the top recalled checkpoint for the current session |
| `/recall-context <query>` | Inject a recalled checkpoint for a specific topic |
| `/dashboard` | Start the live dashboard server and open in browser |
| `/dashboard-status` | Report dashboard server status |
| `/dashboard-stop` | Stop the dashboard server |

---

## Commands

- `/megacompact [summary...]` — summarize the current session and persist a
  `chkpt_xxx` checkpoint to the local vector store. If a summary is supplied it
  is used verbatim; otherwise the COLLAPSE heuristics build one.
- `/recall-context [query]` — semantic-search the local store, dedupe against the
  current window, and inline the top-K relevant checkpoints. With no query it uses
  the latest user message.
- `/megacompact-status` — show the config and current context usage.

---

## Configuration (env-backed)

| Variable | Default | Meaning |
|---|---|---|
| `MEGACOMPACT_FAST_GATE_PCT` | `70` | Context-usage % that arms the auto-trigger. |
| `MEGACOMPACT_TIER` | `low` | Named trigger preset — sets the token threshold. One of `low` (50k), `medium` (100k), `high` (200k), `ultra` (1M), `mega` (10M). |
| `MEGACOMPACT_THRESHOLD_TOKENS` | _(tier default)_ | Explicit token budget that confirms compaction. Overrides `MEGACOMPACT_TIER` when set. |
| `MEGACOMPACT_ANCHOR_USER_MESSAGES` | `3` | Never drop the most recent N user messages (anchor floor). |
| `MEGACOMPACT_PRESERVE_RECENT` | `4` | Preserve the most recent N messages verbatim. |
| `MEGACOMPACT_AUTO` | `true` | Enable the auto-trigger. |
| `MEGACOMPACT_AUTO_INLINE` | `true` | Auto-inline on resume / branch. |
| `MEGACOMPACT_AUTO_INLINE_K` | `3` | Top-K checkpoints to auto-inline. |
| `MEGACOMPACT_DEDUP_SIM` | `0.90` | Cosine threshold to collapse near-dupes. |
| `MEGACOMPACT_STATE_DIR` | `~/.pi/agent/extensions/pi-mega-compact` | Override the store location. |

---

## Architecture & layout

```
extensions/mega-compact.ts   pi extension entry; wires src/ into pi lifecycle
src/adapt.ts                  the single pi↔engine message adapter (index-aligned)
src/engine.ts                 Layer 4: compactSession() Trident pipeline + recall()
src/vectorStore.ts            Layer 3: local vector DB (add/search/dedupe + near-dup)
src/embedder.ts               default hashed trigram-bag embedder (deterministic)
src/store.ts                  gzipped per-session checkpoint + session-state persistence
src/compact.ts               Layer 2: summarize / merge / autoCompactCheck
src/supersede.ts             Layer 1: obsolete file-read pruning
src/boundary.ts              drop-boundary guards (anchor floor + tool-pair)
src/tokens.ts                deterministic token estimator
src/types.ts                 engine-internal types
```

The `src/` directory is **pi-agnostic** and fully unit-tested (`node --test`).
The extension entry adapts between the engine and pi's runtime types.

### Embedding

The default embedder is a **deterministic hashed trigram bag** (fixed dimension,
L2-normalized) — zero dependencies, instant, works offline. It is heuristic-
strength, which is the right bar for "inline the right checkpoint," not
production RAG. A real embedder (e.g. transformers.js) can be dropped in behind
the same `Embedder` interface later.

---

## Development

```bash
npm run build      # tsc
npm test           # build + node --test on dist/**/*.test.js
npm run lint       # tsc --noEmit + guardrails-scan
npm run guardrails # regression_check + guardrails-scan
```

The agent-guardrails suite (Four Laws, scope, secrets, regression) gates every
sprint.

---

## Status

- ✅ Sprint 1 — core engine (Layers 1–2, pure functions)
- ✅ Sprint 2 — local vector store (Layer 3)
- ✅ Sprint 3 — pi extension wiring (Layer 4 persist + trigger)
- ✅ Sprint 4 — unified recall layer (Layer 5: auto-inline + on-demand + sentinel)
- ✅ Sprint 5 — commands / UX / config polish (status chip, store stats, debug log)
- ✅ Sprint 6 — hardening, docs, release (`install.sh`, CHANGELOG, `v0.1.0`)

See `SPRINT_PLAN.md` for the full breakdown and `PLAN.md` for architecture,
`RESEARCH.md` for the pi-API constraints that shaped it, `CHANGELOG.md` for
release notes.

## Install

```bash
./install.sh          # copy into ~/.pi/agent/extensions/pi-mega-compact
./install.sh -s       # symlink (dev mode)
```

The script also registers `extensions/mega-compact.ts` in pi's
`~/.pi/agent/config.json` `pi.extensions` array (needs `jq`).

---

## Acknowledgements

Algorithmic reference (reimplemented in TypeScript, not vendored): memory-mcp
(`MemoryCompactor` / `compact.py`), claw-code (`trident.rs` / `compact.rs`), and
neuralwatt-mcr (pi-extension mechanics). Attribution as design sources only.

## License

[MIT](./LICENSE)
