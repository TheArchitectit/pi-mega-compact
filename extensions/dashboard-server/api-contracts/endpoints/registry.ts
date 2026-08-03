/**
 * api-contracts/endpoints/registry.ts — the ENDPOINTS registry object.
 *
 * Extracted from endpoints.ts (delegate-shell split). Single source of truth
 * for all dashboard API routes. Each entry is an `EndpointDef` (or
 * `SseEndpointDef` for SSE) instance with method, path, description, and typed
 * request/response references.
 *
 * Sprint A1 — PREVENT-PI-004: zero network code (type definitions only).
 * PREVENT-011: no `any` type — all types are explicit.
 */
import type { EndpointDef } from "../core.js";
import type { SnapshotResponse } from "../snapshot.js";
import type { IndexesSummaryResponse } from "../multi-repo.js";
import type { GameStateResponse } from "../game.js";
import type { SseEvent } from "../index.js";
import type { ProviderCacheResponse } from "../provider-cache.js";
import type { RaptorTreeResponse, RaptorBuildHistoryResponse } from "../raptor.js";
import type { MemoryStatusResponse } from "../memory.js";
import type { SetupStatusResponse, SetupDetectResponse, SetupConfigureRequest, SetupConfigureResponse } from "../setup.js";
import type { EmbedderHealthResponse } from "../embedder-health.js";
import type {
	RagSettingsResponse,
	RagSettingsRequest,
	RagSettingsResponsePost,
} from "../rag-settings.js";
import type { RagMetricsResponse } from "../rag-metrics.js";
import type {
	TurnsResponse,
	ConversationTurnsResponse,
	RewindIntentsResponse,
	ForkRequest,
	ForkResponse,
	PostIntentRequest,
	PruneRequest,
	PruneTurnsResponse,
	TopicMemoriesResponse,
} from "../turns.js";
import type {
	DbStatsResponse,
	MaintenanceActionResult,
	MaintenanceAction,
	SchemaHealthResponse,
} from "../maintenance.js";
import type { CacheStripesResponse } from "../cache-stripes.js";
import type {
	WikiIndexResponse,
	WikiPageResponse,
	TopicEvolutionResponse,
	TopicTimelineResponse,
	RenameTopicRequest,
	MergeTopicsRequest,
	SplitTopicRequest,
	CurationResult,
} from "../wiki.js";
import type {
	GameScoreRow,
	GameScoresQuery,
	AchievementRow,
	SessionsResponse,
	SessionTimeseriesQuery,
	SessionTimeseriesResponse,
	GameStatePatch,
	SseEndpointDef,
	TopicsResponse,
} from "../game-types.js";
import type {
	VersionResponse,
	IndexFallbackResponse,
	ReposQuery,
	ReposResponse,
	SummaryResponse,
	DriftReportResponse,
	ServersResponse,
	PerfQuery,
	PerfResponse,
} from "./types.js";

// ─── ENDPOINTS Registry ─────────────────────────────────────────────────────

/**
 * Central registry of all 14 dashboard API endpoints. Each entry is an
 * `EndpointDef` or `SseEndpointDef` instance serving as the single source of
 * truth for route paths, methods, descriptions, and typed request/response
 * contracts.
 *
 * Usage:
 *   import { ENDPOINTS } from './api-contracts';
 *   ENDPOINTS.snapshot.path   // '/api/snapshot'
 *   ENDPOINTS.snapshot.method // 'GET'
 */
