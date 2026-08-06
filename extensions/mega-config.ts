/**
 * mega-config.ts — extension config: named compaction tiers, env helpers,
 * config resolution, and per-repo state-dir scoping.
 *
 * Pure/standalone: depends only on node built-ins + src/config. No shared
 * closure state, so it can be imported by the runtime, commands, and events
 * modules without a cycle.
 */

import { STATE_DIR_DEFAULT } from "../src/config.js";
import { join } from "node:path";
import { execSync } from "node:child_process"; // guardrails-allow PREVENT-PI-004: read-only `git rev-parse` to scope the store per-repo
import type { MegaConfig } from "./mega-config-types.js";

/**
 * Named compaction tiers. A tier sets the token threshold at which the
 * auto-trigger persists a checkpoint; pick by how aggressively you want the
 * session trimmed. Explicit MEGACOMPACT_THRESHOLD_TOKENS always wins.
 */
export const COMPACT_TIERS = {
	low: 50_000,
	medium: 100_000,
	high: 200_000,
	ultra: 1_000_000,
	mega: 10_000_000,
} as const;
export type CompactTier = keyof typeof COMPACT_TIERS;

/**
 * Compaction thresholds as a FRACTION of the model's context window (NOT a
 * static token amount). The live + durable trim fire at tier% of the window,
 * so they always fire BELOW pi's native auto-compaction (~80% of window) for
 * any model size (200k or 1M). `custom` (explicit MEGACOMPACT_THRESHOLD_TOKENS)
 * is NOT scaled by this map — it stays an absolute token count.
 */
export const TIER_PCT: Record<CompactTier, number> = {
	low: 0.5,
	medium: 0.6,
	high: 0.7,
	ultra: 0.7,
	mega: 0.75,
};

// MegaConfig type moved to mega-config-types.ts (delegate-shell split, PC-A)
// so this runtime config barrel stays under the 400-line soft limit.
export type { MegaConfig } from "./mega-config-types.js";
function envFlag(name: string, fallback: number): number {
	const v = process.env[name];
	if (v == null || v === "") return fallback;
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}
function envBool(name: string, fallback: boolean): boolean {
	const v = process.env[name];
	if (v == null || v === "") return fallback;
	return v === "true" || v === "1";
}

/**
 * Resolve the effective token threshold from TIER (or explicit) env vars.
 *
 * For a named tier the returned `thresholdTokens` is a BOOT FALLBACK
 * (`round(tierPct * 200_000)`) — sane before any context event reaches the
 * runtime. The true fire point is computed per-window at runtime via
 * `effectiveThresholdTokens(...)`. `custom` (explicit MEGACOMPACT_THRESHOLD_TOKENS)
 * keeps `tierPct: null` and an ABSOLUTE `thresholdTokens` (never percent-scaled).
 */
function resolveThreshold(): {
	tier: CompactTier | "custom";
	tierPct: number | null;
	thresholdTokens: number;
} {
	const explicit = process.env.MEGACOMPACT_THRESHOLD_TOKENS;
	if (explicit != null && explicit !== "") {
		const n = Number(explicit);
		if (Number.isFinite(n))
			return { tier: "custom", tierPct: null, thresholdTokens: n };
	}
	const raw = (process.env.MEGACOMPACT_TIER ?? "low").toLowerCase();
	const tier = (raw in COMPACT_TIERS ? raw : "low") as CompactTier;
	const tierPct = TIER_PCT[tier];
	// Boot fallback: sane gate before the first context event provides a window.
	const thresholdTokens = Math.round(tierPct * 200_000);
	return { tier, tierPct, thresholdTokens };
}

/**
 * Pure helper: the real compaction fire point, given the model context window.
 *
 *   custom           -> explicitThreshold (ABSOLUTE, never percent-scaled)
 *   tiered+window>0  -> round(tierPct * window)
 *   tiered+window<=0 -> fallbackThreshold (boot fallback; no window known yet)
 *
 * This is the single source of truth consumed by the runtime gates
 * (FAST GATE / autoCompactCheck / agent_end durable trigger) and the
 * pressure/armed/ready computations. Keeping it pure makes it trivially
 * unit-testable without the pi runtime.
 */
export function effectiveThresholdTokens(opts: {
	tierPct: number | null;
	fallbackThreshold: number;
	window: number;
	explicitThreshold?: number;
}): number {
	if (opts.tierPct == null) {
		// custom: absolute threshold, never percent-scaled
		return opts.explicitThreshold ?? opts.fallbackThreshold;
	}
	if (opts.window > 0) return Math.round(opts.tierPct * opts.window);
	return opts.fallbackThreshold;
}

