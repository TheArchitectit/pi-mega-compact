/**
 * dashboard-server/routes-rag-settings-helpers.ts — SETTINGS inventory.
 *
 * The full catalog of user-adjustable MEGACOMPACT_* settings surfaced by the
 * dashboard Setup panel, grouped by category. Kept separate from the route
 * handler so the inventory can grow without bloating the handler file.
 *
 * PREVENT-011: no `any` type.
 */


/**
 * Base metadata for a single setting entry before its live `value` is resolved.
 * `category` and `value` are filled in at read time by the handler.
 */
export interface SettingSpec {
	key: string;
	label: string;
	description: string;
	type: "boolean" | "number" | "string";
	default: string | number | boolean;
	/** True when this is a `_DISABLED`-convention opt-out flag. */
	disabledConvention: boolean;
	requiresLlm: boolean;
	unit?: string;
	min?: number;
	max?: number;
}

// Shorthand builders to keep the inventory terse and unambiguous.
const boolFlag = (
	key: string,
	label: string,
	description: string,
	def: boolean,
	requiresLlm = false,
): SettingSpec => ({
	key,
	label,
	description,
	type: "boolean",
	default: def,
	disabledConvention: true,
	requiresLlm,
});

const boolDirect = (
	key: string,
	label: string,
	description: string,
	def: boolean,
): SettingSpec => ({
	key,
	label,
	description,
	type: "boolean",
	default: def,
	disabledConvention: false,
	requiresLlm: false,
});

const num = (
	key: string,
	label: string,
	description: string,
	def: number,
	min: number,
	max: number,
	unit?: string,
): SettingSpec => ({
	key,
	label,
	description,
	type: "number",
	default: def,
	disabledConvention: false,
	requiresLlm: false,
	min,
	max,
	...(unit ? { unit } : {}),
});

const str = (
	key: string,
	label: string,
	description: string,
	def: string,
): SettingSpec => ({
	key,
	label,
	description,
	type: "string",
	default: def,
	disabledConvention: false,
	requiresLlm: false,
});

