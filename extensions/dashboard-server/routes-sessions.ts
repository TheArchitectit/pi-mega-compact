/**
 * dashboard-server/routes-sessions.ts — Session and SSE event route handlers.
 */

import { createRequire } from "node:module";
import { existsSync, watch } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

import { readFrom } from "./snapshot.js";
import type { RouteContext } from "./routes-core.js";

// ---------------------------------------------------------------------------
// handleEvents — "/api/events" SSE
// ---------------------------------------------------------------------------

export function handleEvents(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	if (req.url !== "/api/events") return false;

	const { eventsPath, eventOffsetRef } = ctx;

	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});

	// Drain existing events so the client starts with history.
	// Only stream events with a "type" field — events.log also contains
	// internal monitoring rows (e.g. captureModel:recorded) that use "event"
	// instead of "type" and aren't part of the SseEvent contract.
	const { data: existing, offset: initialOffset } = readFrom(eventsPath, 0);
	eventOffsetRef.value = initialOffset;
	const lines = existing.split("\n").filter((l: string) => l.trim() && l.includes('"type"'));
	for (const line of lines) {
		res.write(`data: ${line}\n\n`);
	}

	// Tail new events via fs.watch (coalesced with 100ms debounce)
	let watchTimer: ReturnType<typeof setTimeout> | null = null;
	const onWatch = () => {
		if (watchTimer) return;
		watchTimer = setTimeout(() => {
			watchTimer = null;
			const { data, offset } = readFrom(eventsPath, eventOffsetRef.value);
			eventOffsetRef.value = offset;
			const newLines = data.split("\n").filter((l: string) => l.trim() && l.includes('"type"'));
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

	return true;
}

// ---------------------------------------------------------------------------
// handleSessions — "/api/sessions" (GET sessions list) and
// "/api/sessions/timeseries" (GET timeseries).
// ---------------------------------------------------------------------------

export function handleSessions(
	req: IncomingMessage,
	res: ServerResponse,
	_ctx: RouteContext,
): boolean {
	if (!req.url?.startsWith("/api/sessions")) return false;

	// /api/sessions/timeseries handled inline below.
	if (req.url.startsWith("/api/sessions/timeseries")) {
		// /api/sessions/timeseries — S39: stacked per-session token timeseries for
		// the recharts memory graph. GET ?minutes=N (clamped [1,1440]) returns
		// {updatedAt, windowMinutes, series[], totals[]} in recharts-ready shape.
		// Non-GET -> 405. PREVENT-PI-004: loopback.
		const tsReq = createRequire(import.meta.url);
		const {
			readSessionTimeseries,
			pruneTokenSamples,
		} = tsReq(
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
			minutes = Math.min(Math.max(minutes, 1), 1440);
			const sinceTs = Date.now() - minutes * 60_000;
			const pruneMs = Math.max(minutes * 60_000, 1_800_000);
			pruneTokenSamples(pruneMs); // guardrails-allow PREVENT-PI-004: local SQLite read (loopback dashboard)
			const result = readSessionTimeseries(sinceTs); // guardrails-allow PREVENT-PI-004: local SQLite read (loopback dashboard)
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					updatedAt: new Date().toISOString(),
					windowMinutes: minutes,
					series: result.series,
					totals: result.totals,
				}),
			);
		} catch (e) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({ error: "timeseries_unavailable", detail: String(e) }),
			);
		}
		return true;
	}

	// /api/sessions — S39: active pi sessions with latest token usage + heartbeat.
	// GET returns {updatedAt, pruned, sessions[]} after pruning stale heartbeats.
	// The dashboard server is a detached child with no MegaRuntime ref, so it
	// reads session_heartbeats via a require()'d sqlite helper (same pattern as
	// /api/achievements, /api/perf). Non-GET -> 405. PREVENT-PI-004: loopback.
	const sReq = createRequire(import.meta.url);
	const {
		readActiveSessions,
		pruneStaleSessions,
		listRepoRegistry,
	} = sReq(
			"../../src/store/sqlite.js",
		) as typeof import("../../src/store/sqlite.js");
	if (req.method !== "GET") {
		res.writeHead(405, { "Content-Type": "application/json" }); // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
		res.end(JSON.stringify({ error: "method_not_allowed" }));
		return true;
	}
	try {
		const pruned = pruneStaleSessions(); // guardrails-allow PREVENT-PI-004: local SQLite read (loopback dashboard)
		const active = readActiveSessions();
		const repos = listRepoRegistry();
		const repoMap = new Map(repos.map((r) => [r.repoRoot, r]));
		const sessions = active.map((s) => ({
			pid: s.pid,
			sessionId: s.sessionId,
			repoRoot: s.repoRoot,
			displayName: s.repoRoot
				? (s.repoRoot.split(/[\\/]/).filter(Boolean).pop() ?? s.repoRoot)
				: (s.stateDir?.split(/[\\/]/).filter(Boolean).pop() ?? "unknown"),
			model: s.repoRoot ? (repoMap.get(s.repoRoot)?.modelName ?? null) : null,
			tokens: s.tokens,
			percent: s.percent,
			ctxWindow: s.ctxWindow,
			lastSeen: s.lastSeen,
			stateDir: s.stateDir,
		}));
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({ updatedAt: new Date().toISOString(), pruned, sessions }),
		);
	} catch (e) {
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({ error: "sessions_unavailable", detail: String(e) }),
		);
	}
	return true;
}