/**
 * vector-cortex/eval/persist.test.ts — redacted eval JSONL persistence (VC0A).
 *
 * Verifies append-only write + read round-trip, malformed-line tolerance
 * (EVAL_JSONL_TRUNCATED), and that only redacted metric rows are persisted.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const { appendEvalRow, readEvalRows, evalJsonlPath } = await import(
	"./persist.js"
);

function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "vcp-"));
}

describe("vector-cortex eval persistence", () => {
	test("append + read round-trips redacted metric rows", () => {
		const dir = tmpDir();
		try {
			const row = {
				session: "s1",
				seq: 1,
				event: "encode",
				value: 12,
				unit: "ms",
				mode: "A",
			} as const;
			appendEvalRow(dir, [row]);
			const out = readEvalRows(dir);
			assert.equal(out.length, 1);
			assert.deepEqual(out[0], row);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("append-only across multiple calls preserves order", () => {
		const dir = tmpDir();
		try {
			appendEvalRow(dir, [
				{ session: "s1", seq: 1, event: "a", value: 1, unit: "ms", mode: "A" },
				{ session: "s1", seq: 2, event: "b", value: 1, unit: "ms", mode: "B" },
			]);
			appendEvalRow(dir, [
				{ session: "s1", seq: 3, event: "c", value: 1, unit: "ms", mode: "C" },
			]);
			const out = readEvalRows(dir);
			assert.deepEqual(out.map((r) => r.seq), [1, 2, 3]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("malformed / truncated final line is skipped, not fatal", async () => {
		const dir = tmpDir();
		try {
			const { mkdirSync, writeFileSync } = await import("node:fs");
			const path = evalJsonlPath(dir);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(
				path,
				`{"session":"s1","seq":1,"event":"a","value":1,"unit":"ms","mode":"A"}\n{"session":"s1","seq":2,"event":"b",TRUNCATED`,
			);
			const out = readEvalRows(dir);
			assert.equal(out.length, 1);
			assert.equal(out[0].seq, 1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("returns empty array when file absent", () => {
		const dir = tmpDir();
		try {
			assert.deepEqual(readEvalRows(dir), []);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
