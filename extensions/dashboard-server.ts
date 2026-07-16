/**
 * dashboard-server.ts — lightweight local web dashboard for mega-compact.
 *
 * Zero npm dependencies. Uses only Node built-in modules (http, fs, path).
 * Serves a single-page HTML dashboard, a JSON snapshot API, and an SSE
 * endpoint that live-streams new events.log entries.
 *
 * Designed to be spawned as a detached child process from the pi extension
 * and discovered by the /dashboard command via a port.pid file.
 *
 * @module
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, unlinkSync, watch, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Local runtime log
//
// The dashboard server is spawned as a DETACHED child. When it is launched with
// `stdio: "ignore"` (the old default) any crash before the first console.log is
// invisible — there is no log to "check". We therefore mirror every lifecycle
// line to a file in the state dir so a failed start is always diagnosable. The
// launcher also captures stderr, so this doubles as defense-in-depth.
// ---------------------------------------------------------------------------

let LOG_PATH: string | null = null;
function log(...parts: unknown[]): void {
  const line = `[mega-compact][dashboard] ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}`;
  // eslint-disable-next-line no-console
  console.error(line); // stderr — captured by the launcher pipe
  if (LOG_PATH) {
    try { appendFileSync(LOG_PATH, new Date().toISOString() + " " + line + "\n"); } catch { /* non-fatal */ }
  }
}

// --- Multi-repo index (Phase 5b) ------------------------------------------------
// The extension writes a machine-wide repo registry into a single SQLite DB
// (<indexDir>/index.sqlite) as the concurrency-safe write path; the dashboard
// reads that table directly (one read-only connection, opened per request so a
// concurrent writer's WAL never blocks the request). All registry data lives in
// SQLite (the project's one-store invariant) — there is no JSON mirror. Same
// index-dir resolution as src/store/sqlite.ts getIndexDir().
function getIndexDir(): string {
  const override = process.env.MEGACOMPACT_INDEX_DIR;
  if (override && override.trim() !== "") return override;
  try {
    return join(homedir(), ".mega-compact-index");
  } catch {
    return join("/tmp", ".mega-compact-index");
  }
}

interface IndexRepo {
  repoRoot: string;
  displayName: string;
  checkpointCount: number;
  tokensSaved: number;
  compressedOriginalBytes: number;
  lastCompactedAt: number | null;
  provider: string | null;
  providerName: string | null;
  modelName: string | null;
  inputRate: number | null;
  outputRate: number | null;
  lastSeen: number;
}

