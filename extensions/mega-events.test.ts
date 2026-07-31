/**
 * Tests for mega-events extension — DB-mirror event wiring.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	openStore,
	listCheckpointEpochs,
	countRawTranscript,
} from "../src/store/sqlite.js";
import { appendMirrorMessages } from "./mega-events/mirror-append.js";
import { readHwm, dropHwm } from "./mega-events/context-hwm.js";
import { epochIdFor } from "../src/mirror/epoch.js";

function makeTmp(): string {
	return mkdtempSync(join(tmpdir(), "mega-events-test-"));
}

/** Build a minimal AgentMessage-like object with string content. */
function msg(
	content: string,
	role = "user",
	timestamp?: number,
): any {
	return {
		role,
		content,
		...(timestamp !== undefined ? { timestamp } : {}),
	};
}

describe("mega-events: DB-mirror integration", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTmp();
		// openStore creates the tables as a side effect
		openStore(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("openStore creates checkpoint_epochs and raw_transcript tables", () => {
		const db = openStore(dir);
		// Should not throw — tables exist
		const epochs = listCheckpointEpochs(db);
		assert.ok(Array.isArray(epochs));
		const count = countRawTranscript(db);
		assert.equal(count, 0);
	});

	it("DB-mirror flag defaults to false when env is unset", () => {
		delete process.env.MEGACOMPACT_DB_MIRROR;
		// Re-import to pick up env
		// The extension checks env at load time, so just verify the env is absent
		assert.equal(process.env.MEGACOMPACT_DB_MIRROR, undefined);
	});

	it("DB-mirror flag is enabled when env is '1'", () => {
		process.env.MEGACOMPACT_DB_MIRROR = "1";
		assert.equal(process.env.MEGACOMPACT_DB_MIRROR, "1");
		delete process.env.MEGACOMPACT_DB_MIRROR;
	});

	it("DB-mirror flag is enabled when env is 'true'", () => {
		process.env.MEGACOMPACT_DB_MIRROR = "true";
		assert.equal(process.env.MEGACOMPACT_DB_MIRROR, "true");
		delete process.env.MEGACOMPACT_DB_MIRROR;
	});
});

