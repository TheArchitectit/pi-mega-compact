/**
 * api-contracts/rag-settings.ts — comprehensive settings API response types.
 *
 * Types for the /api/rag-settings endpoint used by the dashboard Setup panel to
 * read and update every adjustable MEGACOMPACT_* setting, grouped by category.
 *
 * PREVENT-PI-004: type definitions only, no network code.
 * PREVENT-011: no `any` type — all types are explicit.
 */

/** A single configurable setting's metadata + current value. */
export interface SettingState {
	readonly key: string;
	readonly label: string;
	readonly description: string;
	readonly category: string;
	readonly type: "boolean" | "number" | "string";
	readonly value: string | number | boolean;
	readonly default: string | number | boolean;
	readonly disabledConvention: boolean;
	readonly requiresLlm: boolean;
	readonly unit?: string;
	readonly min?: number;
	readonly max?: number;
}

/** Response for GET /api/rag-settings — all settings grouped by category. */
export interface SettingsResponse {
	readonly categories: ReadonlyArray<{ name: string; settings: SettingState[] }>;
	readonly llmActive: boolean;
}

/** Request body for POST /api/rag-settings — update a single setting. */
export interface SettingsUpdateRequest {
	readonly key: string;
	readonly value: string;
}

/** Response for POST /api/rag-settings. */
export interface SettingsResponsePost {
	readonly envPath: string;
	readonly restartRequired: boolean;
}

/** @deprecated Use SettingState instead */
export type RagFlagState = SettingState;
/** @deprecated Use SettingsResponse instead */
export type RagSettingsResponse = SettingsResponse;
/** @deprecated Use SettingsUpdateRequest instead */
export type RagSettingsRequest = SettingsUpdateRequest;
/** @deprecated Use SettingsResponsePost instead */
export type RagSettingsResponsePost = SettingsResponsePost;
