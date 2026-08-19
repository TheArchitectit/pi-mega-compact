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
 * Named compaction tiers — each tier sets the compaction fire point as a
 * FRACTION of the model's context window (NOT a static token amount): the live
 * + durable trim fire at `tier × window`, so they always fire BELOW pi's native
 * auto-compaction (~80% of window) for any model size (200k or 1M). Pick by how
 * aggressively you want the session trimmed. Explicit
 * MEGACOMPACT_THRESHOLD_TOKENS always wins (`custom`, tierPct null — absolute,
 * never percent-scaled). This is the SINGLE source of truth for tier fractions;
 * `keyof typeof COMPACT_TIERS` is the `CompactTier` type and
 * `raw in COMPACT_TIERS` validates a named preset name.
 */
export const COMPACT_TIERS = {
	low: 0.5,
	medium: 0.6,
	high: 0.7,
	ultra: 0.7,
	mega: 0.75,
} as const;
export type CompactTier = keyof typeof COMPACT_TIERS;

/**
 * Boot-fallback context window (env-overridable). Used ONLY as a display/seed
 * placeholder before the first real context event supplies the provider's
 * window — the live fire point (`effectiveThresholdImpl`) DEFERS (returns
 * `+Infinity`) when the window is unknown, so this value is never a guessed
 * gate. Default 200k keeps the display seed stable; set
 * `MEGACOMPACT_DEFAULT_CONTEXT_WINDOW=<tokens>` to repoint it (e.g. for a
 * 32k-model fleet the seed should reflect that).
 */
export const DEFAULT_CONTEXT_WINDOW = envFlag(
	"MEGACOMPACT_DEFAULT_CONTEXT_WINDOW",
	200_000,
);

/**
 * Display seed for the progress-bar "saved tokens goal" denominator. The live
 * value grows dynamically (`run.ts`: `savedGoal = ceil(tokensSaved × 1.25)` once
 * exceeded), so this is only the initial target before the first compaction.
 * Derived from the low-tier fire point at the default window (no bare magic):
 * `COMPACT_TIERS.low × DEFAULT_CONTEXT_WINDOW`. Display-only.
 */
export const DEFAULT_SAVED_GOAL = Math.round(
	COMPACT_TIERS.low * DEFAULT_CONTEXT_WINDOW,
);

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
 * (`round(tierPct * DEFAULT_CONTEXT_WINDOW)`) — sane before any context event
 * reaches the runtime. The true fire point is computed per-window at runtime via
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
	let tierPct: number = COMPACT_TIERS[tier];
	// 3WF-2 threshold invariant: under the umbrella, when no named tier is set
	// the fire point is the configurable % of the ACTUAL model window (default
	// 0.80 — "20% free remaining"). Tiered (named preset) keeps its preset pct;
	// both paths still compute the legacy 200k boot fallback below as a display
	// placeholder + the custom-tier absolute companion. Umbrella OFF stays
	// byte-identical to v0.20.83 (default tier=low 0.5).
	const umbrella = envBool("MEGACOMPACT_THREE_WAY_FAILBACK", true);
	if (umbrella && !(process.env.MEGACOMPACT_TIER && process.env.MEGACOMPACT_TIER !== "")) {
		tierPct = clamp(envFlag("MEGACOMPACT_THRESHOLD_PCT", 0.8), 0.1, 0.95);
	}
	// Boot fallback: sane gate before the first context event provides a window.
	// (NO hardcoded window in the firing path — effectiveThresholdImpl defers
	// when window unknown; this remains only a display placeholder + custom
	// companion under the umbrella.) Env-overridable via
	// MEGACOMPACT_DEFAULT_CONTEXT_WINDOW (see DEFAULT_CONTEXT_WINDOW).
	const thresholdTokens = Math.round(tierPct * DEFAULT_CONTEXT_WINDOW);
	return { tier, tierPct, thresholdTokens };
}

