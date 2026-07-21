/**
 * dashboard-client/src/utils/types.ts — local extended types.
 *
 * The runtime snapshot (mega-dashboard.ts) includes fields not present in
 * the A1 SnapshotResponse contract (e.g. config.tierPct). This file adds
 * those fields in a type-safe way without using `any`.
 */

import type { SnapshotResponse } from "@contracts";

/**
 * SnapshotResponse extended with runtime-only fields.
 * These fields are emitted by the server but absent from the contract.
 */
export interface RuntimeSnapshot extends SnapshotResponse {
	config: SnapshotResponse["config"] & {
		/** Tier percentage as a 0–1 fraction (runtime-only, not in contract). */
		tierPct?: number;
	};
}

/** Actual flat game-state shape from the server (not the nested contract). */
export interface DashboardGameState {
	game_mode_on: boolean;
	theme: string;
	tui_display_mode: "full" | "minimal";
}
