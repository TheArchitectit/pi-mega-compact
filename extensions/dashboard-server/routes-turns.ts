/**
 * routes-turns.ts — S52 turn-by-turn memory tracking + recall + rewind routes.
 *
 * GET  /api/turns                         — conversation list (turns tab payload)
 * GET  /api/turns/conversation/:convId    — per-turn detail + recall provenance
 * GET  /api/turns/intents                 — pending rewind intents (S52A)
 * POST /api/turns/intent                  — post a rewind intent
 * POST /api/fork                          — fork a conversation at a turn
 * POST /api/turns/prune                   — admin prune (capability-gated)
 * POST /api/turns/vacuum                  — admin vacuum
 *
 * Capability-gated per the S49 contract: display via `asReader()`, prune/vacuum
 * via `asAdmin()`, fork via `asWriter()`. Read-mostly. The store never calls
 * back into the host (ledger protocol). Loopback-only (PREVENT-PI-004).
 * Parameterized (PREVENT-002).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { createTurnStore } from "../../src/store/turns/index.js";
import { openTurnStore } from "../../src/store/turns/connection.js";
import { openIntentQueue } from "../../src/intent.js";
import { forkFromConversation } from "../../src/fork.js";
import type {
	TurnsResponse,
	ConversationTurnsResponse,
	ConversationSummary,
	TurnRow,
	RecallHit,
	RewindIntentsResponse,
	ForkResponse,
	PostIntentRequest,
	PruneTurnsResponse,
} from "./api-contracts/turns.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" }); // guardrails-allow PREVENT-PI-004: loopback dashboard response (local)
	res.end(JSON.stringify(body));
}

/** Read a capped JSON body; returns { ok, value } or { error }. */
function readJsonBody(
	req: IncomingMessage,
	cb: (result: { ok: true; value: Record<string, unknown> } | { ok: false; error: string }) => void,
): void {
	let body = "";
	let tooBig = false;
	req.on("data", (chunk: Buffer) => {
		if (body.length > 65536) {
			tooBig = true;
			return;
		}
		body += chunk.toString();
	});
	req.on("end", () => {
		if (tooBig) return cb({ ok: false, error: "body_too_large" });
		try {
			const v = body ? JSON.parse(body) : {};
			if (typeof v !== "object" || v === null || Array.isArray(v)) {
				return cb({ ok: false, error: "invalid_object" });
			}
			cb({ ok: true, value: v as Record<string, unknown> });
		} catch {
			cb({ ok: false, error: "invalid_json" });
		}
	});
}

