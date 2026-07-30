/**
 * pi-mega-compact — layered, local, vector-backed context compressor.
 *
 * Extension entry. Wires the pi-agnostic Trident engine (src/) into pi's
 * extension lifecycle.
 *
 * Design constraints (from RESEARCH.md):
 *  - No network at runtime (PREVENT-PI-004).
 *  - pi Message has no system-role entry (PREVENT-PI-003); inject compacted
 *    context via `before_agent_start` systemPrompt (Sprint 4), or a
 *    `compactionSummary` message so it renders like native compaction.
 *  - Message drops must preserve an anchor floor (PREVENT-PI-001) and never
 *    split a toolCall/toolResult pair (PREVENT-PI-002).
 *
 * The extension is split into focused modules under extensions/mega-*.ts:
 *   - mega-config.ts        tiers, env helpers, loadConfig, per-repo scoping
 *   - mega-dashboard.ts     live snapshot writer (dashboard.json / events.log)
 *   - mega-runtime.ts       shared live state (MegaRuntime) + widget + model capture
 *   - mega-pipeline.ts      runCompact (Trident+persist) + doRecall (Layer 5)
 *   - mega-commands.ts      data/inspection slash commands
 *   - mega-game-cmds.ts     /mega-compact-settings (+ /mega-game alias) toggle + theme + TUI display mode
 *   - mega-dashboard-cmds.ts  localhost dashboard server lifecycle commands
 *   - mega-events.ts        pi lifecycle event handlers
 *
 * This file is the thin wiring layer: it owns the default export, constructs
 * the runtime, and registers handlers/commands. Behavior is unchanged.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { closeVectorIndex } from "../src/store/vectorIndex.js";
import { closeMemoryIndex } from "../src/store/memoryIndex.js";
import { loadConfig } from "./mega-config.js";
import { MegaRuntime } from "./mega-runtime.js";
import { registerEventHandlers } from "./mega-events.js";
import { registerCommands } from "./mega-commands.js";
import { registerDashboardCommands } from "./mega-dashboard-cmds.js";
import { registerConflictCommands } from "./mega-conflict-cmds.js";
import { registerDbCommands } from "./mega-db-cmds.js";
import { registerGameCommands } from "./mega-game-cmds.js";
import { registerMetricsCommands } from "./mega-metrics-cmds.js";
import { registerTopicsCommands } from "./mega-topics-cmds.js";

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	// S38.9: preflight env validation — check for obviously invalid values at startup.
	// Non-fatal: log warnings and fall back to defaults.
	if (config.autoRetryTransientMax < 0) {
		console.warn(
			"[mega-compact] MEGACOMPACT_AUTO_RETRY_TRANSIENT_MAX must be >= 0; using default 5",
		);
		config.autoRetryTransientMax = 5;
	}
	if (config.autoRetryPermanentMax < 0) {
		console.warn(
			"[mega-compact] MEGACOMPACT_AUTO_RETRY_PERMANENT_MAX must be >= 0; using default 1",
		);
		config.autoRetryPermanentMax = 1;
	}
	if (config.maxConsecutiveErrors < 1) {
		console.warn(
			"[mega-compact] MEGACOMPACT_MAX_CONSECUTIVE_ERRORS must be >= 1; using default 10",
		);
		config.maxConsecutiveErrors = 10;
	}
	// R2: session-global cap validation — 0 disables (valid), negative is invalid.
	if (config.errorRetrySessionMax < 0) {
		console.warn(
			"[mega-compact] MEGACOMPACT_ERROR_RETRY_SESSION_MAX must be >= 0; using default 3",
		);
		config.errorRetrySessionMax = 3;
	}
	// R1: backoff base must be >= 0 (0 means no gating, useful for tests).
	if (config.errorRetryBackoffMs < 0) {
		console.warn(
			"[mega-compact] MEGACOMPACT_ERROR_RETRY_BACKOFF_MS must be >= 0; using default 5000",
		);
		config.errorRetryBackoffMs = 5000;
	}
	// R3: repeat threshold must be >= 1.
	if (config.poisonedContextRepeatThreshold < 1) {
		console.warn(
			"[mega-compact] MEGACOMPACT_POISONED_REPEAT_THRESHOLD must be >= 1; using default 3",
		);
		config.poisonedContextRepeatThreshold = 3;
	}
	// E1: recall dedup thresholds must be in range — out-of-range values silently
	// disable recall dedup. dedupSim ∈ (0,1], crossRepoCosine ∈ [0,1].
	if (!(config.dedupSim > 0 && config.dedupSim <= 1)) {
		console.warn(
			"[mega-compact] MEGACOMPACT_DEDUP_SIM must be in (0,1]; using default 0.9",
		);
		config.dedupSim = 0.9;
	}
	if (!(config.crossRepoCosine >= 0 && config.crossRepoCosine <= 1)) {
		console.warn(
			"[mega-compact] MEGACOMPACT_CROSSREPO_COSINE must be in [0,1]; using default 0.9",
		);
		config.crossRepoCosine = 0.9;
	}
	const runtime = new MegaRuntime(config);
	registerEventHandlers(pi, runtime, config);
	registerCommands(pi, runtime, config);
	registerDashboardCommands(pi, runtime);
	registerConflictCommands(pi, runtime);
	registerDbCommands(pi, runtime);
	registerMetricsCommands(pi, runtime, config);
	registerGameCommands(pi, runtime);
	registerTopicsCommands(pi, runtime, config);
	// v0.8.5 (audit P3): release the fs.watch game-state watcher handle on
	// session teardown so it doesn't linger across reloads. pi exposes no
	// extension-unload event (the factory return value is ignored and there is no
	// "shutdown" event on the ExtensionAPI), so dispose() is wired to the
	// session_shutdown lifecycle event — the closest valid teardown signal.
	// dispose() is idempotent, and the next snapshot() re-opens the watcher
	// lazily via bindRepo() → ensureGameStateWatcher(), so there is no permanent
	// leak and no per-session fd accumulation.
	// The PGlite indexes (vectorIndex / memoryIndex) are lazily opened module
	// singletons. closeVectorIndex()/closeMemoryIndex() existed but had no
	// non-test callers, so a session left both open: PGlite is WASM Postgres and
	// its handles keep node's event loop alive, so `pi -p` produced its answer
	// and then hung until killed rather than exiting. dispose() only released the
	// fs.watch handle and the perf interval, neither of which was the culprit
	// (the interval is unref'd).
	//
	// Both closes are idempotent and safe when the index was never opened, and
	// the next initVectorIndex()/initMemoryIndex() re-opens lazily.
	pi.on("session_shutdown", async () => {
		runtime.dispose();
		await Promise.all([closeVectorIndex(), closeMemoryIndex()]);
	});
}
