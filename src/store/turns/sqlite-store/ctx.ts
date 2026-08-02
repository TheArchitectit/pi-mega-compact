/**
 * ctx.ts — internal context interface for SqliteTurnStore method bodies
 * (extracted from sqlite-store.ts). Each free function in this directory
 * operates on a SqliteTurnStoreCtx so the shell class can delegate without
 * exposing its private fields.
 */
import type { DatabaseSync } from "node:sqlite";
import type { TurnStoreOptions } from "../types.js";

export interface SqliteTurnStoreCtx {
	db: DatabaseSync;
	stateDir: string;
	opts: TurnStoreOptions;
}
