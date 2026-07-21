/**
 * dashboard-server/server.ts — HTTP server creation + launch + CLI entry point.
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
	watch,
	writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { log, setLogPath, setDashboardServerVersion } from "./state.js";
import { readIndex, getIndexDir } from "./index-reader.js";
import { readSnapshot, readFrom } from "./snapshot.js";
import { dashboardHtml } from "./html.js";
import { ACTIVE_WINDOW_SEC } from "./types.js";
import type { IndexIndex, Snapshot, LiveSnapshot } from "./types.js";
import type { GameMetric } from "../../src/game/scoring.js";

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
			res.end(readFileSync(clientIndexHtml));
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
		res.writeHead(200, {
			"Content-Type": types[ext] ?? "application/octet-stream",
		});
		res.end(readFileSync(file));
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
		try {
			snap = readSnapshot(snapshotPath);
		} catch {
			return;
		}
		if (!snap || !snap.repo) return;
		const cur = idx.repos.find((r) => r.stateDir === stateDir);
		if (!cur) return;
		const prevSaved = cur.tokensSaved;
		const prevCp = cur.checkpointCount;
		const prevBytes = cur.compressedOriginalBytes;
		const comp = snap.compression?.repo;
		const liveSaved = comp
			? comp.tokensFreed
			: (snap.repo.tokensSaved ?? prevSaved);
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
		res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type");

		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		if (req.url === "/" || req.url === "/index.html") {
			// Sprint B1: prefer the React client build when present; fall back to the
			// legacy inline html.ts template when the client dist is absent.
			if (serveClientAsset("/", res)) return;
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
			res.end(
				JSON.stringify(idx ?? { updatedAt: null, summary: null, repos: [] }),
			);
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
			res.end(
				JSON.stringify({
					updatedAt: idx?.updatedAt ?? null,
					repos,
					count: repos.length,
				}),
			);
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
			const activeRepos = repos.filter(
				(r) => (r.lastSeen ?? 0) >= cutoffSec,
			).length;
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					updatedAt: idx?.updatedAt ?? null,
					summary: idx?.summary ?? null,
					activeRepos,
					totalRepos: repos.length,
				}),
			);
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
				const servers = (idx?.repos ?? [])
					.filter((r) => (r.lastSeen ?? 0) >= nowSec - ACTIVE_WINDOW_SEC)
					.map((r) => {
						const out: Record<string, unknown> = {
							repoRoot: r.repoRoot,
							displayName: r.displayName,
							model: r.modelName,
							provider: r.providerName,
							lastSeen: r.lastSeen,
							lastCompactedAt: r.lastCompactedAt,
						};
						try {
							const p = join(r.stateDir, "dashboard.json");
							if (existsSync(p)) {
								const snap = JSON.parse(
									readFileSync(p, "utf-8"),
								) as LiveSnapshot;
								out.tier = snap.tier ?? null;
								out.contextPct =
									snap.context && snap.context.percent != null
										? snap.context.percent
										: null;
								out.state = (snap.session && snap.session.state) || null;
								out.cacheHits = snap.cacheHits ?? null;
								out.compacts = snap.compacts ?? null;
								out.timeSaved = snap.timeSaved ?? null;
								out.updatedAt = snap.updatedAt ?? null;
							}
						} catch {
							/* best-effort */
						}
						return out;
					})
					.sort((a, b) => (b.lastSeen as number) - (a.lastSeen as number));
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({ updatedAt: new Date().toISOString(), servers }),
				);
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
				Connection: "keep-alive",
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
				} catch {
					/* give up */
				}
			}

			if (existsSync(eventsPath)) {
				startFileWatch();
			} else {
				pollInterval = setInterval(() => {
					if (existsSync(eventsPath)) {
						if (pollInterval) {
							clearInterval(pollInterval);
							pollInterval = null;
						}
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

		// /api/game-state — S32 game-mode settings (game_mode_on / theme /
		// tui_display_mode). GET returns the current row; PUT applies a partial
		// patch (validated) and returns the post-write row. The dashboard server is
		// a detached child with no MegaRuntime ref, so it reads/writes the
		// game_state SQLite row directly; the in-process MegaRuntime picks up the
		// change via its fs.watch cache-eviction watcher. PREVENT-PI-004: loopback.
		if (req.url?.startsWith("/api/game-state")) {
			const gsReq = createRequire(import.meta.url);
			const { getGameState, setGameState } = gsReq(
				"../../src/store/sqlite.js",
			) as typeof import("../../src/store/sqlite.js");
			const { isValidTheme } = gsReq(
				"../../src/config/themes.js",
			) as typeof import("../../src/config/themes.js");
			if (req.method === "GET") {
				try {
					const gs = getGameState(stateDir); // guardrails-allow PREVENT-PI-004: local SQLite read (loopback dashboard)
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify(gs));
				} catch (e) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(
						JSON.stringify({
							error: "game_state_unavailable",
							detail: String(e),
						}),
					);
				}
				return;
			}
			if (req.method === "PUT") {
				// Read + parse the JSON body (capped — the patch is tiny). The handler
				// is sync, so drain the stream via data/end listeners then continue.
				let body = "";
				let tooBig = false;
				req.on("data", (chunk: Buffer) => {
					// guardrails-allow PREVENT-PI-004: loopback dashboard request body (local)
					if (body.length > 65536) {
						tooBig = true;
						return;
					}
					body += chunk.toString();
				});
				req.on("end", () => {
					if (tooBig) {
						res.writeHead(413, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "body_too_large" }));
						return;
					}
					let patch: Record<string, unknown> = {};
					try {
						patch = body ? JSON.parse(body) : {};
					} catch {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "invalid_json" }));
						return;
					}
					// Reject valid-but-non-object JSON (null/[]/42) — dereferencing
					// patch.game_mode_on would throw an unhandled TypeError inside this
					// 'end' listener and crash the detached server (audit P1: loopback DoS).
					if (
						typeof patch !== "object" ||
						patch === null ||
						Array.isArray(patch)
					) {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "invalid_patch_object" }));
						return;
					}
					// Validate the patch fields (unknown keys ignored; invalid values -> 400).
					const clean: {
						game_mode_on?: boolean;
						theme?: string;
						tui_display_mode?: "full" | "minimal";
					} = {};
					let bad = false;
					if (patch.game_mode_on != null) {
						if (typeof patch.game_mode_on !== "boolean") bad = true;
						else clean.game_mode_on = patch.game_mode_on;
					}
					if (patch.theme != null) {
						if (typeof patch.theme !== "string" || !isValidTheme(patch.theme))
							bad = true;
						else clean.theme = patch.theme;
					}
					if (patch.tui_display_mode != null) {
						if (
							patch.tui_display_mode !== "full" &&
							patch.tui_display_mode !== "minimal"
						)
							bad = true;
						else clean.tui_display_mode = patch.tui_display_mode;
					}
					if (bad) {
						res.writeHead(400, { "Content-Type": "application/json" });
						res.end(JSON.stringify({ error: "invalid_patch" }));
						return;
					}
					try {
						const gs = setGameState(clean, stateDir); // guardrails-allow PREVENT-PI-004: local SQLite write (loopback dashboard)
						res.writeHead(200, { "Content-Type": "application/json" });
						res.end(JSON.stringify(gs));
					} catch (e) {
						res.writeHead(500, { "Content-Type": "application/json" });
						res.end(
							JSON.stringify({
								error: "game_state_write_failed",
								detail: String(e),
							}),
						);
					}
				});
				return;
			}
			// Any other method on /api/game-state → 405.
			res.writeHead(405, { "Content-Type": "application/json" }); // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
			res.end(JSON.stringify({ error: "method_not_allowed" }));
			return;
		}

		// /api/game-scores — S34 high-score leaderboards. GET returns the leaderboard
		// for a metric (?metric=<m>&limit=<n>). `metric` is validated against the
		// METRICS allow-list from src/game/scoring (re-exported via the sqlite barrel);
		// default limit 10, clamped to [1,100]. The dashboard server is a detached
		// child with no MegaRuntime ref, so it reads the game_scores SQLite table
		// directly. Unknown metric -> 400, non-GET -> 405. PREVENT-PI-004: loopback.
		if (req.url?.startsWith("/api/game-scores")) {
			const gsReq = createRequire(import.meta.url);
			const { leaderboard, METRICS } = gsReq(
				"../../src/store/sqlite.js",
			) as typeof import("../../src/store/sqlite.js");
			if (req.method !== "GET") {
				res.writeHead(405, { "Content-Type": "application/json" }); // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
				res.end(JSON.stringify({ error: "method_not_allowed" }));
				return;
			}
			try {
				const url = new URL(req.url, "http://x"); // guardrails-allow PREVENT-PI-004: localhost dashboard URL base (loopback-only)
				const metricParam = url.searchParams.get("metric") ?? "cache";
				if (!(METRICS as readonly string[]).includes(metricParam)) {
					res.writeHead(400, { "Content-Type": "application/json" }); // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
					res.end(
						JSON.stringify({ error: "unknown_metric", metric: metricParam }),
					);
					return;
				}
				const metric = metricParam as GameMetric; // validated against METRICS above
				let limit = Number(url.searchParams.get("limit") ?? "10");
				if (!Number.isFinite(limit) || limit <= 0) limit = 10;
				limit = Math.min(Math.max(limit, 1), 100); // clamp to [1,100]
				const rows = leaderboard(stateDir, metric, { limit }); // guardrails-allow PREVENT-PI-004: local SQLite read (loopback dashboard)
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(rows));
			} catch (e) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error: "game_scores_unavailable",
						detail: String(e),
					}),
				);
			}
			return;
		}

		// /api/perf — v0.8.8 Perf dashboard tab. GET returns rolling-window
		// aggregates over perf_samples: per-kind p50/p95 (turn/provider latency,
		// tps avg, db recompute, disk write), latest rss/heap, cpu user/sys delta,
		// cache hit %, plus the diag recompute/skip/replay counts (read from
		// dashboard.json snapshot if available). The dashboard server is a detached
		// child with no MegaRuntime ref, so it reads perf_samples via a require()'d
		// sqlite helper (same pattern as /api/game-scores). Unknown/invalid params
		// are clamped (never throw). Non-GET -> 405. PREVENT-PI-004: loopback.
		if (req.url?.startsWith("/api/perf")) {
			const pfReq = createRequire(import.meta.url);
			const { readPerfSamples } = pfReq(
				"../../src/store/sqlite.js",
			) as typeof import("../../src/store/sqlite.js");
			if (req.method !== "GET") {
				res.writeHead(405, { "Content-Type": "application/json" }); // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
				res.end(JSON.stringify({ error: "method_not_allowed" }));
				return;
			}
			try {
				const url = new URL(req.url, "http://x"); // guardrails-allow PREVENT-PI-004: localhost dashboard URL base (loopback-only)
				let minutes = Number(url.searchParams.get("minutes") ?? "30");
				if (!Number.isFinite(minutes) || minutes <= 0) minutes = 30;
				minutes = Math.min(minutes, 1440); // cap at 24h
				const sinceTs = Date.now() - minutes * 60_000;
				const rows = readPerfSamples(stateDir, sinceTs); // guardrails-allow PREVENT-PI-004: local SQLite read (loopback dashboard)
				const byKind = new Map<string, number[]>();
				for (const r of rows) {
					let arr = byKind.get(r.kind);
					if (!arr) {
						arr = [];
						byKind.set(r.kind, arr);
					}
					arr.push(r.value);
				}
				// Nearest-rank percentile (ceil(p/100*n)-1, clamped). Code-controlled,
				// never user input (PREVENT-002 safe).
				function pct(arr: number[], p: number): number {
					if (!arr.length) return 0;
					const s = [...arr].sort((a, b) => a - b);
					const idx = Math.min(
						s.length - 1,
						Math.max(0, Math.ceil((p / 100) * s.length) - 1),
					);
					return s[idx];
				}
				function avg(arr: number[]): number {
					if (!arr.length) return 0;
					return arr.reduce((a, b) => a + b, 0) / arr.length;
				}
				// rows are ASC by ts, so the last pushed value is the most recent.
				function latest(arr: number[]): number {
					return arr.length ? arr[arr.length - 1] : 0;
				}
				const get = (k: string): number[] => byKind.get(k) ?? [];
				// diag counters live in the runtime-written dashboard.json (the server is
				// a detached child with no MegaRuntime ref). Read defensively — absent
				// until the first snapshot() write (PREVENT-001: assign before access).
				let diag: {
					ctxFastGate: number;
					liveTrimFires: number;
					liveTrimReplays: number;
				} | null = null;
				try {
					const raw = readFileSync(snapshotPath, "utf-8");
					const parsed = JSON.parse(raw) as {
						diag?: {
							ctxFastGate: number;
							liveTrimFires: number;
							liveTrimReplays: number;
						};
					};
					if (parsed && typeof parsed === "object" && parsed.diag)
						diag = parsed.diag;
				} catch {
					/* dashboard.json not written yet */
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						updatedAt: new Date().toISOString(),
						windowMinutes: minutes,
						sampleCount: rows.length,
						turn_latency_ms: {
							p50: pct(get("turn_latency_ms"), 50),
							p95: pct(get("turn_latency_ms"), 95),
							n: get("turn_latency_ms").length,
						},
						provider_latency_ms: {
							p50: pct(get("provider_latency_ms"), 50),
							p95: pct(get("provider_latency_ms"), 95),
							n: get("provider_latency_ms").length,
						},
						tps: { avg: avg(get("tps")), n: get("tps").length },
						cache_hit_pct: {
							avg: avg(get("cache_hit_pct")),
							latest: latest(get("cache_hit_pct")),
							n: get("cache_hit_pct").length,
						},
						db_recompute_ms: {
							p50: pct(get("db_recompute_ms"), 50),
							p95: pct(get("db_recompute_ms"), 95),
							n: get("db_recompute_ms").length,
						},
						disk_write_ms: {
							p50: pct(get("disk_write_ms"), 50),
							p95: pct(get("disk_write_ms"), 95),
							n: get("disk_write_ms").length,
						},
						rss_mb: { latest: latest(get("rss_mb")), n: get("rss_mb").length },
						heap_mb: {
							latest: latest(get("heap_mb")),
							n: get("heap_mb").length,
						},
						cpu_user_ms: {
							latest: latest(get("cpu_user_ms")),
							n: get("cpu_user_ms").length,
						},
						cpu_sys_ms: {
							latest: latest(get("cpu_sys_ms")),
							n: get("cpu_sys_ms").length,
						},
						diag,
					}),
				);
			} catch (e) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({ error: "perf_unavailable", detail: String(e) }),
				);
			}
			return;
		}

		// /api/achievements — S35 achievement tiles. GET returns the 9 seeded rows
		// {id,title,description,icon,hidden,unlocked_at}. The dashboard server is a
		// detached child with no MegaRuntime ref, so it reads game_achievements via
		// listAchievements(stateDir) directly. Non-GET -> 405. PREVENT-PI-004: loopback.
		if (req.url?.startsWith("/api/achievements")) {
			const achReq = createRequire(import.meta.url);
			const { listAchievements } = achReq(
				"../../src/store/sqlite.js",
			) as typeof import("../../src/store/sqlite.js");
			if (req.method !== "GET") {
				res.writeHead(405, { "Content-Type": "application/json" }); // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
				res.end(JSON.stringify({ error: "method_not_allowed" }));
				return;
			}
			try {
				const rows = listAchievements(stateDir); // guardrails-allow PREVENT-PI-004: local SQLite read (loopback dashboard)
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(rows));
			} catch (e) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error: "achievements_unavailable",
						detail: String(e),
					}),
				);
			}
			return;
		}

		// Fallback — serve the React client build (SPA route) or legacy dashboard.
		// Non-/api/* GETs hit here: serve client assets if built, else inline HTML.
		if (
			req.method === "GET" &&
			req.url &&
			!req.url.startsWith("/api/") &&
			serveClientAsset(req.url, res)
		) {
			return;
		}
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
