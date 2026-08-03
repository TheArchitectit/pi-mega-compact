/**
 * api-contracts/wiki.ts — W2 wiki revival contract types.
 *
 * Shapes for the 7 wiki endpoints plus the SSE events the mutations emit.
 * `CurationResult` is the canonical type from src/wiki/curation.ts (single
 * source of truth), re-exported here for route + client parity. Type-only —
 * no network (PREVENT-PI-004), no `any` (PREVENT-011).
 */
import type { CurationResult } from "../../../src/wiki/curation.js";

/** One topic row in the wiki index (with resolved custom label). */
export interface WikiIndexEntry {
	id: string;
	label: string;
	memoryCount: number;
	lastUpdated: number;
	/** True when the label is a user override, not the auto-generated one. */
	edited: boolean;
	/** Cumulative override kinds for badge provenance. */
	overrideKinds: Array<"label" | "merge" | "split">;
}

/** GET /api/wiki/index — wiki landing page payload. */
export interface WikiIndexResponse {
	topics: WikiIndexEntry[];
	totalTopics: number;
	totalMemories: number;
	lastRebuildAt: number | null;
}

/** Provenance for one memory within a wiki topic. */
export interface MemoryProvenance {
	memoryId: string;
	sessionId: string;
	assignedAt: number;
	method: string;
}

/** GET /api/wiki/topic/:topicId — single topic page. */
export interface WikiPageResponse {
	topic: WikiIndexEntry;
	summary: string;
	keyMemories: Array<{
		memoryId: string;
		content: string;
		timestamp: number;
		importance: number;
	}>;
	provenance: MemoryProvenance[];
	relatedTopicIds: string[];
	generatedAt: number;
}

/** PUT /api/wiki/topic/:topicId/label — rename request body. */
export interface RenameTopicRequest {
	label: string;
}

/** POST /api/wiki/merge — merge source into target. */
export interface MergeTopicsRequest {
	sourceTopicId: string;
	targetTopicId: string;
}

/** POST /api/wiki/topic/:topicId/split — split request body. */
export interface SplitTopicRequest {
	memoryIds: string[];
}

/** One flat node row in the D3 evolution graph. */
export interface TopicEvolutionNode {
	id: string;
	label: string;
	memoryCount: number;
}

/** One edge between evolved topics. */
export interface TopicEvolutionEdge {
	source: string;
	target: string;
	kind: "merge" | "split";
	at: number;
}

/** GET /api/wiki/evolution — nodes + edges + time buckets for D3. */
export interface TopicEvolutionResponse {
	nodes: TopicEvolutionNode[];
	edges: TopicEvolutionEdge[];
	buckets: Array<{ bucket: number; count: number }>;
}

/** GET /api/wiki/topic/:topicId/timeline — per-topic time buckets. */
export interface TopicTimelineResponse {
	topicId: string;
	buckets: Array<{ bucket: number; count: number }>;
	total: number;
}

/** SSE: wiki model rebuilt. */
export interface SseWikiRebuilt {
	type: "wiki_rebuilt";
	ts: string;
	topicCount: number;
}

/** SSE: a topic was renamed. */
export interface SseWikiTopicRenamed {
	type: "wiki_topic_renamed";
	ts: string;
	topicId: string;
	label: string;
	edited: boolean;
}

/** SSE: two topics were merged. */
export interface SseWikiTopicsMerged {
	type: "wiki_topics_merged";
	ts: string;
	sourceTopicId: string;
	targetTopicId: string;
}

/** SSE: a topic was split. */
export interface SseWikiTopicSplit {
	type: "wiki_topic_split";
	ts: string;
	fromTopicId: string;
	toTopicId: string;
}

/** Union of all wiki SSE events. */
export type WikiSseEvent =
	| SseWikiRebuilt
	| SseWikiTopicRenamed
	| SseWikiTopicsMerged
	| SseWikiTopicSplit;

export type { CurationResult };
