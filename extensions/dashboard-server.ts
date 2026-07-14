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
import { existsSync, mkdirSync, readFileSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";

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
    tokensSaved: number;
    sessionCount: number;
    dedupAttempts: number;
    dedupCollapsed: number;
    storageDedupRate: number;
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
      store: { checkpointCount: 0, totalTokenEstimate: 0, tokensSaved: 0, injectedCount: 0, dedupHitRate: 0, storageDedupRate: 0, dedupCollapsed: 0 },
      crew: { activeAgents: 0, currentTurn: 0 },
      repo: { checkpointCount: 0, totalTokenEstimate: 0, tokensSaved: 0, sessionCount: 0, dedupAttempts: 0, dedupCollapsed: 0, storageDedupRate: 0 },
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
</style>
</head>
<body>

<div class="offline-banner" id="offline-banner">Dashboard data unavailable — waiting for a pi session to write snapshot...</div>

<h1><span>mega-compact</span><span class="tier">${tierName}</span></h1>

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
      <span class="label">Checkpoints</span><span class="value" id="st-count">0</span>
      <span class="label">Tokens Stored</span><span class="value" id="st-tokens">0</span>
      <span class="label">Tokens Saved</span><span class="value" id="st-saved">0</span>
      <span class="label">Injected</span><span class="value" id="st-injected">0</span>
      <span class="label">Dedup Rate</span><span class="value" id="st-dedup">0%</span>
      <span class="label">Storage Dedup</span><span class="value" id="st-sdedup">0%</span>
      <span class="label">Collapsed</span><span class="value" id="st-collapsed">0</span>
      <span class="label">Last ID</span><span class="value" id="st-lastid">—</span>
    </div>
  </div>
  <div class="card">
    <h2>Repo (all sessions)</h2>
    <div class="stat-grid">
      <span class="label">Checkpoints</span><span class="value" id="rp-count">0</span>
      <span class="label">Tokens Stored</span><span class="value" id="rp-tokens">0</span>
      <span class="label">Tokens Saved</span><span class="value" id="rp-saved">0</span>
      <span class="label">Sessions</span><span class="value" id="rp-sessions">0</span>
      <span class="label">Collapsed</span><span class="value" id="rp-collapsed">0</span>
      <span class="label">Storage Dedup</span><span class="value" id="rp-sdedup">0%</span>
    </div>
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
  <div class="card">
    <h2>Crew / Agents</h2>
    <div class="stat-grid">
      <span class="label">Active Agents</span><span class="value" id="cr-agents">0</span>
      <span class="label">Current Turn</span><span class="value" id="cr-turn">0</span>
      <span class="label">Status</span><span class="value" id="cr-status">idle</span>
    </div>
  </div>
</div>

<div class="events">
  <h2>Event Stream</h2>
  <div class="events-wrap" id="events"><div class="empty">connecting…</div></div>
</div>

<div class="updated" id="updated"></div>

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
    document.getElementById('st-saved').textContent = (d.store.tokensSaved || 0).toLocaleString();
    document.getElementById('st-injected').textContent = d.store.injectedCount;
    document.getElementById('st-dedup').textContent = Math.round(d.store.dedupHitRate * 100) + '%';
    var sdr = d.store.storageDedupRate || 0;
    document.getElementById('st-sdedup').textContent = (sdr * 100 >= 10 ? Math.round(sdr * 100) : (sdr * 100).toFixed(1)) + '%';
    document.getElementById('st-collapsed').textContent = d.store.dedupCollapsed || 0;
    document.getElementById('st-lastid').textContent = d.session.lastCheckpointId || '—';

    // Repo-wide (all sessions in this repo's SQLite store).
    var repo = d.repo || { checkpointCount: 0, totalTokenEstimate: 0, tokensSaved: 0, sessionCount: 0, dedupCollapsed: 0, storageDedupRate: 0 };
    document.getElementById('rp-count').textContent = repo.checkpointCount;
    document.getElementById('rp-tokens').textContent = repo.totalTokenEstimate.toLocaleString();
    document.getElementById('rp-saved').textContent = (repo.tokensSaved || 0).toLocaleString();
    document.getElementById('rp-sessions').textContent = repo.sessionCount || 0;
    document.getElementById('rp-collapsed').textContent = repo.dedupCollapsed || 0;
    var rsdr = repo.storageDedupRate || 0;
    document.getElementById('rp-sdedup').textContent = (rsdr * 100 >= 10 ? Math.round(rsdr * 100) : (rsdr * 100).toFixed(1)) + '%';

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
})();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function launchDashboardServer(stateDir: string): Promise<{ port: number; url: string }> {
  const portFile = join(stateDir, "port.pid");
  const snapshotPath = join(stateDir, "dashboard.json");
  const eventsPath = join(stateDir, "events.log");

  // ── Existing server? ──────────────────────────────────────────────────────
  if (existsSync(portFile)) {
    try {
      const info = JSON.parse(readFileSync(portFile, "utf-8"));
      if (info && info.port) {
        return Promise.resolve({ port: info.port, url: `http://localhost:${info.port}` });
      }
    } catch {
      // stale file, overwrite
    }
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

  const TARGET_PORT = 9320;
  const PORT_RANGE = 10; // 9320–9329

  return new Promise((resolve, reject) => {
    function tryPort(port: number) {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && port < TARGET_PORT + PORT_RANGE - 1) {
          tryPort(port + 1);
        } else {
          reject(err);
        }
      });

      server.listen(port, "127.0.0.1", () => {
        const url = `http://localhost:${port}`;
        console.log(`[mega-compact] dashboard server running: ${url}`);

        // Write port.pid
        try {
          writeFileSync(portFile, JSON.stringify({ port, pid: process.pid }));
        } catch { /* non-fatal */ }

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
