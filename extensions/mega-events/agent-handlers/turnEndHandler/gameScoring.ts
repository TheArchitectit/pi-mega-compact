/**
 * turnEndHandler/gameScoring.ts — S33/S35 game-mode scoring + achievements.
 *
 * Extracted from turnEndHandler.ts (delegate-shell split) to keep every source
 * file under the extensions limit. Records turns + cache metrics per repo, and
 * arms the MEGA CACHE flare (oopsie gag) when the real dedup hit rate exceeds
 * 100%. Gated behind game_mode_on (no scoring when off). Best-effort +
 * non-fatal: a scoring failure must never break the agent loop (G6).
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MegaRuntime } from "../../../mega-runtime.js";
import { resolveRepoRoot } from "../../../mega-config.js";
import { recordScore, readLatestCacheHitPct } from "../../../../src/store/sqlite.js";
import { evaluateAndUnlockAchievements } from "../../../../src/store/sqlite/game-achievements.js";
import { isMegaCache } from "../../../../src/game/scoring.js";
import { vectorStats } from "../../../../src/vectorStore.js";
import type { TurnEndEvent } from "./event.js";

/** S33+S35: game-mode scoring + achievement evaluation. Best-effort. */
export function gameScoring(
	event: TurnEndEvent,
	ctx: ExtensionContext,
	runtime: MegaRuntime,
): void {
	// S33: game-mode scoring — record turns + cache metrics per repo, and arm
	// the MEGA CACHE flare (oopsie gag) when the real dedup hit rate exceeds
	// 100%. Gated behind game_mode_on (no scoring when off). Best-effort +
	// non-fatal: a scoring failure must never break the agent loop (G6).
	try {
		if (runtime.getCachedGameState().game_mode_on) {
			const repo = resolveRepoRoot(ctx.cwd) ?? runtime.currentStateDir;
			const st = vectorStats(runtime.store, runtime.rt.sessionId);
			// C.3: prefer provider cache hit rate, fall back to dedup hit rate
			const providerPct = readLatestCacheHitPct(runtime.currentStateDir);
			const cachePct =
				providerPct != null ? providerPct : st.dedupHitRate * 100;
			const modelId = runtime.currentModel?.modelId ?? "unknown";
			recordScore(runtime.currentStateDir, {
				repo_root: repo,
				metric: "turns",
				value: runtime.currentTurn,
				meta: { modelId, turnIndex: event.turnIndex },
			});
			recordScore(runtime.currentStateDir, {
				repo_root: repo,
				metric: "cache",
				value: cachePct,
				meta: {
					hits: st.dedupCollapsed + runtime.rt.recallInjections,
					lookups: st.checkpointCount,
				},
			});
			// MEGA CACHE: the real ratio >1 (dedupHitRate>1) → trophy row + flare.
			if (isMegaCache(cachePct)) {
				recordScore(runtime.currentStateDir, {
					repo_root: repo,
					metric: "mega_cache",
					value: cachePct,
					meta: { peakPct: cachePct, firstSeenTs: Date.now() },
				});
				runtime.armMegaCacheFlare(cachePct);
			}
			// S35: evaluate achievements after scoring; arm a one-time flare for
			// the newly-unlocked ones (consumed by snapshot() → widget toast).
			const newTitles = evaluateAndUnlockAchievements(
				runtime.currentStateDir,
			);
			if (newTitles.length) runtime.armAchievementFlare(newTitles);
		}
	} catch {
		/* non-fatal: scoring must never break the agent loop */
	}
}
