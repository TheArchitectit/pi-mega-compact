/**
 * dashboard-client/src/api/client.ts — typed fetch wrappers using A1 contracts.
 *
 * PREVENT-PI-004: every request targets a relative path (loopback-only —
 * the dashboard server is the same origin that serves this static bundle).
 * No absolute URLs, no external hosts.
 *
 * Uses the ENDPOINTS registry from A1 as the single source of truth for
 * paths + methods. Response types come from the api-contracts domain modules.
 */

import { ENDPOINTS } from "@contracts";
import type {
	SnapshotResponse,
	VersionResponse,
	IndexesSummaryResponse,
	IndexFallbackResponse,
	ReposResponse,
	SummaryResponse,
	DriftReportResponse,
	ServersResponse,
	GameStateResponse,
	GameStatePatch,
	GameScoreRow,
	GameScoresQuery,
	PerfResponse,
	PerfQuery,
	AchievementRow,
	SessionsResponse,
	SessionTimeseriesResponse,
	TopicsResponse,
	TurnsResponse,
	ConversationTurnsResponse,
	RewindIntentsResponse,
	ForkResponse,
	PruneTurnsResponse,
	TopicMemoriesResponse,
	DbStatsResponse,
	SchemaHealthResponse,
	MaintenanceAction,
	MaintenanceActionResult,
	ProviderCacheResponse,
} from "@contracts";

/** Error thrown when a dashboard API response is not 2xx. */
export class ApiError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(`dashboard API ${status}: ${message}`);
		this.name = "ApiError";
		this.status = status;
	}
}

/** Internal: typed GET that throws ApiError on non-2xx. */
async function getJson<T>(path: string): Promise<T> {
	// guardrails-allow PREVENT-PI-004: relative-path fetch to same-origin dashboard server (loopback-only, static bundle served by the same Node HTTP server).
	const res = await fetch(path);
	if (!res.ok) {
		throw new ApiError(
			res.status,
			await res.text().catch(() => res.statusText),
		);
	}
	return res.json() as Promise<T>;
}

/** Internal: typed PUT that throws ApiError on non-2xx. */
async function putJson<T>(path: string, body: unknown): Promise<T> {
	// guardrails-allow PREVENT-PI-004: relative-path fetch to same-origin dashboard server (loopback-only).
	const res = await fetch(path, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new ApiError(
			res.status,
			await res.text().catch(() => res.statusText),
		);
	}
	return res.json() as Promise<T>;
}

/** Internal: typed POST that throws ApiError on non-2xx. */
async function postJson<T>(path: string, body: unknown): Promise<T> {
	// guardrails-allow PREVENT-PI-004: relative-path fetch to same-origin dashboard server (loopback-only, static bundle served by the same Node HTTP server).
	const res = await fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new ApiError(
			res.status,
			await res.text().catch(() => res.statusText),
		);
	}
	return res.json() as Promise<T>;
}

/** Build a query string from a record, skipping undefined/null values. */
function query(
	params: Record<string, string | number | undefined | null>,
): string {
	const sp = new URLSearchParams();
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined && v !== null) sp.set(k, String(v));
	}
	const qs = sp.toString();
	return qs ? `?${qs}` : "";
}

// ─── Endpoint wrappers ──────────────────────────────────────────────────────

export function fetchSnapshot(): Promise<SnapshotResponse> {
	return getJson<SnapshotResponse>(ENDPOINTS.snapshot.path);
}

export function fetchVersion(): Promise<VersionResponse> {
	return getJson<VersionResponse>(ENDPOINTS.version.path);
}

export function fetchIndex(): Promise<
	IndexesSummaryResponse | IndexFallbackResponse
> {
	return getJson<IndexesSummaryResponse | IndexFallbackResponse>(
		ENDPOINTS.index.path,
	);
}

export function fetchRepos(activeHours?: number): Promise<ReposResponse> {
	return getJson<ReposResponse>(
		`${ENDPOINTS.repos.path}${query({ active: activeHours ? `${activeHours}h` : undefined })}`,
	);
}

export function fetchSummary(): Promise<SummaryResponse> {
	return getJson<SummaryResponse>(ENDPOINTS.summary.path);
}

export function fetchDrift(): Promise<DriftReportResponse> {
	return getJson<DriftReportResponse>(ENDPOINTS.drift.path);
}

