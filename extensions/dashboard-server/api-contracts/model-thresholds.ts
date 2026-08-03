/**
 * api-contracts/model-thresholds.ts — per-model compaction threshold API types.
 *
 * Types for the /api/model-thresholds endpoints used by the Setup panel
 * "Thresholds" sub-tab to tune the safety margin + fire point per model.
 *
 * PREVENT-PI-004: type definitions only, no network code.
 * PREVENT-011: no `any` type — all types are explicit.
 */
/** A per-model threshold (mirrors src/store/sqlite/model-thresholds.ts
 * ModelThreshold — duplicated here so api-contracts has no cross-package
 * import into src/, per the ast-grep:no-relative-cross-package-import rule). */
export interface ModelThresholdDTO {
	readonly modelId: string;
	readonly safetyMarginPct: number;
	readonly firePointPct: number;
	readonly updatedAt: number | null;
}

/** A model known to this repo (most-recent model_snapshots row, deduped). */
export interface KnownModel {
	readonly modelId: string;
	readonly provider: string;
	readonly modelName: string | null;
	readonly contextWindow: number;
	readonly maxTokens: number;
	/** True when an override row exists in model_thresholds. */
	readonly hasOverride: boolean;
}

/**
 * Response for GET /api/model-thresholds — every known model with its
 * threshold (override if present, otherwise defaults) for the UI table.
 */
export interface ModelThresholdsResponse {
	readonly defaults: {
		readonly safetyMarginPct: number;
		readonly firePointPct: number;
		readonly safetyMarginRange: readonly [number, number];
		readonly firePointRange: readonly [number, number];
	};
	readonly models: ReadonlyArray<
		KnownModel & {
			readonly threshold: {
				readonly safetyMarginPct: number;
				readonly firePointPct: number;
				readonly isOverride: boolean;
			};
		}
	>;
}

/** Request body for PUT /api/model-thresholds. */
export interface ModelThresholdPutRequest {
	readonly modelId: string;
	readonly safetyMarginPct: number;
	readonly firePointPct: number;
}

/** Response for PUT /api/model-thresholds. */
export interface ModelThresholdPutResponse {
	readonly threshold: ModelThresholdDTO;
}

/** Response for DELETE /api/model-thresholds/:modelId. */
export interface ModelThresholdDeleteResponse {
	readonly deleted: boolean;
}

export type ModelThresholdsError =
	| { readonly error: "method_not_allowed" }
	| { readonly error: "invalid_json" }
	| { readonly error: "body_too_large" }
	| { readonly error: "missing_model_id" }
	| { readonly error: "invalid_pct"; readonly detail: string }
	| { readonly error: "internal" };
