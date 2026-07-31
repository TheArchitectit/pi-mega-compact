/**
 * api-contracts/memory.ts — Memory effectiveness stats contract (S53B).
 *
 * Response shape for GET /api/memory-status: aggregate memory-store statistics
 * including total count, 30-day window, top-N stable memories by recall, and
 * average recall score.
 */

export interface MemoryStatsTopMemory {
	readonly id: number;
	readonly text: string;
	/** Number of times the memory was injected at a turn (turn_recall.source='memory'). */
	readonly recallCount: number;
	/** Unix timestamp (seconds) of last recall, or null if never. */
	readonly lastRecalledAt: number | null;
}

/** Response body for GET /api/memory-status. */
export interface MemoryStatusResponse {
	readonly totalMemories: number;
	/** Memories created within the last 30 days. */
	readonly memoriesInLast30Days: number;
	/** Top-N memories sorted by recallCount descending. */
	readonly topStableMemories: MemoryStatsTopMemory[];
	/** Mean recallCount across all recalled memories (0 when none). */
	readonly avgRecallScore: number;
}