export function fetchServers(): Promise<ServersResponse> {
	return getJson<ServersResponse>(ENDPOINTS.servers.path);
}

export function fetchGameState(): Promise<GameStateResponse> {
	return getJson<GameStateResponse>(ENDPOINTS.getGameState.path);
}

export function putGameState(
	patch: GameStatePatch,
): Promise<GameStateResponse> {
	return putJson<GameStateResponse>(ENDPOINTS.putGameState.path, patch);
}

export function fetchGameScores(
	params: GameScoresQuery = {},
): Promise<GameScoreRow[]> {
	return getJson<GameScoreRow[]>(
		`${ENDPOINTS.gameScores.path}${query({ metric: params.metric, limit: params.limit })}`,
	);
}

export function fetchPerf(params: PerfQuery = {}): Promise<PerfResponse> {
	return getJson<PerfResponse>(
		`${ENDPOINTS.perf.path}${query({ minutes: params.minutes })}`,
	);
}

export function fetchAchievements(): Promise<AchievementRow[]> {
	return getJson<AchievementRow[]>(ENDPOINTS.achievements.path);
}

export function fetchSessions(): Promise<SessionsResponse> {
	return getJson<SessionsResponse>(ENDPOINTS.sessions.path);
}

export function fetchSessionTimeseries(
	minutes: number,
): Promise<SessionTimeseriesResponse> {
	return getJson<SessionTimeseriesResponse>(
		`${ENDPOINTS.sessionTimeseries.path}${query({ minutes })}`,
	);
}

export function fetchTopics(): Promise<TopicsResponse> {
	return getJson<TopicsResponse>(ENDPOINTS.topics.path);
}

/** Lifetime provider prompt cache aggregates + $ savings estimate. */
export function fetchProviderCache(): Promise<ProviderCacheResponse> {
	return getJson<ProviderCacheResponse>(ENDPOINTS.providerCache.path);
}

// ── S52: turn-by-turn memory tracking + recall + rewind ───────────────

export function fetchTurns(): Promise<TurnsResponse> {
	return getJson<TurnsResponse>(ENDPOINTS.turns.path);
}

export function fetchConversationTurns(
	conversationId: string,
): Promise<ConversationTurnsResponse> {
	return getJson<ConversationTurnsResponse>(
		`${ENDPOINTS.conversationTurns.path.replace(":convId", encodeURIComponent(conversationId))}`,
	);
}

export function fetchTurnIntents(): Promise<RewindIntentsResponse> {
	return getJson<RewindIntentsResponse>(ENDPOINTS.turnIntents.path);
}

export function postTurnIntent(
	conversationId: string,
	targetTurnIndex: number,
): Promise<unknown> {
	return postJson<unknown>(ENDPOINTS.postTurnIntent.path, {
		conversationId,
		targetTurnIndex,
	});
}

export function postFork(
	conversationId: string,
	turnIndex: number,
): Promise<ForkResponse> {
	return postJson<ForkResponse>(ENDPOINTS.fork.path, {
		conversationId,
		turnIndex,
	});
}

export function postPruneTurns(
	maxTurnAgeMs: number,
	keepMinPerConversation = 50,
): Promise<PruneTurnsResponse> {
	return postJson<PruneTurnsResponse>(ENDPOINTS.pruneTurns.path, {
		maxTurnAgeMs,
		keepMinPerConversation,
	});
}

export function fetchTopicMemories(
	topicId: string,
): Promise<TopicMemoriesResponse> {
	return getJson<TopicMemoriesResponse>(
		ENDPOINTS.topicMemories.path.replace(
			":topicId",
			encodeURIComponent(topicId),
		),
	);
}

// ─── Maintenance (S49B) ─────────────────────────────────────────────────

export function fetchDbStats(): Promise<DbStatsResponse> {
	return getJson<DbStatsResponse>(ENDPOINTS.maintenanceStats.path);
}

export function fetchSchemaHealth(): Promise<SchemaHealthResponse> {
	return getJson<SchemaHealthResponse>(ENDPOINTS.schemaHealth.path);
}

export function postMaintenanceAction(
	action: MaintenanceAction,
): Promise<MaintenanceActionResult> {
	return postJson<MaintenanceActionResult>(
		ENDPOINTS.maintenanceAction.path,
		action,
	);
}
