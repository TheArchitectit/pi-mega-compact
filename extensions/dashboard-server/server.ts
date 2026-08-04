/**
 * dashboard-server/server.ts — HTTP server creation + launch + CLI entry point.
 *
 * Route handlers are extracted to routes.ts. This file owns:
 * - launchDashboardServer (setup, version detection, port finding, IPv6 mirror, lifecycle)
 * - createServer as a thin dispatcher that builds RouteContext and delegates each route
 * - CORS preflight + OPTIONS handling (per-request middleware, not a route)
 */

import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { NEW_UI } from "../../src/config.js";
import { log, setLogPath, setDashboardServerVersion } from "./state.js";
import {
	buildRouteContext,
	handleIndex,
	handleRepoIndex,
	handleEvents,
	handleGameState,
	handleGameScores,
	handlePerf,
	handlePerfSamples,
	handleAchievements,
	handleSessions,
	handleTopics,
	handleTurns,
	handleMaintenance,
	handleProviderCache,
	handleCacheStripes,
	handleMemoryStatus,
	handleSetupStatus,
	handleSetupDetect,
	handleSetupConfigure,
	handleMemoryMap,
	handleRaptorTree,
	handleRaptorBuildHistory,
	handleContextHealth,
	handleCachePoison,
	handleHealthSettings,
	handleEmbedderHealth,
	handleRagSettings,
	handleRagMetrics,
	handleModelThresholds,
	handleWiki,
	handleVectorCortexEvaluation,
	handleVectorCortexHealth,
	handleVectorCortexBreakersReset,
	handleVectorCortexLedger,
	handleStatic,
} from "./routes.js";

