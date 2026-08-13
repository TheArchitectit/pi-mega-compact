/**
 * context-handler/dbMirrorAppend.ts — DB-mirror append + VC1B ledger append.
 *
 * Extracted from context-handler.ts (delegate-shell split). Appends incoming
 * messages to raw_transcript (S27) + conversation_thread/tool_results (P2.2),
 * then appends canonical messages to the v2 vector-cortex ledger (VC1B S1).
 * All best-effort + non-fatal — a failure never breaks the agent loop
 * (PREVENT-PI-004: zero network, local SQLite only).
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { openStore } from "../../../src/store/sqlite.js";
import { appendMirrorMessages } from "../mirror-append.js";
import { appendMessagesToLedger } from "../../mega-runtime/vector-cortex-ledger.js";
import { epochIdFor } from "../../../src/mirror/epoch.js";
import type { MegaRuntime } from "../../mega-runtime.js";
import type { MegaConfig } from "../../mega-config.js";
import { messageContentText } from "./messageText.js";

/**
 * Best-effort tool_call_id for the tool_results insert. The toolResult variant
 * carries a top-level toolCallId (read via an `unknown`-narrowed cast — never
 * reach into `.content`, which is variant-specific and requires narrowing).
 * bashExecution has no toolCallId, so fall back to a stable synthetic id keyed
 * on (turn, index) to satisfy the NOT NULL column. No `any` (PREVENT-011).
 */
function toolCallIdOf(m: AgentMessage, fallback: string): string {
	if (m.role === "toolResult") {
		const id = (m as unknown as { toolCallId?: unknown }).toolCallId;
		if (typeof id === "string" && id.length > 0) return id;
	}
	return fallback;
}

/**
 * Append incoming messages to the DB mirror (raw_transcript + thread/tool
 * tables) and the v2 ledger. Gated on config.dbMirror for the mirror; the VC1B
 * ledger append is flag-gated inside appendMessagesToLedger (flag-OFF opens no
 * DB, byte-identical to the predecessor). Non-fatal end-to-end.
 */
export function appendMirrorAndLedger(
	runtime: MegaRuntime,
	config: MegaConfig,
	messages: AgentMessage[],
): void {
	// S27 DB-mirror: append incoming messages to raw_transcript.
	// Runs BEFORE fast-gate so every message is captured, even if we
	// don't compact this turn. Append is idempotent (content_hash PK).
	// F3: high-water mark (mirror-append.ts) skips already-processed
	// messages on subsequent events. On fork/rewind (shorter list or
	// boundary hash mismatch) the mark is dropped, falling back to a
	// full reprocess.
	if (config.dbMirror) {
		try {
			const db = openStore(runtime.currentStateDir);
			appendMirrorMessages(
				db,
				messages,
				runtime.rt.sessionId,
				epochIdFor(runtime.rt.sessionId),
				runtime.currentTurn,
			);
			// P2.2: populate conversation_thread + tool_results tables for
			// prompt-cache analytics and durable separation. The live-array
			// separation (buildSeparatedPrompt / buildCacheOptimizedPrompt in
			// tailResult) is sufficient for the prompt-construction path;
			// these DB writes persist the split for post-hoc analysis, dashboard
			// queries, and future readers. Gated on (messageSeparation ||
			// cacheStriping) so flag-OFF remains byte-identical to the
			// predecessor — when both flags are OFF the live prompt is never
			// separated, and growing these tables would be dead state.
			// Non-fatal — failure here never breaks the agent loop
			// (PREVENT-PI-004: zero network, local SQLite only).
			if (config.messageSeparation || config.cacheStriping) {
				const sid = runtime.rt.sessionId;
				const turn = runtime.currentTurn;
				const now = Date.now();
				const threadStmt = db.prepare(
					"INSERT OR IGNORE INTO conversation_thread (conversation_id, role, content, turn_index, timestamp) VALUES (?, ?, ?, ?, ?)",
				);
				// Schema (plan-v2.ts) is (conversation_id, tool_call_id,
				// tool_result, turn_index, timestamp) — NOT role/content.
				const toolStmt = db.prepare(
					"INSERT OR IGNORE INTO tool_results (conversation_id, tool_call_id, tool_result, turn_index, timestamp) VALUES (?, ?, ?, ?, ?)",
				);
				const toolHas = db.prepare(
					"SELECT 1 FROM tool_results WHERE conversation_id = ? AND turn_index = ? AND tool_call_id = ? AND tool_result = ? LIMIT 1",
				);
				const threadHas = db.prepare(
					"SELECT 1 FROM conversation_thread WHERE conversation_id = ? AND turn_index = ? AND role = ? AND content = ? LIMIT 1",
				);
				for (const [idx, m] of messages.entries()) {
					const role = m.role;
					const content = messageContentText(m);
					if (role === "user" || role === "assistant") {
						if (threadHas.get(sid, turn, role, content) == null) {
							threadStmt.run(sid, role, content, turn, now);
						}
					} else if (role === "toolResult" || role === "bashExecution") {
						const toolCallId = toolCallIdOf(m, `bash:${turn}:${idx}`);
						if (toolHas.get(sid, turn, toolCallId, content) == null) {
							toolStmt.run(sid, toolCallId, content, turn, now);
						}
					}
				}
			}
		} catch (e) {
			runtime.logger.warn("db-mirror-append-fail", { error: String(e) });
			// Sprint H (Option A): raw_transcript / thread / tool_results write
			// failure — internal store write. Feed the `storeErrorRate` axis.
			runtime.recordInternalError("store_write");
		}
	}

	// VC1B (S1): canonical messages -> v2 ledger occurrences. Flag-OFF opens
	// no DB (byte-identical predecessor); non-fatal. onFailure surfaces
	// per-append rejections (e.g. EVT_SEQ_REGRESSION on rewind/fork) as
	// structured warnings rather than swallowing them silently.
	try {
		appendMessagesToLedger(
			runtime.currentStateDir,
			runtime.rt.sessionId,
			messages,
			runtime.logger,
		);
	} catch (e) {
		runtime.logger.warn("vc1b-ledger-append-fail", { error: String(e) });
		// Sprint H (Option A): the v2 vector-cortex ledger append is a cortex
		// write — this is the host-side hook for the cortex seam (the cortex
		// contract forbids the store from holding a runtime handle, so the ring
		// push happens here in the adapter, not inside src/vector-cortex).
		runtime.recordInternalError("vector_index");
	}
}
