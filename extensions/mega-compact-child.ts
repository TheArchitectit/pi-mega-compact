/**
 * mega-compact-child.ts — minimal extension loaded ONLY into dispatched child
 * pi subprocesses (spawned by ithacus with a second `-e` flag).
 *
 * Design: a child is a FRESH pi process started with `--no-extensions -e <this
 * file>` (see ithacus-spawn.ts). It does NOT receive the parent's MegaConfig and
 * is a separate process, so it reads its two control env vars directly and owns
 * its own bridge. It gives children recall-at-start + compaction-on-shutdown via
 * the mega-compact bridge, with NO tools and NO console output, so it never
 * pollutes the child's `--mode json` JSONL stdout that ithacus-spawn parses.
 *
 * Per the teammate brief this mirrors ithacus-child-mailbox.ts (default export,
 * no console, dispose on session_shutdown) but registers ZERO tools — registering
 * any tool risks a pi duplicate-tool-name hard-fail and children need none.
 *
 * PREVENT-PI-004: no network. The bridge is a same-repo relative import over a
 * local sqlite store; the only I/O is the read-only `git rev-parse` inside
 * repoStateDir. Nothing to flag.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { createMegaBridge } from "../src/bridge.js";
import type {
	MegaBridge,
	BridgeMessage,
} from "../src/bridge.js";
import { repoStateDir } from "./mega-config.js";
import { STATE_DIR_DEFAULT } from "../src/config.js";

/** Default-ON env bool: only `=false`/`=0` disables (matches mega-config envBool). */
function envBool(name: string, fallback: boolean): boolean {
	const v = process.env[name];
	if (v == null || v === "") return fallback;
	return v === "true" || v === "1";
}

/** Extract a recall query from a single AgentMessage (string or content blocks). */
function messageToText(m: { content: unknown }): string {
	const c = (m as { content: unknown }).content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) return c.map((b: { text?: string }) => b.text ?? "").join(" ");
	return "";
}

/** Convert a session's AgentMessages into the bridge's lightweight shape. */
function toBridgeMessages(ctx: ExtensionContext): BridgeMessage[] {
	const out: BridgeMessage[] = [];
	try {
		for (const entry of ctx.sessionManager.getEntries()) {
			for (const m of sessionEntryToContextMessages(entry as never)) {
				if (m.role === "user" || m.role === "assistant") {
					out.push({ role: m.role, text: messageToText(m) });
				}
			}
		}
	} catch {
		/* non-fatal: a child without a session manager yields no messages */
	}
	return out;
}

export default function (pi: ExtensionAPI): void {
	// Flag read at LOAD time: a flag-OFF child registers nothing and a flag-ON
	// child that never fires a hook pays zero cost (bridge is built lazily).
	if (!envBool("MEGACOMPACT_ITHACUS_BRIDGE", true)) return;

	let bridge: MegaBridge | undefined;

	// Build the bridge lazily on first hook fire so cost is opt-in by usage.
	const getBridge = (): MegaBridge => {
		if (!bridge) {
			bridge = createMegaBridge({
				stateDir: repoStateDir(process.cwd(), STATE_DIR_DEFAULT),
			});
		}
		return bridge;
	};

	// S52-style recall injection: prepend staged checkpoints + durable memories
	// to the system prompt, mirroring the main entry's before_agent_start path.
	// 4th-layer stability guard: an unset/empty sessionId makes recall silently
	// useless (the openclaw Date.now() gotcha), so skip outright.
	pi.on("before_agent_start", async (event) => {
		try {
			const sessionId = process.env.ITHACUS_MEGA_SESSION_ID;
			if (!sessionId || sessionId === "") return undefined;

			// Prefer the event's raw prompt; fall back to a generic query.
			const query = event.prompt && event.prompt.trim() ? event.prompt.trim() : "";
			if (query === "") return undefined;

			const b = getBridge();
			const cp = b.recallCheckpoints({ sessionId, query, limit: 3 });
			const mem = await b.recallMemories({ query, limit: 5 });

			const blocks: string[] = [];
			if (!cp.empty && cp.block) blocks.push(cp.block);
			if (!mem.empty && mem.block) blocks.push(mem.block);
			if (blocks.length === 0) return undefined;

			return { systemPrompt: `${event.systemPrompt ?? ""}\n\n${blocks.join("\n\n")}` };
		} catch {
			// layer b: non-fatal — never break the agent loop. No injection.
			return undefined;
		}
	});

	// Compaction on shutdown: persist the session's messages as a checkpoint.
	// Best-effort; non-fatal. Releases the sqlite handle via close().
	// The bridge is constructed lazily here too: a child that only compacts (no
	// recall fired) still persists its session. Best-effort; non-fatal.
	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			const sessionId = process.env.ITHACUS_MEGA_SESSION_ID;
			if (!sessionId || sessionId === "") return;
			const messages = toBridgeMessages(ctx);
			if (messages.length === 0) return;
			await getBridge().compact({ sessionId, messages });
		} catch {
			/* non-fatal */
		} finally {
			if (bridge) {
				bridge.close();
				bridge = undefined;
			}
		}
	});
}
