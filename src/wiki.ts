/**
 * wiki.ts — S51C extractive wiki page generation from topic models.
 *
 * Host-agnostic (no pi imports). Pure local math + string processing
 * (PREVENT-PI-004); read-only over the topic store + memory data. No
 * model/network calls.
 *
 * Extractive summary uses a local TF-IDF sentence ranker (advances the dedup
 * `src/dedup/raptor` patterns).
 */

import type { Topic, TopicAssignment, EmbeddedChunk } from "./topics/types.js";
import { tfidfScores } from "./topics/labels.js";

/** A wiki page for a single topic. */
export interface WikiPage {
	topic: Topic;
	/** Extractive summary: top-scoring sentences from topic members, in original order. */
	summary: string;
	/** Memories with importance for the key-memories panel. */
	keyMemories: Array<{
		content: string;
		timestamp: number;
		importance: number;
	}>;
	/** Recently added or used memories (ordered by timestamp DESC). */
	recentMemories: Array<{
		content: string;
		timestamp: number;
		importance: number;
	}>;
	/** Topics that share members with this one (co-occurrence), limited to top few. */
	relatedTopics: Topic[];
	/** Generated at epoch ms. */
	generatedAt: number;
}

/** Index shown on the wiki landing page. */
export interface WikiIndex {
	topics: Array<{
		id: string;
		label: string;
		memoryCount: number;
		lastUpdated: number;
	}>;
	totalTopics: number;
	totalMemories: number;
	lastRebuildAt: number | null;
}

/** Split text into sentences (very simple: period + newline + question mark + exclamation). */
function splitSentences(text: string): string[] {
	return text
		.split(/[.\n!?]/)
		.map((s) => s.trim())
		.filter((s) => s.length > 10);
}

/** Wrap a text string as a pseudo EmbeddedChunk for tfidfScores reuse. */
function pseudoChunk(text: string): EmbeddedChunk {
	return { chunkId: "", sessionId: "", vec: [], text };
}

interface MemoryContent {
	content: string;
	timestamp: number;
	importance: number;
}

/**
 * Generate an extractive summary for a topic. Takes the topic's member texts,
 * ranks sentences by TF-IDF, and returns the top-scoring ones joined.
 * Pure local math; no model/network calls.
 */
export function extractiveSummary(
	topic: Topic,
	assignments: TopicAssignment[],
	getContent: (memId: string) => string,
): string {
	// Join all member texts for the corpus.
	const members: string[] = [];
	for (const a of assignments) {
		if (a.topicId === topic.id) {
			const txt = getContent(a.memoryId);
			if (txt) members.push(txt);
		}
	}
	const corpusText = members.join(" ");
	if (corpusText.length === 0) return "";
	// Extractively summarize: rank sentences by TF-IDF, pick top 3.
	const sentences = splitSentences(corpusText);
	if (sentences.length === 0) return "";

	// Reuse tfidfScores from labels.ts: each sentence is a pseudo-chunk scored
	// against the full corpus. Sum the top-N term scores for each sentence.
	const corpusChunks = [pseudoChunk(corpusText)];
	const scored = sentences.map((s, i) => {
		const sentScores = tfidfScores([pseudoChunk(s)], corpusChunks);
		const totalScore = sentScores.reduce((sum, ts) => sum + ts.score, 0);
		return { text: s, score: totalScore, idx: i };
	});
	scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
	const top = Math.min(3, sentences.length);
	const chosen = scored.slice(0, top).sort((a, b) => a.idx - b.idx);
	return chosen.map((s) => s.text).join(". ");
}

/**
 * Find other topics (not `selfId`) that a memory also belongs to. Returns
 * distinct topic ids where the memory has assignments for both `selfId` and
 * that other topic.
 */
function coTopicsForMemory(
	memId: string,
	selfId: string,
	allAssignments: TopicAssignment[],
): string[] {
	const memAssignments = allAssignments.filter((a) => a.memoryId === memId);
	const topicSet = new Set(memAssignments.map((a) => a.topicId));
	// Memory must belong to selfId + at least one other for co-occurrence.
	if (!topicSet.has(selfId)) return [];
	topicSet.delete(selfId);
	return [...topicSet];
}

/**
 * Generate a full wiki page for a topic.
 *
 * @param topic The topic to render.
 * @param assignments All topic assignments to pull member memories.
 * @param getMemoryInfo Function returning content/timestamp/importance for a memoryId.
 * @param allTopics All topics (for co-occurrence computation).
 */
export function generateWikiPage(
	topic: Topic,
	assignments: TopicAssignment[],
	getMemoryInfo: (memId: string) => MemoryContent | null,
	allTopics: Topic[],
): WikiPage {
	const topicAssignments = assignments.filter((a) => a.topicId === topic.id);

	const keyMemories = topicAssignments
		.map((a) => getMemoryInfo(a.memoryId))
		.filter((m): m is MemoryContent => m !== null)
		.sort((a, b) => b.importance - a.importance)
		.slice(0, 10);

	const recentMemories = topicAssignments
		.map((a) => getMemoryInfo(a.memoryId))
		.filter((m): m is MemoryContent => m !== null)
		.sort((a, b) => b.timestamp - a.timestamp)
		.slice(0, 5);

	// Co-occurrence: scan ALL assignments (not just this topic's) and count how
	// many memories also belong to each other topic. Topics sharing member ids
	// with this one are "related". A memory that belongs to topicA + topicB is
	// evidence that A and B are related.
	const topicIdCount = new Map<string, number>();
	for (const a of assignments) {
		for (const other of coTopicsForMemory(a.memoryId, topic.id, assignments)) {
			topicIdCount.set(other, (topicIdCount.get(other) ?? 0) + 1);
		}
	}
	const relatedTopics: Topic[] = [];
	const ordered = [...topicIdCount.entries()].sort((a, b) => b[1] - a[1]);
	for (const [tid] of ordered.slice(0, 3)) {
		const t = allTopics.find((x) => x.id === tid);
		if (t) relatedTopics.push(t);
	}

	const getContent = (memId: string): string =>
		getMemoryInfo(memId)?.content ?? "";
	const summary = extractiveSummary(topic, assignments, getContent);

	return {
		topic,
		summary,
		keyMemories,
		recentMemories,
		relatedTopics,
		generatedAt: Date.now(),
	};
}

/** Build the wiki index for the landing page. */
export function buildWikiIndex(topics: Topic[]): WikiIndex {
	return {
		topics: topics.map((t) => ({
			id: t.id,
			label: t.label,
			memoryCount: t.memoryCount,
			lastUpdated: t.lastUpdated,
		})),
		totalTopics: topics.length,
		totalMemories: topics.reduce((s, t) => s + t.memoryCount, 0),
		lastRebuildAt: topics.length > 0 ? topics[0].lastUpdated : null,
	};
}
