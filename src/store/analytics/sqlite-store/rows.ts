/**
 * rows.ts — row ↔ fact mappers for the SQLite analytics store.
 * Maps snake_case DB columns to camelCase contract fields.
 */
import type {
	RequestEventFact,
	MeasurementFact,
	IdentityObservation,
	RequestEventKind,
	QualityNote,
} from "../types.js";

export function rowToRequestEvent(r: Record<string, unknown>): RequestEventFact {
	return {
		id: r.id as string,
		correlationId: (r.correlation_id as string) ?? undefined,
		sessionId: (r.session_id as string) ?? undefined,
		repoId: (r.repo_id as string) ?? undefined,
		turnId: (r.turn_id as string) ?? undefined,
		eventKind: r.event_kind as RequestEventKind,
		observedAt: r.observed_at as number,
		provider: (r.provider as string) ?? undefined,
		model: (r.model as string) ?? undefined,
		status: (r.status as string) ?? undefined,
		inputTokens: (r.input_tokens as number) ?? undefined,
		outputTokens: (r.output_tokens as number) ?? undefined,
		cacheReadTokens: (r.cache_read_tokens as number) ?? undefined,
		cacheWriteTokens: (r.cache_write_tokens as number) ?? undefined,
		durationMs: (r.duration_ms as number) ?? undefined,
		ttftMs: (r.ttft_ms as number) ?? undefined,
		source: r.source as RequestEventFact["source"],
		quality: JSON.parse((r.quality_json as string) ?? "{}") as QualityNote,
	};
}

export function rowToMeasurement(r: Record<string, unknown>): MeasurementFact {
	return {
		observedAt: r.observed_at as number,
		sampleKind: r.sample_kind as string,
		provider: (r.provider as string) ?? undefined,
		model: (r.model as string) ?? undefined,
		value: r.value as number,
		unit: r.unit as string,
		correlationId: (r.correlation_id as string) ?? undefined,
		source: r.source as MeasurementFact["source"],
		quality: JSON.parse((r.quality_json as string) ?? "{}") as QualityNote,
	};
}

export function rowToIdentity(r: Record<string, unknown>): IdentityObservation {
	return {
		observedAt: r.observed_at as number,
		provider: (r.provider as string) ?? undefined,
		model: (r.model as string) ?? undefined,
		source: r.source as IdentityObservation["source"],
		metadata: JSON.parse((r.metadata_json as string) ?? "{}") as Record<string, unknown>,
	};
}
