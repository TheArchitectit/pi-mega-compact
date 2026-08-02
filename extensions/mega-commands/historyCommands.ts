/**
 * mega-commands/historyCommands.ts — the checkpoint history/inspection commands.
 *
 * Extracted from mega-commands.ts (delegate-shell split). Registers
 * /mega-restore, /mega-history, /mega-view, and /mega-help.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeSessionId } from "../../src/store.js";
import { listCheckpoints } from "../../src/store/sqlite.js";
import { decompressSmart } from "../../src/store/compression.js";
import { type MegaRuntime, C } from "../mega-runtime.js";
import { findCheckpoint } from "./helpers.js";

/** Register the checkpoint history/inspection commands. */
export function registerHistoryCommands(
	pi: ExtensionAPI,
	runtime: MegaRuntime,
): void {
	pi.registerCommand("mega-restore", {
		description: "Re-inject a checkpoint's verbatim original region into context. Usage: /mega-restore <chkpt|recent>",
		handler: async (args: string, ctx: ExtensionContext) => {
		 try {
		  runtime.bindRepo(ctx.cwd);
		  const sid = normalizeSessionId(ctx.sessionManager.getSessionId());
		  const cp = findCheckpoint(runtime, sid, args.trim());
		  if (!cp) {
		    ctx.ui.notify(`[mega-compact] no checkpoint found${args.trim() ? ` for "${args.trim()}"` : ""} in this session. Try /mega-history.`);
		    return;
		  }
		  if (!cp.compressedOriginal) {
		    ctx.ui.notify(`[mega-compact] ${cp.checkpointId} has no recoverable original (pre-blob or direct add). Cannot restore verbatim.`);
		    return;
		  }
		  const original = decompressSmart(cp.compressedOriginal).toString("utf-8");
		  // Re-inject verbatim via before_agent_start (PREVENT-PI-003) — never
		  // touches live messages, only prepends the restored region to systemPrompt.
		  runtime.pendingRecallBlock = `The following compacted context was RESTORED from checkpoint ${cp.checkpointId} (verbatim original region):\n\n${original}`;
		  const files = cp.filesModified?.length ? cp.filesModified.join(", ") : "(no files captured)";
		  ctx.ui.notify(
		    `[mega-compact] ♻ restored ${cp.checkpointId} — ${original.length} chars re-injected on next turn.\n` +
		    `[mega-compact] files: ${files}`,
		  );
		  runtime.dashboard.event("restore", { checkpointId: cp.checkpointId, chars: original.length });
		 } catch (e) {
		   ctx.ui.notify(`[mega-compact] /mega-restore failed (checkpoint may be corrupt): ${String(e)}`);
		 }
		},
	});

	pi.registerCommand("mega-history", {
		description: "List this session's checkpoints (id, date, files, tokens). Usage: /mega-history",
		handler: async (_args: string, ctx: ExtensionContext) => {
		  runtime.bindRepo(ctx.cwd);
		  const sid = normalizeSessionId(ctx.sessionManager.getSessionId());
		  const all = listCheckpoints(sid, runtime.currentStateDir);
		  if (all.length === 0) {
		    ctx.ui.notify("[mega-compact] no checkpoints in this session yet.");
		    return;
		  }
		  const rows = all.map((c) => {
		    const when = c.timestamp ? new Date(c.timestamp).toISOString().slice(0, 16).replace("T", " ") : "—";
		    const files = c.filesModified?.length ? c.filesModified.map((f) => f.split("/").pop() ?? f).join(", ") : "—";
		    const orig = c.originalTokenEstimate ?? 0;
		    const stored = c.tokenEstimate ?? 0;
		    const saved = Math.max(0, orig - stored);
		    return `  ${c.checkpointId}  ${when}  ${C.cyan}${saved}t saved${C.reset}  ${files}`;
		  });
		  ctx.ui.notify(
		    `[mega-compact] ${all.length} checkpoint(s) in this session:\n` + rows.join("\n") +
		    `\n[mega-compact] /mega-view <chkpt> to see the original region · /mega-restore <chkpt> to re-inject it`,
		  );
		},
	});

	pi.registerCommand("mega-view", {
		description: "Show a checkpoint's verbatim original region. Usage: /mega-view <chkpt|recent>",
		handler: async (args: string, ctx: ExtensionContext) => {
		 try {
		  runtime.bindRepo(ctx.cwd);
		  const sid = normalizeSessionId(ctx.sessionManager.getSessionId());
		  const cp = findCheckpoint(runtime, sid, args.trim());
		  if (!cp) {
		    ctx.ui.notify(`[mega-compact] no checkpoint found${args.trim() ? ` for "${args.trim()}"` : ""}. Try /mega-history.`);
		    return;
		  }
		  if (!cp.compressedOriginal) {
		    ctx.ui.notify(`[mega-compact] ${cp.checkpointId} summary:\n${cp.summary.slice(0, 500)}${cp.summary.length > 500 ? "…" : ""}\n(no verbatim original stored)`);
		    return;
		  }
		  const original = decompressSmart(cp.compressedOriginal).toString("utf-8");
		  ctx.ui.notify(
		    `[mega-compact] ${cp.checkpointId} — original region (${original.length} chars):\n` +
		    `${original.slice(0, 1500)}${original.length > 1500 ? "\n…(truncated)" : ""}`,
		  );
		 } catch (e) {
		   ctx.ui.notify(`[mega-compact] /mega-view failed (checkpoint may be corrupt): ${String(e)}`);
		 }
		},
	});

	pi.registerCommand("mega-help", {
		description: "Plain-language glossary of what mega-compact's stats mean.",
		handler: async (_args: string, ctx: ExtensionContext) => {
		  ctx.ui.notify(
		    `[mega-compact] glossary — what the numbers mean:\n` +
		    `• token — a chunk of text (~4 chars). Context window = how much text fits in memory at once.\n` +
		    `• space freed — how much conversation we've compressed away to make room (the win).\n` +
		    `• memory held — how much compact summary we're currently keeping as your 'notes'.\n` +
		    `• saved checkpoint — a compact summary of an old conversation chunk we stored.\n` +
		    `• repeat-skipped — how often new text matched something we already had, so we didn't store a duplicate.\n` +
		    `• injected — times we pasted an old saved note back into the chat because it was relevant.\n` +
		    `• recall relevance — of those, how often the note was actually on-topic.\n` +
		    `• data safety — every compressed region is kept verbatim; nothing is permanently deleted. /mega-restore brings any of it back.`,
		  );
		},
	});
}
