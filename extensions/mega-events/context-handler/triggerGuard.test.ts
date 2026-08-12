/**
 * extensions/mega-events/context-handler/triggerGuard.test.ts — 3WF-1 TriggerGuard.
 *
 * No mocks, no stubs (project rule O1): a REAL VectorStore against a temp
 * stateDir, with a REAL checkpoint persisted via compactSession/engine.js. The
 * MegaRuntime is a minimal typed stub (only the fields the guard touches), and
 * ctx is a thin sessionManager/cwd stub matching the existing extension test
 * pattern (see mega-events.test.ts runtimeStub + mega-teamrun.test.ts ctx).
 *
 * Runs via `npm test` (run-tests.mjs globs dist's .test.js outputs).
 *
 * Assertions:
 *  1. store with checkpoints + no staged block -> guard stages a recall block.
 *  2. second call is a no-op (one-shot WeakMap).
 *  3. a pre-staged block is left untouched (session_start wins).
 *  4. empty store -> no block staged, no throw.
 *  5. flag OFF -> leaves pendingRecallBlock null even with store + query
 *     (byte-identical pre-sprint behavior).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VectorStore, vectorList } from "../../../src/vectorStore.js";
import { compactSession, recall } from "../../../src/engine.js";
import { closeIndexStore, setDedupStatus } from "../../../src/store/sqlite.js";
import type { MegaRuntime } from "../../mega-runtime.js";
import type { MegaConfig } from "../../mega-config.js";
import { runTriggerGuard } from "./triggerGuard.js";

/** Real EngineMessage fixtures (user + a tool assistant turn). */
function msg(role: "user" | "assistant", text: string): any {
	return { role, text };
}

/** Minimal MegaRuntime stub exposing only the fields the guard touches. */
function runtimeStub(
	store: VectorStore,
	over: Partial<{ pendingRecallBlock: string | undefined }> = {},
): MegaRuntime {
	const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
	return {
		store,
		pendingRecallBlock: over.pendingRecallBlock,
		appendEvent: (name: string, payload: Record<string, unknown>) => {
			events.push({ name, payload });
		},
	} as unknown as MegaRuntime;
}

/** ctx stub with a configurable session id + latest-user query. */
function ctxStub(opts: { getSessionId?: () => string; query?: string } = {}): any {
	const getSessionId = opts.getSessionId ?? (() => "sess_guard");
	const query = opts.query ?? "dedupe race in store";
	return {
		cwd: "/tmp",
		sessionManager: {
			getSessionId,
			getEntries: () => [{ type: "message", id: "e1", parentId: null, timestamp: "1", message: { role: "user", content: query } }],
		},
	};
}

/** Fresh isolated state dir per VectorStore. */
function freshStore(): { store: VectorStore; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "mc-guard-"));
	return { store: new VectorStore({ dedupSim: 0.9, stateDir: dir }), dir };
}

const cfgOn = { threeWayFailback: true, autoInlineK: 3 } as unknown as MegaConfig;
const cfgOff = { threeWayFailback: false, autoInlineK: 3 } as unknown as MegaConfig;

after(() => {
	try { closeIndexStore(); } catch { /* */ }
});

