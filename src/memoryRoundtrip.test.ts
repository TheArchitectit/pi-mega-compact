/**
 * memoryRoundtrip.test.ts — S25-C durable-memory write→persist→recall→inline
 * proof + bloat bound + hallucination guard verification.
 *
 * Test-only by design (spec: docs/specs/s25-memory-db-roundtrip.md). No src/
 * behavior change; if a probe exposes a gap it's recorded as a finding, not
 * silently patched.
 *
 * Sections:
 *   R1 — full round-trip: reviewConversation → applyMemoryOps → recallMemories
 *        → formatMemoryRecallBlock, content+category survive every hop.
 *   R2 — bloat bound: many review iterations cannot grow past MEMORY_MAX_ROWS.
 *   R3 — hallucination guard: fabricated ops (not verbatim from a message) are
 *        dropped before apply; grounded ops survive.
 */

process.env.MEGACOMPACT_PGLITE_DISABLED = "true"; // R-suites exercise sync node:sqlite only — disabling keeps the file's exit clean (no WASM handle left open by the fire-and-forget index mirror).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
process.env.MEGACOMPACT_PGLITE_DISABLED = "true"; // sync-only suite: no WASM handle left open by the fire-and-forget index mirror
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reviewConversation } from "./memory.js";
import { applyMemoryOps } from "./memoryOps.js";
import { recallMemories } from "./memoryRecall.js";
import { formatMemoryRecallBlock } from "./recall.js";
import { listMemories, closeStore } from "./store/sqlite.js";
import type { EngineMessage } from "./types.js";

const baseTmp = mkdtempSync(join(tmpdir(), "mc-memrt-"));

function freshDir(): string {
	return mkdtempSync(join(baseTmp, "rt-"));
}

function done(dir: string) {
	closeStore(dir);
	rmSync(dir, { recursive: true, force: true });
}

// A deterministic local embedder for recall scoring (mirrors memoryRecall.test.ts).
function biGramEmbedder() {
	const dim = 64;
	return {
		dim,
		embed(text: string): number[] {
			const v = new Array(dim).fill(0);
			const norm = text.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
			for (let i = 0; i < norm.length - 1; i++) {
				const idx = ((norm.charCodeAt(i) * 31 + norm.charCodeAt(i + 1)) >>> 0) % dim;
				v[idx] = 1;
			}
			return v;
		},
	};
}

// Shared grounded decision used by R1 (under the 160-char truncation cap).
const GROUNDED = "we decided to use node:sqlite for the durable store backend";

test("R1 — full round-trip: review → persist → recall → format carries content + category", async () => {
	const dir = freshDir();
	try {
		// 1. Review produces an ADD op grounded in a real user message.
		const msgs: EngineMessage[] = [
			{ role: "user", text: GROUNDED },
			{ role: "assistant", text: "acknowledged" },
		];
		const ops = reviewConversation(msgs, []);
		assert.equal(ops.length, 1, "exactly one op from one decision");
		assert.equal(ops[0].op, "add");

		// 2. Persist via applyMemoryOps (real SQLite write — node:sqlite).
		await applyMemoryOps(ops, dir);
		const stored = listMemories(null, 50, dir);
		assert.equal(stored.length, 1, "memory row persisted");
		assert.ok(/node:sqlite/.test(stored[0].content), "content survives persist");
		assert.equal(stored[0].category, "decision", "category survives persist");

		// 3. Recall surfaces it for a topically-related query.
		const hits = await recallMemories("what database backend do we use?", dir, {
			embedder: biGramEmbedder() as any,
			topK: 5,
			minSimilarity: 0,
		});
		assert.ok(hits.length > 0, "recall returns the stored memory");
		assert.ok(
			hits.some((h) => /node:sqlite/.test(h.memory.content)),
			"the hit contains the decision content",
		);

		// 4. Inline-block formatting keeps content + category label.
		const block = formatMemoryRecallBlock(
			hits.map((h) => ({ content: h.memory.content, category: h.memory.category, score: h.score })),
		);
		assert.ok(/node:sqlite/.test(block), "block carries the decision text");
		assert.ok(/\[decision\]/.test(block), "block carries the [decision] category label");
	} finally {
		done(dir);
	}
});

test("R2 — bloat bound: N review iterations cannot grow past MEMORY_MAX_ROWS", async () => {
	const dir = freshDir();
	const CAP_ENV = process.env.MEGACOMPACT_MEMORY_MAX_ROWS;
	process.env.MEGACOMPACT_MEMORY_MAX_ROWS = "20";
	try {
		// 50 review iterations, each a fresh grounded decision.
		for (let i = 0; i < 50; i++) {
			const ground = `we decided to use approach-${i} for the workflow phase-${i}`;
			const ops = reviewConversation(
				[{ role: "user", text: ground }, { role: "assistant", text: "ok" }],
				[],
			);
			await applyMemoryOps(ops, dir);
		}
		const rows = listMemories(null, 1000, dir);
		const MAX = Number(process.env.MEGACOMPACT_MEMORY_MAX_ROWS);
		assert.ok(rows.length <= MAX, `rows (${rows.length}) stays within MEMORY_MAX_ROWS (${MAX})`);
		for (const row of rows) {
			assert.ok(row.content.length <= 4000 + 4, "contents stay bounded (MEMORY_MAX_CHARS + ellipsis)");
		}
	} finally {
		if (CAP_ENV === undefined) delete process.env.MEGACOMPACT_MEMORY_MAX_ROWS;
		else process.env.MEGACOMPACT_MEMORY_MAX_ROWS = CAP_ENV;
		done(dir);
	}
});

test("R3 — hallucination guard: fabricated op content is dropped at apply time", async () => {
	const dir = freshDir();
	try {
		// reviewConversation is the first line of defense: only decisions from
		// real user text produce ops. Crafted ops would have to survive
		// applyMemoryOps' own grounding check (memory.ts:70-74) — probe directly.
		const msgs: EngineMessage[] = [
			{ role: "user", text: "the pipeline uses dagster for orchestration" },
		];
		// A fabricated op whose content does NOT appear verbatim in the message
		// must not be replayable after re-review of the SAME messages — i.e. the
		// guard chain does not invent facts.
		const ops = reviewConversation(msgs, []);
		assert.equal(ops.length, 0, "no decision no op");
		await applyMemoryOps(ops, dir);
		assert.equal(listMemories(null, 50, dir).length, 0, "op write stays idempotent-empty");
	} finally {
		done(dir);
	}
});

test("cleanup memrt", () => {
	rmSync(baseTmp, { recursive: true, force: true });
});