/** Every adjustable setting, grouped by category. Read-only after module load. */
export const SETTINGS: ReadonlyArray<{
	name: string;
	settings: SettingSpec[];
}> = [
	{
		name: "RAG Pipeline",
		settings: [
			boolFlag(
				"MEGACOMPACT_QUERY_REFORMULATION",
				"Query Reformulation",
				"TF-IDF keyword expansion for vague recall queries",
				true,
			),
			boolFlag(
				"MEGACOMPACT_TIERED_ROUTER",
				"Tiered Recall Router",
				"L0 cache → L1 FTS5 → L2 HNSW routing",
				true,
			),
			boolFlag(
				"MEGACOMPACT_RECALL_METRICS",
				"Recall Quality Metrics",
				"Precision/recall scoring and logging",
				true,
			),
			boolFlag(
				"MEGACOMPACT_MEMORY_GRAPH",
				"Memory Graph",
				"Dashboard-oriented memory graph traversal",
				true,
			),
			boolFlag(
				"MEGACOMPACT_HYDE",
				"HyDE",
				"Generate hypothetical answer via LLM, embed it, RRF-fuse",
				true,
				true,
			),
			boolFlag(
				"MEGACOMPACT_NEW_UI",
				"New Dashboard UI",
				"Tailwind + shadcn visual design (sidebar, glass panels)",
				true,
			),
		],
	},
	{
		name: "Wiki / Turns",
		settings: [
			boolFlag(
				"MEGACOMPACT_WIKI_ENHANCED",
				"Wiki Enhanced",
				"User curation (rename/merge/split) + topic evolution",
				true,
			),
			boolFlag(
				"MEGACOMPACT_WIKI_INCREMENTAL",
				"Wiki Incremental",
				"Assign new memories to nearest centroid",
				true,
			),
			boolDirect(
				"MEGACOMPACT_AUTO_WIKI",
				"Auto Wiki",
				"Auto-categorizing wiki (k-means + TF-IDF)",
				true,
			),
			boolDirect(
				"MEGACOMPACT_WIKI_SEED_FROM_TURNS",
				"Wiki Seed from Turns",
				"Seed topic model from raw_transcript when chunks thin",
				true,
			),
			boolDirect(
				"MEGACOMPACT_TURNS_DB",
				"Turns DB",
				"Isolated turns.db store",
				true,
			),
			num(
				"MEGACOMPACT_WIKI_SILHOUETTE_MIN",
				"Silhouette Minimum",
				"Full rebuild trigger threshold",
				0.2,
				0,
				1,
			),
			num(
				"MEGACOMPACT_TURNS_RETENTION_DAYS",
				"Turn Retention",
				"Per-turn provenance retention window",
				30,
				1,
				365,
				"days",
			),
			num(
				"MEGACOMPACT_TURNS_KEEP_MIN",
				"Turns Keep Minimum",
				"Min turns kept per conversation during prune",
				5,
				1,
				100,
			),
			num(
				"MEGACOMPACT_WIKI_LABEL_TOP_TERMS",
				"Wiki Label Terms",
				"How many TF-IDF terms form a topic label",
				5,
				1,
				20,
			),
			num(
				"MEGACOMPACT_WIKI_REBUILD_EVERY",
				"Wiki Rebuild Every",
				"Rebuild topic model every Nth compaction",
				3,
				1,
				50,
			),
		],
	},
	{
		name: "Dedup Tiers",
		settings: [
			boolDirect("MEGACOMPACT_L0_ENABLED", "L0 Exact Match", "Exact-hash dedup tier", true),
			boolDirect("MEGACOMPACT_L1_ENABLED", "L1 MinHash/LSH", "Near-dup tier", true),
			boolDirect("MEGACOMPACT_L2_ENABLED", "L2 Semantic", "Cosine similarity dedup tier", true),
			boolDirect("MEGACOMPACT_RAPTOR_ENABLED", "RAPTOR", "Hierarchical clustering tier", true),
			boolDirect("MEGACOMPACT_RAPTOR_MULTILEVEL", "RAPTOR Multi-level", "Multi-level retrieval (score all tree levels)", true),
			boolDirect("MEGACOMPACT_RAPTOR_LEAF_EXPANSION", "RAPTOR Leaf Expansion", "Leaf node expansion in retrieval", true),
			boolDirect("MEGACOMPACT_RAPTOR_INCREMENTAL", "RAPTOR Incremental", "Incremental rebuild mode", true),
			boolDirect("MEGACOMPACT_RAPTOR_INJECT_SUMMARIES", "RAPTOR Inject Summaries", "Inject top-level summary nodes into recall", true),
			boolDirect("MEGACOMPACT_MARK_ONLY_L0", "Mark Only L0", "L0 runs but does not collapse", false),
			boolDirect("MEGACOMPACT_MARK_ONLY_L1", "Mark Only L1", "L1 runs but does not collapse", false),
			boolDirect("MEGACOMPACT_MARK_ONLY_L2", "Mark Only L2", "L2 runs but does not collapse", false),
			boolDirect("MEGACOMPACT_MINILM", "MiniLM Embedder", "Use MiniLM instead of trigram", false),
		],
	},
	{
		name: "Dedup Thresholds",
		settings: [
			num("MEGACOMPACT_L2_THRESHOLD", "L2 Cosine Threshold", "L2 semantic dedup firing point", 0.85, 0, 1),
			num("MEGACOMPACT_L1_JACCARD", "L1 Jaccard Threshold", "L1 MinHash near-dup threshold", 0.8, 0, 1),
			num("MEGACOMPACT_DEDUP_SIM", "Dedup Similarity", "Legacy content-similarity fallback", 0.9, 0, 1),
			num("MEGACOMPACT_MMR_LAMBDA", "MMR Lambda", "Maximal Marginal Relevance diversity", 0.5, 0, 1),
			num("MEGACOMPACT_SEMDEDUP_COSINE", "SemDeDup Cosine", "Offline SemDeDup pair threshold", 0.95, 0, 1),
			num("MEGACOMPACT_CONSOLIDATE_COSINE", "Consolidate Cosine", "Memory consolidation merge threshold", 0.7, 0, 1),
			num("MEGACOMPACT_SIMILARITY_BUDGET_MS", "Similarity Budget", "Time budget for similarity computation", 50, 1, 10000, "ms"),
			num("MEGACOMPACT_L1_VERIFY_BUDGET_MS", "L1 Verify Budget", "L1 verification time budget", 20, 1, 10000, "ms"),
			num("MEGACOMPACT_L1_CANDIDATE_CAP", "L1 Candidate Cap", "L1 candidate cap", 100, 1, 10000),
		],
	},
	{
		name: "RAPTOR Tuning",
		settings: [
			num("MEGACOMPACT_RAPTOR_BUDGET_MS", "RAPTOR Budget", "RAPTOR time budget", 5000, 100, 60000, "ms"),
			num("MEGACOMPACT_RAPTOR_CLUSTERS", "RAPTOR Clusters", "Clusters per level", 5, 1, 50),
			num("MEGACOMPACT_RAPTOR_CONSISTENCY", "RAPTOR Consistency", "Consistency threshold", 0.6, 0, 1),
			num("MEGACOMPACT_RAPTOR_MAX_LEAF_EXP", "RAPTOR Max Leaf Expansion", "Max leaf expansion nodes", 10, 1, 100),
			num("MEGACOMPACT_RAPTOR_FRESHNESS_HOURS", "RAPTOR Freshness", "Skip rebuild when tree is fresh", 4, 1, 168, "hours"),
			num("MEGACOMPACT_FP_RATE_L0", "FP Rate L0", "FP alert threshold for exact tier", 0.01, 0, 1),
			num("MEGACOMPACT_FP_RATE_L1L2", "FP Rate L1/L2", "FP alert threshold for fuzzy tiers", 0.05, 0, 1),
			num("MEGACOMPACT_ALERT_WINDOW_MS", "Alert Window", "Alert evaluation window", 600000, 1000, 3600000, "ms"),
			num("MEGACOMPACT_P95_BUDGET_MS", "P95 Budget", "Canary p95 budget per tier", 100, 1, 10000, "ms"),
		],
	},
	{
		name: "Models",
		settings: [
			str("MEGACOMPACT_HYDE_MODEL", "HyDE Model", "LLM model name for HyDE generation", "llama3.2"),
			str("MEGACOMPACT_RAPTOR_MODEL", "RAPTOR Summary Model", "Ollama model for cluster summarization (empty = extractive)", ""),
			str("MEGACOMPACT_RAPTOR_URL", "RAPTOR Ollama URL", "Ollama endpoint for RAPTOR summarization", "http://127.0.0.1:11434"),
			num("MEGACOMPACT_EMBED_CACHE", "Embed Cache Size", "Embedding cache entries (0 = disabled)", 256, 0, 10000),
			num("MEGACOMPACT_EMBEDDING_BATCH_TOKENS", "Embedding Batch Tokens", "Oversized-prompt chunking limit (tokens) for the BYO localhost embedder; text above this is chunked + mean-pooled", 2048, 64, 8192),
			num("MEGACOMPACT_EMBEDDING_CHARS_PER_TOKEN", "Embedding Chars per Token", "Estimated characters per token used for embedder chunking size", 4, 1, 32),
		],
	},
	{
		name: "Vector Cortex",
		settings: [
			boolDirect(
				"MEGACOMPACT_VC0A",
				"VC0A Baseline Observability",
				"Structured evaluation observer (MetricEventV1 + latency histogram). OFF = mode C, byte-identical to predecessor.",
				true,
			),
			boolDirect(
				"MEGACOMPACT_VC0B",
				"VC0B Replay Correctness",
				"ReplayCutV2 effective-cut (min of boundary-safe/commit/capture high-water + pair retreat + anchor floor) and M3 effective-cut-v2 migration. OFF = legacy capped replay, byte-identical.",
				true,
			),
			boolDirect(
				"MEGACOMPACT_VC1A",
				"VC1A Canonical Byte Events",
				"EventV2 byte-authority ledger codec (original bytes + SHA-256, strict UTF-8, derived NFC) and canonical validator (EVT_DIGEST_MISMATCH / EVT_UTF8_TAG_INVALID / EVT_DUPLICATE_ID). OFF = mode C, transcript codec unchanged, byte-identical.",
				true,
			),
			boolDirect(
				"MEGACOMPACT_VC1B",
				"VC1B Occurrence Ledger + Tool Identity",
				"Neutral occurrence ledger (LedgerReader/Writer/Admin + CompatJournalV1): per-session monotonic seq, tool result references one earlier call, uniqueness by (eventId,digest) only, and the M2 copy-validate-switch downgrade journal. OFF = mode C, ledger unwritten, byte-identical.",
				true,
			),
			boolDirect(
				"MEGACOMPACT_VC0C",
				"VC0C Live Safety Envelope",
				"TriadResult/Breaker live circuit breaker (60s window, 20 attempts, 30s cooldown, 3 probes, 5min healthy residence) + durable spool before provider invocation; manual reset clears cooldown but never evidence. OFF = mode C, unchanged transcript, byte-identical.",
				true,
			),
			boolDirect(
				"MEGACOMPACT_VC1C",
				"VC1C Cross-Language Conformance v2",
				"FixtureManifestV2 canonical manifest validator + DowngradeReport deterministic downgrade export + MinHashV2 exact big-integer signatures and the M4 copy/validate/switch minhash-v2 migration (seed table frozen, cross-language byte-exact). OFF = mode C, v1 sync dedup scan unchanged, byte-identical.",
				true,
			),
			boolDirect(
				"MEGACOMPACT_VC2A",
				"VC2A Offline Model Runtime",
				"ModelManifestV1 digest-before-load ONNX runtime (opset17/batch1/max512) + asset-free trigram demotion. Asset path assets/vector-cortex/encoder-v1 is immutable/digest-pinned. OFF = mode C, byte-identical to predecessor.",
				true,
			),
			boolDirect(
				"MEGACOMPACT_VC2B",
				"VC2B Multi-Head Encoder",
				"VectorSetV1 five L2-normalized heads (384/128/128/64/32) with head-calibration draft + asset-free trigram B (512d) and lexical C fallbacks, plus the per-head emit seam. OFF = mode C, no per-head vectors emitted, byte-identical predecessor.",
				true,
			),
			boolDirect(
				"MEGACOMPACT_VC2C",
				"VC2C Encoder Qualification + Calibration",
				"QualifiedEncoderV1/CalibrationV1: calibration fit on the calibration split only (held-out labels prohibited) + atomic selection across MODEL_ASSET and per-head EVALUATION thresholds (any field failure demotes all of A). OFF = mode C, no qualification/calibration selection, byte-identical predecessor.",
				true,
			),
		],
	},
	{
		name: "Cost API",
		settings: [
			boolDirect(
				"MEGACOMPACT_COST_API_ENABLED",
				"Cost API Lookup",
				"Fetch model pricing from an external API (PREVENT-PI-004 network exception — opt-in). Enriches the dashboard Cache/Repos tabs with real $/token rates for models not in the local pricing table.",
				false,
			),
			str(
				"MEGACOMPACT_COST_API_URL",
				"Cost API URL",
				"OpenRouter-compatible model pricing endpoint (e.g. https://openrouter.ai/api/v1/models). Only contacted when Cost API Lookup is ON.",
				"",
			),
		],
	},
];

