/**
 * dashboard-server/server.ts — HTTP server creation + launch + CLI entry point.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { log, setLogPath, setDashboardServerVersion } from "./state.js";
import { readIndex, getIndexDir } from "./index-reader.js";
import { readSnapshot, readFrom } from "./snapshot.js";
import { dashboardHtml } from "./html.js";
import { ACTIVE_WINDOW_SEC } from "./types.js";
import type { IndexIndex, Snapshot, LiveSnapshot } from "./types.js";

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
      if (pkg.version) { SERVER_VERSION = pkg.version; setDashboardServerVersion(pkg.version); break; }
    }
  } catch { /* non-fatal */ }

  // Lazy-loaded via require so the dashboard stays cheap to boot and we don't
  // need a top-level await in the handler.
  const driftReq = createRequire(import.meta.url);
  const detectCrossRepoDrift = (idxDir: string) =>
    (driftReq("../../src/driftDetection.js") as typeof import("../../src/driftDetection.js"))
      .detectCrossRepoDrift(idxDir);
  const portFile = join(stateDir, "port.pid");
  const snapshotPath = join(stateDir, "dashboard.json");
  const eventsPath = join(stateDir, "events.log");
  setLogPath(join(stateDir, "dashboard.log"));
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
          const probe = await fetch(`http://localhost:${info.port}/api/version`, { signal: AbortSignal.timeout(800) }); // guardrails-allow PREVENT-PI-004: optional localhost dashboard server probe (loopback-only)
          live = probe.ok;
        } catch {
          live = false;
        }
        if (live) {
          log("reusing live server from port.pid", { port: info.port });
          return { port: info.port, url: `http://localhost:${info.port}` }; // guardrails-allow PREVENT-PI-004: localhost dashboard URL (loopback-only)
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

  // Overlay the live current-repo snapshot (snapshot.json, rewritten every
  // context event) onto its registry row so the All-repos / Summary views stay
  // in sync with the live menu bar + Current-repo card in real time. The
  // registry (index.sqlite) is only written on repo-switch (bindRepo), so
  // without this the current repo's row freezes between switches. Read-only —
  // no extra writes to index.sqlite. Matched by stateDir, which equals the
  // value this server was launched with (runtime.currentStateDir).
  function overlayCurrentRepo(idx: IndexIndex | null): void {
    if (!idx || !idx.repos.length) return;
    let snap: Snapshot | null = null;
    try { snap = readSnapshot(snapshotPath); } catch { return; }
    if (!snap || !snap.repo) return;
    const cur = idx.repos.find((r) => r.stateDir === stateDir);
    if (!cur) return;
    const prevSaved = cur.tokensSaved;
    const prevCp = cur.checkpointCount;
    const prevBytes = cur.compressedOriginalBytes;
    const comp = snap.compression?.repo;
    const liveSaved = comp ? comp.tokensFreed : (snap.repo.tokensSaved ?? prevSaved);
    const liveCp = snap.repo.checkpointCount ?? prevCp;
    const liveBytes = snap.integrity?.compressedOriginalBytes ?? prevBytes;
    cur.tokensSaved = liveSaved;
    cur.checkpointCount = liveCp;
    cur.compressedOriginalBytes = liveBytes;
    if (idx.summary) {
      idx.summary.totalTokensSaved += liveSaved - prevSaved;
      idx.summary.totalCheckpoints += liveCp - prevCp;
      idx.summary.totalCompressedOriginalBytes += liveBytes - prevBytes;
    }
    idx.updatedAt = snap.updatedAt ?? idx.updatedAt;
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // guardrails-allow PREVENT-PI-004: optional, user-triggered /dashboard localhost server (loopback-only) — CORS open for local browser access
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
      const idx = readIndex();
      if (idx) overlayCurrentRepo(idx);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(idx ?? { updatedAt: null, summary: null, repos: [] }));
      return;
    }

    // /api/repos — registry list. Optional `?active=24h` filters to repos
    // seen within the last N hours (default: all). The dashboard uses this to
    // drive its "active vs archived" badge without refetching /api/index.
    if (req.url?.startsWith("/api/repos")) {
      const url = new URL(req.url, "http://x"); // guardrails-allow PREVENT-PI-004: localhost dashboard URL base (loopback-only)
      const activeParam = url.searchParams.get("active");
      const idx = readIndex();
      if (idx) overlayCurrentRepo(idx);
      let repos = idx?.repos ?? [];
      if (activeParam) {
        const m = /^(\d+)h$/.exec(activeParam);
        if (m) {
          const cutoffSec = Math.floor(Date.now() / 1000) - Number(m[1]) * 3600;
          repos = repos.filter((r) => (r.lastSeen ?? 0) >= cutoffSec);
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ updatedAt: idx?.updatedAt ?? null, repos, count: repos.length }));
      return;
    }

    // /api/summary — header tiles without the full repo list (keeps payload
    // small for embed scenarios). activeRepos mirrors the /api/repos?active=24h
    // count so the dashboard can render the active badge alongside totals.
    if (req.url?.startsWith("/api/summary")) {
      const idx = readIndex();
      if (idx) overlayCurrentRepo(idx);
      const repos = idx?.repos ?? [];
      const cutoffSec = Math.floor(Date.now() / 1000) - 24 * 3600;
      const activeRepos = repos.filter((r) => (r.lastSeen ?? 0) >= cutoffSec).length;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        updatedAt: idx?.updatedAt ?? null,
        summary: idx?.summary ?? null,
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

    if (req.url === "/api/servers") {
      try {
        const idx = readIndex();
        const nowSec = Math.floor(Date.now() / 1000);
        const servers = (idx?.repos ?? []).filter((r) => (r.lastSeen ?? 0) >= nowSec - ACTIVE_WINDOW_SEC).map((r) => {
          const out: Record<string, unknown> = { repoRoot: r.repoRoot, displayName: r.displayName, model: r.modelName, provider: r.providerName, lastSeen: r.lastSeen, lastCompactedAt: r.lastCompactedAt };
          try { const p = join(r.stateDir, "dashboard.json"); if (existsSync(p)) { const snap = JSON.parse(readFileSync(p, "utf-8")) as LiveSnapshot; out.tier = snap.tier ?? null; out.contextPct = (snap.context && snap.context.percent != null) ? snap.context.percent : null; out.state = (snap.session && snap.session.state) || null; out.cacheHits = snap.cacheHits ?? null; out.compacts = snap.compacts ?? null; out.timeSaved = snap.timeSaved ?? null; out.updatedAt = snap.updatedAt ?? null; } } catch { /* best-effort */ }
          return out;
        }).sort((a, b) => (b.lastSeen as number) - (a.lastSeen as number));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ updatedAt: new Date().toISOString(), servers }));
      } catch {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "servers_unavailable" }));
      }
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
        const url = `http://localhost:${port}`; // guardrails-allow PREVENT-PI-004: localhost dashboard URL (loopback-only)
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