test("3WF-1: store with a checkpoint + no staged block -> guard stages a recall block", () => {
	const { store, dir } = freshStore();
	try {
		compactSession(
			{
				sessionId: "sess_guard",
				messages: [
					msg("user", "investigated the dedupe race in store.ts"),
					msg("assistant", "fixed it"),
				],
				keepFrom: 2,
				timestamp: 1,
			},
			store,
		);
		const rt = runtimeStub(store);
		runTriggerGuard(rt, cfgOn, ctxStub({ query: "dedupe race in store" }));
		assert.ok(
			rt.pendingRecallBlock && rt.pendingRecallBlock.includes("Recalled context"),
			"stages a formatted recall block",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("3WF-1: second call is a no-op (one-shot WeakMap)", () => {
	const { store, dir } = freshStore();
	try {
		compactSession(
			{ sessionId: "sess_guard", messages: [msg("user", "the query topic"), msg("assistant", "ok")], keepFrom: 2, timestamp: 1 },
			store,
		);
		const rt = runtimeStub(store);
		runTriggerGuard(rt, cfgOn, ctxStub({ query: "the query topic" }));
		const first = rt.pendingRecallBlock;
		// Mutate the stored block; a second run must NOT overwrite it.
		(rt as any).pendingRecallBlock = "sentinel";
		runTriggerGuard(rt, cfgOn, ctxStub({ query: "the query topic" }));
		assert.equal(rt.pendingRecallBlock, "sentinel", "one-shot: second run is a no-op");
		assert.ok(first, "first run staged a block");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("3WF-1: a pre-staged block (session_start) is left untouched (no-op)", () => {
	const { store, dir } = freshStore();
	try {
		compactSession(
			{ sessionId: "sess_guard", messages: [msg("user", "topic words"), msg("assistant", "ok")], keepFrom: 2, timestamp: 1 },
			store,
		);
		const rt = runtimeStub(store, { pendingRecallBlock: "session_start_block" });
		runTriggerGuard(rt, cfgOn, ctxStub({ query: "topic words" }));
		assert.equal(rt.pendingRecallBlock, "session_start_block", "pre-staged block untouched");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("3WF-1: empty store -> no block staged, no throw", () => {
	const { store, dir } = freshStore();
	try {
		const rt = runtimeStub(store);
		runTriggerGuard(rt, cfgOn, ctxStub());
		assert.equal(rt.pendingRecallBlock, undefined, "nothing staged on an empty store");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("3WF-1: flag OFF -> leaves pendingRecallBlock null even with store + query (byte-identical)", () => {
	const { store, dir } = freshStore();
	try {
		compactSession(
			{ sessionId: "sess_guard", messages: [msg("user", "the query topic"), msg("assistant", "ok")], keepFrom: 2, timestamp: 1 },
			store,
		);
		const rt = runtimeStub(store);
		runTriggerGuard(rt, cfgOff, ctxStub({ query: "the query topic" }));
		assert.equal(rt.pendingRecallBlock, undefined, "flag OFF: guard is a pure no-op");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("3WF-1: any non-empty store stages a block even for a low-relevance query (top-K, floor lands in 3WF-3)", () => {
	// 3WF-1 ships no same-repo relevance floor (that is 3WF-3), so vectorSearch
	// returns the top-K hits unconditionally whenever a checkpoint exists: recall
	// never returns [] on a non-empty store. The provenance-floor branch is
	// therefore latent until 3WF-3 adds the floor that makes "recall produced
	// nothing" reachable. Assert the guard still stages A block (recall win).
	const { store, dir } = freshStore();
	try {
		compactSession(
			{
				sessionId: "sess_guard",
				messages: [msg("user", "investigated the dedupe race in store.ts and fixed the locking"), msg("assistant", "done")],
				keepFrom: 2,
				timestamp: 1,
			},
			store,
		);
		const rt = runtimeStub(store);
		// Zero lexical/semantic overlap — still top-K'd into a recall block today.
		runTriggerGuard(rt, cfgOn, ctxStub({ query: "zzqqxx completely unrelated topic nowhere" }));
		assert.ok(
			rt.pendingRecallBlock && rt.pendingRecallBlock.includes("Recalled context"),
			"any non-empty store yields a staged recall block in 3WF-1 (top-K)",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("3WF-1: the provenance floor branch is defense-in-depth (fires when recall returns [])", () => {
	// Guards the guard's own invariants with a real store: mark the only
	// checkpoint SemDeDup-'removed' so vectorSearch filters it out -> recall
	// returns [] -- but checkpointCount still reports >0 (listCheckpoints does
	// not filter removed rows) -- so the floor branch stages newest-checkpoint
	// provenance instead of silence. Exercises the floor formatting end-to-end.
	const { store, dir } = freshStore();
	try {
		const sessId = "sess_floor";
		compactSession(
			{ sessionId: sessId, messages: [msg("user", "unique token content alpha"), msg("assistant", "ok")], keepFrom: 2, timestamp: 1 },
			store,
		);
		const cp = vectorList(store, sessId)[0];
		assert.ok(cp, "a checkpoint exists for floor synthesis");
		setDedupStatus(cp!.checkpointId, sessId, "removed", dir);
		// Confirm the removal makes recall return [] while count stays >0.
		const rec = recall({ sessionId: sessId, query: "anything", limit: 3, skipInjected: false }, store);
		assert.equal(rec.hits.length, 0, "removed checkpoint is filtered out of vectorSearch");
		const rt = runtimeStub(store);
		runTriggerGuard(rt, cfgOn, ctxStub({ query: "anything", getSessionId: () => sessId }));
		assert.ok(
			rt.pendingRecallBlock && rt.pendingRecallBlock.startsWith("The following compacted context is the most recent checkpoint"),
			"floor branch stages newest-checkpoint provenance when recall returns []",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("3WF-1: guard never throws on a ctx with no session id or entries", () => {
	const { store, dir } = freshStore();
	try {
		const rt = runtimeStub(store);
		const badCtx = { cwd: "/tmp", sessionManager: { getSessionId: () => "", getEntries: () => [] } };
		assert.doesNotThrow(() => runTriggerGuard(rt, cfgOn, badCtx));
		assert.equal(rt.pendingRecallBlock, undefined, "no session id => nothing staged");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