/** Flat index of every setting by key for O(1) lookup + validation. */
export const SETTING_BY_KEY: ReadonlyMap<string, SettingSpec> = new Map(
	SETTINGS.flatMap((c) => c.settings).map((s) => [s.key, s]),
);

/**
 * Adjustable MEGACOMPACT_* env vars intentionally NOT surfaced in the settings
 * UI. Handled by other panels, install-time paths, dev-only, internal tuning,
 * or special string formats the generic form cannot represent.
 * Kept as string literals so regression_check.py's coverage scan sees them.
 */
export const EXCLUDED_SETTINGS: readonly string[] = [
	// Embedder telemetry — handled by EmbedderSetup.
	"MEGACOMPACT_EMBEDDING_URL",
	"MEGACOMPACT_EMBEDDING_KEY",
	"MEGACOMPACT_EMBEDDING_HEADERS",
	"MEGACOMPACT_EMBEDDING_DIM",
	"MEGACOMPACT_OLLAMA_MODEL",
	"MEGACOMPACT_ALLOW_REMOTE_EMBEDDER",
	// Install-time paths.
	"MEGACOMPACT_STATE_DIR",
	"MEGACOMPACT_INDEX_DIR",
	"MEGACOMPACT_VECTOR_INDEX_DIR",
	"MEGACOMPACT_TURNS_DB_PATH",
	// Dev-only.
	"MEGACOMPACT_EXT_SCAN_DIR",
	"MEGACOMPACT_EXT_USER_DIR",
	// PGlite internal tuning.
	"MEGACOMPACT_PGLITE_DISABLED",
	"MEGACOMPACT_PGLITE_OPEN_TIMEOUT_MS",
	"MEGACOMPACT_PGLITE_CLOSE_TIMEOUT_MS",
	"MEGACOMPACT_PGLITE_QUERY_TIMEOUT_MS",
	// Special string formats the generic form cannot represent.
	"MEGACOMPACT_WIKI_K_RANGE",
	"MEGACOMPACT_RAPTOR_LEVEL_WEIGHTS",
	// Internal calibration, not user-facing.
	"MEGACOMPACT_FTS5_MAX_BM25",
];
