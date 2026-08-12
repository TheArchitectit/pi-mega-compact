/**
 * src/failback/floor.test.ts — 3WF-4 shared floor builder (consolidation proof).
 *
 * The 3WF-4 floor work is a REFACTOR: the text that 3WF-1's triggerGuard and
 * 3WF-3's recall validator each built inline now comes from ONE pure module.
 * These tests pin the exact byte sequences the pre-refactor code produced, so a
 * future edit to the shared module cannot silently change either call site's
 * output. The three literals below are transcribed from the pre-refactor
 * sources (triggerGuard.ts buildFloorBlock + validator.ts buildFloorBlock, which
 * were already byte-identical to each other).
 *
 * No mocks: a REAL VectorStore over a temp stateDir with REAL checkpoints, read
 * through BOTH call sites' real read paths (vectorList unfiltered for the guard,
 * listCheckpoints filtered for the validator), asserting identical text.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VectorStore, vectorList } from "../vectorStore.js";
import { compactSession } from "../engine.js";
import { closeIndexStore, listCheckpoints } from "../store/sqlite.js";
import type { StoredCheckpoint } from "../store.js";
import {
	buildFloorBlock,
	unavailableFloorBlock,
	newestCheckpoint,
	FLOOR_UNAVAILABLE_TEXT,
} from "./floor.js";

// --- Pre-refactor literals (byte-for-byte from the 3WF-1/3WF-3 sources) ------

const PRE_WITH_SUMMARY = (summary: string): string =>
	"The following compacted context is the most recent checkpoint from " +
	"this session (recall found no query-relevant match):\n\n" + summary;

const PRE_NO_SUMMARY =
	"This session has compacted context but recall could not surface a " +
	"checkpoint relevant to the current request; the most recent checkpoint " +
	"summary is unavailable.";

const PRE_UNAVAILABLE =
	"This session has compacted context but recall could not surface a " +
	"checkpoint relevant to the current request.";

const dirs: string[] = [];
after(() => {
	closeIndexStore();
	for (const d of dirs) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			/* best-effort temp cleanup */
		}
	}
});

/** Fresh isolated state dir per VectorStore. */
function freshStore(): { store: VectorStore; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "mc-floor-"));
	dirs.push(dir);
	return { store: new VectorStore({ dedupSim: 0.9, stateDir: dir }), dir };
}

/** A checkpoint-shaped fixture for the pure-path assertions. */
function cp(summary: string, timestamp: number): StoredCheckpoint {
	return { summary, timestamp } as unknown as StoredCheckpoint;
}

// --- Pure text identity -----------------------------------------------------

test("floor: with-summary text is byte-identical to the pre-refactor literal", () => {
	const out = buildFloorBlock([cp("did the dedupe race fix", 5)]);
	assert.equal(out.text, PRE_WITH_SUMMARY("did the dedupe race fix"));
	assert.equal(out.basis, "lastCheckpoint");
});

test("floor: no-summary text is byte-identical to the pre-refactor literal", () => {
	for (const cps of [[], [cp("", 1)], [cp("   ", 1)]]) {
		const out = buildFloorBlock(cps);
		assert.equal(out.text, PRE_NO_SUMMARY);
		assert.equal(out.basis, "lastCheckpoint");
	}
});

test("floor: unavailable text is byte-identical to the pre-refactor literal", () => {
	assert.equal(FLOOR_UNAVAILABLE_TEXT, PRE_UNAVAILABLE);
	const out = unavailableFloorBlock();
	assert.equal(out.text, PRE_UNAVAILABLE);
	assert.equal(out.basis, "none");
});

// --- Newest-by-timestamp selection (the pre-refactor loop's exact semantics) -

test("floor: picks the newest checkpoint by timestamp, first wins ties", () => {
	const chosen = newestCheckpoint([cp("older", 1), cp("newest", 9), cp("mid", 4)]);
	assert.equal(chosen?.summary, "newest");
	// Strictly-greater comparison => the FIRST of equal timestamps is kept,
	// exactly as both pre-refactor loops behaved.
	const tie = newestCheckpoint([cp("first", 7), cp("second", 7)]);
	assert.equal(tie?.summary, "first");
	assert.equal(newestCheckpoint([]), undefined);
	// Missing timestamps coerce to 0 (pre-refactor `cp.timestamp ?? 0`).
	const noTs = newestCheckpoint([cp("a", 0), cp("b", 2)]);
	assert.equal(noTs?.summary, "b");
});

// --- Both real call-site read paths agree ------------------------------------

test("floor: guard (vectorList) and validator (listCheckpoints) agree byte-for-byte", () => {
	const { store, dir } = freshStore();
	const sid = "sess_floor";
	["first topic about sqlite", "second topic about recall"].forEach((t, i) => {
		compactSession(
			{
				sessionId: sid,
				messages: [
					{ role: "user", text: t } as never,
					{ role: "assistant", text: "ok" } as never,
				],
				keepFrom: 2,
				timestamp: i + 1,
			},
			store,
		);
	});

	// Guard call site's read: vectorList (unfiltered).
	const guardText = buildFloorBlock(vectorList(store, sid)).text;
	// Validator call site's read: listCheckpoints filtered to non-removed.
	const validatorText = buildFloorBlock(
		listCheckpoints(sid, dir).filter((c) => c.dedupStatus !== "removed"),
	).text;

	assert.equal(guardText, validatorText, "both call sites produce one string");
	assert.ok(guardText.startsWith("The following compacted context is the most"));
	// And it is the pre-refactor construction over the newest checkpoint.
	const newest = newestCheckpoint(vectorList(store, sid));
	assert.equal(guardText, PRE_WITH_SUMMARY(newest?.summary?.trim() ?? ""));
});

test("floor: empty session falls to the no-summary literal", () => {
	const { store } = freshStore();
	const out = buildFloorBlock(vectorList(store, "sess_empty"));
	assert.equal(out.text, PRE_NO_SUMMARY);
});
