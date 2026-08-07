/**
 * api-contracts/endpoints/registry-ext.ts — additive endpoint registry groups.
 *
 * Split out of registry.ts (delegate-shell) so the registry stays under the
 * 500-line extension hard limit. Holds the newest endpoint groups (per-model
 * thresholds, vector-cortex) that are appended to the ENDPOINTS registry via
 * object spread. Types are identical to sibling entries (`EndpointDef`).
 *
 * Sprint A1 — PREVENT-PI-004: zero network code (type definitions only).
 * PREVENT-011: no `any` type.
 */
import type { EndpointDef } from "../core.js";
import type { RagMetricsResponse } from "../rag-metrics.js";
import type { ModelThresholdsResponse } from "../model-thresholds.js";
import type {
  VectorCortexEvaluationSummary,
  VectorCortexLedgerView,
} from "../vector-cortex.js";
import type {
  SetupCortexStatusResponse,
  SetupCortexActionRequest,
  SetupCortexActionResult,
  SetupCortexActionBlocked,
  SetupCortexActionLogQuery,
  SetupCortexActionLogResponse,
} from "../setup-cortex.js";
import type { PrefixStabilityResponse } from "../prefix-stability.js";
import type {
  CortexImproveStartRequest,
  CortexImproveStart,
  CortexImproveStatus,
} from "../cortex-improve.js";
import type { DedupTierAttributionResponse } from "../dedup-attribution.js";
import type { CosineFpReportV1 } from "../cosine-fp.js";
import type { RepoCorpusStatusV1 } from "../repo-corpus.js";

