/**
 * context-handler/injectionConfirm.fixture.ts — shared fixtures for the 3WF-4
 * InjectionConfirm tests.
 *
 * Split out so each test file stays under the extensions/300-soft-cap the way
 * src/recall/recall3wf.fixture.ts does for 3WF-3. These are REAL fixtures, not
 * mocks/stubs: a REAL VectorStore over a temp stateDir with REAL checkpoints
 * persisted via compactSession; the MegaRuntime is a minimal typed stub exposing
 * only the fields confirmInjection touches (store, pendingRecallBlock,
 * pendingMemoryRecallBlock, appendEvent), matching the triggerGuard/thrashGuard
 * test conventions.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { VectorStore } from "../../../src/vectorStore.js";
import { compactSession } from "../../../src/engine.js";
import type { MegaRuntime } from "../../mega-runtime.js";
import type { MegaConfig } from "../../mega-config.js";

/** Real EngineMessage fixture. */
export function msg(role: "user" | "assistant", text: string): any {
	return { role, text };
}

/** A user-role AgentMessage carrying `text` (the tail-block shape). */
export function userMsg(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1 } as unknown as AgentMessage;
}

/** Recorded appendEvent calls, for telemetry assertions. */
export interface RecordedEvent {
	name: string;
	payload: Record<string, unknown>;
}

/** Fresh isolated state dir per VectorStore. */
export function freshStore(): { store: VectorStore; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "mc-inject-"));
	return { store: new VectorStore({ dedupSim: 0.9, stateDir: dir }), dir };
}

/** Persist N distinct checkpoints with ascending timestamps. */
export function seed(store: VectorStore, topics: string[], sid = "sess_inject"): void {
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

/** Minimal MegaRuntime stub exposing only the confirmInjection touch-points. */
export function runtimeStub(
	store: VectorStore,
	over: Partial<{
		pendingRecallBlock: string | undefined;
		pendingMemoryRecallBlock: string | undefined;
	}> = {},
): { runtime: MegaRuntime; events: RecordedEvent[] } {
	const events: RecordedEvent[] = [];
	const runtime = {
		store,
		pendingRecallBlock: over.pendingRecallBlock,
		pendingMemoryRecallBlock: over.pendingMemoryRecallBlock,
		perfTurnStart: undefined,
		rt: { recallInjectedThisTurn: false },
		appendEvent: (name: string, payload: Record<string, unknown>) => {
			events.push({ name, payload });
		},
	} as unknown as MegaRuntime;
	return { runtime, events };
}

/** Config stub: only the flags confirmInjection reads. */
export function configStub(
	over: Partial<{ threeWayFailback: boolean; recallTailInject: boolean }> = {},
): MegaConfig {
	return {
		threeWayFailback: over.threeWayFailback ?? true,
		recallTailInject: over.recallTailInject ?? true,
	} as unknown as MegaConfig;
}
