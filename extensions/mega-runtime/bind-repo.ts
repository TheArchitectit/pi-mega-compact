/**
 * bind-repo.ts — extracted per-repo binding for MegaRuntime.
 *
 * Point store/dashboard/logger at the current repo's state dir. Rebuilds the
 * instances only when the repo root changes, so cross-repo dedup stats, db,
 * and events are fully isolated. Falls back to the global default outside git.
 */

import { join } from "node:path";
import { VectorStore, vectorRepoStats, vectorDataInvariant } from "../../src/vectorStore.js";
import { repoStateDir, resolveRepoRoot } from "../mega-config.js";
import { upsertRepoRegistry } from "../../src/store/sqlite.js";
import { Logger } from "../../src/log.js";
import { Dashboard } from "../mega-dashboard.js";
import type { MegaConfig } from "../mega-config.js";

// ---------------------------------------------------------------------- types

export interface BindRepoContext {
	readonly config: MegaConfig;
	activeRepoRoot: string | null;
	currentStateDir: string;
	store: VectorStore;
	dashboard: Dashboard;
	logger: Logger;
	cachedGameState: import("../../src/store/sqlite.js").GameState | undefined;
	gameStateBump: number;
	ensureGameStateWatcher(): void;
}

// ------------------------------------------------------------------ bindRepo

export function bindRepoImpl(ctx: BindRepoContext, cwd: string | undefined): string {
	const dir = cwd
		? repoStateDir(cwd, ctx.config.stateDir)
		: ctx.config.stateDir;
	const key = cwd ? (resolveRepoRoot(cwd) ?? dir) : dir;
	if (key === ctx.activeRepoRoot) return dir;
	ctx.activeRepoRoot = key;
	ctx.currentStateDir = dir;
	// S31 audit P2: bindRepo switched currentStateDir but left cachedGameState
	// memoized -> the widget kept showing the previous repo's theme/mode/toggle
	// until /mega-game or a restart. The game_state row is per-repo (per
	// stateDir), so evict the memo on every repo switch; the next widget render
	// re-queries lazily via getCachedGameState().
	ctx.cachedGameState = undefined;
	ctx.gameStateBump++;
	// S32: re-target the fs.watch cache-eviction watcher at the NEW stateDir's
	// sqlite.db so cross-process writes (dashboard server) still evict the memo.
	ctx.ensureGameStateWatcher();
	ctx.store = new VectorStore({
		dedupSim: ctx.config.dedupSim,
		stateDir: dir,
	});
	ctx.logger = new Logger({
		enabled: ctx.config.debug,
		path: join(dir, "mega-compact.log"),
	});
	ctx.dashboard = new Dashboard(dir);
	// Aggregate this repo into the machine-wide index so the multi-repo
	// dashboard (Summary / All-repos tabs) can show it alongside every other
	// repo. Best-effort + non-fatal: a read-only index dir or contention must
	// never break the per-repo compaction path. Runs only on repo-switch
	// (this branch), so it's infrequent — not per-context-event.
	try {
		const repo = vectorRepoStats(ctx.store);
		const di = vectorDataInvariant(ctx.store);
		const root = key !== dir ? key : (resolveRepoRoot(cwd ?? dir) ?? dir);
		upsertRepoRegistry({
			repoRoot: root,
			displayName: root.split(/[\\/]/).filter(Boolean).pop() ?? root,
			stateDir: dir,
			checkpointCount: repo.checkpointCount,
			tokensSaved: repo.tokensSaved,
			compressedOriginalBytes: di.compressedOriginalBytes,
		});
	} catch {
		/* non-fatal: index aggregation must not block compaction */
	}
	return dir;
}
