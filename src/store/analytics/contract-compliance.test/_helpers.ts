/** Helpers for the analytics compliance suite. */
import type { AnalyticsStoreOptions, AnalyticsStore, RequestEventFact, MeasurementFact, IdentityObservation } from "../types.js";

export type StoreFactory = (options: AnalyticsStoreOptions) => AnalyticsStore;

let counter = 0;

/** Create a valid RequestEventFact with sensible defaults + overrides. */
export function makeRequestEvent(overrides: Partial<RequestEventFact> = {}): RequestEventFact {
	return {
		id: `evt_${++counter}`,
		correlationId: "corr_test",
		sessionId: "sess_test",
		eventKind: "request_started",
		observedAt: Date.now(),
		provider: "anthropic",
		model: "claude-sonnet-4",
		source: "test",
		quality: {},
		...overrides,
	};
}

/** Create a valid MeasurementFact. */
export function makeMeasurement(overrides: Partial<MeasurementFact> = {}): MeasurementFact {
	return {
		observedAt: Date.now(),
		sampleKind: "cache_hit_pct",
		value: 72.5,
		unit: "percent",
		source: "test",
		quality: {},
		...overrides,
	};
}

/** Create a valid IdentityObservation. */
export function makeIdentity(overrides: Partial<IdentityObservation> = {}): IdentityObservation {
	return {
		observedAt: Date.now(),
		provider: "anthropic",
		model: "claude-sonnet-4",
		source: "test",
		metadata: { contextWindow: 200000 },
		...overrides,
	};
}
