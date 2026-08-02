/**
 * api-contracts/rag-settings.ts — RAG feature flag API response types.
 *
 * Types for the /api/rag-settings endpoint used by the dashboard RAG Settings
 * panel to read and toggle the five RAG feature flags (B1–B5).
 *
 * PREVENT-PI-004: type definitions only, no network code.
 * PREVENT-011: no `any` type — all types are explicit.
 */

/**单个 RAG feature flag state for the dashboard. */
export interface RagFlagState {
	/** Env var key without the _DISABLED suffix, e.g. "MEGACOMPACT_HYDE". */
	readonly key: string;
	/** Short human-readable label, e.g. "HyDE (Hypothetical Document Embeddings)". */
	readonly label: string;
	/** One-line description of what the flag does. */
	readonly description: string;
	/** Whether the flag is currently enabled (true = ON, false = disabled via _DISABLED). */
	readonly enabled: boolean;
	/** Whether this flag requires an LLM embedder (HttpEmbedder) to function. */
	readonly requiresLlm: boolean;
}

/** Response for GET /api/rag-settings. */
export interface RagSettingsResponse {
	readonly flags: RagFlagState[];
	/** Whether an HttpEmbedder (LLM) is currently active — gates HyDE toggle. */
	readonly llmActive: boolean;
}

/** Request body for POST /api/rag-settings. */
export interface RagSettingsRequest {
	/** Map of flag key (e.g. "MEGACOMPACT_HYDE") to desired enabled state. */
	readonly flags: Record<string, boolean>;
}

/** Response for POST /api/rag-settings. */
export interface RagSettingsResponsePost {
	readonly envPath: string;
	readonly restartRequired: boolean;
}
