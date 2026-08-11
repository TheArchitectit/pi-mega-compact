/**
 * write.ts — AnalyticsWriter delegate bodies for the SQLite backend.
 *
 * All methods are append-only (INSERT only, never UPDATE). They return
 * AppendResult — never throw into the host. INSERT OR IGNORE handles duplicate
 * ids gracefully (PMA spec §5: "AppendResult identifies accepted/duplicate/
 * failed without throwing").
 */
import type {
	RequestEventFact,
	MeasurementFact,
	IdentityObservation,
	AppendResult,
} from "../types.js";
import type { AnalyticsStoreCtx } from "./ctx.js";

export function appendRequestEvent(ctx: AnalyticsStoreCtx, fact: RequestEventFact): AppendResult {
	try {
		const res = ctx.db
			.prepare(
				`INSERT OR IGNORE INTO request_events (
					id, correlation_id, session_id, repo_id, turn_id, event_kind,
					observed_at, provider, model, status,
					input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
					duration_ms, ttft_ms, source, quality_json
				) VALUES (
					@id, @correlation_id, @session_id, @repo_id, @turn_id, @event_kind,
					@observed_at, @provider, @model, @status,
					@input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens,
					@duration_ms, @ttft_ms, @source, @quality_json
				)`,
			)
			.run({
				"@id": fact.id,
				"@correlation_id": fact.correlationId ?? null,
				"@session_id": fact.sessionId ?? null,
				"@repo_id": fact.repoId ?? null,
				"@turn_id": fact.turnId ?? null,
				"@event_kind": fact.eventKind,
				"@observed_at": fact.observedAt,
				"@provider": fact.provider ?? null,
				"@model": fact.model ?? null,
				"@status": fact.status ?? null,
				"@input_tokens": fact.inputTokens ?? null,
				"@output_tokens": fact.outputTokens ?? null,
				"@cache_read_tokens": fact.cacheReadTokens ?? null,
				"@cache_write_tokens": fact.cacheWriteTokens ?? null,
				"@duration_ms": fact.durationMs ?? null,
				"@ttft_ms": fact.ttftMs ?? null,
				"@source": fact.source,
				"@quality_json": JSON.stringify(fact.quality ?? {}),
			}) as { changes?: number };
		return (res.changes ?? 0) > 0
			? { status: "accepted", id: fact.id }
			: { status: "duplicate", id: fact.id };
	} catch (e) {
		return { status: "failed", error: String(e) };
	}
}

export function appendMeasurement(ctx: AnalyticsStoreCtx, fact: MeasurementFact): AppendResult {
	try {
		const res = ctx.db
			.prepare(
				`INSERT INTO measurement_samples (
					observed_at, sample_kind, provider, model, value, unit,
					correlation_id, source, quality_json
				) VALUES (
					@observed_at, @sample_kind, @provider, @model, @value, @unit,
					@correlation_id, @source, @quality_json
				)`,
			)
			.run({
				"@observed_at": fact.observedAt,
				"@sample_kind": fact.sampleKind,
				"@provider": fact.provider ?? null,
				"@model": fact.model ?? null,
				"@value": fact.value,
				"@unit": fact.unit,
				"@correlation_id": fact.correlationId ?? null,
				"@source": fact.source,
				"@quality_json": JSON.stringify(fact.quality ?? {}),
			}) as { lastInsertRowid?: number | bigint };
		return { status: "accepted", id: Number(res.lastInsertRowid ?? 0) };
	} catch (e) {
		return { status: "failed", error: String(e) };
	}
}

export function appendIdentity(ctx: AnalyticsStoreCtx, obs: IdentityObservation): AppendResult {
	try {
		const res = ctx.db
			.prepare(
				`INSERT INTO identity_observations (
					observed_at, provider, model, source, metadata_json
				) VALUES (
					@observed_at, @provider, @model, @source, @metadata_json
				)`,
			)
			.run({
				"@observed_at": obs.observedAt,
				"@provider": obs.provider ?? null,
				"@model": obs.model ?? null,
				"@source": obs.source,
				"@metadata_json": JSON.stringify(obs.metadata ?? {}),
			}) as { lastInsertRowid?: number | bigint };
		return { status: "accepted", id: Number(res.lastInsertRowid ?? 0) };
	} catch (e) {
		return { status: "failed", error: String(e) };
	}
}
