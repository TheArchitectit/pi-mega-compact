/**
 * recall/async.ts — Slice 2 async cross-repo recall.
 *
 * Same dedup/bound/inline contract as `recallAndInline`, but backed by
 * `VectorStore.searchAsync` so it can recall across repos (HNSW NN over the
 * global PGlite index) when `opts.crossRepo` is set. The synchronous
 * `recallAndInline` is unchanged and remains the default per-session path.
 * Inline-window dedupe + token cap (Fix C) apply here too.
 */
import {
	vectorSearchAsync,
	vectorWasInjected,
	vectorMarkInjected,
	type SearchHit,
	type VectorStore,
} from "../vectorStore.js";
import { estimateBlockTokens } from "../tokens.js";
import { defaultEmbedder, cosineSimilarity } from "../embedder.js";
import { formatRecallBlock } from "./format.js";
import type { RecallInjectOptions, RecallInjectResult } from "./types.js";

/**
 * `store` must provide `searchAsync` (the live VectorStore does). Errors fall
 * back to an empty result — recall is a bonus, never a hard dependency.
 */
export async function recallAndInlineAsync(
	opts: RecallInjectOptions & { crossRepo?: boolean; repoId?: string },
	store: VectorStore,
): Promise<RecallInjectResult> {
	const limit = opts.limit ?? 3;
	const skip = opts.skipInjected ?? true;
	const maxTokens = opts.recallMaxTokens ?? 0;
	const doWindowDedupe = opts.windowDedupe ?? false;
	const dedupSim = opts.dedupSim ?? 0.9;

	let hits: SearchHit[] = [];
	try {
		hits = await vectorSearchAsync(store, opts.sessionId, opts.query, limit, {
			crossRepo: opts.crossRepo,
			repoId: opts.repoId,
		});
	} catch {
		hits = [];
	}

	// F1: hoist one embedder instance for inline dedupe. defaultEmbedder() is
	// deterministic but creating it per call wastes allocations on large hit sets.
	// (recallAndInline already hoisted this; applying the same fix here.)
	const embedder = defaultEmbedder();
	let liveEmbeddings: number[][] = [];
	if (doWindowDedupe && opts.liveWindow && opts.liveWindow.length > 0) {
		liveEmbeddings = opts.liveWindow.map((m) => embedder.embed(m));
	}

	const toInject: SearchHit[] = [];
	let blockTokens = 0;

	// F2: when cross-repo is on but no global index dir could be resolved, skip
	// foreign hits rather than injecting them undeduped — otherwise a foreign
	// checkpoint with no machine-wide injected-set to consult would re-inject in
	// every new session. Same-repo hits (no repoId) are unaffected. Warn once so
	// the silent degradation is observable. (The extension resolver normally
	// supplies a default globalIndexDir, so this is belt-and-braces.)
	const skipCrossRepoHits = !!opts.crossRepo && !opts.globalIndexDir;
	if (skipCrossRepoHits) {
		try {
			console.warn(
				"[mega-compact:recall] cross-repo recall enabled but globalIndexDir is unset — " +
					"skipping cross-repo injection to avoid re-injecting undeduped foreign checkpoints",
			);
		} catch {
			/* ignore */
		}
	}

	for (const h of hits) {
		// F2: skip foreign hits when we can't dedup them machine-wide.
		if (skipCrossRepoHits && h.repoId) continue;
		if (
			skip &&
			vectorWasInjected(store, opts.sessionId, h.checkpoint.checkpointId)
		)
			continue;
		// S18: machine-wide injected-set — a foreign checkpoint already injected
		// (in any session) is never re-injected. Only applies to cross-repo hits
		// (same-repo hits have no repoId and are handled by the per-session set).
		if (opts.globalIndexDir && h.repoId) {
			try {
				const { wasInjectedGlobal } = await import("./../store/sqlite.js");
				if (
					wasInjectedGlobal(
						h.checkpoint.checkpointId,
						opts.sessionId,
						opts.globalIndexDir,
					)
				)
					continue;
			} catch {
				/* non-fatal: degrade to per-session injected-set only */
			}
		}
		// Inline dedupe: skip a hit already resident in the live window (F1: hoisted embedder).
		if (doWindowDedupe && liveEmbeddings.length > 0) {
			const hitVec = embedder.embed(h.checkpoint.summary);
			if (liveEmbeddings.some((v) => cosineSimilarity(v, hitVec) >= dedupSim))
				continue;
		}
		// F3: build the hit list first; format ONCE at the end so the block carries
		// exactly one preamble and numbering [1..n] rather than one per hit.
		const partTokens = estimateBlockTokens(h.checkpoint.summary);
		if (maxTokens > 0 && blockTokens + partTokens > maxTokens) break;
		toInject.push(h);
		blockTokens += partTokens;
		vectorMarkInjected(store, opts.sessionId, h.checkpoint.checkpointId);
		// S18: record the cross-repo injection machine-wide so it's not re-injected
		// by a later recall (same or different session).
		if (opts.globalIndexDir && h.repoId) {
			try {
				const { markInjectedGlobal } = await import("./../store/sqlite.js");
				markInjectedGlobal(
					h.checkpoint.checkpointId,
					h.repoId,
					opts.sessionId,
					opts.globalIndexDir,
				);
			} catch {
				/* non-fatal */
			}
		}
	}

	// F3: format once — one preamble, correct [1..n] numbering, token cap counted
	// against one preamble (not N). Pass the full toInject array so formatRecallBlock
	// has repoId + score for proper labeling.
	const block = toInject.length > 0 ? formatRecallBlock(toInject) : "";
	const report = toInject.map(
		(h) =>
			`  • ${h.checkpoint.checkpointId} (${h.checkpoint.summary.slice(0, 60).replace(/\n/g, " ")}…)`,
	);

	return { toInject, report, block, empty: toInject.length === 0 };
}
