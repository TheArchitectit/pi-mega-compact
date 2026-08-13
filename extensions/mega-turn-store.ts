/**
 * mega-turn-store.ts — S49 adapter: route per-turn writes to the isolated
 * turns.db (flag ON) or the legacy main-db helpers (flag OFF).
 *
 * RECONCILIATION: maps the extension's per-turn writes onto the contract-first
 * `TurnStore` (master's design): `appendTurn` / `appendRecall` /
 * `ensureConversationId` / `asAdmin().stampTurnsEpoch` / `forkConversation`.
 * src/store/turns/ stays pi-agnostic; this module is the ONLY pi-coupled seam for
 * turn writes. Both paths are best-effort at the call site (try/catch in the
 * handlers), so a failure never breaks the agent loop or the recall path.
 */
import {
	createTurnStore,
	type TurnStore,
	type TurnReader,
	type TurnEntry,
	type TurnRecallEntry,
	type TurnHydeTelemetry,
	type TurnRecallTelemetry,
} from "../src/store/turns/index.js";
import {
	recordTurn as legacyRecordTurn,
	recordTurnRecall as legacyRecordTurnRecall,
	ensureConversationId as legacyEnsureConversationId,
} from "../src/store/sqlite/turns.js";
import type { MegaConfig } from "./mega-config.js";
import type { DatabaseSync } from "node:sqlite";
import { openStore } from "../src/store/sqlite/utils.js";

// Per-stateDir cache of turn stores so the extension doesn't reopen the file
// on every turn. Keyed by stateDir; the underlying connection is also cached
// in src/store/turns/connection.ts, so this is a thin factory memo.
const stores = new Map<string, TurnStore>();

function storeFor(stateDir: string): TurnStore {
	let s = stores.get(stateDir);
	if (!s) {
		s = createTurnStore({ stateDir });
		stores.set(stateDir, s);
	}
	return s;
}

/** Read-only view of the turn store for a state dir (e.g. nextTurnIndexFor). */
export function turnReaderFor(stateDir: string): TurnReader {
	return storeFor(stateDir).asReader();
}

/** Map a legacy RecallSource onto the contract `TurnRecallEntry.source` enum. */
function mapSource(s: string): TurnRecallEntry["source"] {
	switch (s) {
		case "flat":
		case "checkpoint":
			return "checkpoint";
		case "raptor":
		case "cluster_summary":
			return "cluster_summary";
		default:
			return "memory";
	}
}

/** Resolve (or generate) a session's conversation id on the active backend. */
export function ensureConversationIdFor(
	config: MegaConfig,
	sessionId: string,
	stateDir: string,
): string {
	return config.turnsDbEnabled
		? storeFor(stateDir).ensureConversationId(sessionId)
		: legacyEnsureConversationId(sessionId, stateDir);
}

/** Record one turn row (turn_end). Returns the contract TurnId (string). */
/** H1: HyDE telemetry write — a structural subset of HydeInvocationInfo. */
export type RecallHydeWrite = TurnHydeTelemetry;
/** H1: recall-quality write — a structural subset of RecallMetricsSnapshot. */
export type RecallMetricsWrite = TurnRecallTelemetry;

export function recordTurnWrite(
	config: MegaConfig,
	input: {
		conversationId: string;
		sessionId: string;
		turnIndex: number;
		/** S49R: pi's per-session counter, carried for the raw_transcript join. */
		sessionTurnIndex?: number;
		role: string;
		startedAt?: number;
		endedAt?: number;
		ctxTokens?: number;
		ctxPercent?: number;
		pressureBand?: string;
		modelId?: string;
		epochId?: string;
		/** H1: HyDE invocation telemetry (persisted to hyde_* columns). */
		hyde?: RecallHydeWrite;
		/** H1: recall-quality snapshot (persisted to recall_* columns). */
		recallMetrics?: RecallMetricsWrite;
	},
	stateDir: string,
): string {
	if (!config.turnsDbEnabled) {
		legacyRecordTurn(input as never, stateDir);
		return "";
	}
	const entry: TurnEntry = {
		conversationId: input.conversationId,
		sessionId: input.sessionId,
		turnIndex: input.turnIndex,
		sessionTurnIndex: input.sessionTurnIndex,
		role: input.role as TurnEntry["role"],
		endedAt: input.endedAt ?? input.startedAt ?? Date.now(),
		ctxTokens: input.ctxTokens,
		ctxPercent: input.ctxPercent,
		pressureBand: input.pressureBand as TurnEntry["pressureBand"],
		model: input.modelId,
		epochId: input.epochId,
		hyde: input.hyde,
		recallMetrics: input.recallMetrics,
	};
	return storeFor(stateDir).appendTurn(entry);
}

/** Record recall provenance for a turn (one hit at a time — contract is append-only). */
export function recordRecallWrite(
	config: MegaConfig,
	turnId: string | number,
	hits: Array<{
		checkpointId: string;
		score: number;
		source: string;
		raptorLevel?: number;
	}>,
	stateDir: string,
): void {
	if (!config.turnsDbEnabled) {
		legacyRecordTurnRecall(Number(turnId), hits as never, stateDir);
		return;
	}
	const writer = storeFor(stateDir).asWriter();
	for (const h of hits) {
		const entry: TurnRecallEntry = {
			turnId: String(turnId),
			checkpointId: h.checkpointId,
			score: h.score,
			source: mapSource(h.source),
			raptorLevel: h.raptorLevel,
		};
		writer.appendRecall(entry);
	}
}

/** S50B: stamp `epoch_id` on a session's unstamped turns (compact-commit).
 *  Isolated-store only — the legacy main-db turn path is being retired, so it
 *  is a no-op when turnsDbEnabled is false. Returns the number stamped. */
export function stampTurnsEpochFor(
	config: MegaConfig,
	sessionId: string,
	epochId: string,
	stateDir: string,
): number {
	return config.turnsDbEnabled
		? storeFor(stateDir).asAdmin().stampTurnsEpoch(sessionId, epochId)
		: 0;
}

/** S50C: resolve the active turn store for metrics/fork commands.
 *  Returns null when turnsDbEnabled is OFF (legacy main-db turn path — the
 *  per-turn metrics/fork commands are isolated-store only). */
export function turnStoreFor(
	config: MegaConfig,
	stateDir: string,
): TurnStore | null {
	return config.turnsDbEnabled ? storeFor(stateDir) : null;
}

/** S50C: open (cached) the main db handle for metrics read-queries
 *  (raw_transcript + checkpoint_epochs). Callers must NOT close it. */
export function mainDbFor(stateDir: string): DatabaseSync {
	return openStore(stateDir);
}

/** Test/teardown: close all cached turn stores for a state dir. */
export function closeTurnStoreFor(stateDir: string): void {
	const s = stores.get(stateDir);
	if (s) {
		s.close();
		stores.delete(stateDir);
	}
}
