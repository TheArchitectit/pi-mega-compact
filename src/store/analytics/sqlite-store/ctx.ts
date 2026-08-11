/** The shared context passed to every SQLite delegate function. */
import type { DatabaseSync } from "node:sqlite";
import type { AnalyticsStoreOptions } from "../types.js";

export interface AnalyticsStoreCtx {
	db: DatabaseSync;
	stateDir: string;
	opts: AnalyticsStoreOptions;
}