/** Clamp `n` into [lo, hi]; non-finite → fallback. */
function clamp(n: number, lo: number, hi: number): number {
	if (!Number.isFinite(n)) return lo;
	return Math.min(hi, Math.max(lo, n));
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
 * `custom` (tierPct null — an explicit absolute opt-out of percent scaling by
 * design) has no tier fraction to derive from, so it falls back to the named
 * DEFAULT_FAST_GATE_PCT_CUSTOM. Env-overridable like every other default here.
 */
export const DEFAULT_FAST_GATE_PCT_CUSTOM = 70;

function resolveFastGatePct(tierPct: number | null): number {
	const raw = process.env.MEGACOMPACT_FAST_GATE_PCT;
	if (raw != null && raw !== "") {
		const n = Number(raw);
		if (Number.isFinite(n)) return n;
	}
	return tierPct != null ? Math.round(tierPct * 100) : DEFAULT_FAST_GATE_PCT_CUSTOM;
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
		dedupSim: envFlag("MEGACOMPACT_DEDUP_SIM", 0.9),
		raptorEnabled: envBool("MEGACOMPACT_RAPTOR_ENABLED", true),
		legacyDurableTrim: envBool("MEGACOMPACT_LEGACY_DURABLE_TRIM", false),
		dbMirror: envBool("MEGACOMPACT_DB_MIRROR", false),
		// S49: isolated per-turn store (turns.db). Default ON. OFF = legacy main-db
		// turn path (S48 behavior). Mirrors src/config/turns.ts TURNS_DB_ENABLED.
		turnsDbEnabled: envBool("MEGACOMPACT_TURNS_DB", true),
		autoWikiEnabled: envBool("MEGACOMPACT_AUTO_WIKI", true),
		crossRepoEnabled: envBool("MEGACOMPACT_CROSSREPO_ENABLED", true),
		crossRepoCosine: envFlag("MEGACOMPACT_CROSSREPO_COSINE", 0.9),
		// 3WF-3: SAME-repo recall cosine floor applied by the 3-source validator to
		// the top winner. SEPARATE from crossRepoCosine (S17, default 0.90, stricter
		// and cross-repo only). This same-repo floor is permissive by default (0.12)
		// so recall still surfaces loosely-relevant within-repo context while
		// rejecting effectively-unrelated hits. Mirrors src/config.ts RECALL_MIN_COSINE.
		// E1 follow-up (PR #18 review): envFlag (Number.isFinite-guarded) like the
		// dedupSim/crossRepoCosine fix in PR #18 — a typo'd env var must fall back
		// to 0.12, not yield NaN.
		recallMinCosine: envFlag("MEGACOMPACT_RECALL_MIN_COSINE", 0.12),
		memoryAutoReview: envBool("MEGACOMPACT_MEMORY_AUTO_REVIEW", true),
		memoryReviewInterval: envFlag("MEGACOMPACT_MEMORY_REVIEW_INTERVAL", 10),
		recallMaxTokens: envFlag("MEGACOMPACT_RECALL_MAX_TOKENS", 1500),
		windowDedupe: envBool("MEGACOMPACT_WINDOW_DEDUPE", true),
		recallTailInject: envBool("MEGACOMPACT_RECALL_TAIL_INJECT", true),
		// 3WF-1: TriggerGuard — guarantee a staged recall block on every context
		// event even when session_start never fires. Default ON; OFF = byte-identical.
		threeWayFailback: envBool("MEGACOMPACT_THREE_WAY_FAILBACK", true),
		// Sprint A: Mega↔ithacus bridge — gate the child extension + bridge usage.
		// Default ON; OFF (=0/`=false`) = byte-identical pre-bridge behavior.
		// Runtime reads envBool(plain key), mirroring threeWayFailback (plain-write
		// convention, not _DISABLED).
		ithacusBridge: envBool("MEGACOMPACT_ITHACUS_BRIDGE", true),
		// 3WF-2: ThrashGuard re-arm budget as a fraction of effectiveThreshold.
		// 0.10 default (10% of the effective threshold) — see mega-config-types.
		// Clamped to [0.01, 0.5]: below 1% the guard is almost never armed (any
		// growth re-fires, defeating the anti-thrash purpose); above 50% it would
		// suppress legitimate re-fires for half the window. Env-overridable.
		thrashRearmPct: clamp(envFlag("MEGACOMPACT_THRASH_REARM_PCT", 0.1), 0.01, 0.5),
		// PC-A: positive sprint flag, default ON. =0 byte-identical to the
		// pre-change OFF state (single gate lives at the call site in tailResult.ts).
		messageSeparation: envBool("MEGACOMPACT_MESSAGE_SEPARATION", true),
		// positive sprint flag: default ON, =0 byte-identical to OFF
		cacheStriping: envBool("MEGACOMPACT_CACHE_STRIPING", true),
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
