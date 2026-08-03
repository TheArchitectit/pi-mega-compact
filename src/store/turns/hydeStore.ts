/**
 * turns/hydeStore.ts — read helpers over the H1 telemetry columns.
 *
 * Pure read aggregations on the turns table. All queries parameterized
 * (PREVENT-002); no mutation here (turns stays append-only).
 */
import type { DatabaseSync } from "node:sqlite";

export interface TurnTelemetryRow {
	turnId: string;
	conversationId: string;
	turnIndex: number;
	role: string;
	endedAt: number;
	hydeRan: number;
	hydeDoc: string;
	hydeRawCount: number;
	hydeHydeCount: number;
	hydeFusedCount: number;
	hydeLift: number;
	hydeGenerationMs: number;
	recallScore: number;
	recallPass: number;
	recallRelevance: number;
	recallCoverage: number;
	recallDiversity: number;
	recallSpecificity: number;
}

export function listTelemetryTurns(
	db: DatabaseSync,
	opts: { limit?: number } = {},
): TurnTelemetryRow[] {
	const limit = Math.max(1, opts.limit ?? 200);
	return db
		.prepare(
			`SELECT id AS turnId, conversation_id AS conversationId,
			        turn_index AS turnIndex, role, ended_at AS endedAt,
			        hyde_ran AS hydeRan, hyde_doc AS hydeDoc,
			        hyde_raw_count AS hydeRawCount, hyde_hyde_count AS hydeHydeCount,
			        hyde_fused_count AS hydeFusedCount, hyde_lift AS hydeLift,
			        hyde_generation_ms AS hydeGenerationMs,
			        recall_score AS recallScore, recall_pass AS recallPass,
			        recall_relevance AS recallRelevance, recall_coverage AS recallCoverage,
			        recall_diversity AS recallDiversity, recall_specificity AS recallSpecificity
			 FROM turns
			 WHERE hyde_ran = 1 OR recall_pass IS NOT NULL
			 ORDER BY ended_at DESC
			 LIMIT ?`,
		)
		.all(limit) as unknown as TurnTelemetryRow[];
}

export interface DailyTelemetry {
	day: string;
	recallCount: number;
	hydeRanCount: number;
	avgScore: number | null;
	avgLift: number | null;
	avgGenMs: number | null;
}

export function aggregateDailyTelemetry(
	db: DatabaseSync,
	days: number,
): DailyTelemetry[] {
	const since = Date.now() - days * 86_400_000;
	return db
		.prepare(
			`SELECT date(ended_at / 1000, 'unixepoch') AS day,
			        COUNT(*) AS recallCount,
			        SUM(hyde_ran) AS hydeRanCount,
			        AVG(recall_score) AS avgScore,
			        AVG(hyde_lift) AS avgLift,
			        AVG(hyde_generation_ms) AS avgGenMs
			 FROM turns
			 WHERE ended_at >= ? AND (hyde_ran = 1 OR recall_pass IS NOT NULL)
			 GROUP BY day ORDER BY day ASC`,
		)
		.all(since) as unknown as DailyTelemetry[];
}
