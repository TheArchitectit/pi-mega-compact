/**
 * api-contracts/memory.ts — S53B durable-memory effectiveness contracts.
 *
 * `GET /api/memory-status` serves the aggregates computed by
 * src/memoryStats.ts over the `memories` table (main store) + memory-source
 * `turn_recall` provenance (turns.db). This is the first surface that shows
 * whether durable memory is actually earning its context budget:
 * served-vs-stored counts, recall events, average recall score, and the
 * top-stable memory list that feeds prompt-cache-friendly promotion (S53B §2
 * in docs/specs/s53-prompt-cache-memory-program.md).
 *
 * PREVENT-PI-004: loopback-only; all values derive from local SQLite stores.
 */

/** One memory with its stability blend (present only when the
 *  MEGACOMPACT_MEMORY_STABILITY flag is on, which is the default). */
export interface MemoryStabilityRowResponse {
	readonly id: number;
	readonly kind: string;
	readonly category: string | null;
	/** Blended stability 0–1 (0.5 freq30d + 0.3 recency + 0.2 avgScore). */
	readonly stability: number;
	/** turn_recall events for this memory in the last 30 days. */
	readonly events30d: number;
	/** Mean recall score across those events, or null when never recalled. */
	readonly avgScore: number | null;
	/** Last auto-recall/manual-recall timestamp (epoch ms), or null. */
	readonly lastReferencedAt: number | null;
}

/** Response for GET /api/memory-status. */
export interface MemoryStatusResponse {
	/** ISO 8601 generation timestamp. */
	readonly updatedAt: string;
	/** Repo the aggregates are scoped to, or null for machine-wide. */
	readonly scope: string | null;
	readonly totals: {
		/** All memories in scope. */
		readonly memories: number;
		/** Memories never served by recall nor manually recalled. */
		readonly neverReferenced: number;
		/** Memories at/above the stable threshold (null when flag off). */
		readonly stable: number | null;
	};
	readonly recall: {
		/** Fixed aggregation window in days. */
		readonly windowDays: 30;
		/** Memory-source turn_recall events in the window. */
		readonly events30d: number;
		/** Distinct memories appearing in those events. */
		readonly distinctMemories30d: number;
		/** Mean score across the events, or null when none. */
		readonly avgScore: number | null;
	};
	/** Top memories by stability (empty when the flag is off). */
	readonly topStable: MemoryStabilityRowResponse[];
	/** Whether the stability blend was computed this response. */
	readonly stabilityEnabled: boolean;
}
