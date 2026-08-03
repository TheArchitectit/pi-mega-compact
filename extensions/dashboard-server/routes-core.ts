/**
 * dashboard-server/routes-core.ts — RouteContext interface + shared helpers.
 *
 * The core module defines the shared context interface and the factory that
 * builds it. Route handler files import from here; the barrel (routes.ts)
 * re-exports everything for server.ts.
 */

import type { ServerResponse } from "node:http";

import { resolveSnapshot } from "./resolve-snapshot.js";
import type { IndexIndex, Snapshot } from "./types.js";

// ---------------------------------------------------------------------------
// RouteContext — every value closed over by the route bodies lives here.
// ---------------------------------------------------------------------------

export interface RouteContext {
	/** Path to the per-repo dashboard.json snapshot (read via readSnapshot). */
	snapshotPath: string;
	/** Path to the events.log SSE tail file. */
	eventsPath: string;
	/** Current stateDir — the repo being served by this server instance. */
	stateDir: string;
	/** SERVER_VERSION set at launch (exposed at /api/version). */
	SERVER_VERSION: string;
	/**
	 * Serve a file from the React client build directory.
	 * Returns true if served; false means fall through to the next handler.
	 */
	serveClientAsset: (reqPath: string, res: ServerResponse) => boolean;
	/**
	 * Mutex shared between handleEvents and the SSE write loop.
	 * The handler increments this; the outer closure reads it to set the
	 * initial SSE tail offset on new connections.
	 */
	eventOffsetRef: { value: number };
	/** Overlay the live current-repo snapshot onto its index.sqlite row. */
	overlayCurrentRepo: (idx: IndexIndex | null) => void;
	/** Cross-repo drift detector (lazy-required to avoid a top-level await). */
	detectCrossRepoDrift: (idxDir: string) => ReturnType<
		typeof import("../../src/driftDetection.js").detectCrossRepoDrift
	>;
}

// ---------------------------------------------------------------------------
// Helper: overlayCurrentRepo
// ---------------------------------------------------------------------------

function makeOverlayCurrentRepo(
	snapshotPath: string,
	stateDir: string,
): (idx: IndexIndex | null) => void {
	return (idx: IndexIndex | null): void => {
		if (!idx || !idx.repos.length) return;
		// Dynamically resolve the most recently active repo's snapshot so the
		// overlay matches what /api/snapshot serves (not the stale launch dir).
		let snap: Snapshot | null = null;
		let activeStateDir = stateDir;
		try {
			const resolved = resolveSnapshot(snapshotPath, stateDir);
			snap = resolved.snapshot;
			activeStateDir = resolved.stateDir;
		} catch {
			return;
		}
		if (!snap || !snap.repo) return;
		const cur = idx.repos.find((r) => r.stateDir === activeStateDir);
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
	};
}

// ---------------------------------------------------------------------------
// Factory — builds a fully-populated RouteContext for server.ts to use.
// ---------------------------------------------------------------------------

export function buildRouteContext(opts: {
	snapshotPath: string;
	eventsPath: string;
	stateDir: string;
	SERVER_VERSION: string;
	serveClientAsset: (reqPath: string, res: ServerResponse) => boolean;
	detectCrossRepoDrift: (idxDir: string) => ReturnType<
		typeof import("../../src/driftDetection.js").detectCrossRepoDrift
	>;
}): RouteContext {
	return {
		snapshotPath: opts.snapshotPath,
		eventsPath: opts.eventsPath,
		stateDir: opts.stateDir,
		SERVER_VERSION: opts.SERVER_VERSION,
		serveClientAsset: opts.serveClientAsset,
		eventOffsetRef: { value: 0 },
		overlayCurrentRepo: makeOverlayCurrentRepo(
			opts.snapshotPath,
			opts.stateDir,
		),
		detectCrossRepoDrift: opts.detectCrossRepoDrift,
	};
}