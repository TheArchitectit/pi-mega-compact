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
			// queries, and future readers. Non-fatal — failure here never breaks
			// the agent loop (PREVENT-PI-004: zero network, local SQLite only).
			{
				const sid = runtime.rt.sessionId;
				const turn = runtime.currentTurn;
				const now = Date.now();
				const threadStmt = db.prepare(
					"INSERT OR IGNORE INTO conversation_thread (conversation_id, role, content, turn_index, timestamp) VALUES (?, ?, ?, ?, ?)",
				);
				const toolStmt = db.prepare(
					"INSERT OR IGNORE INTO tool_results (conversation_id, role, content, turn_index, timestamp) VALUES (?, ?, ?, ?, ?)",
				);
				for (const m of messages) {
					const role = m.role;
					const content = messageContentText(m);
					if (role === "user" || role === "assistant") {
						threadStmt.run(sid, role, content, turn, now);
					} else if (role === "toolResult" || role === "bashExecution") {
						toolStmt.run(sid, role, content, turn, now);
					}
				}
			}
		} catch (e) {
			runtime.logger.warn("db-mirror-append-fail", { error: String(e) });
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
	}
}
