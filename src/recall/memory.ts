/**
 * recall/memory.ts — S21 memory recall: durables (decisions, rules,
 * user-saved facts) live in the `memories` table. We mirror the checkpoint
 * recall path: rank by cosine, format a block, respect a token cap so it can
 * never net-inflate the system prompt.
 */
import { estimateBlockTokens } from "../tokens.js";
import { formatMemoryRecallBlock } from "./format.js";
import type { MemoryRecallInjectOptions } from "./types.js";

/** Recall top-k durable memories, format into a token-capped block. */
export async function recallMemoriesAndInline(
	opts: MemoryRecallInjectOptions,
): Promise<{ empty: boolean; block: string; report: string[] }> {
	const limit = opts.limit ?? 5;
	const maxTokens = opts.recallMaxTokens ?? 0;
	const { recallMemories, recallMemoriesCrossRepo } = await import(
		"../memoryRecall.js"
	);
	const hits = await recallMemories(opts.query, opts.stateDir, {
		topK: limit,
		minSimilarity: opts.minSimilarity ?? 0.2,
	});

	// S24 cross-repo augmentation: if same-repo recall is thin, pull additional
	// memories from OTHER repos via the PGlite HNSW index. Non-fatal: a failure
	// degrades to the same-repo hits only.
	const crossHits: Array<{ memory: any; score: number; repoId: string }> = [];
	if (opts.crossRepo && hits.length < limit) {
		try {
			const x = await recallMemoriesCrossRepo(opts.query, opts.stateDir, {
				repo: null,
				limit: limit - hits.length,
				crossRepoCosine: opts.crossRepoCosine ?? 0.3,
			});
			for (const h of x) crossHits.push(h);
		} catch {
			/* non-fatal — cross-repo failure → same-repo only */
		}
	}
	if (hits.length === 0 && crossHits.length === 0)
		return { empty: true, block: "", report: [] };

	// Same incremental token cap pattern as checkpoint recall.
	const parts: string[] = [];
	const report: string[] = [];
	let blockTokens = 0;
	const pushHit = (
		content: string,
		category: string | null,
		score: number,
		label: string,
		blockSuffix?: string,
	) => {
		const part = formatMemoryRecallBlock([{ content, category, score, label: blockSuffix }]);
		const partTokens = estimateBlockTokens(part);
		if (maxTokens > 0 && blockTokens + partTokens > maxTokens) return false;
		parts.push(part);
		report.push(
			`  • ${label} (${(score * 100).toFixed(0)}%): ${content.slice(0, 60).replace(/\n/g, " ")}…`,
		);
		blockTokens += partTokens;
		return true;
	};
	for (const h of hits) {
		if (
			!pushHit(
				h.memory.content,
				h.memory.category,
				h.score,
				`memory#${h.memory.id}`,
			)
		)
			break;
	}
	for (const h of crossHits) {
		const repoLabel = h.repoId.split(/[\\/]/).filter(Boolean).pop() ?? h.repoId;
		if (
			!pushHit(
				h.memory.content,
				h.memory.category,
				h.score,
				`memory#${h.memory.id} (from ${repoLabel})`,
				`from ${repoLabel}`,
			)
		)
			break;
	}
	return { empty: parts.length === 0, block: parts.join("\n"), report };
}
