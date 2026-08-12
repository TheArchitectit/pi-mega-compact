/**
 * context-handler/threeWayTelemetry.fixture.ts — shared fixtures for the 3WF-5
 * telemetry verification tests.
 *
 * Split out so the test file stays under the soft cap, mirroring
 * src/recall/recall3wf.fixture.ts (3WF-3) and injectionConfirm.fixture.ts (3WF-4).
 *
 * These are REAL fixtures, not mocks/stubs. The critical difference from the
 * 3WF-1..4 fixtures: those record `appendEvent` calls into an in-memory array,
 * which proves the CALL happened but says nothing about the wire format or the
 * file the dashboard actually tails. Here `appendEvent` is wired to the REAL
 * `appendEventImpl` (extensions/mega-runtime/append-event.ts) against a temp
 * stateDir, so each breadcrumb is serialized to a real events.log exactly as it
 * is in production. The tests then read that file back and parse the JSON — the
 * `ts` + `event` shape is observed, never simulated.
 */
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { VectorStore } from "../../../src/vectorStore.js";
import { compactSession } from "../../../src/engine.js";
import { appendEventImpl } from "../../mega-runtime/append-event.js";
import type { MegaRuntime } from "../../mega-runtime.js";
import type { MegaConfig } from "../../mega-config.js";
import type { Logger } from "../../../src/log.js";

/** Real EngineMessage fixture. */
export function msg(role: "user" | "assistant", text: string): any {
	return { role, text };
}

/** A user-role AgentMessage carrying `text` (the tail-block shape). */
export function userMsg(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1 } as unknown as AgentMessage;
}

/** One parsed events.log line. `ts` + `event` are the contract the dashboard
 *  Events tab (server.ts SSE tail of stateDir/events.log) consumes. */
export interface LoggedEvent {
	ts: unknown;
	event: unknown;
	[k: string]: unknown;
}

/** Fresh isolated state dir per VectorStore. */
export function freshStore(): { store: VectorStore; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "mc-3wf5-"));
	return { store: new VectorStore({ dedupSim: 0.9, stateDir: dir }), dir };
}

/** Persist N distinct checkpoints with ascending timestamps. */
export function seed(store: VectorStore, topics: string[], sid: string): void {
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

/**
 * Read + JSON-parse every line of the REAL events.log written under `stateDir`.
 * PREVENT-001: parse failures are surfaced as null and filtered, never thrown.
 */
export function readEventsLog(stateDir: string): LoggedEvent[] {
	const path = join(stateDir, "events.log");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((line): LoggedEvent | null => {
			try {
				const parsed: unknown = JSON.parse(line);
				if (parsed == null || typeof parsed !== "object") return null;
				return parsed as LoggedEvent;
			} catch {
				return null;
			}
		})
		.filter((e): e is LoggedEvent => e != null);
}

/** Silent logger (the debug-gated sink is not under test here). */
export const noopLogger: Logger = {
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as Logger;

/**
 * MegaRuntime whose `appendEvent` is the REAL events.log writer bound to
 * `stateDir`. Only the fields the 3WF guards touch are populated.
 */
export function realEventRuntime(
	store: VectorStore,
	stateDir: string,
	over: Partial<{
		pendingRecallBlock: string | undefined;
		pendingMemoryRecallBlock: string | undefined;
		effectiveThreshold: number;
	}> = {},
): MegaRuntime {
	const self = {
		store,
		currentStateDir: stateDir,
		pendingRecallBlock: over.pendingRecallBlock,
		pendingMemoryRecallBlock: over.pendingMemoryRecallBlock,
		effectiveThreshold: over.effectiveThreshold ?? 100_000,
		lastCtxWindow: 0,
		logger: noopLogger,
		perfTurnStart: undefined,
		rt: { recallInjectedThisTurn: false, lastCheckpointId: null as string | null },
		appendEvent(event: string, fields: Record<string, unknown>): void {
			appendEventImpl({ currentStateDir: stateDir }, event, fields);
		},
	};
	return self as unknown as MegaRuntime;
}

/** ctx stub with a configurable session id + latest-user query. */
export function ctxStub(opts: { sessionId?: string; query?: string } = {}): any {
	const sessionId = opts.sessionId ?? "sess_3wf5";
	const query = opts.query ?? "dedupe race in store";
	return {
		cwd: "/tmp",
		sessionManager: {
			getSessionId: () => sessionId,
			getEntries: () => [
				{
					type: "message",
					id: "e1",
					parentId: null,
					timestamp: "1",
					message: { role: "user", content: query },
				},
			],
		},
	};
}

/** Config stub: only the flags the 3WF guards read. */
export function configStub(
	over: Partial<{
		threeWayFailback: boolean;
		recallTailInject: boolean;
		thrashRearmPct: number;
	}> = {},
): MegaConfig {
	return {
		threeWayFailback: over.threeWayFailback ?? true,
		recallTailInject: over.recallTailInject ?? true,
		thrashRearmPct: over.thrashRearmPct ?? 0.1,
		autoInlineK: 3,
		tier: "custom",
		tierPct: null,
	} as unknown as MegaConfig;
}
