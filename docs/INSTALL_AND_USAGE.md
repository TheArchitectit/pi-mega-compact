# Install & Usage — pi-mega-compact (v0.3.0)

A complete, copy-paste guide to installing pi-mega-compact and using **every**
feature: the pi extension (auto-compact + recall), the OpenClaw plugin adapter,
the dedup tiers, the dashboard, and the DR/benchmark tooling.

Everything runs **locally** (no network, no API key). The only optional network
surface is the user-triggered localhost dashboard.

---

## 0. Requirements

- **Node >= 18** (builds the `better-sqlite3` native module on `npm install`).
- A **pi** install that loads extensions from `~/.pi/agent/extensions/` **or** an
  **OpenClaw** install (for the plugin adapter). You can use either — or both —
  from the same checkout.
- Reset the native module if you switch Node versions: `npm rebuild better-sqlite3`.

---

## 1. Install the code + build

```bash
git clone https://github.com/TheArchitectit/pi-mega-compact.git \
  ~/.pi/agent/extensions/pi-mega-compact
cd ~/.pi/agent/extensions/pi-mega-compact
npm install
npm run build          # tsc → dist/ (incl. dist/extensions/openclaw-mega-compact.js)
```

Verify (all 278 tests, lint clean):

```bash
npm test && npm run lint
```

> The native `better-sqlite3` binary is ABI-specific. If you ever see
> `ERR_DLOPEN_FAILED … NODE_MODULE_VERSION`, run `npm rebuild better-sqlite3`.

---

## 2. Use it with pi (auto-compact + recall)

### Register the extension

Add to your pi config (`~/.pi/agent/config.json`):

```jsonc
{
  "pi": {
    "extensions": ["~/.pi/agent/extensions/pi-mega-compact/extensions/mega-compact.ts"]
  }
}
```

Or use the bundled helper (needs `jq`):

```bash
./install.sh            # copy into ~/.pi/agent/extensions/pi-mega-compact
./install.sh -s         # symlink instead (dev mode)
```

### What happens automatically

Once registered, pi-mega-compact runs itself:

1. Past the context threshold (`MEGACOMPACT_FAST_GATE_PCT`, default 70%) the
   auto-trigger fires the Trident pipeline and persists a checkpoint
   (`chkpt_xxx`) to the local SQLite store.
2. On **resume** (`pi --continue`) it auto-inlines the most relevant checkpoints
   silently via the `before_agent_start` system prompt.
3. A `mega-compact-marker` lets repeat triggers re-skip already-represented
   regions at ~0 tokens.

### Slash commands (inside pi)

| Command | What it does |
|---|---|
| `/megacompact [summary...]` | Manual compact. A summary arg is used verbatim; otherwise the COLLAPSE heuristics build one. |
| `/megacompact off` | Disable auto-compaction for this session. |
| `/megacompact-status` | Config + current context usage + store stats (count, dedup rate, tokens saved). |
| `/megacompact-recall [query]` | Semantic search the local store, dedupe against the current window, inline top-K. No query → your latest message. |
| `/mega-dashboard` | Start the localhost dashboard + open in browser. |
| `/mega-dashboard-status` | Report dashboard server status. |
| `/mega-dashboard-stop` | Stop the dashboard server. |

### Live stats widget

Above the pi editor:

```
 ⚡ medium │ 142k/200k tokens (71%) │ 3 chkpts │ 🤖 2 agents │ turn 5
   ◐ armed │ dedup: 92% │ saved: 45k tok
```

---

## 3. Use it with OpenClaw (plugin adapter)

The OpenClaw adapter (`extensions/openclaw-mega-compact.ts`) is a **second runtime
boundary** — same SQLite store + dedup engine, exposed to OpenClaw as a
`CompactionProvider`. Installed as a type:module package; OpenClaw loads the
built `dist/extensions/openclaw-mega-compact.js` (produced by `npm run build`).

### Install into OpenClaw

OpenClaw discovers plugins via the `openclaw` field in `package.json`
(`"plugin": "./extensions/openclaw-mega-compact.ts"`,
`"manifest": "./openclaw.plugin.json"`). Install the package from your checkout so
OpenClaw's plugin resolver can find it:

```bash
# From the checkout (symlink into OpenClaw's plugin resolution path):
npm link                      # makes `pi-mega-compact` resolvable
# — or, if you run OpenClaw from its own workspace —
cd <openclaw-workspace> && npm install <path-to>/pi-mega-compact
```

Then register + enable it in `~/.openclaw/openclaw.json`:

```jsonc
{
  "plugins": {
    "allow": [
      "mega-compact"            // add to the allow list
    ],
    "entries": {
      "mega-compact": {
        "enabled": true,        // manifest defaults enabledByDefault:false
        "config": {
          "stateDir": "",       // optional; blank → ~/.pi/agent/extensions/pi-mega-compact
          "dedupSim": 0.9,      // cosine dedup threshold (0–1)
          "preserveRecent": 4,  // recent messages kept verbatim
          "debug": false
        }
      }
    }
  }
}
```

Restart OpenClaw. You should see a log line
`mega-compact: registered compaction provider "mega-compact"`.