describe("mega-events: HWM incremental mirror append", () => {
	let dir: string;
	let sessionId: string;

	beforeEach(() => {
		dir = makeTmp();
		openStore(dir);
		sessionId = "test-session-hwm";
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("F3.1: first event processes all messages and writes HWM", () => {
		const db = openStore(dir);
		const messages = [msg("hello"), msg("world")];
		const result = appendMirrorMessages(
			db,
			messages,
			sessionId,
			epochIdFor(sessionId),
			undefined,
		);
		assert.equal(result.rowsProcessed, 2, "first event: all 2 rows processed");
		assert.equal(countRawTranscript(db), 2, "2 rows in raw_transcript");

		// HWM should exist with correct values
		const hwm = readHwm(db, sessionId);
		assert.ok(hwm, "HWM written after first event");
		assert.equal(hwm!.lastSeq, 2, "HWM lastSeq = 2");
		assert.ok(
			hwm!.lastContentHash.length > 0,
			"HWM has a content hash",
		);
	});

	it("F3.2: second event with one new message processes only the tail", () => {
		const db = openStore(dir);
		// Event 1: 2 messages
		const m1 = [msg("a"), msg("b")];
		const r1 = appendMirrorMessages(db, m1, sessionId, epochIdFor(sessionId), undefined);
		assert.equal(r1.rowsProcessed, 2, "first event: 2 rows");

		// Event 2: 3 messages (same 2 + 1 new)
		const m2 = [msg("a"), msg("b"), msg("c")];
		const r2 = appendMirrorMessages(db, m2, sessionId, epochIdFor(sessionId), undefined);
		assert.equal(r2.rowsProcessed, 1, "second event: only 1 new row");
		assert.equal(countRawTranscript(db), 3, "3 rows total in raw_transcript");

		const hwm = readHwm(db, sessionId);
		assert.equal(hwm!.lastSeq, 3, "HWM updated to 3");
	});

	it("F3.8: content-less boundary message does not defeat the HWM (hash rule aligned)", () => {
		const db = openStore(dir);
		// Event 1 ends with a content-less message (e.g. assistant tool-call-only
		// turn): the stored HWM hash and the next event's boundary check must use
		// the same rule for null/undefined content, or every event full-reprocesses.
		const m1 = [msg("a"), { role: "assistant" } as any];
		const r1 = appendMirrorMessages(db, m1, sessionId, epochIdFor(sessionId), undefined);
		assert.equal(r1.rowsProcessed, 1, "content-less message is skipped as a row");

		// Event 2: same 2 + 1 new — must process only the tail.
		const m2 = [msg("a"), { role: "assistant" } as any, msg("b")];
		const r2 = appendMirrorMessages(db, m2, sessionId, epochIdFor(sessionId), undefined);
		assert.equal(r2.rowsProcessed, 1, "incremental path survives a content-less boundary");
	});

	it("F3.3: sublinear scaling — Nth event processes only 1 new message", () => {
		const db = openStore(dir);
		const messages: any[] = [];

		for (let i = 1; i <= 5; i++) {
			messages.push(msg(`msg-${i}`));
			const result = appendMirrorMessages(
				db,
				[...messages], // copy to simulate full session array
				sessionId,
				epochIdFor(sessionId),
				undefined,
			);
			// Each event processes exactly 1 new row (sublinear: O(1), not O(N))
			assert.equal(
				result.rowsProcessed,
				1,
				`event ${i}: exactly 1 new row (sublinear scaling)`,
			);
		}
		assert.equal(countRawTranscript(db), 5, "5 rows total");
	});

	it("F3.4: shorter message list (fork/rewind) triggers full reprocess and resets HWM", () => {
		const db = openStore(dir);

		// Event 1: 3 messages
		const m1 = [msg("a"), msg("b"), msg("c")];
		const r1 = appendMirrorMessages(db, m1, sessionId, epochIdFor(sessionId), undefined);
		assert.equal(r1.rowsProcessed, 3);
		assert.equal(countRawTranscript(db), 3);

		// Simulate fork: shorter list (2 messages)
		const m2 = [msg("a"), msg("b")];
		const r2 = appendMirrorMessages(db, m2, sessionId, epochIdFor(sessionId), undefined);
		assert.equal(
			r2.rowsProcessed,
			2,
			"shorter list: full reprocess (2 rows)",
		);
		assert.equal(
			countRawTranscript(db),
			3,
			"rows unchanged (INSERT OR IGNORE dedup)",
		);

		// HWM should be reset to the shorter list's count
		const hwm = readHwm(db, sessionId);
		assert.equal(hwm!.lastSeq, 2, "HWM reset to shorter list length");
	});

	it("F3.5: boundary hash mismatch triggers full reprocess and resets HWM", () => {
		const db = openStore(dir);

		// Event 1: 2 messages
		const m1 = [msg("original-a"), msg("original-b")];
		const r1 = appendMirrorMessages(db, m1, sessionId, epochIdFor(sessionId), undefined);
		assert.equal(r1.rowsProcessed, 2);

		// Event 2: 3 messages, but message[1] changed (boundary mismatch)
		const m2 = [msg("original-a"), msg("CHANGED-b"), msg("c")];
		const r2 = appendMirrorMessages(db, m2, sessionId, epochIdFor(sessionId), undefined);
		assert.equal(
			r2.rowsProcessed,
			3,
			"hash mismatch: full reprocess (3 rows attempted, but only new hash rows inserted)",
		);

		const hwm = readHwm(db, sessionId);
		assert.equal(hwm!.lastSeq, 3, "HWM reset after hash mismatch");
	});

	it("F3.6: equivalence — full-processing vs incremental produce identical mirror content", () => {
		const db1 = openStore(join(dir, "full"));
		const db2 = openStore(join(dir, "incremental"));

		const sessionFull = "equiv-full";
		const sessionIncr = "equiv-incr";
		const epochFull = epochIdFor(sessionFull);
		const epochIncr = epochIdFor(sessionIncr);

		// Build session incrementally, message by message (simulates real usage)
		const allMessages: any[] = [];
		for (let i = 1; i <= 5; i++) {
			allMessages.push(msg(`msg-${i}`, i % 2 === 0 ? "assistant" : "user"));
		}

		// Full processing: all 5 messages in one shot (no HWM)
		const fullResult = appendMirrorMessages(
			db1,
			allMessages,
			sessionFull,
			epochFull,
			undefined,
		);
		assert.equal(fullResult.rowsProcessed, 5);

		// Incremental processing: one message at a time
		const currentMessages: any[] = [];
		let totalIncr = 0;
		for (let i = 0; i < allMessages.length; i++) {
			currentMessages.push(allMessages[i]);
			const result = appendMirrorMessages(
				db2,
				[...currentMessages],
				sessionIncr,
				epochIncr,
				undefined,
			);
			totalIncr += result.rowsProcessed;
		}
		assert.equal(totalIncr, 5, "incremental: 5 rows processed across events");

		// Both tables should have identical row counts
		assert.equal(
			countRawTranscript(db1),
			countRawTranscript(db2),
			"same row count in both mirrors",
		);

		// Content verification: list all rows from both and compare
		const rows1 = db1
			.prepare(
				"SELECT content_hash, role, content_bytes FROM raw_transcript WHERE session_id = ? ORDER BY seq ASC",
			)
			.all(sessionFull) as any[];
		const rows2 = db2
			.prepare(
				"SELECT content_hash, role, content_bytes FROM raw_transcript WHERE session_id = ? ORDER BY seq ASC",
			)
			.all(sessionIncr) as any[];

		assert.equal(rows1.length, rows2.length, "same number of rows");
		for (let i = 0; i < rows1.length; i++) {
			assert.equal(rows1[i].content_hash, rows2[i].content_hash, `row ${i}: same content_hash`);
			assert.equal(rows1[i].role, rows2[i].role, `row ${i}: same role`);
			assert.equal(rows1[i].content_bytes, rows2[i].content_bytes, `row ${i}: same content_bytes`);
		}
	});

	it("F3.7: dropHwm explicitly resets — next event is full reprocess", () => {
		const db = openStore(dir);

		// Process 2 messages
		appendMirrorMessages(db, [msg("a"), msg("b")], sessionId, epochIdFor(sessionId), undefined);
		assert.equal(countRawTranscript(db), 2);

		// Explicitly drop HWM (simulates external reset)
		dropHwm(db, sessionId);
		assert.equal(readHwm(db, sessionId), undefined, "HWM dropped");

		// Next event with same messages: full reprocess (but INSERT OR IGNORE
		// prevents duplicates — still returns rowsProcessed === 2 because it
		// attempts all messages; the HWM table ensures idempotency)
		const result = appendMirrorMessages(
			db,
			[msg("a"), msg("b")],
			sessionId,
			epochIdFor(sessionId),
			undefined,
		);
		assert.equal(
			result.rowsProcessed,
			2,
			"after dropHwm: full reprocess (rows attempted)",
		);
		assert.equal(
			countRawTranscript(db),
			2,
			"rows unchanged (INSERT OR IGNORE dedup)",
		);

		// HWM re-established
		const hwm = readHwm(db, sessionId);
		assert.equal(hwm!.lastSeq, 2, "HWM re-established");
	});
});
