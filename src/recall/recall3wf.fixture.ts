/**
 * src/recall/recall3wf.fixture.ts — shared fixtures for the 3WF-3 recall tests.
 *
 * Split out of recall3wf.test.ts (which crossed the src 300 soft cap) so each
 * test file stays under the limit. These are REAL fixtures, not mocks/stubs:
 * a REAL VectorStore over a temp stateDir, REAL checkpoints persisted via
 * compactSession, and readers that go through the SAME working path the
 * extension uses (recallRawHits -> vectorSearch -> listCheckpoints, and
 * vectorWasInjected), mirroring the proven triggerGuard test pattern.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VectorStore } from "../vectorStore.js";
import { compactSession } from "../engine.js";
import { recallAndInline } from "../recall.js";
import { recallRawHits } from "./readonly.js";
import { openStore } from "../store/sqlite/utils.js";
import { initSchema } from "../store/sqlite/schema.js";

/** Real EngineMessage fixture. */
export function msg(role: "user" | "assistant", text: string): any {
	return { role, text };
}

/** Fresh isolated state dir per VectorStore. */
export function freshStore(): { store: VectorStore; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "mc-3wf-"));
	return { store: new VectorStore({ dedupSim: 0.9, stateDir: dir }), dir };
}

/** Persist N distinct checkpoints with distinct content + ascending timestamps. */
export function seed(store: VectorStore, topics: string[], sid = "sess_3wf"): void {
	topics.forEach((t, i) => {
		compactSession(
			{
				sessionId: sid,
				messages: [msg("user", t), msg("assistant", "ok")],
				keepFrom: 2,
				timestamp: i + 1,
			},
			store,
		);
	});
}

/** Checkpoint ids via the real search path (vectorSearch -> listCheckpoints). */
export function checkpointIds(store: VectorStore, sid: string, query: string): string[] {
	return recallRawHits({ sessionId: sid, query, limit: 10 }, store).map(
		(h) => h.checkpoint.checkpointId,
	);
}

/** Run the real recallAndInline path with skipInjected:false so nothing is
 *  marked and the block reflects the search result exactly (deterministic). */
export function recallAndInlineCapture(
	sid: string,
	query: string,
	store: VectorStore,
): { block: string; empty: boolean; toInject: unknown[] } {
	const r = recallAndInline(
		{ sessionId: sid, query, limit: 3, source: "command", skipInjected: false, windowDedupe: false },
		store,
	);
	return { block: r.block, empty: r.empty, toInject: r.toInject };
}

/** Count recall-provenance rows (turn_recall) for a session via raw SQL reader. */
export function countTurnRecallRows(store: VectorStore, sid: string): number {
	try {
		const reader = openStore(store.stateDir);
		// Ensure the turns/turn_recall tables exist so a 0-count is meaningful
		// (a write on the new path would be visible, not masked by a missing table).
		initSchema(reader);
		const row = reader
			.prepare(
				`SELECT COUNT(*) AS n FROM turn_recall tr
				 JOIN turns t ON t.id = tr.turn_id
				 WHERE t.session_id = ?`,
			)
			.get(sid) as { n: number };
		return row?.n ?? 0;
	} catch {
		return 0;
	}
}