export async function launchDashboardServer(
	stateDir: string,
): Promise<{ port: number; url: string }> {
	// Our own package version — exposed at /api/version so the launcher can
	// detect a stale server (started by an older build) and replace it on
	// upgrade instead of reuse it.
	let SERVER_VERSION = "0.0.0";
	// `here` is hoisted out of the version-detection try block so the
	// dashboard-client dist path (Sprint B1) can reuse it without recompute.
	const here = dirname(fileURLToPath(import.meta.url));
	try {
		// Since v0.7.9 (8821ef3) dashboard-server.js lives at
		// <pkg>/dist/extensions/dashboard-server/, so package.json is THREE levels
		// up. Keep the two- and one-level-up candidates as fallbacks for flatter
		// dev-checkout layouts. Guard each candidate so a missing file is skipped.
		const candidates = [
			join(here, "..", "..", "..", "package.json"),
			join(here, "..", "..", "package.json"),
			join(here, "..", "package.json"),
		];
		for (const p of candidates) {
			if (!existsSync(p)) continue;
			const pkg = JSON.parse(readFileSync(p, "utf-8"));
			if (pkg.version) {
				SERVER_VERSION = pkg.version;
				setDashboardServerVersion(pkg.version);
				break;
			}
		}
	} catch {
		/* non-fatal */
	}

	// Lazy-loaded via require so the dashboard stays cheap to boot and we don't
	// need a top-level await in the handler.
	const driftReq = createRequire(import.meta.url);
	const detectCrossRepoDrift = (idxDir: string) =>
		(
			driftReq(
				"../../src/driftDetection.js",
			) as typeof import("../../src/driftDetection.js")
		).detectCrossRepoDrift(idxDir);
	const portFile = join(stateDir, "port.pid");
	const snapshotPath = join(stateDir, "dashboard.json");
	const eventsPath = join(stateDir, "events.log");
	setLogPath(join(stateDir, "dashboard.log"));

	// ── React client build (Sprint B1) ────────────────────────────────────
	// If the Vite-built dashboard-client bundle is present, serve it as the
	// dashboard UI (SPA fallback for all non-/api/* routes). If absent, fall
	// back to the legacy inline html.ts template. Candidate paths cover both
	// the dist/ build layout and a flat dev checkout (mirrors the package.json
	// candidate pattern above).
	const clientDistCandidates = [
		join(here, "..", "dashboard-client", "dist"), // dist/extensions/dashboard-client/dist
		join(here, "..", "..", "dashboard-client", "dist"), // dist/dashboard-client/dist (flat)
		join(here, "..", "..", "..", "extensions", "dashboard-client", "dist"), // repo-root extensions/dashboard-client/dist (dist build)
		join(here, "..", "dashboard-client", "dist"), // dev: extensions/dashboard-server/../dashboard-client/dist
	];
	const clientDist =
		clientDistCandidates.find((p) => existsSync(join(p, "index.html"))) ??
		clientDistCandidates[0];
	const clientIndexHtml = join(clientDist, "index.html");
	const hasClientBuild = existsSync(clientIndexHtml);
	if (hasClientBuild) log("client build present", { clientDist });

	function injectUiFlag(html: string): string {
		const flag = NEW_UI() ? "true" : "false";
		const script = `<script>window.MEGACOMPACT_NEW_UI=${flag}</script>`;
		if (html.includes("</head>")) {
			return html.replace("</head>", `${script}</head>`);
		}
		return html + script;
	}

	// guardrails-allow PREVENT-PI-004: read-only static file serving from the local dashboard-client/dist bundle (loopback-only UI).
	const serveClientAsset = (reqPath: string, res: ServerResponse): boolean => {
		if (!hasClientBuild) return false;
		// Normalize: strip query, prevent path traversal, map "/" to index.html.
		const clean = reqPath.split("?")[0];
		if (clean.includes("..")) return false;
		const rel =
			clean === "/" || clean === "" ? "index.html" : clean.replace(/^\//, "");
		const file = join(clientDist, rel);
		if (!file.startsWith(clientDist) || !existsSync(file)) {
			// SPA fallback: unknown non-asset routes serve index.html (client-side routing).
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(injectUiFlag(readFileSync(clientIndexHtml, "utf-8")));
			return true;
		}
		const ext = rel.slice(rel.lastIndexOf(".") + 1);
		const types: Record<string, string> = {
			html: "text/html; charset=utf-8",
			js: "text/javascript",
			css: "text/css",
			json: "application/json",
			svg: "image/svg+xml",
			png: "image/png",
			ico: "image/x-icon",
			map: "application/json",
		};
		const payload: string | Uint8Array =
			ext === "html"
				? injectUiFlag(readFileSync(file, "utf-8"))
				: readFileSync(file);
		res.writeHead(200, {
			"Content-Type": types[ext] ?? "application/octet-stream",
		});
		res.end(payload);
		return true;
	};

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
					const probe = await fetch(
						`http://localhost:${info.port}/api/version`,
						{ signal: AbortSignal.timeout(800) },
					); // guardrails-allow PREVENT-PI-004: optional localhost dashboard server probe (loopback-only)
					live = probe.ok;
				} catch {
					live = false;
				}
				if (live) {
					log("reusing live server from port.pid", { port: info.port });
					return { port: info.port, url: `http://localhost:${info.port}` }; // guardrails-allow PREVENT-PI-004: localhost dashboard URL (loopback-only)
				}
				log("port.pid present but no live server — treating as stale", {
					port: info.port,
				});
			}
		} catch {
			log("port.pid unparseable — treating as stale");
		}
		// stale file, remove so the fresh bind does not collide with a lingering
		// process that still holds the port
		try {
			unlinkSync(portFile);
		} catch {
			/* ignore */
		}
	}

	// ── New server ────────────────────────────────────────────────────────────
	mkdirSync(stateDir, { recursive: true });

	// Build RouteContext once; all handlers receive the same ctx object.
	const ctx = buildRouteContext({
		snapshotPath,
		eventsPath,
		stateDir,
		SERVER_VERSION,
		serveClientAsset,
		detectCrossRepoDrift,
	});

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		// guardrails-allow PREVENT-PI-004: optional, user-triggered /dashboard localhost server (loopback-only) — CORS restricted to same-origin localhost browsers.
		// CORS for local access — restricted to loopback origins (the dashboard server only binds to localhost).
		const origin = req.headers.origin;
		if (
			typeof origin === "string" &&
			/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
		) {
			res.setHeader("Access-Control-Allow-Origin", origin);
			res.setHeader("Vary", "Origin");
		}
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type");

		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		// Dispatch — each handler returns true if it ended the response.
		if (handleIndex(req, res, ctx)) return;
		if (handleRepoIndex(req, res, ctx)) return;
		if (handleEvents(req, res, ctx)) return;
		if (handleGameState(req, res, ctx)) return;
		if (handleGameScores(req, res, ctx)) return;
		if (handlePerfSamples(req, res, ctx)) return;
		if (handlePerf(req, res, ctx)) return;
		if (handleAchievements(req, res, ctx)) return;
		if (handleSessions(req, res, ctx)) return;
		if (handleTopics(req, res, ctx)) return;
		if (handleTurns(req, res, ctx)) return;
		if (handleMaintenance(req, res, ctx)) return;
		if (handleProviderCache(req, res, ctx)) return;
		if (handleMemoryStatus(req, res, ctx)) return;
		if (handleCacheStripes(req, res, ctx)) return;
		if (handleSetupStatus(req, res, ctx)) return;
		if (handleSetupDetect(req, res, ctx)) return;
		if (handleSetupConfigure(req, res, ctx)) return;
		if (handleMemoryMap(req, res, ctx)) return;
		if (handleRaptorTree(req, res, ctx)) return;
		if (handleRaptorBuildHistory(req, res, ctx)) return;
		if (handleContextHealth(req, res, ctx)) return;
		if (handleCachePoison(req, res, ctx)) return;
		if (handleHealthSettings(req, res, ctx)) return;
		if (handleEmbedderHealth(req, res, ctx)) return;
		if (handleRagSettings(req, res, ctx)) return;
		if (handleRagMetrics(req, res, ctx)) return;
		if (handleModelThresholds(req, res, ctx)) return;
		if (handleWiki(req, res, ctx)) return;
		if (handleVectorCortexEvaluation(req, res, ctx)) return;
		if (handleVectorCortexHealth(req, res, ctx)) return;
		if (handleVectorCortexBreakersReset(req, res, ctx)) return;
		if (handleVectorCortexLedger(req, res, ctx)) return;
		handleStatic(req, res, ctx);
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

				// v0.8.2: also bind the IPv6 loopback (::1). On many systems `localhost`
				// resolves to ::1 first (see /etc/hosts), so an IPv4-only bind makes the
				// browser hit ::1:port and get connection refused. PREVENT-PI-004
				// (loopback-only) means BOTH 127.0.0.1 and ::1. Non-fatal: IPv4-only
				// hosts or a ::1 already in use just skip the mirror.
				let v6: ReturnType<typeof createServer> | undefined;
				const v4Handler = server.listeners("request")[0];
				if (v4Handler) {
					v6 = createServer((r, s) =>
						(v4Handler as (a: IncomingMessage, b: ServerResponse) => void).call(
							server,
							r,
							s,
						),
					);
					v6.on("error", (e: NodeJS.ErrnoException) =>
						log("ipv6 loopback bind skipped", {
							port,
							code: e.code,
							message: e.message,
						}),
					);
					v6.listen(port, "::1", () => log("ipv6 loopback bound", { port })); // guardrails-allow PREVENT-PI-004: IPv6 loopback (::1) mirror of the localhost dashboard server
				}

				// Write port.pid
				try {
					writeFileSync(portFile, JSON.stringify({ port, pid: process.pid }));
				} catch (e) {
					log("could not write port.pid", { error: String(e) });
				}

				// Graceful cleanup
				const cleanup = () => {
					try {
						unlinkSync(portFile);
					} catch {
						/* already gone */
					}
					server.close();
					try {
						v6?.close();
					} catch {
						/* not bound */
					}
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
