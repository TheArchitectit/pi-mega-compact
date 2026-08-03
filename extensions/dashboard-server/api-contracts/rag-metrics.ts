/**
 * api-contracts/rag-metrics.ts — GET /api/rag-metrics response + HyDE/recall SSE
 * event contracts (H1/H2).
 */
import type { TurnTelemetryRow, DailyTelemetry } from "../../../src/store/turns/hydeStore.js";

export interface RagMetricsResponse {
	flags: {
		hydeEnabled: boolean;
		recallMetricsEnabled: boolean;
	};
	totals: {
		telemetryTurns: number;
		hydeRanTurns: number;
		avgLift: number;
		avgScore: number | null;
		avgGenerationMs: number;
		recentPassRate: number;
	};
	recent: TurnTelemetryRow[];
	daily: DailyTelemetry[];
}
