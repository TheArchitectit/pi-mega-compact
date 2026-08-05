/**
 * dashboard-server/routes-rag-settings-types.ts — SETTINGS inventory contract.
 *
 * The shared shapes the settings inventory is built from. Extracted so the
 * inventory can be split across sibling files (helpers.ts + the per-area groups)
 * without either side importing the other's data — contract-first, per
 * docs/ENGINEERING_PRACTICES.md.
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

/** One named category of settings as rendered by the Setup panel. */
export interface SettingGroup {
	name: string;
	settings: SettingSpec[];
}
