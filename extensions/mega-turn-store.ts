/**
 * mega-turn-store.ts — S49 adapter: route per-turn writes to the isolated
 * turns.db (flag ON) or the legacy main-db helpers (flag OFF).
 *
 * This is the ONLY pi-coupled seam for turn writes. src/store/turns/ stays
 * pi-agnostic; this module maps the extension's (sessionId, stateDir, config)
 * onto whichever backend the flag selects. Both paths are best-effort at the
 * call site (try/catch in the handlers), so a failure never breaks the agent
 * loop or the recall path.
 */
import {
	createTurnStore,
	type TurnStore,
	type RecordTurnInput,
	type RecordTurnRecallHit,
} from "../src/store/turns/index.js";
import {
	recordTurn as legacyRecordTurn,
	recordTurnRecall as legacyRecordTurnRecall,
	ensureConversationId as legacyEnsureConversationId,
} from "../src/store/sqlite/turns.js";
import type { MegaConfig } from "./mega-config.js";

// Per-stateDir cache of turn stores so the extension doesn't reopen the file
// on every turn. Keyed by stateDir; the underlying connection is also cached
// in src/store/turns/connection.ts, so this is a thin factory memo.
const stores = new Map<string, TurnStore>();

function storeFor(stateDir: string): TurnStore {
	let s = stores.get(stateDir);
	if (!s) {
		s = createTurnStore(stateDir);
		stores.set(stateDir, s);
	}
	return s;
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

/** Record one turn row (turn_end). Returns the turn id. */
export function recordTurnWrite(
	config: MegaConfig,
	input: RecordTurnInput,
	stateDir: string,
): number {
	return config.turnsDbEnabled
		? storeFor(stateDir).recordTurn(input)
		: legacyRecordTurn(input, stateDir);
}

/** Record recall provenance for a turn. */
export function recordRecallWrite(
	config: MegaConfig,
	turnId: number,
	hits: RecordTurnRecallHit[],
	stateDir: string,
): void {
	if (config.turnsDbEnabled) {
		storeFor(stateDir).recordTurnRecall(turnId, hits);
	} else {
		legacyRecordTurnRecall(turnId, hits, stateDir);
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
		? storeFor(stateDir).stampTurnsEpoch(sessionId, epochId)
		: 0;
}
