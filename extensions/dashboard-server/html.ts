/**
 * dashboard-server/html.ts — single-page HTML dashboard template.
 */

import { dashboardServerVersion } from "./state.js";

export function dashboardHtml(tierName: string): string {
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
  h1 .version-pill { background: #30363d; color: #8b949e; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
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

<h1><span>mega-compact</span><span class="tier" id="hdr-tier">${tierName}</span><span class="version-pill">v${dashboardServerVersion}</span><span class="model-pill" id="hdr-model">—</span></h1>

<nav class="tabs">
  <button class="tab active" data-tab="current">Current repo</button>
  <button class="tab" data-tab="all">All repos</button>
  <button class="tab" data-tab="active">Active Repos</button>
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
      <span class="label" title="Total size of the original conversation text dropped into compaction this session, including redundant regions skipped by dedup. This is the 'in'.">Original (dropped)</span><span class="value" id="st-in">0</span>
      <span class="label" title="Compact summaries we are currently holding as 'memory' for this session (the 'out'). Smaller is better.">Kept (summaries)</span><span class="value" id="st-kept">0</span>
      <span class="label" title="Conversation space freed = dropped − kept (the 'saved').">Freed (dropped − kept)</span><span class="value" id="st-freed">0</span>
      <span class="label" title="How many times old context was automatically brought back into the conversation because it was relevant to what you were doing.">Injected</span><span class="value" id="st-injected">0</span>
      <span class="label" title="Of the times we recalled old context, how often it was actually on-topic.">Recall Relevance</span><span class="value" id="st-dedup">0%</span>
      <span class="label" title="How often new content matched something we already had, so we skipped storing a duplicate copy. Higher = less wasted space.">Storage Dedup</span><span class="value" id="st-sdedup">0%</span>
      <span class="label" title="How many duplicate chunks we collapsed into one instead of storing separately.">Collapsed</span><span class="value" id="st-collapsed">0</span>
      <span class="label" title="The ID of the most recent saved checkpoint.">Last ID</span><span class="value" id="st-lastid">—</span>
    </div>
    <div class="meter-track" style="margin-top:10px"><div class="meter-fill" id="st-compress-bar" style="width:0%"></div></div>
    <div class="meter-sub" id="st-compress-sub">waiting for compaction…</div>
  </div>
  <div class="card">
    <h2>Repo (all sessions)</h2>
    <div class="stat-grid">
      <span class="label">Checkpoints</span><span class="value" id="rp-count">0</span>
      <span class="label">Original (dropped)</span><span class="value" id="rp-in">0</span>
      <span class="label">Kept (summaries)</span><span class="value" id="rp-kept">0</span>
      <span class="label">Freed (dropped − kept)</span><span class="value" id="rp-freed">0</span>
      <span class="label">Sessions</span><span class="value" id="rp-sessions">0</span>
      <span class="label">Collapsed</span><span class="value" id="rp-collapsed">0</span>
      <span class="label">Storage Dedup</span><span class="value" id="rp-sdedup">0%</span>
    </div>
    <div class="meter-track" style="margin-top:10px"><div class="meter-fill" id="rp-compress-bar" style="width:0%"></div></div>
    <div class="meter-sub" id="rp-compress-sub">waiting for compaction…</div>
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
      <span class="label" title="Live pressure band — climbs low→mega as context fills the window.">Tier (live)</span><span class="value" id="cf-tier">${tierName}</span>
      <span class="label" title="The env-resolved base compaction preset (low/medium/high/ultra/mega) that set the token threshold.">Preset</span><span class="value" id="cf-preset">—</span>
      <span class="label" title="Live pressure = currentTokens / threshold — % of the model context window (threshold fires at the tier's % of window).">Pressure</span><span class="value" id="cf-pressure">—</span>
      <span class="label" title="Compaction threshold = tierPct × model context window — mega-compact trims BELOW pi's native ~80% auto-compact for any model size.">Threshold</span><span class="value" id="cf-threshold">—</span>
      <span class="label" title="Fast-gate arming floor — the live trim arms once context passes this % of the window.">Fast Gate</span><span class="value" id="cf-gate">—</span>
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
      <li><b>Original (dropped)</b> — everything compacted away (including duplicates caught by dedup). The "in."</li>
      <li><b>Kept (summaries)</b> — compact summaries still held as "memory" (the "out").</li>
      <li><b>Freed</b> = dropped − kept — tokens saved so far (higher = better).</li>
      <li><b>Compression %</b> — Freed ÷ Dropped — the headline efficiency number. Higher = more space reclaimed.</li>
      <li><b>Storage dedup %</b> — how often new content matched something already saved, so no duplicate copy was written.</li>
      <li><b>Data safety</b> — every compacted region is kept verbatim (compressed). Nothing is permanently deleted; you can restore any of it.</li>
    </ul>
    <p class="legend-note">Hover any label above for a quick explanation.</p>
  </div>
  <div class="card">
    <h2>💾 Cache Hits &amp; Compactions</h2>
    <div class="stat-grid">
      <span class="label">Cache Hits (session)</span><span class="value" id="ch-session">0</span>
      <span class="label">Cache Hits (total)</span><span class="value" id="ch-total">0</span>
      <span class="label">Tokens Saved (session)</span><span class="value" id="ch-tok-session">0</span>
      <span class="label">Tokens Saved (total)</span><span class="value" id="ch-tok-total">0</span>
      <span class="label">Compactions (session)</span><span class="value" id="cp-session">0</span>
      <span class="label">Compactions (total)</span><span class="value" id="cp-total">0</span>
    </div>
  </div>
  <div class="card">
    <h2>⏱ Time Saved (est.)</h2>
    <div class="stat-grid">
      <span class="label">Compact (session)</span><span class="value" id="ts-compact-session">0</span>
      <span class="label">Compact (total)</span><span class="value" id="ts-compact-total">0</span>
      <span class="label">Cache Hit (session)</span><span class="value" id="ts-cache-session">0</span>
      <span class="label">Cache Hit (total)</span><span class="value" id="ts-cache-total">0</span>
    </div>
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

<!-- Active repos (live cache-hit / compaction stats across machines) -->
<div class="tab-panel" id="panel-active">
  <div class="card">
    <h2>Active Repos — Live Cache Hits &amp; Compactions</h2>
    <p class="legend-note">Repos seen within the last 30 minutes, with their per-repo cache-hit, compaction, and time-saved (est.) totals pulled live from each repo's dashboard.json.</p>
    <table class="repos">
      <thead>
        <tr>
          <th>Repo</th><th>Model</th><th>Tier</th>
          <th style="text-align:right">Context %</th><th>State</th>
          <th style="text-align:right">Compactions (s/t)</th>
          <th style="text-align:right">Cache Hits (s/t)</th>
          <th style="text-align:right">Compact s/t (s)</th>
          <th style="text-align:right">CacheHit s/t (s)</th>
        </tr>
      </thead>
      <tbody id="active-rows"><tr><td colspan="9" class="repo-none">loading…</td></tr></tbody>
    </table>
    <div class="updated" id="active-updated"></div>
  </div>
</div>

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

  <h2 style="margin-top:24px;font-size:13px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px">Savings by Model</h2>
  <p class="legend-note" style="margin-bottom:10px">How much context &amp; cost mega-compact has reclaimed, grouped by the model you were running. Compression ratio reflects workload/content, not model quality.</p>
  <table class="repos">
    <thead>
      <tr>
        <th>Model</th><th>Provider</th>
        <th style="text-align:right" title="Tokens dropped from context by compaction (the input reclaimed)">Tokens In</th>
        <th style="text-align:right" title="Tokens kept as compacted summaries still in context (the output retained)">Tokens Out</th>
        <th style="text-align:right">Freed</th>
        <th style="text-align:right" title="Model context window (max input tokens the model accepts)">Ctx Window</th>
        <th style="text-align:right" title="Model max output tokens per turn">Max Out</th>
        <th style="text-align:right" title="Reasoning-capable model">Reas.</th>
        <th style="text-align:right" title="Distinct sessions with at least one checkpoint">Sessions</th>
        <th style="text-align:right">Checkpoints</th>
        <th style="text-align:right" title="USD per input token">In $/tok</th>
        <th style="text-align:right" title="USD per output token">Out $/tok</th>
        <th style="text-align:right">$ Saved</th>
        <th style="text-align:right">Last Used</th>
      </tr>
    </thead>
    <tbody id="bm-rows"><tr><td colspan="14" class="repo-none">loading…</td></tr></tbody>
  </table>
  <p class="legend-note" style="margin-top:8px">Tokens In = Σ original region tokens dropped by compaction. Tokens Out = Σ compacted summary tokens still retained in context. Freed = Tokens In − Tokens Out (net context reclaimed). Ctx Window / Max Out / Reas. come from the latest captured model snapshot for each repo.</p>

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

    // ---- Vector Store — reconciled token accounting (same formula as widget) -
    document.getElementById('st-count').textContent = d.store.checkpointCount;
    // Compression block from the snapshot (Freed = In − Out, single formula).
    var c = d.compression || {};
    var sess = c.session || { tokensIn:0, tokensOut:0, tokensFreed:0, compressionPct:0, dedupPct:0 };
    var cRepo = c.repo || { tokensIn:0, tokensOut:0, tokensFreed:0, compressionPct:0, dedupPct:0 };
    document.getElementById('st-in').textContent = sess.tokensIn.toLocaleString();
    document.getElementById('st-kept').textContent = sess.tokensOut.toLocaleString();
    document.getElementById('st-freed').textContent = sess.tokensFreed.toLocaleString();
    var sp = sess.compressionPct || 0;
    document.getElementById('st-compress-bar').style.width = Math.max(sp * 100, 0.5) + '%';
    document.getElementById('st-compress-bar').className = 'meter-fill ' + (sp >= 0.9 ? 'meter-green' : sp >= 0.6 ? 'meter-yellow' : 'meter-red');
    document.getElementById('st-compress-sub').textContent = (sp * 100 >= 10 ? Math.round(sp * 100) : (sp * 100).toFixed(1)) + '% tokens saved · dedup: ' + (sess.dedupPct * 100 >= 10 ? Math.round(sess.dedupPct * 100) : (sess.dedupPct * 100).toFixed(1)) + '%';
    // ------
    document.getElementById('st-injected').textContent = d.store.injectedCount;
    document.getElementById('st-dedup').textContent = Math.round(d.store.dedupHitRate * 100) + '%';
    var sdr = d.store.storageDedupRate || 0;
    document.getElementById('st-sdedup').textContent = (sdr * 100 >= 10 ? Math.round(sdr * 100) : (sdr * 100).toFixed(1)) + '%';
    document.getElementById('st-collapsed').textContent = d.store.dedupCollapsed || 0;
    document.getElementById('st-lastid').textContent = d.session.lastCheckpointId || '—';

    // ---- Repo (all sessions) — same compression fields, repo scope ----------
    document.getElementById('rp-count').textContent = (d.repo && d.repo.checkpointCount || 0).toLocaleString();
    document.getElementById('rp-in').textContent = cRepo.tokensIn.toLocaleString();
    document.getElementById('rp-kept').textContent = cRepo.tokensOut.toLocaleString();
    document.getElementById('rp-freed').textContent = cRepo.tokensFreed.toLocaleString();
    document.getElementById('rp-sessions').textContent = (d.repo && d.repo.sessionCount || 0).toLocaleString();
    document.getElementById('rp-collapsed').textContent = (d.repo && d.repo.dedupCollapsed || 0).toLocaleString();
    var rdr = d.repo && d.repo.storageDedupRate || 0;
    document.getElementById('rp-sdedup').textContent = (rdr * 100 >= 10 ? Math.round(rdr * 100) : (rdr * 100).toFixed(1)) + '%';
    var rp = cRepo.compressionPct || 0;
    document.getElementById('rp-compress-bar').style.width = Math.max(rp * 100, 0.5) + '%';
    document.getElementById('rp-compress-bar').className = 'meter-fill ' + (rp >= 0.9 ? 'meter-green' : rp >= 0.6 ? 'meter-yellow' : 'meter-red');
    document.getElementById('rp-compress-sub').textContent = (rp * 100 >= 10 ? Math.round(rp * 100) : (rp * 100).toFixed(1)) + '% tokens saved · dedup: ' + (cRepo.dedupPct * 100 >= 10 ? Math.round(cRepo.dedupPct * 100) : (cRepo.dedupPct * 100).toFixed(1)) + '%';

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

    // S24: headline tier is the LIVE pressure band; the config card shows the
    // env preset + live pressure ratio so the user sees the system react.
    document.getElementById('hdr-tier').textContent = d.tier;
    document.getElementById('cf-tier').textContent = d.tier + ' (live)';
    document.getElementById('cf-preset').textContent = d.presetTier;
    document.getElementById('cf-pressure').textContent = Math.round((d.pressure || 0) * 100) + '%';
    // (b) Threshold: show the effective token threshold AND the % of the model
    // context window it represents (percentage-based tiers). d.config.tierPct
    // is present on the live snapshot written by the runtime (Phase-1/2a).
    var cfgPct = d.config.tierPct;
    var cw = d.context.contextWindow || 0;
    var thresholdTxt = d.config.thresholdTokens.toLocaleString();
    if (cfgPct != null && cw > 0) {
      thresholdTxt += ' (' + Math.round(cfgPct * 100) + '% of ' + cw.toLocaleString() + ')';
    }
    document.getElementById('cf-threshold').textContent = thresholdTxt;
    // (c) Fast Gate: arming floor — live trim arms once context passes this %.
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
    var repoSaved = cRepo.tokensFreed || 0;
    if (model && model.inputRate && repoSaved > 0) {
      var usd = (repoSaved * model.inputRate);
      var win = d.context.contextWindow || 0;
      var windows = win > 0 ? (repoSaved / win).toFixed(1) : '0';
      document.getElementById('cost-usd').textContent = '≈ $' + usd.toFixed(4) + ' saved';
      document.getElementById('cost-windows').textContent = windows + ' context-windows extended';
    } else {
      document.getElementById('cost-usd').textContent = '≈ $0.00 saved';
      document.getElementById('cost-windows').textContent = '0 context-windows extended';
    }

    // --- Cache hits & compactions (live counters) ---------------------------
    var ch = d.cacheHits || { session: 0, total: 0, sessionTokensSaved: 0, totalTokensSaved: 0 };
    var cp = d.compacts || { session: 0, total: 0 };
    var ts = d.timeSaved || { compact: { sessionSec: 0, totalSec: 0 }, cacheHit: { sessionSec: 0, totalSec: 0 } };
    document.getElementById('ch-session').textContent = (ch.session || 0).toLocaleString();
    document.getElementById('ch-total').textContent = (ch.total || 0).toLocaleString();
    document.getElementById('ch-tok-session').textContent = (ch.sessionTokensSaved || 0).toLocaleString();
    document.getElementById('ch-tok-total').textContent = (ch.totalTokensSaved || 0).toLocaleString();
    document.getElementById('cp-session').textContent = (cp.session || 0).toLocaleString();
    document.getElementById('cp-total').textContent = (cp.total || 0).toLocaleString();
    document.getElementById('ts-compact-session').textContent = fmtSec(ts.compact.sessionSec);
    document.getElementById('ts-compact-total').textContent = fmtSec(ts.compact.totalSec);
    document.getElementById('ts-cache-session').textContent = fmtSec(ts.cacheHit.sessionSec);
    document.getElementById('ts-cache-total').textContent = fmtSec(ts.cacheHit.totalSec);

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
    fetch('/api/snapshot').then(function(r) { return r.json(); }).then(renderSnapshot).catch(function() {}); // guardrails-allow PREVENT-PI-004: browser-side fetch in dashboard HTML template (not Node runtime)
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
    renderByModel(repos);
  }

  // Savings-by-model aggregation for the Summary tab — groups the machine-
  // wide repo registry by (modelName || '(unknown)') so the user can see how
  // much context + cost mega-compact has reclaimed, broken down by which model
  // they were running. $ Saved = Σ(tokensSaved × inputRate) per model. Sorted
  // by tokens saved descending so the biggest-reclaim model wins the top row.
  function renderByModel(repos) {
    var rows = document.getElementById('bm-rows');
    if (!rows) return;
    if (!repos || !repos.length) {
      rows.innerHTML = '<tr><td colspan="14" class="repo-none">No repositories registered yet.</td></tr>';
      return;
    }
    var groups = {};
    for (var i = 0; i < repos.length; i++) {
      var r = repos[i];
      var key = (r.modelName && String(r.modelName).trim()) || '(unknown)';
      if (!groups[key]) groups[key] = {
        model: key, provider: r.providerName || r.provider || '—', repos: 0, checkpoints: 0,
        tokensSaved: 0, tokensIn: 0, tokensOut: 0, sessions: 0, usd: 0, lastAt: 0,
        inRates: [], outRates: [], ctxWindows: [], maxTokens: [], reasoning: null,
      };
      var g = groups[key];
      g.repos++;
      g.checkpoints += (r.checkpointCount || 0);
      g.tokensSaved += (r.tokensSaved || 0);
      g.tokensIn += (r.tokensDropped || 0);
      g.tokensOut += (r.tokensKept || 0);
      g.sessions += (r.sessions || 0);
      if (r.inputRate) { g.usd += (r.tokensSaved || 0) * r.inputRate; g.inRates.push(r.inputRate); }
      if (r.outputRate) g.outRates.push(r.outputRate);
      if (r.contextWindow) g.ctxWindows.push(r.contextWindow);
      if (r.maxTokens) g.maxTokens.push(r.maxTokens);
      if (r.reasoning != null) g.reasoning = r.reasoning;
      if (r.lastCompactedAt && r.lastCompactedAt > g.lastAt) g.lastAt = r.lastCompactedAt;
    }
    var arr = [];
    for (var k in groups) { if (Object.prototype.hasOwnProperty.call(groups, k)) arr.push(groups[k]); }
    arr.sort(function(a, b) { return b.tokensSaved - a.tokensSaved; });
    // Helper: a set of numeric samples collapses to a single value when all
    // repos in the group agree, otherwise shows the range (min–max) so the
    // user can see mixed-config model groups at a glance.
    function collapseNum(samples) {
      if (!samples || !samples.length) return '—';
      var lo = Math.min.apply(null, samples), hi = Math.max.apply(null, samples);
      return lo === hi ? lo.toLocaleString() : lo.toLocaleString() + '–' + hi.toLocaleString();
    }
    function collapseRate(samples) {
      if (!samples || !samples.length) return '—';
      var lo = Math.min.apply(null, samples), hi = Math.max.apply(null, samples);
      var fmt = function(v) { return '$' + v.toFixed(6); };
      return lo === hi ? fmt(lo) : fmt(lo) + '–' + fmt(hi);
    }
    rows.innerHTML = arr.map(function(g) {
      var freed = (g.tokensIn || 0) - (g.tokensOut || 0);
      var usd = g.usd > 0 ? '$' + g.usd.toFixed(4) : '—';
      var when = g.lastAt ? new Date(g.lastAt).toLocaleString() : '—';
      var reas = g.reasoning == null ? '—' : (g.reasoning ? 'yes' : 'no');
      return '<tr>' +
        '<td><span class="repo-model">' + sanitize(g.model) + '</span></td>' +
        '<td>' + sanitize(g.provider) + '</td>' +
        '<td class="num">' + (g.tokensIn || 0).toLocaleString() + '</td>' +
        '<td class="num">' + (g.tokensOut || 0).toLocaleString() + '</td>' +
        '<td class="num">' + freed.toLocaleString() + '</td>' +
        '<td class="num">' + collapseNum(g.ctxWindows) + '</td>' +
        '<td class="num">' + collapseNum(g.maxTokens) + '</td>' +
        '<td class="num">' + reas + '</td>' +
        '<td class="num">' + g.sessions.toLocaleString() + '</td>' +
        '<td class="num">' + g.checkpoints.toLocaleString() + '</td>' +
        '<td class="num">' + collapseRate(g.inRates) + '</td>' +
        '<td class="num">' + collapseRate(g.outRates) + '</td>' +
        '<td class="num">' + sanitize(usd) + '</td>' +
        '<td class="num">' + sanitize(when) + '</td>' +
      '</tr>';
    }).join('');
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
    fetch('/api/index').then(function(r) { return r.json(); }).then(function(d) { // guardrails-allow PREVENT-PI-004: browser-side fetch in dashboard HTML template (not Node runtime)
      indexCache = d && d.repos ? d : indexCache;
      renderIndex(d);
    }).catch(function() {});
  }
  pollIndex();
  setInterval(pollIndex, 5000);

  // --- Active repos (live cache-hit / compaction stats) ---------------------
  function fmtSec(s) {
    s = s || 0;
    if (s >= 3600) return (s / 3600).toFixed(1) + 'h';
    if (s >= 60) return Math.round(s / 60) + 'm';
    if (s >= 1) return s.toFixed(1) + 's';
    return Math.round(s * 1000) + 'ms';
  }
  function renderActiveRepos(d) {
    d = d || { updatedAt: null, servers: [] };
    var servers = d.servers || [];
    var rowsEl = document.getElementById('active-rows');
    if (!rowsEl) return;
    if (!servers.length) {
      rowsEl.innerHTML = '<tr><td colspan="9" class="repo-none">No active repositories.</td></tr>';
    } else {
      rowsEl.innerHTML = servers.map(function(r) {
        var ch = r.cacheHits || { session: 0, total: 0, sessionTokensSaved: 0, totalTokensSaved: 0 };
        var cp = r.compacts || { session: 0, total: 0 };
        var ts = r.timeSaved || { compact: { sessionSec: 0, totalSec: 0 }, cacheHit: { sessionSec: 0, totalSec: 0 } };
        return '<tr>' +
          '<td title="' + sanitize(r.repoRoot) + '">' + sanitize(r.displayName || r.repoRoot) + '</td>' +
          '<td>' + sanitize(r.model || '—') + '</td>' +
          '<td>' + sanitize(r.tier || '—') + '</td>' +
          '<td class="num">' + (r.contextPct != null ? Math.round(r.contextPct * 100) + '%' : '—') + '</td>' +
          '<td>' + sanitize(r.state || '—') + '</td>' +
          '<td class="num">' + (cp.session || 0) + ' / ' + (cp.total || 0) + '</td>' +
          '<td class="num">' + (ch.session || 0) + ' / ' + (ch.total || 0) + '</td>' +
          '<td class="num">' + fmtSec(ts.compact.sessionSec) + ' / ' + fmtSec(ts.compact.totalSec) + '</td>' +
          '<td class="num">' + fmtSec(ts.cacheHit.sessionSec) + ' / ' + fmtSec(ts.cacheHit.totalSec) + '</td>' +
        '</tr>';
      }).join('');
    }
    var upd = document.getElementById('active-updated');
    if (upd) upd.textContent = d.updatedAt ? 'Updated ' + new Date(d.updatedAt).toLocaleTimeString() : '';
  }
  function pollServers() {
    fetch('/api/servers').then(function(r) { return r.json(); }).then(renderActiveRepos).catch(function() {}); // guardrails-allow PREVENT-PI-004: browser-side fetch in dashboard HTML template (not Node runtime)
  }
  pollServers();
  setInterval(pollServers, 5000);

  // --- Tab switching ------------------------------------------------------
  var tabs = document.querySelectorAll('.tab');
  var panels = { current: 'panel-current', all: 'panel-all', active: 'panel-active', summary: 'panel-summary' };
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
      if (name === 'active') pollServers();
    });
  }
})();
</script>
</body>
</html>`;
}
