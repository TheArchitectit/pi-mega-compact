/**
 * mirror-append.ts — extracted DB-mirror append logic for context-handler.ts
 * (F3 sprint: high-water mark incremental append).
 *
 * Follows the repo's delegate-shell pattern: the context handler shell delegates
 * to this impl module for the mirror-append concern. Returns `rowsProcessed`
 * so callers (including tests) can observe how many new rows were written
 * without adding test-only hooks.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { DatabaseSync } from "node:sqlite";
import { appendRawTranscript, type RawTranscriptRow } from "../../src/store/sqlite.js";
import { computeContentDigest } from "../../src/dedup/digest.js";
import {
	ensureHwmTable,
	readHwm,
	writeHwm,
	dropHwm,
} from "./context-hwm.js";

export interface MirrorAppendResult {
	rowsProcessed: number;
}

/**
 * Append incoming messages to raw_transcript with HWM incremental support.
 *
 * On fork/rewind (shorter message list or boundary hash mismatch), the HWM
 * is dropped and all messages are reprocessed.
 */
export function appendMirrorMessages(
	db: DatabaseSync,
	messages: AgentMessage[],
	sessionId: string,
	epochId: string,
	currentTurn: number | undefined,
): MirrorAppendResult {
	ensureHwmTable(db);
	const hwm = readHwm(db, sessionId);

	let tailStart = 0;
	let needDrop = false;

	if (hwm) {
		if (messages.length <= hwm.lastSeq) {
			// Session was shortened (fork/rewind/clear) — full reprocess.
			needDrop = true;
		} else {
			// Verify boundary integrity: hash of message at hwm.lastSeq-1
			// must match the stored hash.
			const boundaryMsg = messages[hwm.lastSeq - 1];
			const boundaryHash = contentHashOf(
				(boundaryMsg as { content?: unknown }).content,
			);
			if (boundaryHash === hwm.lastContentHash) {
				tailStart = hwm.lastSeq;
			} else {
				needDrop = true;
			}
		}
	}

	if (needDrop) {
		dropHwm(db, sessionId);
	}

	// Process tail (or all if tailStart === 0).
	let rowsProcessed = 0;
	for (let i = tailStart; i < messages.length; i++) {
		const raw = toRawRow(messages[i], sessionId, epochId, currentTurn);
		if (raw) {
			appendRawTranscript(db, raw);
			rowsProcessed++;
		}
	}

	// Write new HWM.
	if (messages.length > 0) {
		const lastMsg = messages[messages.length - 1];
		writeHwm(db, {
			sessionId,
			lastSeq: messages.length,
			lastContentHash: contentHashOf(
				(lastMsg as { content?: unknown }).content,
			),
		});
	}

	return { rowsProcessed };
}

/** Single rule for hashing message content on BOTH sides of the HWM
 *  (write + boundary check) — a mismatch here silently defeats the
 *  incremental path (every event would full-reprocess). null/undefined → "". */
function contentHashOf(content: unknown): string {
	if (content == null) return "";
	const bytes =
		typeof content === "string"
			? content
			: JSON.stringify(canonicalize(content));
	return computeContentDigest(bytes).contentHash;
}

/**
 * Canonicalize a value for deterministic JSON serialization (keys sorted).
 * This is the same logic as the inline function in context-handler.ts.
 */
function canonicalize(value: unknown): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(canonicalize);
	const sorted = Object.keys(value as Record<string, unknown>).sort();
	const out: Record<string, unknown> = {};
	for (const k of sorted) {
		(out as Record<string, unknown>)[k] = canonicalize(
			(value as Record<string, unknown>)[k],
		);
	}
	return out;
}

/** Convert an AgentMessage to a RawTranscriptRow (same logic as toRawTranscriptRow in context-handler.ts). */
function toRawRow(
	msg: AgentMessage,
	sessionId: string,
	epochId: string,
	currentTurn: number | undefined,
): RawTranscriptRow | null {
	const m = msg as {
		role?: string;
		content?: unknown;
		timestamp?: number;
		toolName?: string;
	};
	const content = m.content;
	if (content == null || content === "") return null;
	const contentBytes =
		typeof content === "string"
			? content
			: JSON.stringify(canonicalize(content));
	return {
		contentHash: computeContentDigest(contentBytes).contentHash,
		sessionId,
		seq: 0, // assigned by appendRawTranscript
		role: m.role ?? "unknown",
		contentBytes,
		toolName: m.toolName ?? null,
		messageTimestamp: m.timestamp ?? null,
		checkpointEpoch: epochId,
		turnIndex: currentTurn ?? null,
	};
}

// Re-export for convenience when the handler only needs the table ensure.
export { ensureHwmTable, readHwm, writeHwm, dropHwm };
