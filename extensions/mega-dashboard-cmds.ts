/**
 * mega-dashboard-cmds.ts — the local web-dashboard slash commands.
 *
 * Spawns / discovers / stops the optional localhost dashboard server
 * (extensions/dashboard-server.ts) as a detached child process. All network
 * usage here is loopback-only and audited via // guardrails-allow PREVENT-PI-004.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, writeFileSync, readFileSync, unlinkSync, openSync, closeSync } from "node:fs";
import { spawn, execSync } from "node:child_process"; // guardrails-allow PREVENT-PI-004: spawns the optional, user-triggered localhost dashboard server only
import type { MegaRuntime } from "./mega-runtime.js";

/** Register the dashboard server lifecycle commands. */
export function registerDashboardCommands(pi: ExtensionAPI, runtime: MegaRuntime): void {
  // H3 fix: read currentStateDir at CALL time, not registration time. The
  // previous `const portFile = join(runtime.currentStateDir, ...)` captured the
  // state dir once at extension load; after a repo switch (bindRepo updates
  // currentStateDir) the dashboard commands would read/write the OLD repo's
  // port.pid — potentially spawning a duplicate server or failing to stop the
  // current one. Functions re-resolve on every call.
  const portFile = (): string => join(runtime.currentStateDir, "port.pid");
  const runnerFile = (): string => join(runtime.currentStateDir, "_dashboard-runner.mjs");
  const launchLog = (): string => join(runtime.currentStateDir, "_dashboard-launch.log");
  // Whether the runner must be spawned with --experimental-strip-types (true only
  // when we fall back to the .ts source outside node_modules; false when using
  // the shipped compiled dist/extensions/dashboard-server.js).
  let dashboardNeedsStrip = false;

  // The dashboard server binds a 10-port range starting at MEGACOMPACT_DASHBOARD_PORT
  // (default 9320) — see TARGET_PORT/PORT_RANGE in dashboard-server.js. Probe each for
  // a live /api/snapshot so we detect readiness even when port.pid landed in a different
  // state dir than we poll. Configurable so tests can use a private, non-colliding range.
  const DASH_BASE = Number(process.env.MEGACOMPACT_DASHBOARD_PORT ?? "9320");
  async function findLivePort(): Promise<number | null> {
    for (let port = DASH_BASE; port <= DASH_BASE + 9; port++) {
      try {
        const res = await fetch(`http://localhost:${port}/api/snapshot`, { signal: AbortSignal.timeout(800) }); // guardrails-allow PREVENT-PI-004: localhost liveness probe of the dashboard server this extension spawned
        if (res.ok) return port;
      } catch { /* not on this port — try next */ }
    }
    return null;
  }

  /** Try to reach a running dashboard server. Returns details or null.
   *  `hasPidFile` tells the caller whether this server was launched by us
   *  (port.pid present) — a live server with NO pid file is an orphan from an
   *  older/detached spawn that we should replace rather than reuse. */
  async function isServerRunning(): Promise<{ port: number; url: string; hasPidFile: boolean } | null> {
    const port = await findLivePort();
    if (!port) {
      // Stale marker with no live server behind it — clean up.
      if (existsSync(portFile())) {
        try { unlinkSync(portFile()); } catch { /* ignore */ }
      }
      return null;
    }
    return { port, url: `http://localhost:${port}`, hasPidFile: existsSync(portFile()) }; // guardrails-allow PREVENT-PI-004: localhost URL of the dashboard server this extension spawned
  }

  /** Version the running server on `port` reports, or null. */
  async function serverVersion(port: number): Promise<string | null> {
    try {
      const res = await fetch(`http://localhost:${port}/api/version`, { signal: AbortSignal.timeout(800) }); // guardrails-allow PREVENT-PI-004: localhost version probe of the dashboard server this extension spawned
      if (!res.ok) return null;
      const j = await res.json() as { version?: string };
      return j.version ?? null;
    } catch {
      return null;
    }
  }

  /** Version of THIS extension (read from its own package.json). */
  function ownVersion(): string | null {
    try {
      const here = dirname(fileURLToPath(import.meta.url)); // .../extensions
      const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf-8"));
      return pkg.version ?? null;
    } catch {
      return null;
    }
  }

  /** PID listening on 127.0.0.1:port (our own server), or null. Uses `ss`
   *  (Linux/macOS) — best-effort, returns null if unavailable. */
  function pidOnPort(port: number): number | null {
    try {
      const out = execSync(`ss -ltnp 2>/dev/null | grep ':${port} '`, { encoding: "utf-8" });
      const m = out.match(/pid=(\d+)/);
      return m ? Number(m[1]) : null;
    } catch {
      return null;
    }
  }

  /** Kill a running dashboard server (best-effort): read the pid from port.pid,
   *  or — when there's no marker (an orphan) — from the port owner. Then remove
   *  the marker so the next spawn starts fresh. */
  function killServerOnPort(port: number): void {
    let pid: number | null = null;
    try {
      const info = JSON.parse(readFileSync(portFile(), "utf-8"));
      if (info && info.pid) pid = info.pid;
    } catch { /* no marker */ }
    if (pid == null) pid = pidOnPort(port); // orphan with no pid.pid
    if (pid != null) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    }
    try { unlinkSync(portFile()); } catch { /* ignore */ }
  }

  /**
   * Resolve the launchable dashboard-server module.
   *
   * CRITICAL: Node's `--experimental-strip-types` REFUSES to strip .ts files that
   * live under `node_modules` (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). Since
   * the published package installs under node_modules, importing the .ts source
   * fails in every real install (it only worked from a source checkout). So we
   * prefer the COMPILED dist/extensions/dashboard-server.js (which the package
   * ships from v0.4.6 — it imports only Node built-ins, so it runs standalone),
   * and only fall back to the .ts source (with strip-types) when the compiled
   * file is absent AND we're not under node_modules (dev checkout without a build).
   *
   * Returns { entry, needsStripTypes }.
   */
  function resolveDashboardEntry(): { entry: string; needsStripTypes: boolean } | null {
    const here = dirname(fileURLToPath(import.meta.url)); // .../extensions
    const candidates = [
      // 1. Compiled sibling when running from dist/ (import.meta is dist/extensions/…js)
      { entry: join(here, "dashboard-server.js"), strip: false },
      // 2. Compiled under the package's dist/ when running from source extensions/…ts
      { entry: join(here, "..", "dist", "extensions", "dashboard-server.js"), strip: false },
      // 3. Last resort: the .ts source (only strippable OUTSIDE node_modules)
      { entry: join(here, "dashboard-server.ts"), strip: true },
    ];
    for (const c of candidates) {
      if (!existsSync(c.entry)) continue;
      if (c.strip && c.entry.includes(`${sep}node_modules${sep}`)) continue; // unstrippable
      return { entry: c.entry, needsStripTypes: c.strip };
    }
    return null;
  }

  /** Write a small ESM runner script that imports and launches the dashboard server. */
  function writeRunnerScript(): boolean {
    const resolved = resolveDashboardEntry();
    if (!resolved) return false;
    dashboardNeedsStrip = resolved.needsStripTypes;
    const script = [
      `import { appendFileSync } from "node:fs";`,
      `const __log = ${JSON.stringify(launchLog())};`,
      `function __fail(err) {`,
      `  const msg = "[mega-compact] dashboard failed: " + (err && err.stack ? err.stack : String(err));`,
      `  try { appendFileSync(__log, msg + "\\n"); } catch { /* ignore */ }`,
      `  console.error(msg);`,
      `  process.exit(1);`,
      `}`,
      `import { launchDashboardServer } from ${JSON.stringify(resolved.entry)};`,
      `launchDashboardServer(${JSON.stringify(runtime.currentStateDir)}).catch(__fail);`,
    ].join("\n");
    writeFileSync(runnerFile(), script);
    return true;
  }

  /** Open a URL in the default browser. Platform-aware. Uses spawn (not exec) to avoid shell injection. */
  function openBrowser(url: string): void {
    const cmd =
      process.platform === "darwin" ? "open" :
        process.platform === "win32" ? "start" :
          "xdg-open";
    try {
      spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
    } catch {
      /* non-fatal — user can open manually */
    }
  }

  pi.registerCommand("mega-dashboard", {
    description: "Start the local web dashboard and optionally open it in the default browser.",
    handler: async (_args: string, ctx: ExtensionContext) => {
      runtime.bindRepo(ctx.cwd);
      let info = await isServerRunning();

      if (info) {
        // Replace the server when it's stale: either (a) an orphan — a live
        // server with no port.pid (e.g. left running from a detached spawn or a
        // previous upgrade) that keeps serving old HTML from memory; or (b) a
        // server that reports a different version than this extension (an older
        // build). A live server WITH a matching pid file and version is reused.
        const orphan = !info.hasPidFile;
        const running = await serverVersion(info.port);
        const want = ownVersion();
        const stale = orphan || (want != null && running != null && running !== want);
        if (stale) {
          ctx.ui.notify(
            orphan
              ? "[mega-compact] replacing orphaned dashboard server…"
              : `[mega-compact] replacing stale dashboard (${running} → ${want})…`,
          );
          killServerOnPort(info.port);
          info = null;
        } else {
          ctx.ui.notify(`[mega-compact] dashboard already running at ${info.url}`);
          const open = await ctx.ui.confirm("mega-compact dashboard", `Open ${info.url} in browser?`);
          if (open) openBrowser(info.url);
          return;
        }
      }

      // Start the server
      ctx.ui.notify("[mega-compact] starting dashboard server…");
      if (!writeRunnerScript()) {
        ctx.ui.notify("[mega-compact] dashboard entry not found — check logs.");
        return;
      }

      // Clear any stale marker so a fresh bind never collides with a lingering
      // orphan, and truncate the launch log so the next error report shows only
      // this attempt's output.
      try { unlinkSync(portFile()); } catch { /* ignore */ }
      try { writeFileSync(launchLog(), ""); } catch { /* ignore */ }

      const args = dashboardNeedsStrip ? ["--experimental-strip-types", runnerFile()] : [runnerFile()];
      // Redirect the child's stderr to the launch log so that a CRASH BEFORE the
      // runner's own __fail handler runs (e.g. an ESM module-load / parse error,
      // or a missing entry) is still captured. With the old `stdio: "ignore"`
      // these failures were completely silent and the "check logs" message
      // pointed at an empty file. We open the fd in the parent and pass it to the
      // child; once spawned we close our copy (the child keeps its own dup).
      let stderrFd: number;
      try {
        stderrFd = openSync(launchLog(), "a");
      } catch {
        stderrFd = -1; // fall back to ignored stderr
      }
      const child = spawn(process.execPath, args, {
        detached: true,
        stdio: ["ignore", "ignore", stderrFd >= 0 ? stderrFd : "ignore"],
      });
      if (stderrFd >= 0) {
        try { closeSync(stderrFd); } catch { /* ignore */ }
      }
      child.unref();

      // Poll for a live server (port 9320–9329) instead of relying solely on the
      // port.pid marker, which can land in a different state dir than the one we
      // poll when a prior compact left currentStateDir pointing elsewhere.
      const deadline = Date.now() + 6_000;
      let port: number | null = null;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        port = await findLivePort();
        if (port) break;
      }

      if (!port) {
        let detail = "";
        try {
          const log = readFileSync(launchLog(), "utf-8").trim();
          if (log) detail = ` — ${log.split("\n").slice(-3).join("; ")}`;
        } catch { /* no log yet */ }
        ctx.ui.notify(`[mega-compact] dashboard server failed to start${detail}. See ${launchLog()}`);
        return;
      }

      const url = `http://localhost:${port}`; // guardrails-allow PREVENT-PI-004: localhost URL of the dashboard server this extension spawned
      ctx.ui.notify(`[mega-compact] dashboard running at ${url}`);
      const open = await ctx.ui.confirm("mega-compact dashboard", `Open ${url} in browser?`);
      if (open) openBrowser(url);
    },
  });

  pi.registerCommand("mega-dashboard-stop", {
    description: "Stop the local dashboard server.",
    handler: async (_args: string, ctx: ExtensionContext) => {
      runtime.bindRepo(ctx.cwd);
      if (!existsSync(portFile())) {
        ctx.ui.notify("[mega-compact] no dashboard server running.");
        return;
      }
      try {
        const info = JSON.parse(readFileSync(portFile(), "utf-8"));
        // Verify the server is actually ours by probing the port before killing
        try {
          await fetch(`http://localhost:${info.port}/api/snapshot`, { signal: AbortSignal.timeout(1000) }); // guardrails-allow PREVENT-PI-004: localhost probe to verify the dashboard server is ours before stopping it
        } catch {
          // Not responding — just clean up stale pid file
          try { unlinkSync(portFile()); } catch { /* ok */ }
          ctx.ui.notify("[mega-compact] dashboard was not running (stale pid file cleaned up).");
          return;
        }
        if (info?.pid) process.kill(info.pid, "SIGTERM");
      } catch { /* already dead */ }
      try { unlinkSync(portFile()); } catch { /* ok */ }
      ctx.ui.notify("[mega-compact] dashboard stopped.");
    },
  });

  pi.registerCommand("mega-dashboard-status", {
    description: "Check if the dashboard server is running.",
    handler: async (_args: string, ctx: ExtensionContext) => {
      runtime.bindRepo(ctx.cwd);
      const info = await isServerRunning();
      if (info) {
        ctx.ui.notify(`[mega-compact] dashboard running at ${info.url}`);
      } else {
        ctx.ui.notify("[mega-compact] dashboard is not running. Use /dashboard to start it.");
      }
    },
  });
}
