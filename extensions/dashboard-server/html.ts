/**
 * dashboard-server/html.ts — single-page HTML dashboard template.
 */

import { dashboardServerVersion } from "./state.js";
import { THEMES, DEFAULT_THEME, themeDataBlock } from "../../src/config/themes.js";

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
  <label title="Visual theme (applies instantly)">Theme <select id="set-theme">${THEME_OPTIONS}</select></label>
  <label title="TUI widget display density">TUI <select id="set-tui-mode"><option value="full">Full</option><option value="minimal">Minimal</option></select></label>
</div>

<nav class="tabs">
  <button class="tab active" data-tab="current">Current repo</button>
  <button class="tab" data-tab="all">All repos</button>
  <button class="tab" data-tab="active">Active Repos</button>
  <button class="tab" data-tab="summary">Summary</button>
  <button class="tab" data-tab="game">Game Mode</button>
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
  renderGameScores();
  renderAchievements();
  setInterval(pollSnapshot, 2000);
  setInterval(renderGameScores, 2000);
  setInterval(renderAchievements, 2000);

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

  // --- Game-mode settings strip (S32) -------------------------------------
  // Polls GET /api/game-state and applies the row to the settings controls +
  // the document theme. On any control change, PUTs a partial patch back. The
  // dashboard server is a detached child with no MegaRuntime ref, so it reads /
  // writes the game_state SQLite row directly; the in-process MegaRuntime picks
  // up the change via its fs.watch cache-eviction watcher (S32).
  var gmCheckbox = document.getElementById('set-game-mode');
  var gmTheme = document.getElementById('set-theme');
  var gmTui = document.getElementById('set-tui-mode');

  function applyGameState(gs) {
    if (!gs) return;
    if (gs.theme) document.documentElement.dataset.theme = gs.theme;
    if (gmCheckbox) gmCheckbox.checked = !!gs.game_mode_on;
    if (gmTheme) gmTheme.value = gs.theme || 'transparent';
    if (gmTui) gmTui.value = gs.tui_display_mode || 'full';
  }
  function pollGameState() {
    fetch('/api/game-state').then(function(r) { return r.json(); }).then(applyGameState).catch(function() {}); // guardrails-allow PREVENT-PI-004: browser-side fetch in dashboard HTML template (not Node runtime)
  }
  function putGameState(patch) {
    fetch('/api/game-state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).then(function(r) { return r.json(); }).then(applyGameState).catch(function() {}); // guardrails-allow PREVENT-PI-004: browser-side fetch in dashboard HTML template (not Node runtime)
  }
  if (gmCheckbox) gmCheckbox.addEventListener('change', function() { putGameState({ game_mode_on: gmCheckbox.checked }); });
  if (gmTheme) gmTheme.addEventListener('change', function() { putGameState({ theme: gmTheme.value }); });
  if (gmTui) gmTui.addEventListener('change', function() { putGameState({ tui_display_mode: gmTui.value }); });
  pollGameState();
  setInterval(pollGameState, 5000);

  // --- Game Mode leaderboards (S34) ----------------------------------------
  // Polls GET /api/game-scores per metric, renders the per-repo leaderboard
  // tables, the MEGA CACHE banner, the hidden Opie's Wild Ride unlock tile, and
  // the transient oopsie toast (fires when a NEW mega_cache trophy row appears
  // since the last poll). Browser-side fetch only (PREVENT-PI-004).
  var GAME_METRICS = ['cache', 'dedupe', 'turns', 'mega_cache'];
  var GAME_EMPTY = true;
  var lastMegaTs = 0;
  var lastMaxLevel = 0;
  function fmtPct(v) { return (Math.round(v * 10) / 10) + '%'; }
  function fmtDate(ts) { return ts ? new Date(ts).toLocaleString() : '—'; }
  function trophyMeta(m) { try { return (m && typeof m === 'object') ? m : {}; } catch (e) { return {}; } }
  function renderGameScores() {
    var results = {};
    var pending = GAME_METRICS.length + 1; // metrics + repos badge
    function done() {
      if (--pending > 0) return;
      var cache = results['cache'] || [];
      if (cache.length) GAME_EMPTY = false;
      document.getElementById('lb-cache').innerHTML = cache.map(function(r) {
        return '<tr><td title="' + sanitize(r.repo_root) + '">' + sanitize(r.repo_root.split('/').pop()) + '</td><td class="num">' + sanitize(String(r.value)) + '</td></tr>';
      }).join('') || '<tr><td colspan="2" class="repo-none">no data</td></tr>';
      var dedupe = results['dedupe'] || [];
      if (dedupe.length) GAME_EMPTY = false;
      document.getElementById('lb-dedupe').innerHTML = dedupe.map(function(r) {
        return '<tr><td title="' + sanitize(r.repo_root) + '">' + sanitize(r.repo_root.split('/').pop()) + '</td><td class="num">' + sanitize(String(r.value)) + '</td></tr>';
      }).join('') || '<tr><td colspan="2" class="repo-none">no data</td></tr>';
      var turns = results['turns'] || [];
      var maxTurns = turns.reduce(function(mx, r) { return Math.max(mx, r.value); }, 0);
      var lvl = Math.floor(Math.log2(maxTurns + 1)) + 1;
      var lvlEl = document.getElementById('turns-level');
      if (lvlEl) lvlEl.textContent = 'LVL ' + lvl;
      if (turns.length) GAME_EMPTY = false;
      // level-up pulse: when max level increases vs last poll, pulse the cache bar
      if (lvl > lastMaxLevel && lastMaxLevel > 0) {
        var bar = document.getElementById('ctx-bar');
        if (bar) { bar.classList.add('level-up'); setTimeout(function() { bar.classList.remove('level-up'); }, 1200); }
      }
      if (lvl > lastMaxLevel) lastMaxLevel = lvl;
      document.getElementById('lb-turns').innerHTML = turns.map(function(r) {
        return '<tr><td title="' + sanitize(r.repo_root) + '">' + sanitize(r.repo_root.split('/').pop()) + '</td><td class="num">' + sanitize(String(r.value)) + '</td></tr>';
      }).join('') || '<tr><td colspan="2" class="repo-none">no data</td></tr>';
      // mega_cache trophies + banner + Opie tile + transient toast
      var mega = results['mega_cache'] || [];
      var megaBody = document.getElementById('lb-mega_cache');
      if (megaBody) {
        megaBody.innerHTML = mega.map(function(r) {
          var m = trophyMeta(r.meta);
          var fs = m.firstSeenTs || m.firstSeen || r.ts;
          var extra = fs ? ' <span class="lb-meta">' + sanitize(fmtDate(fs)) + '</span>' : '';
          return '<tr><td title="' + sanitize(r.repo_root) + '">' + sanitize(r.repo_root.split('/').pop()) + '</td><td class="num">' + sanitize(fmtPct(r.value)) + extra + '</td></tr>';
        }).join('') || '<tr><td colspan="2" class="repo-none">no trophies yet</td></tr>';
      }
      var banner = document.getElementById('mega-cache-banner');
      var tile = document.getElementById('opie-tile');
      var best = null, firstSeen = null;
      mega.forEach(function(r) {
        if (best == null || r.value > best) best = r.value;
        var m = trophyMeta(r.meta);
        var fs = m.firstSeenTs || m.firstSeen || r.ts;
        if (firstSeen == null || fs < firstSeen) firstSeen = fs;
      });
      if (banner) {
        if (best != null && best > 100) {
          banner.style.display = 'block';
          banner.textContent = '🥧 MEGA CACHE! peak ' + fmtPct(best) + ' — first reached ' + fmtDate(firstSeen);
        } else { banner.style.display = 'none'; }
      }
      if (tile) {
        if (best != null && best > 100) {
          tile.style.display = 'block';
          tile.className = 'achievement-tile unlocked';
          tile.innerHTML = '🏆 Opie\\'s Wild Ride<span class="ach-detail">best ' + sanitize(fmtPct(best)) + ' · first ' + sanitize(fmtDate(firstSeen)) + '</span>';
        } else { tile.style.display = 'none'; tile.className = 'achievement-tile'; }
      }
      // transient oopsie toast: a NEW mega_cache trophy row since the last poll
      var maxTs = mega.reduce(function(mx, r) { return Math.max(mx, r.ts); }, 0);
      var newRow = mega.find(function(r) { return r.ts > lastMegaTs && r.value > 100; });
      if (lastMegaTs && newRow) {
        var toast = document.getElementById('mega-cache-toast');
        if (toast) {
          toast.textContent = 'oopsie! cache went to ' + Math.round(newRow.value) + '% — MEGA CACHE 🥧';
          toast.classList.add('show');
          setTimeout(function() { toast.classList.remove('show'); }, 4000);
        }
      }
      if (maxTs > lastMegaTs) lastMegaTs = maxTs;
      // empty state
      var emptyEl = document.getElementById('game-empty');
      if (emptyEl) emptyEl.style.display = GAME_EMPTY ? 'block' : 'none';
    }
    GAME_METRICS.forEach(function(m) {
      fetch('/api/game-scores?metric=' + encodeURIComponent(m) + '&limit=25').then(function(r) { return r.ok ? r.json() : []; }).then(function(rows) { results[m] = rows || []; }).catch(function() { results[m] = []; }).then(done);
    });
    fetch('/api/game-scores?metric=repos&limit=1').then(function(r) { return r.ok ? r.json() : []; }).then(function(rows) {
      var badge = document.getElementById('repos-badge');
      if (badge) badge.textContent = ((rows && rows.length) ? rows[0].value : 0) + ' repos';
      if (rows && rows.length && rows[0].value > 0) GAME_EMPTY = false;
    }).catch(function() {}).then(done);
  }

  // --- Achievements tile row (S35) ------------------------------------------
  // Polls GET /api/achievements; renders the tile row (hidden+locked render
  // NOTHING; unlocked show icon+title+date; visible-but-locked show ??? teaser)
  // and fires a transient toast when a newly-unlocked achievement appears.
  // Browser-side fetch only (PREVENT-PI-004).
  var lastAchMaxTs = 0;
  function renderAchievements() {
    fetch('/api/achievements').then(function(r) { return r.ok ? r.json() : []; }).then(function(rows) { // guardrails-allow PREVENT-PI-004: browser-side fetch in dashboard HTML template (not Node runtime)
      var box = document.getElementById('ach-tiles');
      if (!box) return;
      var html = '';
      var maxTs = 0;
      (rows || []).forEach(function(a) {
        if (a.hidden === 1 && a.unlocked_at == null) return; // hidden invariant: render nothing
        if (a.unlocked_at != null) {
          var isNew = a.unlocked_at > lastAchMaxTs && lastAchMaxTs > 0;
          maxTs = Math.max(maxTs, a.unlocked_at);
          html += '<div class="ach-tile unlocked' + (isNew ? ' just-unlocked' : '') + '">' + sanitize(a.icon || '') + ' ' + sanitize(a.title) + '<span class="ach-detail">unlocked ' + sanitize(fmtDate(a.unlocked_at)) + '</span></div>';
        } else {
          html += '<div class="ach-tile locked">??? ' + sanitize(a.title) + '</div>';
        }
      });
      box.innerHTML = html || '<span class="repo-none">no achievements yet</span>';
      var newly = (rows || []).filter(function(a) { return a.unlocked_at != null && a.unlocked_at > lastAchMaxTs; });
      if (lastAchMaxTs && newly.length) {
        var toast = document.getElementById('ach-toast');
        if (toast) {
          toast.textContent = newly.map(function(a) { return (a.icon || '') + ' ' + a.title; }).join(', ') + ' unlocked!';
          toast.classList.add('show');
          setTimeout(function() { toast.classList.remove('show'); }, 4000);
        }
      }
      if (maxTs > lastAchMaxTs) lastAchMaxTs = maxTs;
    }).catch(function() {});
  }

  // --- Tab switching ------------------------------------------------------
  var tabs = document.querySelectorAll('.tab');
  var panels = { current: 'panel-current', all: 'panel-all', active: 'panel-active', summary: 'panel-summary', game: 'panel-game' };
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
      if (name === 'game') { renderGameScores(); renderAchievements(); }
    });
  }
})();
</script>
</body>
</html>`;
}
