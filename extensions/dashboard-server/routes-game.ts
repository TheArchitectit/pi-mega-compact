/**
 * dashboard-server/routes-game.ts — Game-mode and performance route handlers.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { RouteContext } from "./routes-core.js";
import type { GameMetric } from "../../src/game/scoring.js";

// ---------------------------------------------------------------------------
// handleGameState — "/api/game-state" (GET + PUT)
// ---------------------------------------------------------------------------

export function handleGameState(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	if (!req.url?.startsWith("/api/game-state")) return false;

	const { stateDir } = ctx;

	// /api/game-state — S32 game-mode settings (game_mode_on / theme /
	// tui_display_mode). GET returns the current row; PUT applies a partial
	// patch (validated) and returns the post-write row. The dashboard server is
	// a detached child with no MegaRuntime ref, so it reads/writes the
	// game_state SQLite row directly; the in-process MegaRuntime picks up the
	// change via its fs.watch cache-eviction watcher. PREVENT-PI-004: loopback.
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
		return true;
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
		return true;
	}
	// Any other method on /api/game-state -> 405.
	res.writeHead(405, { "Content-Type": "application/json" }); // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
	res.end(JSON.stringify({ error: "method_not_allowed" }));
	return true;
}

// ---------------------------------------------------------------------------
// handleGameScores — "/api/game-scores"
// ---------------------------------------------------------------------------

export function handleGameScores(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	if (!req.url?.startsWith("/api/game-scores")) return false;

	const { stateDir } = ctx;

	// /api/game-scores — S34 high-score leaderboards. GET returns the leaderboard
	// for a metric (?metric=<m>&limit=<n>). `metric` is validated against the
	// METRICS allow-list from src/game/scoring (re-exported via the sqlite barrel);
	// default limit 10, clamped to [1,100]. The dashboard server is a detached
	// child with no MegaRuntime ref, so it reads the game_scores SQLite table
	// directly. Unknown metric -> 400, non-GET -> 405. PREVENT-PI-004: loopback.
	const gsReq = createRequire(import.meta.url);
	const { leaderboard, METRICS } = gsReq(
		"../../src/store/sqlite.js",
	) as typeof import("../../src/store/sqlite.js");
	if (req.method !== "GET") {
		res.writeHead(405, { "Content-Type": "application/json" }); // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
		res.end(JSON.stringify({ error: "method_not_allowed" }));
		return true;
	}
	try {
		const url = new URL(req.url, "http://x"); // guardrails-allow PREVENT-PI-004: localhost dashboard URL base (loopback-only)
		const metricParam = url.searchParams.get("metric") ?? "cache";
		if (!(METRICS as readonly string[]).includes(metricParam)) {
			res.writeHead(400, { "Content-Type": "application/json" }); // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
			res.end(
				JSON.stringify({ error: "unknown_metric", metric: metricParam }),
			);
			return true;
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
	return true;
}

// ---------------------------------------------------------------------------
// handlePerf — "/api/perf"
// ---------------------------------------------------------------------------

export function handlePerf(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	if (!req.url?.startsWith("/api/perf")) return false;

	const { stateDir, snapshotPath } = ctx;

	// /api/perf — v0.8.8 Perf dashboard tab. GET returns rolling-window
	// aggregates over perf_samples: per-kind p50/p95 (turn/provider latency,
	// tps avg, db recompute, disk write), latest rss/heap, cpu user/sys delta,
	// cache hit %, plus the diag recompute/skip/replay counts (read from
	// dashboard.json snapshot if available). The dashboard server is a detached
	// child with no MegaRuntime ref, so it reads perf_samples via a require()'d
	// sqlite helper (same pattern as /api/game-scores). Unknown/invalid params
	// are clamped (never throw). Non-GET -> 405. PREVENT-PI-004: loopback.
	const pfReq = createRequire(import.meta.url);
	const { readPerfSamples } = pfReq(
		"../../src/store/sqlite.js",
	) as typeof import("../../src/store/sqlite.js");
	if (req.method !== "GET") {
		res.writeHead(405, { "Content-Type": "application/json" }); // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
		res.end(JSON.stringify({ error: "method_not_allowed" }));
		return true;
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
					samples: rows
						.filter((r) => r.kind === "cache_hit_pct")
						.map((r) => ({ pct: r.value, ts: r.ts })),
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
	return true;
}

// ---------------------------------------------------------------------------
// handleAchievements — "/api/achievements"
// ---------------------------------------------------------------------------

export function handleAchievements(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	if (!req.url?.startsWith("/api/achievements")) return false;

	const { stateDir } = ctx;

	// /api/achievements — S35 achievement tiles. GET returns the 9 seeded rows
	// {id,title,description,icon,hidden,unlocked_at}. The dashboard server is a
	// detached child with no MegaRuntime ref, so it reads game_achievements via
	// listAchievements(stateDir) directly. Non-GET -> 405. PREVENT-PI-004: loopback.
	const achReq = createRequire(import.meta.url);
	const { listAchievements } = achReq(
		"../../src/store/sqlite.js",
	) as typeof import("../../src/store/sqlite.js");
	if (req.method !== "GET") {
		res.writeHead(405, { "Content-Type": "application/json" }); // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
		res.end(JSON.stringify({ error: "method_not_allowed" }));
		return true;
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
	return true;
}