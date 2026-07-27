/**
 * dashboard-server/html.ts — single-page HTML dashboard template.
 */

import { dashboardServerVersion } from "./state.js";
import { THEMES, DEFAULT_THEME, themeDataBlock } from "../../src/config/themes.js";
import { dashboardClientJs } from "./dashboard-client.js";

// Server-side injection of every theme's :root[data-theme="<id>"] CSS-var
// override block so the client can switch themes instantly by setting
// document.documentElement.dataset.theme. PREVENT-PI-004: pure local, no network.
const THEME_STYLE_BLOCKS = THEMES.map(themeDataBlock).join("\n");
const THEME_OPTIONS = THEMES.map((t) => `<option value="${t.id}">${t.label}</option>`).join("");

export function dashboardHtml(tierName: string): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="${DEFAULT_THEME}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mega-compact dashboard</title>
<style>
  /* S32: CSS-variable skin. Base :root holds the CURRENT hardcoded hexes so the
     default (data-theme="transparent") is visually identical to the pre-S32
     dashboard. Each :root[data-theme="<id>"] block (injected below from
     src/config/themes.ts) overrides the 4 theme vars (--bg/--fg/--accent/--mega).
     Non-theme palette tokens (card bg, borders, muted text, meter colors) stay
     fixed so visual parity is preserved under the transparent default. */
  :root {
    --bg: #0d1117;          /* page background (transparent theme -> transparent) */
    --fg: #c9d1d9;          /* default foreground */
    --accent: #3fb950;      /* accent (bars, ok values, on-bullets) */
    --mega: #f0883e;        /* MEGA CACHE highlight */
    --fg-strong: #f0f6fc;   /* headings, strong values */
    --muted: #8b949e;       /* labels, sub-text */
    --dim: #484f58;         /* timestamps, empty states */
    --card-bg: #161b22;     /* card / events / table background */
    --border: #30363d;      /* card / table borders */
    --border-soft: #21262d; /* meter track, ev borders, table row borders */
    --blue: #1f6feb;        /* tier pill, active tab */
    --green-bar: #238636;   /* green meter fill, safe border */
    --yellow-bar: #d29922;  /* yellow meter fill, na-bullet */
    --red-bar: #f85149;     /* red meter fill, offline banner */
    --purple: #a371f7;      /* recall events, repo model, cost h2 */
    --purple-pill: #6e40c9; /* model pill bg */
    --hover-row: #1c2128;   /* table row hover */
    --link: #58a6ff;        /* repo-link hover */
    --th-bg: #0d1117;       /* table header background */
  }
  /* html backdrop keeps the page dark even when --bg is transparent (transparent
     theme) so there's no white flash — visually identical to the pre-S32 fill. */
  html { background: #0d1117; }
  ${THEME_STYLE_BLOCKS}
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; background: var(--bg); color: var(--fg); padding: 24px; line-height: 1.5; }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 20px; display: flex; align-items: center; gap: 10px; color: var(--fg-strong); }
  h1 .tier { background: var(--blue); color: #fff; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 10px; text-transform: uppercase; letter-spacing: .5px; }
  h1 .version-pill { background: var(--border); color: var(--muted); font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
  .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .card.safe { border-color: var(--green-bar); }
  .card.safe h2 { color: var(--accent); }
  .safe-note { font-size: 12px; color: var(--muted); margin: 12px 0 0; line-height: 1.5; }
  .value.ok { color: var(--accent); }
  .label {
    cursor: help;
    border-bottom: 1px dotted var(--dim);
  }
  .card.legend { grid-column: 1 / -1; }
  .legend-list { margin: 0; padding-left: 18px; color: var(--fg); }
  .legend-list li { margin-bottom: 8px; line-height: 1.5; }
  .legend-list b { color: var(--fg-strong); }
  .legend-note { font-size: 12px; color: var(--muted); margin: 12px 0 0; font-style: italic; }
  .card h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .5px; color: var(--muted); margin-bottom: 12px; font-weight: 600; }
  .meter-track { background: var(--border-soft); border-radius: 4px; height: 20px; overflow: hidden; margin: 8px 0; }
  .meter-fill { height: 100%; border-radius: 4px; transition: width .6s ease; min-width: 2px; }
  .meter-green { background: var(--green-bar); }
  .meter-yellow { background: var(--yellow-bar); }
  .meter-red { background: var(--red-bar); }
  .meter-label { font-size: 24px; font-weight: 700; color: var(--fg-strong); }
  .meter-sub { font-size: 12px; color: var(--muted); }
  .status-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 14px; }
  .status-row .bullet { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .bullet-on { background: var(--accent); box-shadow: 0 0 6px #3fb95088; }
  .bullet-off { background: var(--dim); }
  .bullet-na { background: var(--yellow-bar); }
  .state-text { font-size: 13px; color: var(--muted); margin-top: 8px; font-family: monospace; }
  .stat-grid { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 14px; }
  .stat-grid .label { color: var(--muted); }
  .stat-grid .value { color: var(--fg-strong); font-weight: 600; font-family: monospace; }
  .conf-grid { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 14px; }
  .conf-grid .label { color: var(--muted); }
  .conf-grid .value { color: var(--fg-strong); font-family: monospace; }
  .events { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .events h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .5px; color: var(--muted); margin-bottom: 12px; font-weight: 600; }
  .events-wrap { max-height: 240px; overflow-y: auto; font-family: monospace; font-size: 12px; }
  .ev { padding: 3px 0; border-bottom: 1px solid var(--border-soft); display: flex; gap: 8px; align-items: baseline; }
  .ev:last-child { border-bottom: none; }
  .ev-type { font-weight: 700; min-width: 70px; text-align: right; }
  .ev-type-compact { color: var(--accent); }
  .ev-type-recall { color: var(--purple); }
  .ev-time { color: var(--dim); font-size: 10px; min-width: 80px; }
  .ev-detail { color: var(--muted); flex: 1; }
  .updated { font-size: 11px; color: var(--dim); margin-top: 16px; text-align: right; }
  .empty { color: var(--dim); font-style: italic; font-size: 13px; padding: 8px 0; }
  .offline-banner { background: #f8514922; border: 1px solid var(--red-bar); border-radius: 6px; padding: 10px 16px; margin-bottom: 16px; font-size: 13px; color: var(--red-bar); display: none; }
  .tabs { display: flex; gap: 8px; margin-bottom: 20px; }
  .tab { background: var(--card-bg); color: var(--muted); border: 1px solid var(--border); border-radius: 6px; padding: 8px 16px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all .15s ease; }
  .tab:hover { color: var(--fg); border-color: var(--dim); }
  .tab.active { background: var(--blue); color: #fff; border-color: var(--blue); }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }
  /* S32: header settings strip (game-mode toggle + theme + TUI display-mode) */
  .settings-strip { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; padding: 10px 14px; background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; font-size: 13px; color: var(--muted); flex-wrap: wrap; }
  .settings-strip label { display: flex; align-items: center; gap: 6px; font-weight: 600; }
  .settings-strip input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; accent-color: var(--accent); }
  .settings-strip select { background: var(--th-bg); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; font-size: 13px; cursor: pointer; }
  .settings-strip select:hover { border-color: var(--dim); }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 20px; }
  .summary-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .summary-card .num { font-size: 24px; font-weight: 700; color: var(--fg-strong); }
  .summary-card .lbl { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .5px; margin-top: 4px; }
  table.repos { width: 100%; border-collapse: collapse; background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  table.repos th, table.repos td { text-align: left; padding: 10px 14px; font-size: 13px; border-bottom: 1px solid var(--border-soft); }
  table.repos th { color: var(--muted); text-transform: uppercase; letter-spacing: .5px; font-size: 11px; background: var(--th-bg); }
  table.repos td.num { font-family: monospace; color: var(--fg-strong); text-align: right; }
  table.repos tr:last-child td { border-bottom: none; }
  table.repos tr:hover td { background: var(--hover-row); }
  .repo-model { color: var(--purple); }
  .repo-none { color: var(--dim); font-style: italic; }
  .updated { font-size: 11px; color: var(--dim); margin-top: 16px; text-align: right; }
  .model-pill { background: var(--purple-pill); color: #fff; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 10px; text-transform: uppercase; letter-spacing: .5px; }
  .card.cost h2 { color: var(--purple); }
  .cost-usd { font-size: 22px; font-weight: 700; color: var(--accent); }
  .cost-sub { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .repo-link { cursor: pointer; }
  .repo-link:hover td { color: var(--link); }
  .repo-detail { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: none; align-items: center; justify-content: center; z-index: 50; }
  .repo-detail.open { display: flex; }
  .repo-detail-box { background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 24px; width: 560px; max-width: 92vw; max-height: 86vh; overflow-y: auto; }
  .repo-detail-box h2 { font-size: 14px; color: var(--fg-strong); margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; }
  .repo-close { cursor: pointer; color: var(--muted); font-size: 20px; line-height: 1; border: none; background: none; padding: 0 4px; }
  .repo-close:hover { color: var(--fg-strong); }
  .repo-path { font-size: 11px; color: var(--dim); word-break: break-all; margin: -8px 0 12px; }
  /* S34: Game Mode tab — leaderboards, MEGA CACHE banner, Opie unlock tile */
  #panel-game .game-leaderboards { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px; }
  #panel-game .lb-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 14px; }
  #panel-game .lb-card h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .5px; color: var(--muted); margin-bottom: 10px; font-weight: 600; }
  #panel-game table { width: 100%; border-collapse: collapse; font-size: 13px; }
  #panel-game td { padding: 4px 8px; border-bottom: 1px solid var(--border-soft); }
  #panel-game td.num { text-align: right; font-family: monospace; color: var(--fg-strong); font-weight: 600; }
  #panel-game .lb-meta { color: var(--muted); font-size: 11px; margin-left: 6px; }
  #panel-game .repos-badge { display: inline-block; background: var(--blue); color: #fff; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 10px; margin-left: 8px; }
  #mega-cache-banner { display: none; background: var(--mega); color: #1a1006; font-weight: 700; padding: 10px 14px; border-radius: 8px; margin: 12px 0; }
  .achievement-tile { display: none; background: linear-gradient(135deg, #f0883e, #ffd700); color: #1a1006; font-weight: 700; padding: 12px 16px; border-radius: 8px; margin: 12px 0; box-shadow: 0 0 16px #f0883e88; }
  .achievement-tile .ach-detail { display: block; font-weight: 500; font-size: 12px; margin-top: 4px; }
  #mega-cache-toast { display: none; position: fixed; top: 16px; left: 50%; transform: translateX(-50%); background: var(--mega); color: #1a1006; font-weight: 700; padding: 10px 18px; border-radius: 8px; z-index: 1000; box-shadow: 0 4px 20px #0008; }
  #mega-cache-toast.show { display: block; animation: mega-flash 0.6s ease-in-out 2; }
  .level-up { animation: level-up-pulse 1.2s ease-in-out; }
  #game-empty { color: var(--dim); font-style: italic; padding: 12px 0; }
  @keyframes level-up-pulse { 0%{transform:scale(1)} 50%{transform:scale(1.08); filter:brightness(1.3)} 100%{transform:scale(1)} }
  @keyframes mega-flash { 0%{background:transparent} 25%{background:var(--mega-bg, gold)} 100%{background:transparent} }
  /* S35: achievements tile row + unlock toast */
  .ach-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; margin: 8px 0 16px; }
  .ach-tile { padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border); font-size: 12px; background: var(--card-bg); }
  .ach-tile.unlocked { background: linear-gradient(135deg, #f0883e, #ffd700); color: #1a1006; font-weight: 700; box-shadow: 0 0 12px #f0883e66; }
  .ach-tile.locked { opacity: .55; }
  .ach-tile.just-unlocked { animation: ach-unlock-pulse 0.6s ease-out; }
  .ach-tile .ach-detail { display: block; font-weight: 500; font-size: 11px; margin-top: 3px; }
  #ach-toast { display: none; position: fixed; top: 16px; left: 50%; transform: translateX(-50%); background: var(--blue); color: #fff; font-weight: 700; padding: 10px 18px; border-radius: 8px; z-index: 1000; box-shadow: 0 4px 20px #0008; }
  #ach-toast.show { display: block; }
  @keyframes ach-unlock-pulse { 0%{transform:scale(.9);opacity:.4} 60%{transform:scale(1.05)} 100%{transform:scale(1);opacity:1} }
</style>
</head>
<body>

<div class="offline-banner" id="offline-banner">Dashboard data unavailable — waiting for a pi session to write snapshot...</div>

<h1><span>mega-compact</span><span class="tier" id="hdr-tier">${tierName}</span><span class="version-pill">v${dashboardServerVersion}</span><span class="model-pill" id="hdr-model">—</span></h1>

<div class="settings-strip">
  <label title="Turn game mode on/off (themes the widget + dashboard)"><input type="checkbox" id="set-game-mode"> Game mode</label>
  <label title="Visual theme (applies instantly)">Theme <select id="set-theme">${THEME_OPTIONS}</select> <button type="button" id="set-theme-next" title="Cycle to the next theme (P3)">Next theme →</button></label>
  <label title="TUI widget display density">TUI <select id="set-tui-mode"><option value="full">Full</option><option value="minimal">Minimal</option></select> <span class="tui-mode-hint">(affects the in-app TUI widget; not shown here)</span></label>
</div>

<nav class="tabs">
  <button class="tab active" data-tab="current">Current repo</button>
  <button class="tab" data-tab="all">All repos</button>
  <button class="tab" data-tab="active">Active Repos</button>
  <button class="tab" data-tab="summary">Summary</button>
  <button class="tab" data-tab="game">Game Mode</button>
  <button class="tab" data-tab="perf">Perf</button>
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

<h2 style="margin-top:24px;font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">All Repositories</h2>
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

  <h2 style="margin-top:24px;font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Savings by Model</h2>
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

<!-- Game Mode (S34) — high-score leaderboards, MEGA CACHE banner, Opie unlock -->
<div class="tab-panel" id="panel-game">
  <h2 style="font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">High Scores</h2>
  <div id="mega-cache-banner"></div>
  <div id="mega-cache-toast"></div>
  <div class="achievement-tile" id="opie-tile"></div>
  <h3 style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-top:16px">Achievements</h3>
  <div id="ach-toast"></div>
  <div id="ach-tiles" class="ach-tiles">loading…</div>
  <div class="game-leaderboards">
    <div class="lb-card"><h3>Cache % <span class="repos-badge" id="repos-badge"></span></h3><table><tbody id="lb-cache"><tr><td colspan="2" class="repo-none">loading…</td></tr></tbody></table></div>
    <div class="lb-card"><h3>Dedupe (collapsed)</h3><table><tbody id="lb-dedupe"><tr><td colspan="2" class="repo-none">loading…</td></tr></tbody></table></div>
    <div class="lb-card"><h3>Turns <span id="turns-level"></span></h3><table><tbody id="lb-turns"><tr><td colspan="2" class="repo-none">loading…</td></tr></tbody></table></div>
    <div class="lb-card"><h3>MEGA CACHE trophies</h3><table><tbody id="lb-mega_cache"><tr><td colspan="2" class="repo-none">loading…</td></tr></tbody></table></div>
  </div>
  <div id="game-empty">No scores yet — run a session with game mode on.</div>
</div>

<!-- Perf (v0.8.8) — live local instrumentation -->
<div class="tab-panel" id="panel-perf">
  <div class="grid">
    <div class="card"><h2>Model latency</h2><div class="stat-grid"><span class="label">Turn p50</span><span class="value" id="pf-turn-p50">—</span><span class="label">Turn p95</span><span class="value" id="pf-turn-p95">—</span><span class="label">Provider p50</span><span class="value" id="pf-prov-p50">—</span><span class="label">Provider p95</span><span class="value" id="pf-prov-p95">—</span></div></div>
    <div class="card"><h2>Throughput</h2><div class="stat-grid"><span class="label">TPS (avg)</span><span class="value" id="pf-tps">—</span><span class="label">Cache hit %</span><span class="value" id="pf-cache">—</span></div></div>
    <div class="card"><h2>Process</h2><div class="stat-grid"><span class="label">RSS</span><span class="value" id="pf-rss">—</span><span class="label">Heap</span><span class="value" id="pf-heap">—</span><span class="label">CPU user/sys</span><span class="value" id="pf-cpu">—</span></div></div>
    <div class="card"><h2>Snapshot cost</h2><div class="stat-grid"><span class="label">DB recompute p50</span><span class="value" id="pf-db-p50">—</span><span class="label">DB recompute p95</span><span class="value" id="pf-db-p95">—</span><span class="label">Disk write p50</span><span class="value" id="pf-disk">—</span></div></div>
    <div class="card"><h2>TUI lag proxy</h2><div class="stat-grid"><span class="label">Live-trim fires</span><span class="value" id="pf-recompute">—</span><span class="label">Cache replays</span><span class="value" id="pf-replays">—</span><span class="label">Fast-gate skips</span><span class="value" id="pf-skips">—</span></div><div class="meter-sub">skip vs recompute vs replay cadence</div></div>
  </div>
  <div class="updated" id="perf-updated">waiting for data</div>
</div>

<script>
${dashboardClientJs()}
</script>
</body>
</html>`;
}
