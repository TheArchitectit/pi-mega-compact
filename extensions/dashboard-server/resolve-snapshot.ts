/**
 * dashboard-server/resolve-snapshot.ts — dynamic per-repo snapshot resolver.
 *
 * The dashboard server is launched with a single static stateDir, but the
 * active pi session may be running in a different repo. This module resolves
 * which repo's dashboard.json to serve as the "this session" snapshot.
 *
 * Resolution order (the launch dir is the OWNer of this dashboard):
 * 1. The launch stateDir's OWN dashboard.json — the pi process that launched
 *    this dashboard server is the session you are coding in, so its snapshot
 *    is "this session" by definition. It must be fresh (updatedAt within
 *    STALE_MS) to win; otherwise the launch dir's pi process has exited or
 *    stopped snapshotting, and showing its stale data as "this session" is
 *    misleading. When stale, fall through to the most-recently-active repo.
 * 2. Most recently seen repo (by last_seen in repo_registry) whose
 *    dashboard.json exists and has a non-null updatedAt — this includes the
 *    launch dir via the registry, so an exited-but-recent launch session
 *    still appears.
 * 3. The static launch stateDir's dashboard.json (original behavior).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { readSnapshot } from "./snapshot.js";
import type { Snapshot } from "./types.js";
import { getIndexDir } from "./index-reader.js";

export interface ResolvedSnapshot {
	snapshot: Snapshot;
	/** The stateDir that produced this snapshot. */
	stateDir: string;
}

/** Snapshots older than this are stale — the owning pi session has exited or
 *  stopped snapshotting. 5 minutes covers the slowest possible context event
 *  cadence + debounce + snapshot throttle. */
const STALE_MS = 5 * 60 * 1000;

/** Age of a snapshot's updatedAt in ms. Returns Infinity for invalid dates. */
function snapshotAgeMs(updatedAt: string | null | undefined): number {
	if (!updatedAt) return Infinity;
	const t = Date.parse(updatedAt);
	if (Number.isNaN(t)) return Infinity;
	return Date.now() - t;
}

const require = createRequire(import.meta.url);

interface RepoRegistryRow {
	state_dir: string;
	last_seen: number;
}

/**
 * Find the most recently active repo's stateDir by scanning the repo registry
 * for the repo with the highest last_seen whose dashboard.json exists and has
 * a non-null updatedAt. Unlike the old `mostRecentOtherRepoStateDir`, this
 * does NOT exclude the launch dir — when the launch dir's snapshot is stale
 * but its registry entry has a recent last_seen (e.g. session just exited),
 * it should still be eligible.
 */
function mostRecentActiveRepoStateDir(_launchStateDir: string): string | null {
	const indexPath = join(getIndexDir(), "index.sqlite");
	if (!existsSync(indexPath)) return null;
	let db;
	try {
		const { DatabaseSync } =
			require("node:sqlite") as typeof import("node:sqlite");
		db = new DatabaseSync(indexPath, { readOnly: true });
		const rows = db
			.prepare(
				`SELECT state_dir, last_seen FROM repo_registry
				 WHERE state_dir IS NOT NULL AND last_seen IS NOT NULL
				 ORDER BY last_seen DESC`,
			)
			.all() as unknown as RepoRegistryRow[];
		for (const r of rows) {
			const dashPath = join(r.state_dir, "dashboard.json");
			if (!existsSync(dashPath)) continue;
			const snap = readSnapshot(dashPath);
			if (snap.updatedAt) {
				return r.state_dir;
			}
		}
		return null;
	} catch {
		return null;
	} finally {
		try {
			db?.close();
		} catch {
			/* ignore */
		}
	}
}

/**
 * Resolve the best snapshot to serve. The launch dir wins when its snapshot is
 * fresh; when stale (or missing) the most recently active repo wins instead.
 */
export function resolveSnapshot(
	staticSnapshotPath: string,
	staticStateDir: string,
): ResolvedSnapshot {
	// 1. The launch dir's OWN snapshot is "this session" — but only when it's
	//    fresh (updated within STALE_MS). A stale launch-dir snapshot means
	//    the pi process that owned it has exited or stopped snapshotting; serving
	//    its frozen data as "this session" is misleading. Fall through to the
	//    most-recently-active repo so the user sees the session that is actually
	//    running.
	if (existsSync(staticSnapshotPath)) {
		const launchSnap = readSnapshot(staticSnapshotPath);
		if (launchSnap.updatedAt && snapshotAgeMs(launchSnap.updatedAt) < STALE_MS) {
			return { snapshot: launchSnap, stateDir: staticStateDir };
		}
	}
	// 2. Fall back to the most recently active OTHER repo (launch dir stale or
	//    had no live snapshot yet). The registry includes the launch dir too,
	//    so a recently-exited launch session can still appear.
	const activeDir = mostRecentActiveRepoStateDir(staticStateDir);
	if (activeDir) {
		const activePath = join(activeDir, "dashboard.json");
		const snap = readSnapshot(activePath);
		if (snap.updatedAt) {
			return { snapshot: snap, stateDir: activeDir };
		}
	}
	// 3. Last resort: the static launch path (even if stale).
	return {
		snapshot: readSnapshot(staticSnapshotPath),
		stateDir: staticStateDir,
	};
}
