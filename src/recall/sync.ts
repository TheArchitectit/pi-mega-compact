/**
 * recall/sync.ts — the unified synchronous recall+dedupe+prepare-inject path.
 *
 * ONE vector store, THREE entry points, ONE dedup engine. Every way context
 * gets re-injected into the window (auto-inline on resume, on-demand
 * /recall-context, and the dedup sentinel) goes through `recallAndInline`.
 * It always does: search -> dedupe -> inject. The only thing that differs per
 * entry point is *what triggers it* and *what query it uses*.
 *
 * Injection respects PREVENT-PI-003: pi has no `system` message role, so we
 * prepend our recall block to the system prompt via the `before_agent_start`
 * hook's `systemPrompt` result (the extension wires that). This module is
 * pi-agnostic: it returns an injectable text block and records injections; the
 * extension decides where it lands.
 */
import { recall as searchRecall } from "../engine.js";
import { vectorMarkInjected, type VectorStore } from "../vectorStore.js";
import { estimateBlockTokens } from "../tokens.js";
import { defaultEmbedder, cosineSimilarity } from "../embedder.js";
import { RAG_QUERY_REFORMULATION, RAG_TIERED_ROUTER, RAG_RECALL_METRICS, RAG_HYDE_ENABLED } from "../config.js";
import { generateHypotheticalDoc, fuseRecallHits } from "../hyde.js";
import type {
	RecallInjectOptions,
	RecallInjectResult,
	HydeInvocationInfo,
	RecallMetricsSnapshot,
} from "./types.js";
import type { SearchHit } from "../vectorStore.js";
import { reformulateRecallQuery, runTieredRecall } from "./reformulate.js";
import { formatRecallBlock, scoreAndLogRecallMetrics, raptorOverviewBlock } from "./format.js";
import { buildHydeInfo, hydeSkipped } from "./hydeTelemetry.js";

/**
 * Recall and inline context from the checkpoint store.
 *
 * S27 contract — DB-Mirror demotion:
 *
 * When `MEGACOMPACT_DB_MIRROR` is ON, the `raw_transcript` table is the
 * canonical, byte-stable source of truth for message reconstruction. The
 * `dedup_mirror` provides space-efficient storage with ref_count tracking
 * (see src/mirror/dedup.ts). The legacy JSON checkpoint is retained as a
 * DR snapshot only (see src/store.ts checkpoint helpers).
 *
 * The recall function continues to work from the VectorStore (checkpoint
 * summaries + embeddings) for fast semantic search — this path is unaffected
 * by the mirror flag. If full transcript reconstruction is ever needed
 * (replay, export, debug), prefer reading from `raw_transcript + dedup_mirror`
 * via `listRawTranscriptRange()` + `dedupTranscript()` instead of the legacy
 * JSON checkpoint. Falls back to legacy checkpoint if mirror is empty
 * (pre-migration sessions).
 *
 * Pi-agnostic: no pi runtime imports (src/ invariant).
 */
