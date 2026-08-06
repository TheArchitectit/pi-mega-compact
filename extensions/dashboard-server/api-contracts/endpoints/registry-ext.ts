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
import type { SetupCortexStatusResponse } from "../setup-cortex.js";

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
} as const;
