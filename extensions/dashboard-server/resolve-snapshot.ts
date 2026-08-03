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
 *    is "this session" by definition. This must win over any other repo
 *    regardless of last_seen freshness; otherwise a more-recently-active
 *    OTHER repo steals the "this session" slot and your actual session gets
 *    demoted to an "other" gauge, producing the exact duplicate-gauge bug
 *    (this session + pi-<launchrepo> both showing the same active session
 *    split across two boxes).
 * 2. Most recently seen OTHER repo (by last_seen in repo_registry) whose
 *    dashboard.json exists and has a non-null updatedAt — fallback for when
 *    the launch dir has no live snapshot yet (e.g. dashboard launched before
 *    any compaction wrote dashboard.json).
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

const require = createRequire(import.meta.url);

interface RepoRegistryRow {
	state_dir: string;
	last_seen: number;
}

/**
 * Find the most recently active OTHER repo's stateDir (excluding the launch
 * dir, which is handled by the caller) by scanning the repo registry for the
 * repo with the highest last_seen whose dashboard.json exists and has a
 * non-null updatedAt. Returns null if no suitable repo is found.
 */
function mostRecentOtherRepoStateDir(launchStateDir: string): string | null {
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
				   AND state_dir != @launch
				 ORDER BY last_seen DESC`,
			)
			.all({ launch: launchStateDir }) as unknown as RepoRegistryRow[];
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
 * Resolve the best snapshot to serve. Tries the most recently active repo's
 * dashboard.json first, then falls back to the static launch path.
 */
export function resolveSnapshot(
	staticSnapshotPath: string,
	staticStateDir: string,
): ResolvedSnapshot {
	// 1. The launch dir's OWN snapshot is "this session" — the pi process that
	//    launched this dashboard is the session you are coding in. It wins over
	//    any other repo regardless of last_seen, so a more-recently-active OTHER
	//    repo can't steal the "this session" slot and demote your actual session
	//    to a duplicate "other" gauge.
	if (existsSync(staticSnapshotPath)) {
		const launchSnap = readSnapshot(staticSnapshotPath);
		if (launchSnap.updatedAt) {
			return { snapshot: launchSnap, stateDir: staticStateDir };
		}
	}
	// 2. Fall back to the most recently active OTHER repo (launch dir had no
	//    live snapshot yet).
	const activeDir = mostRecentOtherRepoStateDir(staticStateDir);
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