export function recallAndInline(
	opts: RecallInjectOptions,
	store: VectorStore,
): RecallInjectResult {
	// ── S27 Recall Demotion ─────────────────────────────────────────────
	//
	// When MEGACOMPACT_DB_MIRROR is ON, the raw_transcript + dedup_mirror
	// tables are preferred for byte-stable reconstruction. The current
	// recall path (VectorStore search → format → inject) is unaffected —
	// it provides fast semantic search over checkpoint summaries.
	//
	// If full transcript reconstruction is ever needed (replay, export,
	// debug), call reconstructFromMirror(db, sessionId, fromSeq, toSeq)
	// from src/mirror/dedup.ts instead of reading from the legacy JSON
	// checkpoint. Falls back to legacy checkpoint if mirror is empty
	// (pre-migration sessions).
	//
	// Invariant: raw_transcript + dedup_mirror are additive and never
	// lose data. The legacy JSON checkpoint remains as a DR snapshot.
	// ─────────────────────────────────────────────────────────────────────

	const limit = opts.limit ?? 3;
	const skip = opts.skipInjected ?? true;
	const maxTokens = opts.recallMaxTokens ?? 0; // 0 = unbounded (legacy behavior)
	const doWindowDedupe = opts.windowDedupe ?? false;
	const dedupSim = opts.dedupSim ?? 0.9;

	// F4: thread skipInjected through to searchRecall instead of hardcoding false
	// and re-implementing the filter here. newHits is already deduped when skip
	// is true (default); equals hits when skip is false (openclaw command path).
	//
	// S57 B1: optionally expand a vague query via TF-IDF neighbor terms.
	// S57 B2: optionally route via the TieredRouter's sync L0 cache peek.
	// Both flags default OFF — recallQuery === opts.query and the single
	// searchRecall call reproduce the pre-S57 byte-identical path.
	const recallQuery = RAG_QUERY_REFORMULATION()
		? reformulateRecallQuery(opts.query, store, opts.sessionId)
		: opts.query;

	// F1: hoist one embedder instance (shared by HyDE below + inline dedupe later).
	// defaultEmbedder() is deterministic but creating it per call wastes allocations.
	const embedder = defaultEmbedder();

	// S43 re-plan: HyDE — auto-ON when an HttpEmbedder is active (LLM configured
	// for indexing); opt out via MEGACOMPACT_HYDE_DISABLED=true. Generates a
	// hypothetical answer doc, embeds it, runs a second searchRecall, and
	// RRF-fuses with the raw-query results. Non-fatal: any error → raw-only.
	// TrigramEmbedder (kind !== "http") skips this — S57 B1 reformulation above
	// already handles the no-LLM path.
	// H1 telemetry tracking for the HyDE block below.
	let hydeHits: SearchHit[] | null = null;
	let hydeDoc = "";
	let hydeGenMs = 0;
	let hydeRawCount = 0;
	if (RAG_HYDE_ENABLED() && embedder.kind === "http") {
		const t0 = Date.now();
		const hyde = generateHypotheticalDoc(opts.query, embedder);
		hydeGenMs = Date.now() - t0;
		if (hyde) {
			hydeDoc = hyde;
			try {
				const r2 = searchRecall(
					{ sessionId: opts.sessionId, query: hyde, limit, skipInjected: skip },
					store,
				);
				hydeHits = r2.newHits;
			} catch {
				hydeHits = null;
			}
		}
	}

	let newHits: SearchHit[];
	if (RAG_TIERED_ROUTER()) {
		newHits = runTieredRecall(recallQuery, opts.sessionId, limit, skip, store).newHits;
	} else {
		const result = searchRecall(
			{ sessionId: opts.sessionId, query: recallQuery, limit, skipInjected: skip },
			store,
		);
		newHits = result.newHits;
	}
	// H1: the raw-query hit count is taken BEFORE fusion.
	hydeRawCount = newHits.length;

	// S43 re-plan: fuse the hypothetical-doc hits with the raw-query hits via RRF
	// when HyDE produced results. The downstream inline dedupe + metrics + format
	// operate on this fused set.
	if (hydeHits && hydeHits.length > 0) {
		newHits = fuseRecallHits(newHits, hydeHits, limit);
	}
	// Precompute live-window embeddings once for inline dedupe (Fix C). Trigram
	// embedder is local + cheap; never a network call (PREVENT-PI-004).
	let liveEmbeddings: number[][] = [];
	if (doWindowDedupe && opts.liveWindow && opts.liveWindow.length > 0) {
		liveEmbeddings = opts.liveWindow.map((m) => embedder.embed(m));
	}

	// F3: build the hit list first; format ONCE at the end so the block carries
	// exactly one preamble and [1..n] numbering, and the token cap counts body
	// tokens (one preamble at format time, not N). We accumulate summaries and
	// break mid-stream when the cap would be exceeded.
	const toInject: SearchHit[] = [];
	let blockTokens = 0;

	for (const h of newHits) {
		// Inline dedupe: skip a hit already resident in the live window (Fix C).
		if (doWindowDedupe && liveEmbeddings.length > 0) {
			const hitVec = embedder.embed(h.checkpoint.summary);
			if (liveEmbeddings.some((v) => cosineSimilarity(v, hitVec) >= dedupSim))
				continue;
		}

		const partTokens = estimateBlockTokens(h.checkpoint.summary);
		// Token cap: never push a chunk that would overrun the ceiling.
		if (maxTokens > 0 && blockTokens + partTokens > maxTokens) break;

		toInject.push(h);
		blockTokens += partTokens;
		vectorMarkInjected(store, opts.sessionId, h.checkpoint.checkpointId);
	}

	// S57 B3: optionally score + log recall quality metrics (flag-OFF: skipped,
	// byte-identical). Scores the injected hits against the ORIGINAL query so the
	// metric measures whether the (possibly expanded) search results stay
	// relevant to what the user actually asked.
	let recallMetrics: RecallMetricsSnapshot | null = null;
	if (RAG_RECALL_METRICS()) {
		recallMetrics = scoreAndLogRecallMetrics(opts.query, toInject);
	}

	// F3: format once — one preamble, correct [1..n] numbering.
	const recallBlock = toInject.length > 0 ? formatRecallBlock(toInject) : "";
	const report = toInject.map(
		(h) =>
			`  • ${h.checkpoint.checkpointId} (${h.checkpoint.summary.slice(0, 60).replace(/\n/g, " ")}…)`,
	);

	// S25 Phase-2 (RAPTOR_INJECT_SUMMARIES): prepend a hierarchical overview
	// header built from the tree's top-level summary nodes (root + the
	// highest-scoring level-1 cluster summaries). This gives the model a topical
	// map of the session before the detailed checkpoint hits. Default ON via
	// the store's config; `opts.raptorSummaries` (when explicitly set) overrides.
	// Skipped when no tree exists, the tree is stale/timedOut, or shadow mode is on.
	let overview = "";
	const injectSummaries =
		opts.raptorSummaries ?? store.cfg.RAPTOR_INJECT_SUMMARIES;
	if (injectSummaries && recallBlock) {
		overview = raptorOverviewBlock(store, opts.sessionId, opts.query);
	}
	const block =
		overview && recallBlock
			? overview + "\n" + recallBlock
			: overview || recallBlock;

	// H1: build the HyDE invocation telemetry for this pass.
	const fusedCount = toInject.length;
	let hydeInfo: HydeInvocationInfo;
	if (RAG_HYDE_ENABLED() && embedder.kind === "http") {
		hydeInfo =
			hydeHits && hydeHits.length > 0
				? buildHydeInfo("ran", hydeDoc, hydeGenMs, hydeRawCount, hydeHits.length, fusedCount)
				: hydeSkipped(hydeDoc ? "generation-failed" : "no-llm", hydeRawCount, fusedCount);
	} else {
		hydeInfo = hydeSkipped("disabled", hydeRawCount, fusedCount);
	}

	return {
		toInject,
		report,
		block,
		empty: block.length === 0,
		hydeInfo,
		recallMetrics,
	};
}