> **Store sharing:** the adapter defaults its state dir to the **same**
> `~/.pi/agent/extensions/pi-mega-compact` as the pi extension, so checkpoints
> created under pi are visible under OpenClaw (and vice-versa) unless you point
> `stateDir` elsewhere. Override with the `stateDir` config key or the
> `MEGA_COMPACT_STATE_DIR` env var.

### OpenClaw tools

The adapter registers two on-demand tools inside OpenClaw:

| Tool | What it does |
|---|---|
| `mega_status` | Returns vector-store stats for a session: checkpoint count, total tokens saved, last checkpoint id, injected count, dedup hit rate. Args: `{ sessionId? }`. |
| `mega_recall` | Recalls + inlines relevant context from the store. Args: `{ sessionId, query, limit? }` (limit default 3). Requires `sessionId` + `query`. |

### OpenClaw hooks (diagnostics)

- `before_compaction` — logs the message count in scope.
- `after_compaction` — logs the produced summary length.

These are informational only (no behavior change); grep your OpenClaw logs for
`mega-compact:` to watch them.

### How OpenClaw compaction uses it

When OpenClaw decides to compact, it calls the `mega-compact` provider's
`summarize({ messages, compressionRatio, signal })`. The adapter converts
OpenClaw messages → engine messages, runs the Trident pipeline
(`compactSession`), persists a checkpoint, and returns the summary. It only acts
when there are ≥6 messages and returns `""` (no-op) otherwise. The summary
replaces the compacted region exactly as the built-in summarizer would.

---

## 4. Dedup tiers (all entry points share them)

Every checkpoint flows through the cascade. Each tier is independently
flaggable via env vars (single source: `src/config/dedup.ts`).

| Tier | Env flag | Default | Catches |
|---|---|---|---|
| **L0** exact | `MEGACOMPACT_L0_ENABLED` | `true` | Identical content (SHA-256 content hash / region hash / summary hash; case+whitespace+ANSI normalized). |
| **L1** near-dup | `MEGACOMPACT_L1_ENABLED` | `true` | One-word rewordings via MinHash/LSH + trigram verify. |
| **L2** semantic | `MEGACOMPACT_L2_ENABLED` | `true` | Paraphrases via cosine (threshold `MEGACOMPACT_L2_THRESHOLD`, default 0.85 trigram). MMR diversifies retrieval. |
| **RAPTOR** | `MEGACOMPACT_RAPTOR_ENABLED` | `false` | Hierarchical summary tree (**shadow mode by default** — builds + logs, doesn't serve). |

**`MARK_ONLY_*` (L0/L1/L2):** set `MEGACOMPACT_MARK_ONLY_L<n>=true` to run + record
a tier's decision but **not collapse** — the safe partial-rollout / auto-degrade
state (used automatically by the FP alert + canary).

**Other knobs:** `MEGACOMPACT_MINILM` (off; not shipped),
`MEGACOMPACT_EMBEDDING_URL` (BYO loopback embedder),
`MEGACOMPACT_FP_RATE_L0`/`_L1L2` (alert thresholds),
`MEGACOMPACT_P95_BUDGET_MS` (canary auto-disable). Full table in `README.md`.

---

## 5. Dashboard (localhost only)

`/mega-dashboard` (pi) or the OpenClaw dashboard starts a **localhost** server
with: token gauge, store stats (checkpoints, dedup, injected), and a live event
stream (`events.log`). This is the only network surface and is user-triggered.
Stop with `/mega-dashboard-stop`.

---

## 6. Operational tooling (scripts/)

Run after `npm run build`.

**DR drill** — validate the SQLite store against its JSON snapshots and rebuild
if corrupt:

```bash
bash scripts/dedup-restore-drill.sh ~/.pi/agent/extensions/pi-mega-compact
```

**Benchmark** — dedup hit rate, compression ratio, per-tier p95, storage at
100 / 1K / 10K checkpoints:

```bash
node scripts/dedup-benchmark.mjs 100 1000 10000
```

---

## 7. Uninstall

```bash
rm -rf ~/.pi/agent/extensions/pi-mega-compact   # pi
```

For OpenClaw: remove `mega-compact` from `plugins.allow` / `plugins.entries` in
`~/.openclaw/openclaw.json` and uninstall the package (`npm unlink pi-mega-compact`
or remove it from the workspace `package.json`).

Then delete the state dir to purge all data:

```bash
rm -rf ~/.pi/agent/extensions/pi-mega-compact
```

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `ERR_DLOPEN_FAILED … NODE_MODULE_VERSION` | `npm rebuild better-sqlite3` (Node ABI mismatch). |
| OpenClaw doesn't load the plugin | Confirm `npm run build` ran (needs `dist/extensions/openclaw-mega-compact.js`), `mega-compact` is in `plugins.allow`, and `entries.mega-compact.enabled=true`. |
| No auto-inline on resume | Check `/megacompact-status` shows checkpoints; recall fires when persisted checkpoints + a usable query exist. |
| Wrong collapse (FP) | Flip the suspect tier `MARK_ONLY_*=true`; see `docs/DEDUP_RUNBOOK.md`. |
| Extension not loading | `/megacompact-status` should report store stats; confirm the path in `pi.extensions`. |
