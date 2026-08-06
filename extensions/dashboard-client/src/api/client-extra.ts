/**
 * dashboard-client/src/api/client-extra.ts — newer dashboard API wrappers.
 *
 * Extracted from client.ts (delegate-shell split) so client.ts stays under the
 * 400-line extension soft limit. Holds the newest endpoint groups: per-model
 * compaction thresholds (S52) and the PC-C prefix-stability trend. client.ts
 * re-exports these so downstream imports are unchanged.
 */

import { ENDPOINTS } from "@contracts";
import type {
	ModelThresholdsResponse,
	ModelThresholdPutRequest,
	ModelThresholdPutResponse,
	PrefixStabilityResponse,
} from "@contracts";
import { getJson, putJson } from "./client-http.js";

/** GET /api/model-thresholds — list known models with their thresholds. */
export function fetchModelThresholds(): Promise<ModelThresholdsResponse> {
	return getJson<ModelThresholdsResponse>(ENDPOINTS.modelThresholds.path);
}

/** PUT /api/model-thresholds — upsert a per-model override. */
export function putModelThreshold(
	body: ModelThresholdPutRequest,
): Promise<ModelThresholdPutResponse> {
	return putJson<ModelThresholdPutResponse>(
		ENDPOINTS.modelThresholds.path,
		body,
	);
}

/** DELETE /api/model-thresholds/:modelId — delete an override (revert). */
export async function deleteModelThreshold(
	modelId: string,
): Promise<{ deleted: boolean }> {
	const res = await fetch(
		`${ENDPOINTS.modelThresholds.path}/${encodeURIComponent(modelId)}`,
		{ method: "DELETE" },
	);
	if (!res.ok) throw new Error(`deleteModelThreshold ${res.status}`);
	return res.json() as Promise<{ deleted: boolean }>;
}

/** Prompt-cache per-turn stable-prefix ratio trend (PC-C). */
export function fetchPrefixStability(
	limit = 50,
): Promise<PrefixStabilityResponse> {
	return getJson<PrefixStabilityResponse>(
		`${ENDPOINTS.prefixStability.path}?limit=${limit}`,
	);
}
