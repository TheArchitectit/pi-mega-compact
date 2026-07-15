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

/** Resolved, frozen-at-load config. tier/thresholdTokens are mutated at
 *  runtime by /mega-tier via `setTier`. */
export interface MegaConfig {
  tier: CompactTier | "custom";
  thresholdTokens: number;
  stateDir: string;
  fastGatePct: number;
  anchorUserMessages: number;
  preserveRecent: number;
  /** High-pressure floor for preserveRecent — when context is near the limit
   *  we compact deeper, but never below this (keeps recent turns for coherence). */
  preserveRecentMin: number;
  auto: boolean;
  autoInline: boolean;
  autoInlineK: number;
  dedupSim: number;
  /** RAPTOR hierarchical recall enabled (Fix D). Drives both live recall and
   *  the durable-trim summary source (root summary). */
  raptorEnabled: boolean;
  /** Token ceiling for the re-injected recall block (Fix C). Recall stops
   *  adding checkpoints once the block would exceed this — bounds read-path
   *  token cost so it can never net-inflate the window. */
  recallMaxTokens: number;
  /** Inline-dedupe recalled checkpoints against the live window (Fix C): drop
   *  a hit whose summary is ≥ dedupSim similar to a live message — "dedupe on
   *  inline/read" so we never re-inject context already resident. */
  windowDedupe: boolean;
  debug: boolean;
}

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

/** Resolve the effective token threshold from TIER (or explicit) env vars. */
function resolveThreshold(): { tier: CompactTier | "custom"; thresholdTokens: number } {
  const explicit = process.env.MEGACOMPACT_THRESHOLD_TOKENS;
  if (explicit != null && explicit !== "") {
    const n = Number(explicit);
    if (Number.isFinite(n)) return { tier: "custom", thresholdTokens: n };
  }
  const raw = (process.env.MEGACOMPACT_TIER ?? "low").toLowerCase();
  const tier = (raw in COMPACT_TIERS ? raw : "low") as CompactTier;
  return { tier, thresholdTokens: COMPACT_TIERS[tier] };
}

/**
 * Pressure helpers for adaptive compression (Fix E) live in src/config.ts
 * (pi-agnostic) so unit tests can import them without the pi runtime. Re-export
 * here so the extension has one import surface.
 */
export { pressureFromPct, preserveRecentForPressure } from "../src/config.js";

/** Build the resolved config from env + defaults. */
export function loadConfig(): MegaConfig {
  const { tier, thresholdTokens } = resolveThreshold();
  return {
    tier,
    // Global default; the live store/dashboard are rebound per-repo at runtime
    // via MegaRuntime.bindRepo() so each git repo gets its own isolated state dir.
    stateDir: process.env.MEGACOMPACT_STATE_DIR ?? STATE_DIR_DEFAULT,
    fastGatePct: envFlag("MEGACOMPACT_FAST_GATE_PCT", 70),
    thresholdTokens,
    anchorUserMessages: envFlag("MEGACOMPACT_ANCHOR_USER_MESSAGES", 3),
    preserveRecent: envFlag("MEGACOMPACT_PRESERVE_RECENT", 4),
    preserveRecentMin: envFlag("MEGACOMPACT_PRESERVE_RECENT_MIN", 2),
    auto: envBool("MEGACOMPACT_AUTO", true),
    autoInline: envBool("MEGACOMPACT_AUTO_INLINE", true),
    autoInlineK: envFlag("MEGACOMPACT_AUTO_INLINE_K", 3),
    dedupSim: Number(process.env.MEGACOMPACT_DEDUP_SIM ?? "0.9"),
    raptorEnabled: envBool("MEGACOMPACT_RAPTOR_ENABLED", true),
    recallMaxTokens: envFlag("MEGACOMPACT_RECALL_MAX_TOKENS", 1500),
    windowDedupe: envBool("MEGACOMPACT_WINDOW_DEDUPE", true),
    debug: envBool("MEGACOMPACT_DEBUG", false),
  };
}

/** Mutate tier + threshold in place (used by /mega-tier at runtime). */
export function setTier(config: MegaConfig, tier: CompactTier): void {
  config.tier = tier;
  config.thresholdTokens = COMPACT_TIERS[tier];
}

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
