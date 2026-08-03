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
	PerfSamplesResponse,
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
	DebugBundleResponse,
	ProviderCacheResponse,
	CacheStripesResponse,
	SetupStatusResponse,
	SetupDetectResponse,
	SetupConfigureRequest,
	SetupConfigureResponse,
	EmbedderHealthResponse,
	RaptorTreeResponse,
	RaptorBuildHistoryResponse,
	SettingsResponse,
	SettingsUpdateRequest,
	SettingsResponsePost,
	RagMetricsResponse,
	ModelThresholdsResponse,
	ModelThresholdPutRequest,
	ModelThresholdPutResponse,
	WikiIndexResponse,
	WikiPageResponse,
	CurationResult,
	RenameTopicRequest,
	MergeTopicsRequest,
	SplitTopicRequest,
	TopicTimelineResponse,
	TopicEvolutionResponse,
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

/** GET /api/perf/samples — raw perf samples for one kind (chart drill-down). */
export function fetchPerfSamples(
	kind: string,
	minutes?: number,
): Promise<PerfSamplesResponse> {
	return getJson<PerfSamplesResponse>(
		`${ENDPOINTS.perfSamples.path}${query({ kind, minutes })}`,
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

/** Cache stripe distribution + health score (A3). */
export function fetchCacheStripes(): Promise<CacheStripesResponse> {
	return getJson<CacheStripesResponse>(ENDPOINTS.cacheStripes.path);
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

export function fetchDebugBundle(): Promise<DebugBundleResponse> {
	return postJson<DebugBundleResponse>("/api/maintenance/gather-debug", {});
}

// ─── Setup wizard (P0b) ────────────────────────────────────────────────────

/** GET /api/setup-status — current embedder configuration. */
export function fetchSetupStatus(): Promise<SetupStatusResponse> {
	return getJson<SetupStatusResponse>(ENDPOINTS.setupStatus.path);
}

/** GET /api/setup-detect — detect available local embedder backends. */
export function fetchSetupDetect(): Promise<SetupDetectResponse> {
	return getJson<SetupDetectResponse>(ENDPOINTS.setupDetect.path);
}

/** POST /api/setup-configure — write embedder config to .mega-compact.env. */
export function configureEmbedder(
	body: SetupConfigureRequest,
): Promise<SetupConfigureResponse> {
	return postJson<SetupConfigureResponse>(ENDPOINTS.setupConfigure.path, body);
}

// ─── RAPTOR tree (Part B) ─────────────────────────────────────────────

/** GET /api/raptor-tree — tree for a session (defaults to latest with nodes). */
export function fetchRaptorTree(
	sessionId?: string,
): Promise<RaptorTreeResponse> {
	return getJson<RaptorTreeResponse>(
		`${ENDPOINTS.raptorTree.path}${query({ sessionId })}`,
	);
}

/** GET /api/raptor-build-history — build history for a session (coherence, depth, timeout). */
export function fetchRaptorBuildHistory(
	sessionId?: string,
): Promise<RaptorBuildHistoryResponse> {
	return getJson<RaptorBuildHistoryResponse>(
		`${ENDPOINTS.raptorBuildHistory.path}${query({ sessionId })}`,
	);
}

/** GET /api/embedder-health — round-trip a test embed through the active embedder. */
export function fetchEmbedderHealth(): Promise<EmbedderHealthResponse> {
	return getJson<EmbedderHealthResponse>(ENDPOINTS.embedderHealth.path);
}

// ─── RAG Settings ─────────────────────────────────────────────────────

/** GET /api/rag-settings — read all adjustable settings grouped by category. */
export function fetchSettings(): Promise<SettingsResponse> {
	return getJson<SettingsResponse>(ENDPOINTS.ragSettings.path);
}

/** POST /api/rag-settings — update a single setting (writes the env file). */
export function postSetting(
	body: SettingsUpdateRequest,
): Promise<SettingsResponsePost> {
	return postJson<SettingsResponsePost>(ENDPOINTS.ragSettingsUpdate.path, body);
}

/** @deprecated Use fetchSettings instead. */
export function fetchRagSettings(): Promise<SettingsResponse> {
	return fetchSettings();
}

/** @deprecated Use postSetting instead. */
export function postRagSettings(
	body: SettingsUpdateRequest,
): Promise<SettingsResponsePost> {
	return postSetting(body);
}

/** GET /api/rag-metrics — HyDE + recall-quality telemetry aggregates (H2). */
export function fetchRagMetrics(): Promise<RagMetricsResponse> {
	return getJson<RagMetricsResponse>(ENDPOINTS.ragMetrics.path);
}

// ─── Wiki Revival (W3) ────────────────────────────────────────────────

/** GET /api/wiki/index — wiki landing (topics with resolved labels + badges). */
export function fetchWikiIndex(): Promise<WikiIndexResponse> {
	return getJson<WikiIndexResponse>(ENDPOINTS.wikiIndex.path);
}

/** GET /api/wiki/topic/:topicId — single topic page + provenance. */
export function fetchWikiTopic(topicId: string): Promise<WikiPageResponse> {
	return getJson<WikiPageResponse>(
		ENDPOINTS.wikiTopic.path.replace(":topicId", encodeURIComponent(topicId)),
	);
}

/** PUT /api/wiki/topic/:topicId/label — rename a topic (user curation). */
export function renameTopic(
	topicId: string,
	label: string,
): Promise<CurationResult> {
	return putJson<CurationResult>(
		ENDPOINTS.renameTopic.path.replace(":topicId", encodeURIComponent(topicId)),
		{ label } satisfies RenameTopicRequest,
	);
}

/** POST /api/wiki/merge — merge source topic into target. */
export function mergeTopics(
	sourceTopicId: string,
	targetTopicId: string,
): Promise<CurationResult> {
	return postJson<CurationResult>(ENDPOINTS.mergeTopics.path, {
		sourceTopicId,
		targetTopicId,
	} satisfies MergeTopicsRequest);
}

/** POST /api/wiki/topic/:topicId/split — carve listed memories into a new topic. */
export function splitTopic(
	topicId: string,
	memoryIds: string[],
): Promise<CurationResult> {
	return postJson<CurationResult>(
		ENDPOINTS.splitTopic.path.replace(":topicId", encodeURIComponent(topicId)),
		{ memoryIds } satisfies SplitTopicRequest,
	);
}

/** GET /api/wiki/topic/:topicId/timeline — per-topic memory-addition buckets. */
export function fetchTopicTimeline(
	topicId: string,
): Promise<TopicTimelineResponse> {
	return getJson<TopicTimelineResponse>(
		ENDPOINTS.topicTimeline.path.replace(
			":topicId",
			encodeURIComponent(topicId),
		),
	);
}

/** GET /api/wiki/evolution — global D3 topic-evolution graph feed. */
export function fetchTopicEvolution(): Promise<TopicEvolutionResponse> {
	return getJson<TopicEvolutionResponse>(ENDPOINTS.topicEvolution.path);
}

// ─── Per-model compaction thresholds (S52 / v0.16.1) ────────────────────

/** GET /api/model-thresholds — list known models with their thresholds. */
export function fetchModelThresholds(): Promise<ModelThresholdsResponse> {
	return getJson<ModelThresholdsResponse>(ENDPOINTS.modelThresholds.path);
}

/** PUT /api/model-thresholds — upsert a per-model override. */
export function putModelThreshold(
	body: ModelThresholdPutRequest,
): Promise<ModelThresholdPutResponse> {
	return putJson<ModelThresholdPutResponse>(
		ENDPOINTS.modelThresholds.path,
		body,
	);
}

/** DELETE /api/model-thresholds/:modelId — delete an override (revert). */
export async function deleteModelThreshold(
	modelId: string,
): Promise<{ deleted: boolean }> {
	const res = await fetch(
		`${ENDPOINTS.modelThresholds.path}/${encodeURIComponent(modelId)}`,
		{ method: "DELETE" },
	);
	if (!res.ok) throw new Error(`deleteModelThreshold ${res.status}`);
	return res.json() as Promise<{ deleted: boolean }>;
}
