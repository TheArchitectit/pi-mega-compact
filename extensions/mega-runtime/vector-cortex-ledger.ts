/**
 * vector-cortex-ledger.ts — VC1B occurrence-ledger writer wiring (S1).
 *
 * Wires ONLY the `LedgerWriter` capability into message ingestion: each
 * canonical message that flows through the compaction pipeline becomes an
 * occurrence in the v2 ledger. The wiring is writer-only (never reader/admin
 * here — the dashboard GET owns the reader), matching the capability-gated
 * CONTRACTS §Store rule. A tool RESULT occurrence references exactly one
 * earlier call via `toolCallId` (the ledger enforces EVT_TOOL_CALL_MISSING).
 *
 * When MEGACOMPACT_VC1B is OFF the seam opens NO ledger DB at all — and even if
 * a caller already holds a store, its write path is inert (S2 flag-gate in
 * store.ts) — so the OFF behavior is byte-identical to the pre-VC1B predecessor.
 *
 * Local-only (PREVENT-PI-004), no `any` (PREVENT-011), no console.log (events
 * go through the ledger emit seam); non-fatal — a ledger write failure never
 * breaks the agent loop.
 */
import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { VC1B_ENABLED } from "../../src/config/vector-cortex.js";
import {
	createLedgerStore,
	type LedgerWriter,
} from "../../src/vector-cortex/ledger/store.js";

/** A single canonical message mapped to a ledger occurrence input. */
export interface LedgerMessageInput {
	readonly session: string;
	readonly seq: bigint;
	readonly eventId: string;
	readonly kind: string;
	readonly toolCallId?: string;
	readonly sourceBytes: Uint8Array;
}

/** The writer handle handed to ingestion. */
export interface LedgerWriterHandle {
	readonly writer: LedgerWriter;
	readonly close: () => void;
}

/** Open the ledger writer for ingestion, or null when VC1B is disabled. */
export function openLedgerWriter(stateDir: string): LedgerWriterHandle | null {
	if (!VC1B_ENABLED()) return null;
	const store = createLedgerStore({ stateDir });
	return { writer: store.writer(), close: () => store.close() };
}

/**
 * Append one occurrence for a canonical message. `kind` is the neutral kind;
 * when `toolCallId` is present the ledger enforces exactly-one reference to an
 * earlier call. Flag-OFF (null handle) and the writer's own inert path are
 * no-ops. Non-fatal: never throws to the loop — a failure is surfaced as
 * `{ ok: false, code }` so the caller can log the reason (Q02).
 */
export function appendLedgerMessage(
	handle: LedgerWriterHandle,
	input: LedgerMessageInput,
): { ok: boolean; code?: string } {
	try {
		const res = handle.writer.append(input);
		return res.ok ? { ok: true } : { ok: false, code: res.code };
	} catch (e) {
		return { ok: false, code: String(e) };
	}
}

/** Structured logger sink for seam append failures (wired by the extension). */
export interface LedgerAppendLogger {
	readonly warn: (event: string, fields: Record<string, unknown>) => void;
}

/**
 * Append one occurrence per canonical message in `messages` (session-scoped,
 * sequence = 1-based index). Opens the writer, appends each, closes the handle.
 * Returns the number of accepted occurrences (0 when disabled OR when every
 * append was a non-fatal no-op). This is the S1 ingestion seam.
 *
 * Monotonic-prefix assumption (Q02): the FIRST accepted append establishes the
 * per-session high-water, and each subsequent append must carry `seq =
 * highWater + 1`. Append order here follows `messages` array order with 1-based
 * indices, so a shorter/mid-removal/reordered `messages` list after a prior
 * taller run (rewind/fork) can drive `seq` backwards and be rejected with
 * `EVT_SEQ_REGRESSION`. Such appends fail on the ledger and, without `onFailure`,
 * are swallowed silently — so the caller should pass `onFailure` to log them.
 */
export function appendMessagesToLedger(
	stateDir: string,
	sessionId: string,
	messages: AgentMessage[],
	onFailure?: Readonly<LedgerAppendLogger>,
): number {
	const ledger = openLedgerWriter(stateDir);
	if (!ledger) return 0;
	try {
		let accepted = 0;
		for (let i = 0; i < messages.length; i++) {
			const input = messageToLedgerInput(messages[i]!, sessionId, i);
			const res = appendLedgerMessage(ledger, input);
			if (res.ok) {
				accepted++;
			} else if (onFailure) {
				onFailure.warn("vc1b-ledger-append-skip", {
					session: sessionId,
					seq: input.seq.toString(),
					eventId: input.eventId,
					kind: input.kind,
					reason: res.code ?? "unknown",
				});
			}
		}
		return accepted;
	} finally {
		ledger.close();
	}
}

/**
 * Map an AgentMessage to a ledger occurrence input. `eventId` is the stable
 * content digest so re-observed identical messages are (event_id,digest)-deduped;
 * `kind` mirrors the canonical role. `toolCallId` is intentionally NOT set here:
 * pi discriminates messages by `role` only and the tool-call id lives in
 * variant-specific `.content`/`.tool_calls` we must not reach into, so the
 * exactly-one tool back-edge (EVT_TOOL_CALL_MISSING) is exercised at the
 * store/acceptance level and the full live mapping is deferred to the VC1
 * producer-wiring sprint.
 */
export function messageToLedgerInput(
	msg: AgentMessage,
	session: string,
	indexInSession: number,
): LedgerMessageInput {
	const m = msg as { role?: string; id?: string };
	const text = messageText(msg);
	const role = m.role ?? "unknown";
	const digest = `sha256:${createHash("sha256").update(text).digest("hex")}`;
	return {
		session,
		seq: BigInt(indexInSession + 1),
		eventId: m.id ?? digest,
		kind: role,
		sourceBytes: new TextEncoder().encode(text),
	};
}

/** Best-effort text extraction from an AgentMessage (string or part array). */
function messageText(msg: AgentMessage): string {
	const content = (msg as { content?: unknown }).content;
	if (content == null) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((p) => {
				const part = p as { type?: string; text?: string };
				return typeof part.text === "string" ? part.text : "";
			})
			.join("\n");
	}
	if (typeof content === "object") {
		const maybe = (content as Record<string, unknown>).text;
		if (typeof maybe === "string") return maybe;
	}
	return "";
}