/**
 * Resolve the optional manual arming-floor override (MEGACOMPACT_FAST_GATE_PCT).
 * Kept for backward-compat: when unset, the default arming floor equals the
 * tier's percent threshold (tierPct*100) so the dashboard stays consistent;
 * `custom` (tierPct null) falls back to the legacy 70% default.
 */
function resolveFastGatePct(tierPct: number | null): number {
	const raw = process.env.MEGACOMPACT_FAST_GATE_PCT;
	if (raw != null && raw !== "") {
		const n = Number(raw);
		if (Number.isFinite(n)) return n;
	}
	return tierPct != null ? Math.round(tierPct * 100) : 70;
}

/**
 * Pressure helpers for adaptive compression live in src/config.ts (pi-agnostic)
 * so unit tests can import them without the pi runtime. Re-export here so the
 * extension has one import surface. (S24 unified the previously percentage-only
 * signal into pressureRatio/pressureBand, which the runtime uses as the single
 * "how full" signal that drives the tier label, trim depth, and memory cadence.)
 */
export {
	pressureFromPct,
	preserveRecentForPressure,
	pressureRatio,
	pressureBand,
	memoryReviewCadence,
	type PressureBand,
} from "../src/config.js";

/** Build the resolved config from env + defaults. */
export function loadConfig(): MegaConfig {
	const { tier, tierPct, thresholdTokens } = resolveThreshold();
	// S29: optional percent-based fire-point override for tiered configs.
	// null = inherit tierPct (default; preserves existing fire points). Clamped
	// to [0.1, 1] so a bogus env can't disable or invert the gate. Ignored by
	// the `custom` tier (tierPct null) which keeps the absolute token gate.
	const aptRaw = process.env.MEGACOMPACT_AUTO_PCT_TRIGGER;
	const autoPctTrigger =
		aptRaw && aptRaw !== "" && Number.isFinite(Number(aptRaw))
			? Math.min(1, Math.max(0.1, Number(aptRaw)))
			: null;
	return {
		tier,
		tierPct,
		// Global default; the live store/dashboard are rebound per-repo at runtime
		// via MegaRuntime.bindRepo() so each git repo gets its own isolated state dir.
		stateDir: process.env.MEGACOMPACT_STATE_DIR ?? STATE_DIR_DEFAULT,
		fastGatePct: resolveFastGatePct(tierPct),
		thresholdTokens,
		anchorUserMessages: envFlag("MEGACOMPACT_ANCHOR_USER_MESSAGES", 3),
		preserveRecent: envFlag("MEGACOMPACT_PRESERVE_RECENT", 4),
		preserveRecentMin: envFlag("MEGACOMPACT_PRESERVE_RECENT_MIN", 2),
		auto: envBool("MEGACOMPACT_AUTO", true),
		autoInline: envBool("MEGACOMPACT_AUTO_INLINE", true),
		autoContinueLengthStop: envBool(
			"MEGACOMPACT_AUTO_CONTINUE_LENGTH_STOP",
			true,
		),
		autoRetryTransientMax: envFlag("MEGACOMPACT_AUTO_RETRY_TRANSIENT_MAX", 5),
		autoRetryPermanentMax: envFlag("MEGACOMPACT_AUTO_RETRY_PERMANENT_MAX", 1),
		raceGuardStrict: envBool("MEGACOMPACT_RACE_GUARD_STRICT", true),
		maxConsecutiveErrors: envFlag("MEGACOMPACT_MAX_CONSECUTIVE_ERRORS", 10),
		errorRetryHardStop: envBool("MEGACOMPACT_ERROR_RETRY_HARD_STOP", false),
		errorRetryBackoffMs: envFlag("MEGACOMPACT_ERROR_RETRY_BACKOFF_MS", 5000),
		errorRetrySessionMax: envFlag("MEGACOMPACT_ERROR_RETRY_SESSION_MAX", 3),
		poisonedContextRepeatThreshold: envFlag(
			"MEGACOMPACT_POISONED_REPEAT_THRESHOLD",
			3,
		),
		providerOutageAdviseThreshold: envFlag(
			"MEGACOMPACT_PROVIDER_OUTAGE_THRESHOLD",
			3,
		),
		advisoryChannel: envBool("MEGACOMPACT_ADVISORY_CHANNEL", true),
		autoPctTrigger,
		autoInlineK: envFlag("MEGACOMPACT_AUTO_INLINE_K", 3),
		dedupSim: Number(process.env.MEGACOMPACT_DEDUP_SIM ?? "0.9"),
		raptorEnabled: envBool("MEGACOMPACT_RAPTOR_ENABLED", true),
		legacyDurableTrim: envBool("MEGACOMPACT_LEGACY_DURABLE_TRIM", false),
		dbMirror: envBool("MEGACOMPACT_DB_MIRROR", false),
		// S49: isolated per-turn store (turns.db). Default ON. OFF = legacy main-db
		// turn path (S48 behavior). Mirrors src/config/turns.ts TURNS_DB_ENABLED.
		turnsDbEnabled: envBool("MEGACOMPACT_TURNS_DB", true),
		autoWikiEnabled: envBool("MEGACOMPACT_AUTO_WIKI", true),
		crossRepoEnabled: envBool("MEGACOMPACT_CROSSREPO_ENABLED", true),
		crossRepoCosine: Number(process.env.MEGACOMPACT_CROSSREPO_COSINE ?? "0.90"),
		memoryAutoReview: envBool("MEGACOMPACT_MEMORY_AUTO_REVIEW", true),
		memoryReviewInterval: envFlag("MEGACOMPACT_MEMORY_REVIEW_INTERVAL", 10),
		recallMaxTokens: envFlag("MEGACOMPACT_RECALL_MAX_TOKENS", 1500),
		windowDedupe: envBool("MEGACOMPACT_WINDOW_DEDUPE", true),
		recallTailInject: envBool("MEGACOMPACT_RECALL_TAIL_INJECT", true),
		// PC-A: positive sprint flag, default ON. =0 byte-identical to the
		// pre-change OFF state (single gate lives at the call site in tailResult.ts).
		messageSeparation: envBool("MEGACOMPACT_MESSAGE_SEPARATION", true),
			cacheStriping: envBool("MEGACOMPACT_CACHE_STRIPING", false),
		tuiWidget: envBool("MEGACOMPACT_TUI_WIDGET", true),
		ragQueryReformulation: envBool("MEGACOMPACT_QUERY_REFORMULATION", false),
		ragTieredRouter: envBool("MEGACOMPACT_TIERED_ROUTER", false),
		ragRecallMetrics: envBool("MEGACOMPACT_RECALL_METRICS", false),
		ragMemoryGraph: envBool("MEGACOMPACT_MEMORY_GRAPH", false),
		wikiSeedFromTurns: envBool("MEGACOMPACT_WIKI_SEED_FROM_TURNS", true),
		memoryGraphSeedTurns: envBool("MEGACOMPACT_MEMORY_GRAPH_SEED_TURNS", true),
		memoryGraphSeedTurnContent: envBool("MEGACOMPACT_MEMORY_GRAPH_SEED_TURN_CONTENT", true),
		memoryGraphSeedMemories: envBool("MEGACOMPACT_MEMORY_GRAPH_SEED_MEMORIES", true),
		memoryGraphCrossTypeThreshold: envFlag("MEGACOMPACT_MEMORY_GRAPH_CROSS_TYPE_THRESHOLD", 0.85),
		memoryGraphWithinTypeThreshold: envFlag("MEGACOMPACT_MEMORY_GRAPH_WITHIN_TYPE_THRESHOLD", 0.7),
		contextHealth: envBool("MEGACOMPACT_CONTEXT_HEALTH", true),
		contextHealthDrift: envBool("MEGACOMPACT_CONTEXT_HEALTH_DRIFT", true),
		contextHealthOutputQuality: envBool("MEGACOMPACT_CONTEXT_HEALTH_OUTPUT_QUALITY", true),
		contextHealthCachePoison: envBool("MEGACOMPACT_CONTEXT_HEALTH_CACHE_POISON", true),
		contextHealthMitigate: envBool("MEGACOMPACT_CONTEXT_HEALTH_MITIGATE", false),
		// D.1: env-overridable recompact delta (minimum context growth % before
		// re-compacting instead of replaying the cached live trim). Default 50.
		recompactPctDelta: envFlag("MEGACOMPACT_RECOMPACT_PCT_DELTA", 50),
		debug: envBool("MEGACOMPACT_DEBUG", false),
	};
}

/**
 * Remove a cached tier mutation helper here — the live tier the user sees is the
 * pressure band (MegaRuntime.pressureBand), and the base preset is env-resolved
 * at load (loadConfig). The /mega-tier command was removed in S24 so there is no
 * runtime tier mutation; see the S24 spec (docs/specs/s24-unified-pressure.md).
 */

/**
 * Resolve the current repo's git root from a cwd. Returns undefined for a
 * non-git directory (caller falls back to a global state dir).
 */
export function resolveRepoRoot(cwd: string): string | undefined {
	try {
		const out = execSync("git rev-parse --show-toplevel", {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return out || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Per-repo state dir: <repo>/.pi/mega-compact (tracked, so it travels with the
 * repo across devices — not gitignored). Falls back to `fallback` for non-git
 * cwds (the explicit MEGACOMPACT_STATE_DIR override, if set).
 */
export function repoStateDir(cwd: string, fallback: string): string {
	const root = resolveRepoRoot(cwd);
	if (!root) return fallback;
	return join(root, ".pi", "mega-compact");
}
