/**
 * dashboard-server/routes-repo.ts — Repo-index and static route handlers.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { readSnapshot } from "./snapshot.js";
import { dashboardHtml } from "./html.js";
import { readIndex, getIndexDir } from "./index-reader.js";
import { ACTIVE_WINDOW_SEC } from "./types.js";
import type { RouteContext } from "./routes-core.js";
import type { LiveSnapshot } from "./types.js";
import { readProviderCacheForRepo } from "../../src/store/sqlite/perf-samples.js";
import { computeCacheSavings, lookupModelInputRate } from "../../src/pricing.js";
import { latestModelSnapshot } from "../../src/store/sqlite/model-snapshots.js";

// ---------------------------------------------------------------------------
// handleIndex — "/" | "/index.html" | "/api/snapshot" | "/api/version"
// ---------------------------------------------------------------------------

export function handleIndex(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	const { snapshotPath, SERVER_VERSION, serveClientAsset } = ctx;

	if (req.url === "/" || req.url === "/index.html") {
		// Sprint B1: prefer the React client build when present; fall back to the
		// legacy inline html.ts template when the client dist is absent.
		if (serveClientAsset("/", res)) return true;
		const tier = readSnapshot(snapshotPath).tier;
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(dashboardHtml(tier));
		return true;
	}

	if (req.url === "/api/snapshot") {
		const snap = readSnapshot(snapshotPath);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(snap));
		return true;
	}

	// Server version — lets the /dashboard launcher detect a stale server from
	// an older build and replace it on upgrade rather than reuse it.
	if (req.url === "/api/version") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ version: SERVER_VERSION }));
		return true;
	}

	return false;
}

// ---------------------------------------------------------------------------
// handleRepoIndex — "/api/index" | "/api/repos" | "/api/summary" | "/api/drift" | "/api/servers"
// ---------------------------------------------------------------------------

export function handleRepoIndex(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	const { overlayCurrentRepo, detectCrossRepoDrift } = ctx;

	if (req.url === "/api/index") {
		const idx = readIndex();
		if (idx) overlayCurrentRepo(idx);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify(idx ?? { updatedAt: null, summary: null, repos: [] }),
		);
		return true;
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
		return true;
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
		return true;
	}

	// /api/drift — R4: cross-repo drift report over repo_registry. Flags stale
	// repos (>30d idle), compaction lag (active but >24h since last
	// compaction), and recent model churn. Read-only.
	if (req.url?.startsWith("/api/drift")) {
		const report = detectCrossRepoDrift(getIndexDir());
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(report));
		return true;
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
						// Provider cache per-repo lifetime (E.2)
						try {
							const pc = readProviderCacheForRepo(r.stateDir);
							// Price from model snapshot if available
							const modelSnap = latestModelSnapshot(r.stateDir);
							const inputRate = modelSnap
								? modelSnap.inputRate
								: lookupModelInputRate(r.modelName ?? "") ?? 0;
							const savings = computeCacheSavings(
								pc.totalCacheRead,
								pc.totalCacheWrite,
								inputRate,
							);
							out.providerCache = {
								avgHitPct: pc.avgHitPct,
								cacheRead: pc.totalCacheRead,
								cacheWrite: pc.totalCacheWrite,
								totalInput: pc.totalInput,
								sampleCount: pc.sampleCount,
								estimatedSaved: savings.netSaved > 0 ? savings.netSaved : null,
							};
						} catch {
							/* best-effort — repo may not have perf_samples */
						}
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
		return true;
	}

	return false;
}

// ---------------------------------------------------------------------------
// handleStatic — non-/api/* GET fallback (SPA client build or legacy HTML).
// ---------------------------------------------------------------------------

export function handleStatic(
	req: IncomingMessage,
	res: ServerResponse,
	_ctx: RouteContext,
): boolean {
	const { snapshotPath, serveClientAsset } = _ctx;

	if (
		req.method === "GET" &&
		req.url &&
		!req.url.startsWith("/api/") &&
		serveClientAsset(req.url, res)
	) {
		return true;
	}
	// Legacy SPA fallback — serve inline HTML with current tier.
	const tier = readSnapshot(snapshotPath).tier;
	res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
	res.end(dashboardHtml(tier));
	return true;
}