/** Additive endpoint entries spread into the ENDPOINTS registry. */
export const EXTRA_ENDPOINTS = {
	// ─── Per-model compaction thresholds (S52 / v0.16.1) ───────────────

	/** GET /api/model-thresholds — List known models + their thresholds. */
	modelThresholds: {
		method: "GET",
		path: "/api/model-thresholds",
		description:
			"Every known model (from model_snapshots) with its per-model threshold override (or defaults).",
	} as const satisfies EndpointDef<"GET", undefined, ModelThresholdsResponse>,

	// ─── RAG Metrics (Sprint H2) ──────────────────────────────────────

	/** GET /api/rag-metrics — HyDE + recall-quality telemetry aggregates. */
	ragMetrics: {
		method: "GET",
		path: "/api/rag-metrics",
		description:
			"HyDE invocation + recall-quality telemetry: flags, totals, recent turns, and daily series.",
	} as const satisfies EndpointDef<"GET", undefined, RagMetricsResponse>,

	// ─── Vector Cortex (VC0A) ────────────────────────────────────────

	/** GET /api/vector-cortex/evaluation — reader-only eval aggregate (VC0A). */
	vectorCortexEvaluation: {
		method: "GET",
		path: "/api/vector-cortex/evaluation",
		description:
			"Reader-only vector-cortex evaluation summary: latency histogram + per-mode sample counts (never payloads).",
	} as const satisfies EndpointDef<
		"GET",
		undefined,
		VectorCortexEvaluationSummary
	>,

	/** GET /api/vector-cortex/ledger — reader-only occurrence ledger view (VC1B). */
	vectorCortexLedger: {
		method: "GET",
		path: "/api/vector-cortex/ledger",
		description:
			"Reader-only occurrence-ledger identity view: seq/eventId/kind/digest + high-water (never source payloads).",
	} as const satisfies EndpointDef<
		"GET",
		undefined,
		VectorCortexLedgerView
	>,

	// ─── VC9A Setup Cortex (dashboard Setup tab cortex status) ─────────

	/** GET /api/setup-cortex-status — reader-only vector-cortex encoder gate. */
	setupCortexStatus: {
		method: "GET",
		path: "/api/setup-cortex-status",
		description:
			"Reader-only vector-cortex encoder gate: mode A/B/C, qualification verdict, blockers, encoder health — for the dashboard Setup tab. Never closes the ML gate.",
	} as const satisfies EndpointDef<"GET", undefined, SetupCortexStatusResponse>,

	// ─── VC9B Setup Cortex actions (dashboard Setup tab action drivers) ─────

	/** POST /api/setup-cortex-action — confirmation-gated fetch/bench/verify. */
	setupCortexAction: {
		method: "POST",
		path: "/api/setup-cortex-action",
		description:
			"Confirmation-gated driver: fetch-model / bench / verify-asset. Executes only the committed local scripts (scripts/vc2-model-prep/*) or re-reads the committed encoder assets; an OPEN hard-gate item returns action_blocked_by_open_item and does NOT spawn. Never payload bytes; confirm:true required.",
	} as const satisfies EndpointDef<
		"POST",
		SetupCortexActionRequest,
		SetupCortexActionResult | SetupCortexActionBlocked
	>,

	/** GET /api/setup-cortex-action-log — bounded, redacted action log tail. */
	setupCortexActionLog: {
		method: "GET",
		path: "/api/setup-cortex-action-log",
		description:
			"Bounded (8 KiB) redacted tail of a VC9B action log under <stateDir>/logs/vc9b/; the name must be a validated basename (path traversal rejected).",
	} as const satisfies EndpointDef<
		"GET",
		SetupCortexActionLogQuery,
		SetupCortexActionLogResponse
	>,

	// ─── PC-C Prompt-cache prefix stability (dashboard Cache tab) ───────

	/** GET /api/prefix-stability — per-turn stable-prefix ratio trend (PC-C). */
	prefixStability: {
		method: "GET",
		path: "/api/prefix-stability",
		description:
			"Per-turn prompt-cache stable-prefix ratio trend (GET /api/prefix-stability?limit=N) read from prefix_stability rows in the local events log. Flag-off (MEGACOMPACT_PC_C=0) returns 404.",
	} as const satisfies EndpointDef<
		"GET",
		undefined,
		PrefixStabilityResponse
	>,

	// ─── ML5-D Improve Cortex (dashboard Vector Cortex tab) ───────────

	/** POST /api/cortex/improve — launch a local ML5-A training job. */
	improveCortex: {
		method: "POST",
		path: "/api/cortex/improve",
		description:
			"Launch a local ML5-A training job that re-qualifies the five heads against the latest local corpus and returns an opaque jobId. Requires confirm:true; flag-off returns 404. Local-only — never fetches anything.",
	} as const satisfies EndpointDef<
		"POST",
		CortexImproveStartRequest,
		CortexImproveStart
	>,

	/** GET /api/cortex/improve/status/:jobId — poll an improve job. */
	improveCortexStatus: {
		method: "GET",
		path: "/api/cortex/improve/status/:jobId",
		description:
			"Poll an in-process Cortex improve job to terminal qualified / demoted_to_B. Unknown jobId or flag-off returns 404. Read-only, in-memory job state.",
	} as const satisfies EndpointDef<
		"GET",
		undefined,
		CortexImproveStatus
	>,

	// ─── DEDUP-ATTR tier-attribution rollup ───────────────────────────

	/** GET /api/dedup-tier-attribution — reader-only per-tier dedup shares. */
	dedupTierAttribution: {
		method: "GET",
		path: "/api/dedup-tier-attribution",
		description:
			"Reader-only dedup tier-attribution rollup (DEDUP-ATTR): L0/L1/L2/new percent of dedup decisions in a query window (default 24h, ?windowMs=, capped 30d). Counts + shares only, never matched checkpoint contents or raw query text. Flag-off returns 404.",
	} as const satisfies EndpointDef<
		"GET",
		undefined,
		DedupTierAttributionResponse
	>,

	// ─── COS-FP-A cosine threshold report ────────────────────────────

	/** GET /api/cosine-fp-report — reader-only synthetic FP bench recommendation. */
	cosineFpReport: {
		method: "GET",
		path: "/api/cosine-fp-report",
		description:
			"Reader-only cosine-FP report (COS-FP-A): the last written synthetic bench aggregate — grid summary, per-content-type FP/FN/F1, recommended default, report digest. Counts + fractions + digests only, never template text. Missing report → awaiting_data; flag-off returns 404.",
	} as const satisfies EndpointDef<"GET", undefined, CosineFpReportV1>,

	// ─── REPO-A cross-repo corpus ──────────────────────────────────────

	/** GET /api/repo-corpus — reader-only pseudonymous corpus status. */
	repoCorpus: {
		method: "GET",
		path: "/api/repo-corpus",
		description:
			"Reader-only cross-repo corpus status (REPO-A): which pseudonymous repos/sessions are in the consented corpus, cross-repo overlap descriptors, and per-repo active-consent state. Counts + IDs + status only — never payload content. Flag-off returns 404; absent corpus returns awaiting_data.",
	} as const satisfies EndpointDef<"GET", undefined, RepoCorpusStatusV1>,
} as const;