/** Read the machine-wide repo registry from SQLite (read-only, single shot). */
function readIndex(): { updatedAt: string; summary: unknown; repos: unknown[] } | null {
  const indexPath = join(getIndexDir(), "index.sqlite");
  if (!existsSync(indexPath)) return null;
  let db: DatabaseSync | undefined;
  try {
    // Read-only + immutable WAL so a concurrent writer's WAL never blocks us.
    db = new DatabaseSync(indexPath, { readOnly: true });
    db.exec("PRAGMA journal_mode = WAL");
    const rows = db
      .prepare("SELECT * FROM repo_registry ORDER BY last_seen DESC")
      .all() as Record<string, unknown>[];
    const mapped: IndexRepo[] = rows.map((r) => ({
      repoRoot: String(r.repo_root ?? ""),
      displayName: String(r.display_name ?? ""),
      checkpointCount: Number(r.checkpoint_count ?? 0),
      tokensSaved: Number(r.tokens_saved ?? 0),
      compressedOriginalBytes: Number(r.compressed_original_bytes ?? 0),
      lastCompactedAt: (r.last_compacted_at as number | null) ?? null,
      provider: (r.provider as string | null) ?? null,
      providerName: (r.provider_name as string | null) ?? null,
      modelName: (r.model_name as string | null) ?? null,
      inputRate: (r.input_rate as number | null) ?? null,
      outputRate: (r.output_rate as number | null) ?? null,
      lastSeen: Number(r.last_seen ?? 0),
    }));
    // Defensive display hygiene (belt-and-suspenders — the real fix is that
    // tests now isolate via MEGACOMPACT_INDEX_DIR): drop transient test/temp
    // paths that should never have been real repos, and collapse duplicate
    // display names to the most-recently-seen row (rows are last_seen DESC, so
    // the first occurrence wins). Keeps the All-repos list readable.
    const isTransient = (p: string) =>
      /^\/tmp\//.test(p) || /^\/private\/tmp\//.test(p) || /^\/var\/folders\//.test(p) ||
      /\/mc-(ext|e2e|resume|recall)-/.test(p);
    const seenName = new Set<string>();
    const repos: IndexRepo[] = [];
    for (const r of mapped) {
      if (isTransient(r.repoRoot)) continue;
      if (seenName.has(r.displayName)) continue;
      seenName.add(r.displayName);
      repos.push(r);
    }
    const summary = {
      totalRepos: repos.length,
      totalCheckpoints: repos.reduce((a, r) => a + r.checkpointCount, 0),
      totalTokensSaved: repos.reduce((a, r) => a + r.tokensSaved, 0),
      totalCompressedOriginalBytes: repos.reduce((a, r) => a + r.compressedOriginalBytes, 0),
    };
    return { updatedAt: new Date().toISOString(), summary, repos };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Snapshot {
  version: number;
  updatedAt: string | null;
  tier: string;
  config: {
    fastGatePct: number;
    thresholdTokens: number;
    anchorUserMessages: number;
    preserveRecent: number;
    auto: boolean;
    autoInlineK: number;
  };
  session: {
    id: string | null;
    state: string | null;
    persistedThisSession: boolean;
    lastCheckpointId: string | null;
    lastCompactedFrom: number;
  };
  context: {
    tokens: number | null;
    percent: number | null;
    contextWindow: number;
  };
  trigger: {
    armed: boolean;
    ready: boolean;
    currentTokens: number | null;
    thresholdTokens: number;
    fastGatePct: number;
  };
  store: {
    checkpointCount: number;
    totalTokenEstimate: number;
    originalTokens: number;
    tokensSaved: number;
    injectedCount: number;
    dedupHitRate: number;
    storageDedupRate: number;
    dedupCollapsed: number;
  };
  crew: {
    activeAgents: number;
    currentTurn: number;
  };
  repo: {
    checkpointCount: number;
    totalTokenEstimate: number;
    originalTokens: number;
    tokensSaved: number;
    sessionCount: number;
    dedupAttempts: number;
    dedupCollapsed: number;
    storageDedupRate: number;
  };
  integrity: {
    regionsRetained: number;
    compressedOriginalBytes: number;
    duplicatesCollapsed: number;
    bytesPermanentlyDeleted: number;
  };
  model?: {
    name: string;
    provider: string;
    providerName: string;
    inputRate: number;
    outputRate: number;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readSnapshot(snapshotPath: string) {
  try {
    const raw = readFileSync(snapshotPath, "utf-8");
    return JSON.parse(raw) as Snapshot;
  } catch {
    return {
      version: 1,
      updatedAt: null,
      tier: "unknown",
      config: { fastGatePct: 80, thresholdTokens: 100_000, anchorUserMessages: 1, preserveRecent: 2, auto: true, autoInlineK: 3 },
      session: { id: null, state: null, persistedThisSession: false, lastCheckpointId: null, lastCompactedFrom: 0 },
      context: { tokens: null, percent: null, contextWindow: 0 },
      trigger: { armed: false, ready: false, currentTokens: null, thresholdTokens: 100_000, fastGatePct: 80 },
      store: { checkpointCount: 0, totalTokenEstimate: 0, originalTokens: 0, tokensSaved: 0, injectedCount: 0, dedupHitRate: 0, storageDedupRate: 0, dedupCollapsed: 0 },
      crew: { activeAgents: 0, currentTurn: 0 },
      repo: { checkpointCount: 0, totalTokenEstimate: 0, originalTokens: 0, tokensSaved: 0, sessionCount: 0, dedupAttempts: 0, dedupCollapsed: 0, storageDedupRate: 0 },
      integrity: { regionsRetained: 0, compressedOriginalBytes: 0, duplicatesCollapsed: 0, bytesPermanentlyDeleted: 0 },
      model: undefined,
    } as Snapshot;
  }
}

function readFrom(path: string, charOffset: number): { data: string; offset: number } {
  try {
    const content = readFileSync(path, "utf-8");
    if (content.length <= charOffset) return { data: "", offset: charOffset };
    return { data: content.slice(charOffset), offset: content.length };
  } catch {
    return { data: "", offset: charOffset };
  }
}

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------

function dashboardHtml(tierName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mega-compact dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; background: #0d1117; color: #c9d1d9; padding: 24px; line-height: 1.5; }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 20px; display: flex; align-items: center; gap: 10px; color: #f0f6fc; }
  h1 .tier { background: #1f6feb; color: #fff; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 10px; text-transform: uppercase; letter-spacing: .5px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
  .card.safe { border-color: #238636; }
  .card.safe h2 { color: #3fb950; }
  .safe-note { font-size: 12px; color: #8b949e; margin: 12px 0 0; line-height: 1.5; }
  .value.ok { color: #3fb950; }
  .label {
    cursor: help;
    border-bottom: 1px dotted #484f58;
  }
  .card.legend { grid-column: 1 / -1; }
  .legend-list { margin: 0; padding-left: 18px; color: #c9d1d9; }
  .legend-list li { margin-bottom: 8px; line-height: 1.5; }
  .legend-list b { color: #f0f6fc; }
  .legend-note { font-size: 12px; color: #8b949e; margin: 12px 0 0; font-style: italic; }
  .card h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .5px; color: #8b949e; margin-bottom: 12px; font-weight: 600; }
  .meter-track { background: #21262d; border-radius: 4px; height: 20px; overflow: hidden; margin: 8px 0; }
  .meter-fill { height: 100%; border-radius: 4px; transition: width .6s ease; min-width: 2px; }
  .meter-green { background: #238636; }
  .meter-yellow { background: #d29922; }
  .meter-red { background: #f85149; }
  .meter-label { font-size: 24px; font-weight: 700; color: #f0f6fc; }
  .meter-sub { font-size: 12px; color: #8b949e; }
  .status-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 14px; }
  .status-row .bullet { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .bullet-on { background: #3fb950; box-shadow: 0 0 6px #3fb95088; }
  .bullet-off { background: #484f58; }
  .bullet-na { background: #d29922; }
  .state-text { font-size: 13px; color: #8b949e; margin-top: 8px; font-family: monospace; }
  .stat-grid { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 14px; }
  .stat-grid .label { color: #8b949e; }
  .stat-grid .value { color: #f0f6fc; font-weight: 600; font-family: monospace; }
  .conf-grid { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 14px; }
  .conf-grid .label { color: #8b949e; }
  .conf-grid .value { color: #f0f6fc; font-family: monospace; }
  .events { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
  .events h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .5px; color: #8b949e; margin-bottom: 12px; font-weight: 600; }
  .events-wrap { max-height: 240px; overflow-y: auto; font-family: monospace; font-size: 12px; }
  .ev { padding: 3px 0; border-bottom: 1px solid #21262d; display: flex; gap: 8px; align-items: baseline; }
  .ev:last-child { border-bottom: none; }
  .ev-type { font-weight: 700; min-width: 70px; text-align: right; }
  .ev-type-compact { color: #3fb950; }
  .ev-type-recall { color: #a371f7; }
  .ev-time { color: #484f58; font-size: 10px; min-width: 80px; }
  .ev-detail { color: #8b949e; flex: 1; }
  .updated { font-size: 11px; color: #484f58; margin-top: 16px; text-align: right; }
  .empty { color: #484f58; font-style: italic; font-size: 13px; padding: 8px 0; }
  .offline-banner { background: #f8514922; border: 1px solid #f85149; border-radius: 6px; padding: 10px 16px; margin-bottom: 16px; font-size: 13px; color: #f85149; display: none; }
  .tabs { display: flex; gap: 8px; margin-bottom: 20px; }
  .tab { background: #161b22; color: #8b949e; border: 1px solid #30363d; border-radius: 6px; padding: 8px 16px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all .15s ease; }
  .tab:hover { color: #c9d1d9; border-color: #484f58; }
  .tab.active { background: #1f6feb; color: #fff; border-color: #1f6feb; }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 20px; }
  .summary-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
  .summary-card .num { font-size: 24px; font-weight: 700; color: #f0f6fc; }
  .summary-card .lbl { font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: .5px; margin-top: 4px; }
  table.repos { width: 100%; border-collapse: collapse; background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; }
  table.repos th, table.repos td { text-align: left; padding: 10px 14px; font-size: 13px; border-bottom: 1px solid #21262d; }
  table.repos th { color: #8b949e; text-transform: uppercase; letter-spacing: .5px; font-size: 11px; background: #0d1117; }
  table.repos td.num { font-family: monospace; color: #f0f6fc; text-align: right; }
  table.repos tr:last-child td { border-bottom: none; }
  table.repos tr:hover td { background: #1c2128; }
  .repo-model { color: #a371f7; }
  .repo-none { color: #484f58; font-style: italic; }
  .updated { font-size: 11px; color: #484f58; margin-top: 16px; text-align: right; }
  .model-pill { background: #6e40c9; color: #fff; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 10px; text-transform: uppercase; letter-spacing: .5px; }
  .card.cost h2 { color: #a371f7; }
  .cost-usd { font-size: 22px; font-weight: 700; color: #3fb950; }
  .cost-sub { font-size: 12px; color: #8b949e; margin-top: 4px; }
  .repo-link { cursor: pointer; }
  .repo-link:hover td { color: #58a6ff; }
  .repo-detail { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: none; align-items: center; justify-content: center; z-index: 50; }
  .repo-detail.open { display: flex; }
  .repo-detail-box { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 24px; width: 560px; max-width: 92vw; max-height: 86vh; overflow-y: auto; }
  .repo-detail-box h2 { font-size: 14px; color: #f0f6fc; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; }
  .repo-close { cursor: pointer; color: #8b949e; font-size: 20px; line-height: 1; border: none; background: none; padding: 0 4px; }
  .repo-close:hover { color: #f0f6fc; }
  .repo-path { font-size: 11px; color: #484f58; word-break: break-all; margin: -8px 0 12px; }
</style>
</head>
<body>

<div class="offline-banner" id="offline-banner">Dashboard data unavailable — waiting for a pi session to write snapshot...</div>

<h1><span>mega-compact</span><span class="tier">${tierName}</span><span class="model-pill" id="hdr-model">—</span></h1>

<nav class="tabs">
  <button class="tab active" data-tab="current">Current repo</button>
  <button class="tab" data-tab="all">All repos</button>
  <button class="tab" data-tab="summary">Summary</button>
</nav>

<!-- Current repo (existing single-repo view) -->
<div class="tab-panel" id="panel-current">
<div class="grid">
  <div class="card">
    <h2>Context Window</h2>
    <div class="meter-label" id="ctx-pct">—</div>
    <div class="meter-track"><div class="meter-fill" id="ctx-bar" style="width:0%"></div></div>
    <div class="meter-sub" id="ctx-sub">waiting for data</div>
  </div>
  <div class="card">
    <h2>Trigger Status</h2>
    <div class="status-row"><div class="bullet" id="tr-armed"></div><span>Armed (context ≥ fast gate)</span></div>
    <div class="status-row"><div class="bullet" id="tr-ready"></div><span>Ready (tokens ≥ threshold)</span></div>
    <div class="state-text" id="tr-state">waiting</div>
  </div>
  <div class="card">
    <h2>Vector Store</h2>
    <div class="stat-grid">
      <span class="label" title="A saved summary of a chunk of your conversation that was compacted to free up space.">Checkpoints</span><span class="value" id="st-count">0</span>
      <span class="label" title="How much conversation we are currently holding as compact summaries (the 'memory' this extension keeps). Smaller is better.">Tokens Stored</span><span class="value" id="st-tokens">0</span>
      <span class="label" title="Total size of the original conversation text before it was compacted.">Original Tokens</span><span class="value" id="st-orig">0</span>
      <span class="label" title="How much conversation space we have freed up for you (original size minus the compact summary we kept).">Tokens Saved</span><span class="value" id="st-saved">0</span>
      <span class="label" title="How many times old context was automatically brought back into the conversation because it was relevant to what you were doing.">Injected</span><span class="value" id="st-injected">0</span>
      <span class="label" title="Of the times we recalled old context, how often it was actually on-topic.">Recall Relevance</span><span class="value" id="st-dedup">0%</span>
      <span class="label" title="How often new content matched something we already had, so we skipped storing a duplicate copy. Higher = less wasted space.">Storage Dedup</span><span class="value" id="st-sdedup">0%</span>
      <span class="label" title="How many duplicate chunks we collapsed into one instead of storing separately.">Collapsed</span><span class="value" id="st-collapsed">0</span>
      <span class="label" title="The ID of the most recent saved checkpoint.">Last ID</span><span class="value" id="st-lastid">—</span>
    </div>
  </div>
  <div class="card">
    <h2>Repo (all sessions)</h2>
    <div class="stat-grid">
      <span class="label">Checkpoints</span><span class="value" id="rp-count">0</span>
      <span class="label">Tokens Stored</span><span class="value" id="rp-tokens">0</span>
      <span class="label">Original Tokens</span><span class="value" id="rp-orig">0</span>
      <span class="label">Tokens Saved</span><span class="value" id="rp-saved">0</span>
      <span class="label">Sessions</span><span class="value" id="rp-sessions">0</span>
      <span class="label">Collapsed</span><span class="value" id="rp-collapsed">0</span>
      <span class="label">Storage Dedup</span><span class="value" id="rp-sdedup">0%</span>
    </div>
  </div>
  <div class="card safe">
    <h2>🛡 Data Safety</h2>
    <div class="stat-grid">
      <span class="label">Regions Retained</span><span class="value" id="ig-retained">0</span>
      <span class="label">Compressed-Original</span><span class="value" id="ig-bytes">0 B</span>
      <span class="label">Dedup Duplicates</span><span class="value" id="ig-dupes">0</span>
      <span class="label">Permanently Deleted</span><span class="value ok" id="ig-deleted">0 B</span>
    </div>
    <p class="safe-note">Every compacted region is kept verbatim (compressed). "Drop" = removed from the live window only. We never delete your data.</p>
  </div>
  <div class="card">
    <h2>Configuration</h2>
    <div class="conf-grid">
      <span class="label">Tier</span><span class="value" id="cf-tier">${tierName}</span>
      <span class="label">Threshold</span><span class="value" id="cf-threshold">—</span>
      <span class="label">Fast Gate</span><span class="value" id="cf-gate">—</span>
      <span class="label">Auto</span><span class="value" id="cf-auto">—</span>
      <span class="label">Anchor</span><span class="value" id="cf-anchor">—</span>
    </div>
  </div>
  <div class="card cost">
    <h2>💰 Model &amp; Cost Savings</h2>
    <div class="cost-usd" id="cost-usd">≈ $0.00 saved</div>
    <div class="cost-sub" id="cost-windows">0 context-windows extended</div>
    <div class="stat-grid" style="margin-top:12px">
      <span class="label" title="The model pi is currently using — its pricing drives the cost figure.">Model</span><span class="value" id="md-name">—</span>
      <span class="label" title="The provider serving the model.">Provider</span><span class="value" id="md-provider">—</span>
      <span class="label" title="USD per input token, from the model's pricing.">Input Rate</span><span class="value" id="md-input">—</span>
      <span class="label" title="USD per output token, from the model's pricing.">Output Rate</span><span class="value" id="md-output">—</span>
    </div>
  </div>
  <div class="card">
    <h2>Crew / Agents</h2>
    <div class="stat-grid">
      <span class="label">Active Agents</span><span class="value" id="cr-agents">0</span>
      <span class="label">Current Turn</span><span class="value" id="cr-turn">0</span>
      <span class="label">Status</span><span class="value" id="cr-status">idle</span>
    </div>
  </div>
  <div class="card legend">
    <h2>What these numbers mean</h2>
    <ul class="legend-list">
      <li><b>Tokens saved</b> — conversation space this extension has freed up for you (it compacted old text into short summaries).</li>
      <li><b>Tokens stored</b> — how much "memory" (compact summaries) the extension is currently holding for this repo.</li>
      <li><b>Injected</b> — times old context was automatically pasted back in because it was relevant to your current task.</li>
      <li><b>Recall relevance</b> — of those, how often the recalled context was actually on-topic.</li>
      <li><b>Storage dedup</b> — how often new content matched something already saved, so a duplicate copy was skipped (saves space).</li>
      <li><b>Data safety</b> — every compacted region is kept verbatim (compressed). Nothing is permanently deleted; you can restore any of it.</li>
    </ul>
    <p class="legend-note">Hover any label above for a quick explanation.</p>
  </div>
</div>

<div class="events">
  <h2>Event Stream</h2>
  <div class="events-wrap" id="events"><div class="empty">connecting…</div></div>
</div>

<h2 style="margin-top:24px;font-size:13px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px">All Repositories</h2>
<table class="repos">
  <thead>
    <tr>
      <th>Repo</th><th>Model</th>
      <th style="text-align:right">Checkpoints</th>
      <th style="text-align:right">Tokens Saved</th>
      <th style="text-align:right">Retained</th>
      <th style="text-align:right">Last Compacted</th>
    </tr>
  </thead>
  <tbody id="cur-rows"><tr><td colspan="6" class="repo-none">loading…</td></tr></tbody>
</table>
<div class="updated" id="cur-updated"></div>

<div class="updated" id="updated"></div>
</div><!-- /panel-current -->

<!-- Per-repo detail modal -->
<div class="repo-detail" id="repo-detail">
  <div class="repo-detail-box">
    <h2><span id="rd-name">Repo</span><button class="repo-close" id="rd-close" title="Close">×</button></h2>
    <div class="repo-path" id="rd-path"></div>
    <div class="stat-grid">
      <span class="label">Model</span><span class="value" id="rd-model">—</span>
      <span class="label">Checkpoints</span><span class="value" id="rd-cp">0</span>
      <span class="label">Tokens Saved</span><span class="value" id="rd-saved">0</span>
      <span class="label">Compressed-Original</span><span class="value" id="rd-bytes">0 B</span>
      <span class="label">Last Compacted</span><span class="value" id="rd-when">—</span>
      <span class="label">Provider</span><span class="value" id="rd-provider">—</span>
    </div>
  </div>
</div>

<!-- All repos (machine-wide registry from index.sqlite) -->
<div class="tab-panel" id="panel-all">
  <table class="repos">
    <thead>
      <tr>
        <th>Repo</th><th>Model</th>
        <th style="text-align:right">Checkpoints</th>
        <th style="text-align:right">Tokens Saved</th>
        <th style="text-align:right">Retained</th>
        <th style="text-align:right">Last Compacted</th>
      </tr>
    </thead>
    <tbody id="all-rows"><tr><td colspan="6" class="repo-none">loading…</td></tr></tbody>
  </table>
  <div class="updated" id="all-updated"></div>
</div>

<!-- Summary (aggregate across all repos) -->
<div class="tab-panel" id="panel-summary">
  <div class="summary-grid">
    <div class="summary-card"><div class="num" id="sm-repos">0</div><div class="lbl">Repositories</div></div>
    <div class="summary-card"><div class="num" id="sm-checkpoints">0</div><div class="lbl">Total Checkpoints</div></div>
    <div class="summary-card"><div class="num" id="sm-saved">0</div><div class="lbl">Total Tokens Saved</div></div>
    <div class="summary-card"><div class="num" id="sm-bytes">0 B</div><div class="lbl">Compressed-Original</div></div>
  </div>
  <div class="updated" id="sm-updated"></div>
</div>

<script>
(function() {
  var evBox = document.getElementById('events');
  var evBuffer = [];
  var MAX_EV = 50;
  var offlineBanner = document.getElementById('offline-banner');

  function bullet(el, on, na) {
    el.className = 'bullet ' + (na ? 'bullet-na' : on ? 'bullet-on' : 'bullet-off');
  }

  function renderSnapshot(d) {
    if (!d || !d.updatedAt) { offlineBanner.style.display = 'block'; return; }
    offlineBanner.style.display = 'none';

    var pct = d.context.percent || 0;
    document.getElementById('ctx-pct').textContent = pct + '%';
    var bar = document.getElementById('ctx-bar');
    bar.style.width = Math.max(pct, 1) + '%';
    bar.className = 'meter-fill ' + (pct >= 90 ? 'meter-red' : pct >= 70 ? 'meter-yellow' : 'meter-green');
    var tok = d.context.tokens != null ? d.context.tokens.toLocaleString() : '?';
    var win = d.context.contextWindow ? d.context.contextWindow.toLocaleString() : '?';
    document.getElementById('ctx-sub').textContent = tok + ' / ' + win + ' tokens';

    bullet(document.getElementById('tr-armed'), d.trigger.armed, false);
    bullet(document.getElementById('tr-ready'), d.trigger.ready, !d.trigger.armed);
    var state = d.trigger.ready ? 'THRESHOLD EXCEEDED — compacting next event' :
                d.trigger.armed ? 'past fast gate — monitoring token count' : 'idle — below fast gate';
    document.getElementById('tr-state').textContent = state;

    document.getElementById('st-count').textContent = d.store.checkpointCount;
    document.getElementById('st-tokens').textContent = d.store.totalTokenEstimate.toLocaleString();
    document.getElementById('st-orig').textContent = (d.store.originalTokens || 0).toLocaleString();
    document.getElementById('st-saved').textContent = (d.store.tokensSaved || 0).toLocaleString();
    document.getElementById('st-injected').textContent = d.store.injectedCount;
    document.getElementById('st-dedup').textContent = Math.round(d.store.dedupHitRate * 100) + '%';
    var sdr = d.store.storageDedupRate || 0;
    document.getElementById('st-sdedup').textContent = (sdr * 100 >= 10 ? Math.round(sdr * 100) : (sdr * 100).toFixed(1)) + '%';
    document.getElementById('st-collapsed').textContent = d.store.dedupCollapsed || 0;
    document.getElementById('st-lastid').textContent = d.session.lastCheckpointId || '—';

    // Repo-wide (all sessions in this repo's SQLite store).
    var repo = d.repo || { checkpointCount: 0, totalTokenEstimate: 0, originalTokens: 0, tokensSaved: 0, sessionCount: 0, dedupCollapsed: 0, storageDedupRate: 0 };
    document.getElementById('rp-count').textContent = repo.checkpointCount;
    document.getElementById('rp-tokens').textContent = repo.totalTokenEstimate.toLocaleString();
    document.getElementById('rp-orig').textContent = (repo.originalTokens || 0).toLocaleString();
    document.getElementById('rp-saved').textContent = (repo.tokensSaved || 0).toLocaleString();
    document.getElementById('rp-sessions').textContent = repo.sessionCount || 0;
    document.getElementById('rp-collapsed').textContent = repo.dedupCollapsed || 0;
    var rsdr = repo.storageDedupRate || 0;
    document.getElementById('rp-sdedup').textContent = (rsdr * 100 >= 10 ? Math.round(rsdr * 100) : (rsdr * 100).toFixed(1)) + '%';

    // Data-safety invariant (Phase 0 — trust foundation).
    var ig = d.integrity || { regionsRetained: 0, compressedOriginalBytes: 0, duplicatesCollapsed: 0, bytesPermanentlyDeleted: 0 };
    function fmtBytes(b) {
      b = b || 0;
      if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MiB';
      if (b >= 1024) return (b / 1024).toFixed(1) + ' KiB';
      return b + ' B';
    }
    document.getElementById('ig-retained').textContent = (ig.regionsRetained || 0).toLocaleString();
    document.getElementById('ig-bytes').textContent = fmtBytes(ig.compressedOriginalBytes);
    document.getElementById('ig-dupes').textContent = (ig.duplicatesCollapsed || 0).toLocaleString();
    document.getElementById('ig-deleted').textContent = fmtBytes(ig.bytesPermanentlyDeleted);

    // Crew / agents (live sub-agent activity + turn).
    var crew = d.crew || { activeAgents: 0, currentTurn: 0 };
    document.getElementById('cr-agents').textContent = crew.activeAgents || 0;
    document.getElementById('cr-turn').textContent = crew.currentTurn || 0;
    document.getElementById('cr-status').textContent = (crew.activeAgents > 0)
      ? ('▶ ' + crew.activeAgents + ' running') : 'idle';

    document.getElementById('cf-tier').textContent = d.tier;
    document.getElementById('cf-threshold').textContent = d.config.thresholdTokens.toLocaleString();
    document.getElementById('cf-gate').textContent = d.config.fastGatePct + '%';
    document.getElementById('cf-auto').textContent = d.config.auto ? 'enabled' : 'disabled';
    document.getElementById('cf-anchor').textContent = d.config.anchorUserMessages;

    // --- Active model + cost savings (same calc as /mega-status) ---------------
    var model = d.model;
    document.getElementById('hdr-model').textContent = model && model.name ? model.name : '—';
    document.getElementById('md-name').textContent = model && model.name ? model.name : '—';
    document.getElementById('md-provider').textContent = model && model.providerName ? model.providerName : (model && model.provider ? model.provider : '—');
    document.getElementById('md-input').textContent = model && model.inputRate ? '$' + (model.inputRate).toFixed(6) : '—';
    document.getElementById('md-output').textContent = model && model.outputRate ? '$' + (model.outputRate).toFixed(6) : '—';
    if (model && model.inputRate && repo.tokensSaved > 0) {
      var usd = (repo.tokensSaved * model.inputRate);
      var win = d.context.contextWindow || 0;
      var windows = win > 0 ? (repo.tokensSaved / win).toFixed(1) : '0';
      document.getElementById('cost-usd').textContent = '≈ $' + usd.toFixed(4) + ' saved';
      document.getElementById('cost-windows').textContent = windows + ' context-windows extended';
    } else {
      document.getElementById('cost-usd').textContent = '≈ $0.00 saved';
      document.getElementById('cost-windows').textContent = '0 context-windows extended';
    }

    document.getElementById('updated').textContent = 'Updated ' + new Date(d.updatedAt).toLocaleTimeString();
  }

  function sanitize(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function renderEvent(ev) {
    evBuffer.unshift(ev);
    if (evBuffer.length > MAX_EV) evBuffer.length = MAX_EV;
    evBox.innerHTML = evBuffer.map(function(e) {
      var t = e.ts ? new Date(e.ts).toLocaleTimeString() : '';
      var detail = '';
      if (e.data) {
        if (e.data.checkpointId) detail = sanitize(e.data.checkpointId);
        else if (e.data.query) detail = sanitize(e.data.query.slice(0, 80));
        if (e.data.tokenEstimate != null) detail += '  ' + e.data.tokenEstimate + ' tok';
        if (e.data.deduped) detail += '  (deduped)';
        if (e.data.injected != null) detail = 'injected: ' + e.data.injected + (e.data.empty ? ' (empty)' : '');
      }
      return '<div class="ev">' +
        '<span class="ev-time">' + t + '</span>' +
        '<span class="ev-type ev-type-' + sanitize(e.type) + '">' + sanitize(e.type) + '</span>' +
        '<span class="ev-detail">' + detail + '</span></div>';
    }).join('');
  }

  // Poll snapshot every 2s
  function pollSnapshot() {
    fetch('/api/snapshot').then(function(r) { return r.json(); }).then(renderSnapshot).catch(function() {});
  }
  pollSnapshot();
  setInterval(pollSnapshot, 2000);

  // SSE for events
  function connectSSE() {
    var es = new EventSource('/api/events');
    es.onmessage = function(msg) {
      try { renderEvent(JSON.parse(msg.data)); } catch(e) {}
    };
    es.onerror = function() {
      es.close();
      setTimeout(connectSSE, 3000);
    };
  }
  connectSSE();

  // --- Multi-repo (index.sqlite via /api/index) ---------------------------
  function fmtBytesTop(b) {
    b = b || 0;
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MiB';
    if (b >= 1024) return (b / 1024).toFixed(1) + ' KiB';
    return b + ' B';
  }
  function renderIndex(d) {
    d = d || { updatedAt: null, summary: null, repos: [] };
    var repos = d.repos || [];
    var s = d.summary || { totalRepos: 0, totalCheckpoints: 0, totalTokensSaved: 0, totalCompressedOriginalBytes: 0 };
    document.getElementById('sm-repos').textContent = (s.totalRepos || 0).toLocaleString();
    document.getElementById('sm-checkpoints').textContent = (s.totalCheckpoints || 0).toLocaleString();
    document.getElementById('sm-saved').textContent = (s.totalTokensSaved || 0).toLocaleString();
    document.getElementById('sm-bytes').textContent = fmtBytesTop(s.totalCompressedOriginalBytes);

    // Shared clickable-row renderer for both the in-current table and the
    // All-repos tab — each row opens the per-repo detail modal.
    function rowsHtml() {
      if (!repos.length) return '<tr><td colspan="6" class="repo-none">No repositories registered yet.</td></tr>';
      return repos.map(function(r) {
        var model = r.modelName
          ? '<span class="repo-model">' + sanitize(r.modelName) + '</span>'
          : '<span class="repo-none">—</span>';
        var when = r.lastCompactedAt ? new Date(r.lastCompactedAt).toLocaleString() : '—';
        return '<tr class="repo-link" data-repo="' + sanitize(r.repoRoot) + '">' +
          '<td title="' + sanitize(r.repoRoot) + '">' + sanitize(r.displayName || r.repoRoot) + '</td>' +
          '<td>' + model + '</td>' +
          '<td class="num">' + (r.checkpointCount || 0).toLocaleString() + '</td>' +
          '<td class="num">' + (r.tokensSaved || 0).toLocaleString() + '</td>' +
          '<td class="num">' + fmtBytesTop(r.compressedOriginalBytes) + '</td>' +
          '<td class="num">' + sanitize(when) + '</td>' +
        '</tr>';
      }).join('');
    }
    document.getElementById('cur-rows').innerHTML = rowsHtml();
    document.getElementById('all-rows').innerHTML = rowsHtml();
    bindRepoRows();

    var stamp = d.updatedAt ? 'Updated ' + new Date(d.updatedAt).toLocaleTimeString() : '';
    document.getElementById('cur-updated').textContent = stamp;
    document.getElementById('all-updated').textContent = stamp;
    document.getElementById('sm-updated').textContent = stamp;
  }

  // Per-repo detail modal ---------------------------------------------------
  var detailEl = document.getElementById('repo-detail');
  var indexCache = { repos: [] };
  function openRepoDetail(root) {
    var r = null;
    for (var i = 0; i < indexCache.repos.length; i++) {
      if (indexCache.repos[i].repoRoot === root) { r = indexCache.repos[i]; break; }
    }
    if (!r) return;
    document.getElementById('rd-name').textContent = r.displayName || r.repoRoot;
    document.getElementById('rd-path').textContent = r.repoRoot;
    document.getElementById('rd-model').textContent = r.modelName || '—';
    document.getElementById('rd-provider').textContent = r.providerName || (r.provider || '—');
    document.getElementById('rd-cp').textContent = (r.checkpointCount || 0).toLocaleString();
    document.getElementById('rd-saved').textContent = (r.tokensSaved || 0).toLocaleString();
    document.getElementById('rd-bytes').textContent = fmtBytesTop(r.compressedOriginalBytes);
    document.getElementById('rd-when').textContent = r.lastCompactedAt ? new Date(r.lastCompactedAt).toLocaleString() : '—';
    detailEl.classList.add('open');
  }
  document.getElementById('rd-close').addEventListener('click', function() { detailEl.classList.remove('open'); });
  detailEl.addEventListener('click', function(e) { if (e.target === detailEl) detailEl.classList.remove('open'); });
  function bindRepoRows() {
    var rows = document.querySelectorAll('.repo-link');
    for (var i = 0; i < rows.length; i++) {
      rows[i].addEventListener('click', function() { openRepoDetail(this.getAttribute('data-repo')); });
    }
  }
  function pollIndex() {
    fetch('/api/index').then(function(r) { return r.json(); }).then(function(d) {
      indexCache = d && d.repos ? d : indexCache;
      renderIndex(d);
    }).catch(function() {});
  }
  pollIndex();
  setInterval(pollIndex, 5000);

  // --- Tab switching ------------------------------------------------------
  var tabs = document.querySelectorAll('.tab');
  var panels = { current: 'panel-current', all: 'panel-all', summary: 'panel-summary' };
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].addEventListener('click', function() {
      var name = this.getAttribute('data-tab');
      for (var j = 0; j < tabs.length; j++) tabs[j].classList.remove('active');
      this.classList.add('active');
      for (var k in panels) {
        if (Object.prototype.hasOwnProperty.call(panels, k)) {
          var el = document.getElementById(panels[k]);
          if (el) el.classList.toggle('active', k === name);
        }
      }
      if (name === 'all' || name === 'summary') pollIndex();
    });
  }
})();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export async function launchDashboardServer(stateDir: string): Promise<{ port: number; url: string }> {
  // Our own package version — exposed at /api/version so the launcher can
  // detect a stale server (started by an older build) and replace it on
  // upgrade instead of reuse it.
  let SERVER_VERSION = "0.0.0";
  try {
    // dashboard-server.js lives at <pkg>/dist/extensions/, so package.json is
    // two levels up. Guard each candidate so a dev-checkout layout still works.
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [join(here, "..", "..", "package.json"), join(here, "..", "package.json")];
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      const pkg = JSON.parse(readFileSync(p, "utf-8"));
      if (pkg.version) { SERVER_VERSION = pkg.version; break; }
    }
  } catch { /* non-fatal */ }

  // Lazy-loaded via require so the dashboard stays cheap to boot and we don't
  // need a top-level await in the handler.
  const driftReq = createRequire(import.meta.url);
  const detectCrossRepoDrift = (idxDir: string) =>
    (driftReq("../src/driftDetection.js") as typeof import("../src/driftDetection.js"))
      .detectCrossRepoDrift(idxDir);
  const portFile = join(stateDir, "port.pid");
  const snapshotPath = join(stateDir, "dashboard.json");
  const eventsPath = join(stateDir, "events.log");
  LOG_PATH = join(stateDir, "dashboard.log");
  log("launch invoked", { stateDir });

  // ── Existing server? ───────────────────────────────────────────────────────
  // A stale port.pid pointing at a dead/competing process is the classic cause
  // of "dashboard failed to start" — we return a port that is NOT actually
  // serving. Probe for a live server on that port first; only reuse the marker
  // when something real answers /api/version. Otherwise drop it and start fresh.
  if (existsSync(portFile)) {
    try {
      const info = JSON.parse(readFileSync(portFile, "utf-8"));
      if (info && info.port) {
        let live = false;
        try {
          const probe = await fetch(`http://localhost:${info.port}/api/version`, { signal: AbortSignal.timeout(800) });
          live = probe.ok;
        } catch {
          live = false;
        }
        if (live) {
          log("reusing live server from port.pid", { port: info.port });
          return { port: info.port, url: `http://localhost:${info.port}` };
        }
        log("port.pid present but no live server — treating as stale", { port: info.port });
      }
    } catch {
      log("port.pid unparseable — treating as stale");
    }
    // stale file, remove so the fresh bind does not collide with a lingering
    // process that still holds the port
    try { unlinkSync(portFile); } catch { /* ignore */ }
  }

  // ── New server ────────────────────────────────────────────────────────────
  mkdirSync(stateDir, { recursive: true });

  let eventOffset = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // CORS for local access
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === "/" || req.url === "/index.html") {
      const tier = readSnapshot(snapshotPath).tier;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(dashboardHtml(tier));
      return;
    }

    if (req.url === "/api/snapshot") {
      const snap = readSnapshot(snapshotPath);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(snap));
      return;
    }

    // Server version — lets the /dashboard launcher detect a stale server from
    // an older build and replace it on upgrade rather than reuse it.
    if (req.url === "/api/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ version: SERVER_VERSION }));
      return;
    }

    // Multi-repo aggregate (Phase 5b): the machine-wide repo registry read
    // directly from SQLite (index.sqlite). Lets one dashboard show every repo's
    // checkpoints, tokens saved, and active model. Read-only.
    if (req.url === "/api/index") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(readIndex() ?? { updatedAt: null, summary: null, repos: [] }));
      return;
    }

    // /api/repos — registry list. Optional `?active=24h` filters to repos
    // seen within the last N hours (default: all). The dashboard uses this to
    // drive its "active vs archived" badge without refetching /api/index.
    if (req.url?.startsWith("/api/repos")) {
      const url = new URL(req.url, "http://x");
      const activeParam = url.searchParams.get("active");
      const idx = readIndex() ?? { updatedAt: null, summary: null, repos: [] };
      let repos = (idx.repos ?? []) as IndexRepo[];
      if (activeParam) {
        const m = /^(\d+)h$/.exec(activeParam);
        if (m) {
          const cutoffSec = Math.floor(Date.now() / 1000) - Number(m[1]) * 3600;
          repos = repos.filter((r) => (r.lastSeen ?? 0) >= cutoffSec);
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ updatedAt: idx.updatedAt, repos, count: repos.length }));
      return;
    }

    // /api/summary — header tiles without the full repo list (keeps payload
    // small for embed scenarios). activeRepos mirrors the /api/repos?active=24h
    // count so the dashboard can render the active badge alongside totals.
    if (req.url?.startsWith("/api/summary")) {
      const idx = readIndex() ?? { updatedAt: null, summary: null, repos: [] };
      const repos = (idx.repos ?? []) as IndexRepo[];
      const cutoffSec = Math.floor(Date.now() / 1000) - 24 * 3600;
      const activeRepos = repos.filter((r) => (r.lastSeen ?? 0) >= cutoffSec).length;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        updatedAt: idx.updatedAt,
        summary: idx.summary,
        activeRepos,
        totalRepos: repos.length,
      }));
      return;
    }

    // /api/drift — R4: cross-repo drift report over repo_registry. Flags stale
    // repos (>30d idle), compaction lag (active but >24h since last
    // compaction), and recent model churn. Read-only.
    if (req.url?.startsWith("/api/drift")) {
      const report = detectCrossRepoDrift(getIndexDir());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(report));
      return;
    }

    if (req.url === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });

      // Drain existing events so the client starts with history
      const { data: existing, offset: initialOffset } = readFrom(eventsPath, 0);
      eventOffset = initialOffset;
      const lines = existing.split("\n").filter((l: string) => l.trim());
      for (const line of lines) {
        res.write(`data: ${line}\n\n`);
      }

      // Tail new events via fs.watch (coalesced with 100ms debounce)
      let watchTimer: ReturnType<typeof setTimeout> | null = null;
      const onWatch = () => {
        if (watchTimer) return;
        watchTimer = setTimeout(() => {
          watchTimer = null;
          const { data, offset } = readFrom(eventsPath, eventOffset);
          eventOffset = offset;
          const newLines = data.split("\n").filter((l: string) => l.trim());
          for (const line of newLines) {
            res.write(`data: ${line}\n\n`);
          }
        }, 100);
      };

      // Set up file watching: if file exists, watch it directly;
      // otherwise poll for creation every 1s then switch to fs.watch.
      let watcher: ReturnType<typeof watch> | null = null;
      let pollInterval: ReturnType<typeof setInterval> | null = null;

      function startFileWatch(): void {
        try {
          watcher = watch(eventsPath, onWatch);
        } catch { /* give up */ }
      }

      if (existsSync(eventsPath)) {
        startFileWatch();
      } else {
        pollInterval = setInterval(() => {
          if (existsSync(eventsPath)) {
            if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
            startFileWatch();
          }
        }, 1000);
      }

      req.on("close", () => {
        if (watchTimer) clearTimeout(watchTimer);
        if (pollInterval) clearInterval(pollInterval);
        watcher?.close();
      });
      return;
    }

    // Fallback — serve the dashboard
    const tier = readSnapshot(snapshotPath).tier;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(dashboardHtml(tier));
  });

  // Bind base + range are env-configurable so tests can use a private,
  // non-colliding range (parallel runs / leftover servers from killed runs
  // would otherwise EADDRINUSE on the machine-global 9320 range). Default
  // MEGACOMPACT_DASHBOARD_PORT=9320 (10-port range 9320–9329) preserves the
  // production behavior.
  const TARGET_PORT = Number(process.env.MEGACOMPACT_DASHBOARD_PORT ?? "9320");
  const PORT_RANGE = 10; // TARGET_PORT..TARGET_PORT+9

  return new Promise((resolve, reject) => {
    function tryPort(port: number) {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && port < TARGET_PORT + PORT_RANGE - 1) {
          log("port in use, trying next", { port });
          tryPort(port + 1);
        } else {
          log("listen failed", { port, code: err.code, message: err.message });
          reject(err);
        }
      });

      server.listen(port, "127.0.0.1", () => {
        const url = `http://localhost:${port}`;
        log("server running", { url });
        // eslint-disable-next-line no-console
        console.log(`[mega-compact] dashboard server running: ${url}`);

        // Write port.pid
        try {
          writeFileSync(portFile, JSON.stringify({ port, pid: process.pid }));
        } catch (e) {
          log("could not write port.pid", { error: String(e) });
        }

        // Graceful cleanup
        const cleanup = () => {
          try { unlinkSync(portFile); } catch { /* already gone */ }
          server.close();
          process.exit(0);
        };
        process.on("SIGTERM", cleanup);
        process.on("SIGINT", cleanup);

        resolve({ port, url });
      });
    }

    tryPort(TARGET_PORT);
  });
}

// ---------------------------------------------------------------------------
// CLI entry point — when run directly as `node dashboard-server.js <stateDir>`
// ---------------------------------------------------------------------------

if (process.argv[1] && process.argv[1].includes("dashboard-server")) {
  const stateDir = process.argv[2];
  if (!stateDir) {
    console.error("Usage: node dashboard-server.js <stateDir>");
    process.exit(1);
  }
  launchDashboardServer(stateDir).catch((err) => {
    console.error("[mega-compact] dashboard server failed:", err);
    process.exit(1);
  });
}
