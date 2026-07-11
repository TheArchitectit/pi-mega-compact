/**
 * pi-mega-compact — layered, local, vector-backed context compressor.
 *
 * Entry point. Wires the Trident completion engine (src/) into pi's extension
 * lifecycle. Sprint 0 scaffolds the wiring; the compaction/recall engine is
 * filled in across Sprints 1–4. See PLAN.md / SPRINT_PLAN.md / RESEARCH.md.
 *
 * Design constraints (from RESEARCH.md):
 *  - No network at runtime (PREVENT-PI-004).
 *  - pi Message has no system-role entry (PREVENT-PI-003); inject context via
 *    before_agent_start systemPrompt instead.
 *  - Message drops must preserve an anchor floor (PREVENT-PI-001) and never
 *    split a toolCall/toolResult pair (PREVENT-PI-002).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";

const STATUS_KEY = "mega-compact";
const STATE_DIR = join(homedir(), ".pi", "agent", "extensions", "mega-compact");

function envFlag(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function loadConfig() {
  return {
    fastGatePct: Number(envFlag("MEGACOMPACT_FAST_GATE_PCT", "70")),
    thresholdTokens: Number(envFlag("MEGACOMPACT_THRESHOLD_TOKENS", "50000")),
    anchorUserMessages: Number(envFlag("MEGACOMPACT_ANCHOR_USER_MESSAGES", "3")),
    preserveRecent: Number(envFlag("MEGACOMPACT_PRESERVE_RECENT", "4")),
    auto: envFlag("MEGACOMPACT_AUTO", "true") === "true",
    autoInline: envFlag("MEGACOMPACT_AUTO_INLINE", "true") === "true",
    autoInlineK: Number(envFlag("MEGACOMPACT_AUTO_INLINE_K", "3")),
    dedupSim: Number(envFlag("MEGACOMPACT_DEDUP_SIM", "0.95")),
  };
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  function setStatus(ctx: ExtensionContext, text: string | undefined) {
    ctx.ui.setStatus(STATUS_KEY, text);
  }

  // State reset on session start (mirrors neuralwatt-mcr discipline).
  pi.on("session_start", async (_event, ctx) => {
    setStatus(ctx, config.auto ? "mega-compact: ready" : "mega-compact: manual only");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    setStatus(ctx, undefined);
  });

  // Manual commands (full bodies land in Sprint 3–5).
  pi.registerCommand("megacompact", {
    description: "Compress current session context into the local vector store.",
    handler: async (args: string, ctx: ExtensionContext) => {
      ctx.ui.notify(`[mega-compact] /megacompact ${args.trim()} — engine pending (Sprint 3).`);
    },
  });

  pi.registerCommand("recall-context", {
    description: "Recall relevant compacted context from the vector store and inline it.",
    handler: async (args: string, ctx: ExtensionContext) => {
      ctx.ui.notify(`[mega-compact] /recall-context ${args.trim()} — engine pending (Sprint 4).`);
    },
  });

  pi.registerCommand("megacompact-status", {
    description: "Show mega-compact config and current context usage.",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const usage = ctx.getContextUsage();
      const pct = usage?.percent != null ? `${usage.percent}%` : "n/a";
      ctx.ui.notify(
        `[mega-compact] pct=${pct} fastGate=${config.fastGatePct}% ` +
          `threshold=${config.thresholdTokens} auto=${config.auto} autoInline=${config.autoInline} ` +
          `anchor=${config.anchorUserMessages} stateDir=${STATE_DIR}`,
      );
    },
  });

  // Touch the unused config consumers so noUnusedLocals stays happy until the
  // real engine consumes them. (Removed once Sprints wire them in.)
  void readFileSync;
}
