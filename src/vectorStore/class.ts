/**
 * class.ts — VectorStore implementation (extracted from vectorStore.ts).
 *
 * One store, three consumers (per PLAN.md): auto-inline on resume, on-demand
 * /recall-context, and the dedup sentinel. All share `add / search / dedupe`.
 *
 * Backed by the gzipped on-disk checkpoint files (store.ts). Similarity is a
 * linear cosine scan — checkpoint counts are small, so no ANN index is needed.
 */
import type { Embedder } from "../embedder.js";
import { defaultEmbedder } from "../embedder.js";
import {
	loadDedupConfig,
	type DedupConfigShape,
	type DedupTier,
} from "../config/dedup.js";
import { logDecision } from "../monitoring.js";
import { repoKey } from "../store/repoKey.js";
import { getStateDir } from "../store.js";
import type { RaptorTree } from "../dedup/raptor/tree.js";
import { openBloom } from "../store/bloom.js";
import { migrateJsonToSqlite } from "../store/migrate.js";
import { addCheckpoint } from "./add.js";
import type { AddInput, AddResult } from "./types.js";

export class VectorStore {
	// These fields are `readonly` (set once in the constructor) but NOT private:
	// the add/read/search/dedup helpers split into add.ts, vector-read.ts,
	// vector-search.ts, and vector-dedup.ts access them directly. Marking them
	// private would force ugly `as unknown as` casts in those modules; keeping
	// them package-public makes VectorStore a thin barrel whose helpers live in
	// sibling files.
	readonly embedder: Embedder;
	readonly stateDir: string;
	/** L2 semantic firing point (cfg.L2_COSINE, or a direct test override). */
	readonly l2Threshold: number;
	/** Single source of truth for tier flags + thresholds (Sprint 14). */
	readonly cfg: DedupConfigShape;
	/** Optional monitoring target (Sprint 14). Undefined → no monitoring. */
	readonly eventsPath?: string;
	/**
	 * Repo key for the async PGlite vector index (Slice 2). We use the stateDir
	 * itself as the repo id — it is already unique per repo and available here
	 * without crossing into the pi-runtime layer (src/ stays pi-agnostic). The
	 * global index keys on repoId so recall can span repos.
	 */
	readonly repoId: string;
	/** S25: per-session cached rehydrated RaptorTree. Keyed by sessionId.
	 *  Freshness-validated via maxRaptorNodeBuiltAt on each lookup — a cheap
	 *  indexed MAX query replaces the O(n·leaves) rehydrate on every search. */
	readonly raptorCache = new Map<
		string,
		{ tree: RaptorTree; builtAt: number }
	>();

	constructor(
		opts: {
			embedder?: Embedder;
			dedupSim?: number;
			stateDir?: string;
			l2Enabled?: boolean;
			l2Threshold?: number;
			/** Override the dedup config (defaults to env/file snapshot). */
			config?: DedupConfigShape;
			/** Optional events.log path for decision monitoring (Sprint 14). */
			eventsPath?: string;
			/** Repo id for the async cross-repo vector index. Defaults to stateDir. */
			repoId?: string;
		} = {},
	) {
		this.embedder = opts.embedder ?? defaultEmbedder();
		this.stateDir = opts.stateDir ?? getStateDir();
		// S25: single repo-scope key shared with the memory index (git-root
		// scoped; falls back to stateDir outside git).
		this.repoId = opts.repoId ?? repoKey(this.stateDir);
		// Sprint 14: all tier flags/thresholds flow from the single config source
		// (DedupConfig). The legacy opts.dedupSim / opts.l2Enabled remain accepted
		// for backward-compat callers but flags are authoritative via `cfg`.
		void opts.dedupSim;
		void opts.l2Enabled;
		// Sprint 12 L2 semantic tier. Threshold 0.85 is the default trigram
		// embedder's honest firing point; a direct override is allowed for tests.
		this.cfg = opts.config ?? loadDedupConfig();
		this.l2Threshold = opts.l2Threshold ?? this.cfg.L2_COSINE;
		this.eventsPath = opts.eventsPath;
		// Sprint 8: bring any v0.1.0 JSON checkpoint files into SQLite (idempotent).
		migrateJsonToSqlite(this.stateDir);
		// Sprint 10: warm the bloom accelerator (accelerator only — SQLite stays
		// source of truth; a bloom hit is always confirmed by a query below).
		openBloom(this.stateDir);
	}

	/** Emit a structured dedup-decision event (best-effort, never throws). */
	record(
		tier: DedupTier,
		result: "deduped" | "new" | "mark_only",
		reason: string | undefined,
		latencyMs: number,
		similarityScore?: number,
		matchedId?: string,
	): void {
		if (!this.eventsPath) return;
		logDecision(this.eventsPath, {
			ts: Date.now(),
			tier,
			result,
			reason,
			latencyMs: Math.round(latencyMs * 100) / 100,
			similarityScore,
			matchedId,
		});
	}

	/**
	 * Add a checkpoint, deduping it against the session's existing checkpoints.
	 *
	 * The cascade itself lives in ./add.ts (sibling-helper pattern) so this class
	 * stays a thin shell over the fields its helpers read.
	 */
	add(input: AddInput): AddResult {
		return addCheckpoint(this, input);
	}
}