export const ENDPOINTS = {
	/** GET /api/snapshot — Full session, store, compression, and context snapshot. */
	snapshot: {
		method: "GET",
		path: "/api/snapshot",
		description: "Full session, store, compression, and context snapshot.",
	} as const satisfies EndpointDef<"GET", undefined, SnapshotResponse>,

	/** GET /api/version — Dashboard server version string. */
	version: {
		method: "GET",
		path: "/api/version",
		description: "Dashboard server version for stale-server detection.",
	} as const satisfies EndpointDef<"GET", undefined, VersionResponse>,

	/** GET /api/index — Multi-repo aggregate index (or fallback when unavailable). */
	index: {
		method: "GET",
		path: "/api/index",
		description:
			"Machine-wide multi-repo registry with checkpoints, tokens, and model info.",
	} as const satisfies EndpointDef<
		"GET",
		undefined,
		IndexesSummaryResponse | IndexFallbackResponse
	>,

	/** GET /api/repos — Registry list with optional active-window filter. */
	repos: {
		method: "GET",
		path: "/api/repos",
		description: "Repo registry list, optionally filtered by recent activity.",
	} as const satisfies EndpointDef<"GET", ReposQuery, ReposResponse>,

	/** GET /api/summary — Lightweight header tiles without the full repo list. */
	summary: {
		method: "GET",
		path: "/api/summary",
		description:
			"Aggregate summary with active/total repo counts (no repo list).",
	} as const satisfies EndpointDef<"GET", undefined, SummaryResponse>,

	/** GET /api/drift — Cross-repo drift report. */
	drift: {
		method: "GET",
		path: "/api/drift",
		description:
			"Cross-repo drift report flagging stale repos, compaction lag, and model churn.",
	} as const satisfies EndpointDef<"GET", undefined, DriftReportResponse>,

	/** GET /api/servers — Recently-active repo servers with live snapshot data. */
	servers: {
		method: "GET",
		path: "/api/servers",
		description: "Recently-active repo servers with live snapshot data.",
	} as const satisfies EndpointDef<"GET", undefined, ServersResponse>,

	/** GET /api/events — SSE stream of dashboard events. */
	events: {
		type: "sse",
		method: "GET",
		path: "/api/events",
		description: "Server-Sent Events stream of all dashboard events.",
		event: "data",
	} as const satisfies SseEndpointDef<SseEvent>,

	/** GET /api/game-state — Current game-mode settings. */
	getGameState: {
		method: "GET",
		path: "/api/game-state",
		description: "Current game-mode configuration and active ritual state.",
	} as const satisfies EndpointDef<"GET", undefined, GameStateResponse>,

	/** PUT /api/game-state — Apply a partial patch to game-mode settings. */
	putGameState: {
		method: "PUT",
		path: "/api/game-state",
		description:
			"Apply a partial patch to game-mode settings and return the updated state.",
	} as const satisfies EndpointDef<"PUT", GameStatePatch, GameStateResponse>,

	/** GET /api/game-scores — High-score leaderboard for a metric. */
	gameScores: {
		method: "GET",
		path: "/api/game-scores",
		description: "High-score leaderboard for a game metric.",
	} as const satisfies EndpointDef<"GET", GameScoresQuery, GameScoreRow[]>,

	/** GET /api/perf — Rolling-window performance aggregates. */
	perf: {
		method: "GET",
		path: "/api/perf",
		description: "Rolling-window performance aggregates over perf_samples.",
	} as const satisfies EndpointDef<"GET", PerfQuery, PerfResponse>,

	/** GET /api/achievements — Achievement tiles with unlock state. */
	achievements: {
		method: "GET",
		path: "/api/achievements",
		description: "All achievement rows with unlock state.",
	} as const satisfies EndpointDef<"GET", undefined, AchievementRow[]>,

	/** GET /api/sessions — Active sessions with latest token usage (S39). */
	sessions: {
		method: "GET",
		path: "/api/sessions",
		description: "Active pi sessions with latest token usage + heartbeat.",
	} as const satisfies EndpointDef<"GET", undefined, SessionsResponse>,

	/** GET /api/sessions/timeseries — Stacked per-session token timeseries (S39). */
	sessionTimeseries: {
		method: "GET",
		path: "/api/sessions/timeseries",
		description:
			"Recharts-ready per-session token timeseries for the stacked memory graph.",
	} as const satisfies EndpointDef<
		"GET",
		SessionTimeseriesQuery,
		SessionTimeseriesResponse
	>,

	/** GET /api/topics — Auto-categorizing wiki topics (S51). */
	topics: {
		method: "GET",
		path: "/api/topics",
		description:
			"Auto-categorized wiki topics from k-means + TF-IDF over real embeddings.",
	} as const satisfies EndpointDef<"GET", undefined, TopicsResponse>,

	/** GET /api/turns — Turn-by-turn memory tracking + recall (S52). */
	turns: {
		method: "GET",
		path: "/api/turns",
		description:
			"Per-conversation turn list with recall + epoch provenance (turn-by-turn memory tracking).",
	} as const satisfies EndpointDef<"GET", undefined, TurnsResponse>,

	/** GET /api/turns/conversation/:convId — per-turn detail + recall hits. */
	conversationTurns: {
		method: "GET",
		path: "/api/turns/conversation/:convId",
		description:
			"Per-turn metrics + injected-checkpoint recall provenance for one conversation.",
	} as const satisfies EndpointDef<"GET", undefined, ConversationTurnsResponse>,

	/** GET /api/turns/intents — pending rewind intents (S52A). */
	turnIntents: {
		method: "GET",
		path: "/api/turns/intents",
		description:
			"Pending rewind intents queued by the dashboard for the host to consume.",
	} as const satisfies EndpointDef<"GET", undefined, RewindIntentsResponse>,

	/** POST /api/turns/intent — post a rewind intent. */
	postTurnIntent: {
		method: "POST",
		path: "/api/turns/intent",
		description:
			"Queue a rewind-to-turn-N intent for the host to apply at before_agent_start.",
	} as const satisfies EndpointDef<"POST", PostIntentRequest, unknown>,

	/** POST /api/fork — fork a conversation at a turn. */
	fork: {
		method: "POST",
		path: "/api/fork",
		description:
			"Branch a child conversation off a parent turn + return the recall set to rehydrate.",
	} as const satisfies EndpointDef<"POST", ForkRequest, ForkResponse>,

	/** POST /api/turns/prune — admin prune (capability-gated). */
	pruneTurns: {
		method: "POST",
		path: "/api/turns/prune",
		description:
			"Prune old turns (admin capability — dashboard uses asAdmin()).",
	} as const satisfies EndpointDef<"POST", PruneRequest, PruneTurnsResponse>,

	/** GET /api/topics/:topicId/memories — wiki topic drill-down (S52). */
	topicMemories: {
		method: "GET",
		path: "/api/topics/:topicId/memories",
		description: "Member memories assigned to a wiki topic (drill-down).",
	} as const satisfies EndpointDef<"GET", undefined, TopicMemoriesResponse>,

	// ─── Wiki Revival (W2) ───────────────────────────────────────────

	/** GET /api/wiki/index — wiki landing page with resolved labels. */
	wikiIndex: {
		method: "GET",
		path: "/api/wiki/index",
		description:
			"Wiki index: auto-categorized topics with resolved (override-aware) labels.",
	} as const satisfies EndpointDef<"GET", undefined, WikiIndexResponse>,

	/** GET /api/wiki/topic/:topicId — single topic page + provenance. */
	wikiTopic: {
		method: "GET",
		path: "/api/wiki/topic/:topicId",
		description:
			"Single wiki topic page: summary, key memories, and memory provenance.",
	} as const satisfies EndpointDef<"GET", undefined, WikiPageResponse>,

	/** PUT /api/wiki/topic/:topicId/label — rename a topic (user curation). */
	renameTopic: {
		method: "PUT",
		path: "/api/wiki/topic/:topicId/label",
		description:
			"Rename a wiki topic (persists a label override; emits wiki_topic_renamed).",
	} as const satisfies EndpointDef<"PUT", RenameTopicRequest, CurationResult>,

	/** POST /api/wiki/merge — merge one topic into another. */
	mergeTopics: {
		method: "POST",
		path: "/api/wiki/merge",
		description:
			"Merge source topic into target (reassigns memories; emits wiki_topics_merged).",
	} as const satisfies EndpointDef<"POST", MergeTopicsRequest, CurationResult>,

	/** POST /api/wiki/topic/:topicId/split — split listed memories into a new topic. */
	splitTopic: {
		method: "POST",
		path: "/api/wiki/topic/:topicId/split",
		description:
			"Split listed member memories into a new topic (emits wiki_topic_split).",
	} as const satisfies EndpointDef<"POST", SplitTopicRequest, CurationResult>,

	/** GET /api/wiki/topic/:topicId/timeline — per-topic time buckets. */
	topicTimeline: {
		method: "GET",
		path: "/api/wiki/topic/:topicId/timeline",
		description:
			"Per-topic memory-assignment timeline buckets for charts.",
	} as const satisfies EndpointDef<"GET", undefined, TopicTimelineResponse>,

	/** GET /api/wiki/evolution — node/edge D3 evolution graph. */
	topicEvolution: {
		method: "GET",
		path: "/api/wiki/evolution",
		description:
			"Topic evolution nodes + edges + time buckets from topic_evolution.",
	} as const satisfies EndpointDef<"GET", undefined, TopicEvolutionResponse>,

	// ─── S49B Maintenance Tab ─────────────────────────────────────────

	/** GET /api/maintenance — DB stats (table row counts + storage). */
	maintenanceStats: {
		method: "GET",
		path: "/api/maintenance",
		description: "SQLite table row counts, storage stats, and DB file sizes.",
	} as const satisfies EndpointDef<"GET", undefined, DbStatsResponse>,

	/** GET /api/maintenance/schema-health — Schema version + integrity audit. */
	schemaHealth: {
		method: "GET",
		path: "/api/maintenance/schema-health",
		description:
			"SCHEMA_VERSION, PRAGMA integrity_check, FK check, and per-column audit.",
	} as const satisfies EndpointDef<"GET", undefined, SchemaHealthResponse>,

	/** POST /api/maintenance/action — Trigger a maintenance action. */
	maintenanceAction: {
		method: "POST",
		path: "/api/maintenance/action",
		description:
			"Run vacuum, checkpoint, reindex, fts5-rebuild, reconcile-dedup, prune, or integrity-check.",
	} as const satisfies EndpointDef<
		"POST",
		MaintenanceAction,
		MaintenanceActionResult
	>,

	// ─── Provider Cache (Sprint A.2) ─────────────────────────────────

	/** GET /api/provider-cache — Lifetime provider prompt cache aggregates + $ savings. */
	providerCache: {
		method: "GET",
		path: "/api/provider-cache",
		description:
			"Lifetime provider prompt cache hit-rate aggregates + dollar savings estimate.",
	} as const satisfies EndpointDef<"GET", undefined, ProviderCacheResponse>,


		// ─── A3 Cache Stripes (PLAN_V2 Phase 4) ───────────────────────────

		/** GET /api/cache-stripes — Per-stripe distribution + health score. */
		cacheStripes: {
			method: "GET",
			path: "/api/cache-stripes",
			description:
				"Per-stripe distribution counts, average stability scores, and composite cache health.",
		} as const satisfies EndpointDef<"GET", undefined, CacheStripesResponse>,
	// ─── Memory Effectiveness (S53B) ───────────────────────────────────────

	/** GET /api/memory-status — Memory store aggregate statistics. */
	memoryStatus: {
		method: "GET",
		path: "/api/memory-status",
		description:
			"Memory store statistics: total count, 30-day window, top-N stable memories, avg recall score.",
	} as const satisfies EndpointDef<"GET", undefined, MemoryStatusResponse>,

	/** GET /api/setup-status — Current embedder configuration. */
	setupStatus: {
		method: "GET",
		path: "/api/setup-status",
		description:
			"Current embedder configuration (which embedder is active, embedding URL, cache, MiniLM flag).",
	} as const satisfies EndpointDef<"GET", undefined, SetupStatusResponse>,

	/** GET /api/setup-detect — Detect available local embedder backends. */
	setupDetect: {
		method: "GET",
		path: "/api/setup-detect",
		description:
			"Best-effort detection of local embedder backends (ollama, llama.cpp, ONNX) available on the machine.",
	} as const satisfies EndpointDef<"GET", undefined, SetupDetectResponse>,

	/** POST /api/setup-configure — Write embedder config to .mega-compact.env. */
	setupConfigure: {
		method: "POST",
		path: "/api/setup-configure",
		description:
			"Write the chosen embedder configuration to .mega-compact.env (loaded at next startup). Returns whether a restart is required.",
	} as const satisfies EndpointDef<"POST", SetupConfigureRequest, SetupConfigureResponse>,

	// ─── RAPTOR tree (Part B) ───────────────────────────────────────

	/** GET /api/raptor-tree — Hierarchical RAPTOR summary tree for a session. */
	raptorTree: {
		method: "GET",
		path: "/api/raptor-tree",
		description:
			"Hierarchical RAPTOR tree (summary nodes by level) for a session; defaults to the latest session with nodes.",
	} as const satisfies EndpointDef<"GET", undefined, RaptorTreeResponse>,

	/** GET /api/raptor-build-history — Build history (coherence, depth, timeout) for a session. */
	raptorBuildHistory: {
		method: "GET",
		path: "/api/raptor-build-history",
		description:
			"RAPTOR build history rows (node/leaf count, depth, coherence score, timed_out) for a session; defaults to the latest session with builds.",
	} as const satisfies EndpointDef<"GET", undefined, RaptorBuildHistoryResponse>,

	/** GET /api/embedder-health — Round-trip a test embed through the active embedder. */
	embedderHealth: {
		method: "GET",
		path: "/api/embedder-health",
		description:
			"Probe the active embedder with a test embed and report status, latency, dimensions, and masked URL.",
	} as const satisfies EndpointDef<"GET", undefined, EmbedderHealthResponse>,

	// ─── RAG Settings (Sprint B6) ─────────────────────────────────────

	/** GET /api/rag-settings — Read the state of all RAG feature flags. */
	ragSettings: {
		method: "GET",
		path: "/api/rag-settings",
		description:
			"Read the current state of all RAG feature flags (enabled/disabled).",
	} as const satisfies EndpointDef<"GET", undefined, RagSettingsResponse>,

	/** POST /api/rag-settings — Update RAG feature flag states. */
	ragSettingsUpdate: {
		method: "POST",
		path: "/api/rag-settings",
		description:
			"Update RAG feature flag states by writing _DISABLED env vars to .mega-compact.env.",
	} as const satisfies EndpointDef<"POST", RagSettingsRequest, RagSettingsResponsePost>,

	// ─── RAG Metrics (Sprint H2) ──────────────────────────────────────

	/** GET /api/rag-metrics — HyDE + recall-quality telemetry aggregates. */
	ragMetrics: {
		method: "GET",
		path: "/api/rag-metrics",
		description:
			"HyDE invocation + recall-quality telemetry: flags, totals, recent turns, and daily series.",
	} as const satisfies EndpointDef<"GET", undefined, RagMetricsResponse>,
} as const;
