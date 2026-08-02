/**
 * recall/format.ts — recall-block formatting + the S25 RAPTOR overview header
 * and the S57 B3 recall-quality metrics logger.
 *
 * Pure helpers: given hit/cluster/memory data they produce the model-visible
 * text block (or log metrics). No store mutation here.
 */
import type { SearchHit, VectorStore } from "../vectorStore.js";
import { rehydrateRaptorTree, isShadowMode } from "../dedup/raptor/index.js";
import { maxCheckpointTimestamp } from "../store/sqlite.js";
import { normalizeSessionId } from "../store.js";
import { cosineSimilarity } from "../embedder.js";
import { computeRecallMetrics } from "../recallMetrics.js";
import { Logger } from "../log.js";

/** Wrap a recall block so the model reads it as restored compacted context. */
export function formatRecallBlock(hits: SearchHit[]): string {
	if (hits.length === 0) return "";
	const parts = hits.map((h, i) => {
		const score = (h.score * 100).toFixed(0);
		// S17: label a cross-repo hit with its source repo (the repoId doubles as
		// that repo's stateDir, so the last path segment is the repo's display
		// name). Same-repo hits (no repoId) stay unlabeled.
		const repoName = h.repoId
			? ` (from repo ${h.repoId.split("/").filter(Boolean).pop() ?? h.repoId})`
			: "";
		// S42B: a RAPTOR cluster node hit (not a stored checkpoint) is labeled as a
		// hierarchical summary and uses raptorSummary as its body. No Key files line
		// (cluster nodes carry no file list).
		if (h.raptorLevel !== undefined) {
			return (
				`### Recalled cluster summary [${i + 1}] (level ${h.raptorLevel}, relevance ${score}%)${repoName}\n` +
				`${(h.raptorSummary ?? h.checkpoint.summary).trim()}\n`
			);
		}
		return (
			`### Recalled context [${i + 1}] (relevance ${score}%)${repoName}\n` +
			`${h.checkpoint.summary.trim()}\n` +
			(h.checkpoint.filesModified.length
				? `Key files: ${h.checkpoint.filesModified.join(", ")}.\n`
				: "")
		);
	});
	return (
		"The following compacted context was recalled from earlier in this session " +
		"and is relevant to the current request. Treat it as background you already know:\n\n" +
		parts.join("\n")
	);
}

/**
 * S25 Phase-2: format the RAPTOR tree's top-level summary nodes (root + level-1
 * clusters) as a hierarchical overview HEADER. Surfacing the high-level topical
 * structure before the detailed checkpoint hits gives the model a map of what
 * the session has covered. `nodes` are the RAPTOR summary nodes to surface,
 * highest level first (root → level-1 clusters). Returns "" when empty.
 */
export function formatRaptorBlock(
	nodes: { summary: string; level: number; score?: number }[],
): string {
	if (nodes.length === 0) return "";
	const parts = nodes.map((n, i) => {
		const score =
			n.score !== undefined
				? ` (relevance ${(n.score * 100).toFixed(0)}%)`
				: "";
		const label =
			n.level === 0
				? `Session overview [${i + 1}]${score}`
				: `Cluster summary [${i + 1}] (level ${n.level})${score}`;
		return `### ${label}\n${n.summary.trim()}\n`;
	});
	return (
		"The following hierarchical overview summarizes the structure of this " +
		"session so far. Use it as a map of what has been covered:\n\n" +
		parts.join("\n")
	);
}

/** Format one memory hit for the recall block. Category + score for traceability. */
export function formatMemoryRecallBlock(
	hits: Array<{ content: string; category: string | null; score: number; label?: string }>,
): string {
	if (hits.length === 0) return "";
	const parts = hits.map((h, i) => {
		const pct = (h.score * 100).toFixed(0);
		const cat = h.category ? `[${h.category}] ` : "";
		const src = h.label ? ` ${h.label}` : "";
		return `### Recalled memory [${i + 1}] (relevance ${pct}%${src})\n${cat}${h.content.trim()}`;
	});
	return (
		"The following facts about this project were saved from earlier turns " +
		"and are relevant to the current request. Treat them as established:\n\n" +
		parts.join("\n")
	);
}

/**
 * S25 Phase-2: build the hierarchical overview header for a session. Rehydrates
 * the persisted RAPTOR tree, picks the root + top level-1 cluster nodes by
 * cosine similarity to the query, and formats them via formatRaptorBlock.
 * Returns "" when no tree, stale tree, timedOut tree, or shadow mode. Non-fatal
 * (wrapped in try/catch) — the overview is a bonus; a failure must never block
 * the detailed recall block.
 */
export function raptorOverviewBlock(
	store: VectorStore,
	sessionId: string,
	query: string,
): string {
	try {
		const sid = normalizeSessionId(sessionId);
		// S25 gate: the overview header is part of the RAPTOR serve surface, so it
		// must honor the same contract as raptorSearchHits — shadow mode is
		// logging-only building, not injection.
		if (isShadowMode()) return "";
		const tree = rehydrateRaptorTree(sid, store.stateDir);
		if (!tree || !tree.rootId || tree.timedOut) return "";
		// Freshness: a tree built before the session's latest checkpoint is stale.
		const maxTs = maxCheckpointTimestamp(sid, store.stateDir);
		if (tree.builtAt && tree.builtAt < maxTs) return "";
		const root = tree.nodes.get(tree.rootId);
		if (!root) return "";
		const qv = store.embedder.embed(query);
		// Root (level 0) first, then the top level-1 clusters by cosine to the query.
		const nodes: { summary: string; level: number; score: number }[] = [
			{
				summary: root.summary,
				level: root.level,
				score: cosineSimilarity(qv, root.embedding),
			},
		];
		const level1 = [...tree.nodes.values()]
			.filter((n) => n.level === 1 && n.summary)
			.map((n) => ({
				summary: n.summary,
				level: n.level,
				score: cosineSimilarity(qv, n.embedding),
			}))
			.sort((a, b) => b.score - a.score)
			.slice(0, 3);
		nodes.push(...level1);
		return formatRaptorBlock(nodes);
	} catch {
		return ""; // non-fatal: overview is a bonus
	}
}

/**
 * B3: Compute recall-quality metrics on the injected hits and log them.
 * Only called when RAG_RECALL_METRICS() is ON. Non-fatal.
 */
export function scoreAndLogRecallMetrics(query: string, toInject: SearchHit[]): void {
	try {
		const logger = new Logger();
		const metrics = computeRecallMetrics(query, toInject);
		logger.info("recall_metrics", {
			hitCount: toInject.length,
			score: metrics.score,
			pass: metrics.pass,
		});
		if (!metrics.pass && toInject.length > 0) {
			logger.info("recall_metrics_low_quality", {
				score: metrics.score,
				relevance: metrics.breakdown.relevance,
				coverage: metrics.breakdown.coverage,
				diversity: metrics.breakdown.diversity,
			});
		}
	} catch {
		/* non-fatal: metrics never break recall */
	}
}
