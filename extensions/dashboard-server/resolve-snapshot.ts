/**
 * dashboard-server/resolve-snapshot.ts — dynamic per-repo snapshot resolver.
 *
 * The dashboard server is launched with a single static stateDir, but the
 * active pi session may be running in a different repo. This module queries
 * the repo registry to find the most recently active repo's dashboard.json,
 * so the Overview always shows live data from the repo pi is actually running
 * in.
 *
 * The launch stateDir is a candidate like any other (NOT excluded): when
 * `/dashboard` was run in the repo you are still coding in, the launch dir
 * IS the most-recently-active repo and must win. Excluding it would serve a
 * stale other-repo snapshot, surfacing a phantom 0% "this session" gauge
 * plus a duplicate live-session gauge.
 *
 * Resolution order:
 * 1. Most recently seen repo (by last_seen in repo_registry, launch dir
 *    included) whose dashboard.json exists and has a non-null updatedAt
 * 2. The static launch stateDir's dashboard.json (original behavior)
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
 * Find the most recently active repo's stateDir by scanning the repo registry
 * for the repo with the highest last_seen whose dashboard.json exists and has
 * a non-null updatedAt. Returns null if no suitable repo is found.
 *
 * The launch stateDir is NOT excluded: if it is itself the most-recently-active
 * repo (the common case — `/dashboard` was run in the repo you are still
 * coding in), its live dashboard.json must be served. Excluding it would cause
 * a stale *other*-repo snapshot to win, producing a phantom 0% "this session"
 * gauge + a duplicate live-session gauge.
 */
function mostRecentRepoStateDir(_staticStateDir: string): string | null {
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
 * Resolve the best snapshot to serve. Tries the most recently active repo's
 * dashboard.json first, then falls back to the static launch path.
 */
export function resolveSnapshot(
	staticSnapshotPath: string,
	staticStateDir: string,
): ResolvedSnapshot {
	// Try the most recently active repo first.
	const activeDir = mostRecentRepoStateDir(staticStateDir);
	if (activeDir) {
		const activePath = join(activeDir, "dashboard.json");
		const snap = readSnapshot(activePath);
		if (snap.updatedAt) {
			return { snapshot: snap, stateDir: activeDir };
		}
	}
	// Fall back to the static launch path.
	return {
		snapshot: readSnapshot(staticSnapshotPath),
		stateDir: staticStateDir,
	};
}