export function handleTurns(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RouteContext,
): boolean {
	const url = req.url ?? "";
	if (!url.startsWith("/api/turns") && url !== "/api/fork") return false;

	// ── GET /api/turns — conversation list ─────────────────────────────
	if (req.method === "GET" && url === "/api/turns") {
		try {
			const store = createTurnStore({ stateDir: ctx.stateDir });
			const reader = store.asReader();
			// Enumerate conversations via session_conversations + a distinct scan.
			const tdb = openTurnStore(ctx.stateDir);
			const convRows = tdb
				.prepare(
					`SELECT DISTINCT conversation_id FROM turns ORDER BY conversation_id ASC`,
				)
				.all() as Array<{ conversation_id: string }>;
			const conversations: ConversationSummary[] = convRows.map((r) => {
				const stats = reader.conversationStats(r.conversation_id);
				const epochCount = (
					tdb
						.prepare(
							"SELECT COUNT(DISTINCT epoch_id) AS c FROM turns WHERE conversation_id = ? AND epoch_id IS NOT NULL",
						)
						.get(r.conversation_id) as { c: number }
				).c;
				const totalRecall = (
					tdb
						.prepare(
							`SELECT COUNT(*) AS c FROM turn_recall tr JOIN turns t ON tr.turn_id = t.id
							WHERE t.conversation_id = ?`,
						)
						.get(r.conversation_id) as { c: number }
				).c;
				return {
					conversationId: r.conversation_id,
					turnCount: stats.turnCount,
					firstTurnAt: stats.firstTurnAt,
					lastTurnAt: stats.lastTurnAt,
					avgCtxPercent: stats.avgCtxPercent,
					epochCount,
					totalRecall,
				};
			});
			// Active conversation = the one with the most recent turn across all.
			let activeConversationId: string | null = null;
			let lastSeen = 0;
			for (const c of conversations) {
				if (c.lastTurnAt > lastSeen) {
					lastSeen = c.lastTurnAt;
					activeConversationId = c.conversationId;
				}
			}
			sendJson(res, 200, { conversations, activeConversationId } satisfies TurnsResponse);
			return true;
		} catch (e) {
			sendJson(res, 500, { error: String(e) });
			return true;
		}
	}

	// ── GET /api/turns/conversation/:convId — per-turn detail + recall ─
	const convMatch =
		req.method === "GET"
			? url.match(/^\/api\/turns\/conversation\/([^/?]+)$/)
			: null;
	if (convMatch) {
		try {
			const convId = decodeURIComponent(convMatch[1]);
			const store = createTurnStore({ stateDir: ctx.stateDir });
			const reader = store.asReader();
			const entries = reader.query({ conversationId: convId, limit: 10000 });
			const turns: TurnRow[] = entries.map((e) => ({
				turnIndex: e.turnIndex,
				conversationId: e.conversationId,
				sessionId: e.sessionId,
				role: e.role,
				endedAt: e.endedAt,
				ctxTokens: e.ctxTokens ?? null,
				ctxPercent: e.ctxPercent ?? null,
				pressureBand: e.pressureBand ?? null,
				model: e.model ?? null,
				epochId: e.epochId ?? null,
				recall: reader
					.listRecallByIndex(convId, e.turnIndex)
					.map((r): RecallHit => ({
						checkpointId: r.checkpointId,
						score: r.score,
						source: r.source,
						raptorLevel: r.raptorLevel ?? null,
					})),
			}));
			sendJson(res, 200, { conversationId: convId, turns } satisfies ConversationTurnsResponse);
			return true;
		} catch (e) {
			sendJson(res, 500, { error: String(e) });
			return true;
		}
	}

	// ── GET /api/turns/intents — pending rewind intents ───────────────
	if (req.method === "GET" && url === "/api/turns/intents") {
		try {
			const tdb = openTurnStore(ctx.stateDir);
			const q = openIntentQueue(tdb);
			const intents = q.pendingIntents().map((i) => ({
				id: i.id,
				conversationId: i.conversationId,
				targetTurnIndex: i.targetTurnIndex,
				createdAt: i.createdAt,
				status: i.status,
			}));
			sendJson(res, 200, { intents } satisfies RewindIntentsResponse);
			return true;
		} catch (e) {
			sendJson(res, 500, { error: String(e) });
			return true;
		}
	}

	// ── POST /api/turns/intent — post a rewind intent ─────────────────
	if (req.method === "POST" && url === "/api/turns/intent") {
		readJsonBody(req, (result) => {
			if (!result.ok) return sendJson(res, 400, { error: result.error });
			const v = result.value;
			const conversationId = typeof v.conversationId === "string" ? v.conversationId : "";
			const targetTurnIndex = typeof v.targetTurnIndex === "number" ? v.targetTurnIndex : -1;
			if (!conversationId || targetTurnIndex < 0) {
				return sendJson(res, 400, { error: "missing_conversationId_or_targetTurnIndex" });
			}
			try {
				const tdb = openTurnStore(ctx.stateDir);
				const q = openIntentQueue(tdb);
				const intent = q.postIntent({ conversationId, targetTurnIndex } satisfies PostIntentRequest);
				sendJson(res, 201, intent);
			} catch (e) {
				sendJson(res, 500, { error: String(e) });
			}
		});
		return true;
	}

	// ── POST /api/fork — fork a conversation at a turn ─────────────────
	if (req.method === "POST" && url === "/api/fork") {
		readJsonBody(req, (result) => {
			if (!result.ok) return sendJson(res, 400, { error: result.error });
			const v = result.value;
			const conversationId = typeof v.conversationId === "string" ? v.conversationId : "";
			const turnIndex = typeof v.turnIndex === "number" ? v.turnIndex : -1;
			if (!conversationId || turnIndex < 0) {
				return sendJson(res, 400, { error: "missing_conversationId_or_turnIndex" });
			}
			try {
				const store = createTurnStore({ stateDir: ctx.stateDir });
				const out = forkFromConversation(store, conversationId, turnIndex);
				sendJson(res, 201, {
					childConversationId: out.childConversationId,
					recalledCount: out.recalled.length,
					checkpointIds: out.checkpointIds,
				} satisfies ForkResponse);
			} catch (e) {
				sendJson(res, 400, { error: String(e) });
			}
		});
		return true;
	}

	// ── POST /api/turns/prune — admin prune ───────────────────────────
	if (req.method === "POST" && url === "/api/turns/prune") {
		readJsonBody(req, (result) => {
			if (!result.ok) return sendJson(res, 400, { error: result.error });
			const v = result.value;
			const maxTurnAgeMs = typeof v.maxTurnAgeMs === "number" ? v.maxTurnAgeMs : 0;
			const keepMinPerConversation =
				typeof v.keepMinPerConversation === "number" ? v.keepMinPerConversation : 50;
			if (maxTurnAgeMs <= 0) {
				return sendJson(res, 400, { error: "invalid_maxTurnAgeMs" });
			}
			try {
				const store = createTurnStore({ stateDir: ctx.stateDir });
				const report = store.asAdmin().prune({
					maxTurnAgeMs,
					keepMinPerConversation,
					vacuumAfterPrune: true,
				});
				sendJson(res, 200, {
					turnsRemoved: report.turnsRemoved,
					recallRemoved: report.recallRemoved,
					branchesPreserved: report.branchesPreserved,
					freedBytes: report.freedBytes,
				} satisfies PruneTurnsResponse);
			} catch (e) {
				sendJson(res, 500, { error: String(e) });
			}
		});
		return true;
	}

	// ── POST /api/turns/vacuum — admin vacuum ────────────────────────
	if (req.method === "POST" && url === "/api/turns/vacuum") {
		try {
			createTurnStore({ stateDir: ctx.stateDir }).asAdmin().vacuum();
			sendJson(res, 200, { ok: true });
		} catch (e) {
			sendJson(res, 500, { error: String(e) });
		}
		return true;
	}

	return false;
}
