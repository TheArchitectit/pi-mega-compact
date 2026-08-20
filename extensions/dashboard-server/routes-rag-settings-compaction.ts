/**
 * dashboard-server/routes-rag-settings-compaction.ts — Compaction SETTINGS.
 *
 * The compaction-group flag inventory, split out of routes-rag-settings-helpers.ts
 * (delegate-shell split per the extensions/ 400-line soft limit) when the
 * v0.21.9 output-headroom flags landed. regression_check.py globs every
 * routes-rag-settings*.ts sibling, so no scanner update is needed on split.
 *
 * PREVENT-011: no `any` type.
 */

import type { SettingSpec, SettingGroup } from "./routes-rag-settings-types.js";

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

/** The compaction flags, as one SETTINGS category. */
export const COMPACTION_SETTINGS: SettingGroup = {
	name: "Compaction",
	settings: [
		num(
			"MEGACOMPACT_THRESHOLD_PCT",
			"Compaction Threshold",
			"Fraction of the actual model context window at which compaction fires — 0.80 fires at 80% used (leaves 20% free). Applies to any model size; a per-model Model Thresholds row overrides it",
			0.8,
			0.1,
			0.95,
		),
		num(
			"MEGACOMPACT_THRASH_REARM_PCT",
			"Thrash Re-arm %",
			"After an ineffective compaction (live window did not shrink), refuse to re-fire until the live window grows by this fraction of the effective threshold. Default 0.10 (10%)",
			0.1,
			0.01,
			0.5,
		),
		boolDirect(
			"MEGACOMPACT_OUTPUT_ERROR_COMPACT",
			"Output-Error Compact",
			"When a model response is truncated mid-output (stopReason: 'length'), trip a one-shot forced compaction to free input headroom. Closes the small-context deadlock where the model truncates below the input threshold.",
			true,
		),
		boolDirect(
			"MEGACOMPACT_OVERFLOW_HEADROOM",
			"Overflow Headroom Gate",
			"Fire compaction BEFORE the request overflows the model window — when input tokens + the output reserve + safety margin would exceed the context window — instead of waiting for the percent fire point (which judges only INPUT and never trips on small-window models whose output budget is a large fraction of the window). Percent-based: the reserve scales with the model's own window, so the math holds at every window size (32k…5M). OFF disables this pre-fire check (the gate reverts to input-only judgment); the pair-safe tail-cap hardenings are unconditional safety fixes and remain active.",
			true,
		),
		num(
			"MEGACOMPACT_OUTPUT_RESERVE_PCT",
			"Output Reserve %",
			"FALLBACK output reserve as a fraction of the context window, used only when the model's declared maxTokens is absent or implausible (0, or a models.json sentinel like 1e9/1e38, or >= the window). When maxTokens IS plausible the declared value wins — vLLM-style backends reserve the FULL declared maxTokens. Default 0.30 (30%), clamped 0.10–0.95.",
			0.3,
			0.1,
			0.95,
		),
		boolDirect(
			"MEGACOMPACT_WIRE_OVERHEAD",
			"Invisible-Overhead Calibration",
			"Add the provider's fixed request overhead H (system prompt + tool definitions + extension systemPrompt prepends — everything pi adds at request time that NEVER appears in the stored transcript) back into the token estimate for the headroom gate + tail cap. H is a per-model EMA of observed wire samples, else the Wire-Overhead Default fraction of the window. Closes the 32k overflow loop (attempt #9). OFF = byte-identical v0.21.11.",
			true,
		),
		num(
			"MEGACOMPACT_WIRE_OVERHEAD_DEFAULT_PCT",
			"Wire-Overhead Default %",
			"Fraction of the context window used as the overhead H when no wire sample has been observed yet for the model. Once a sample lands, the per-model EMA wins. Clamped 0–0.85, default 0.15 (15%). Percent-based: identical math at every window size.",
			0.15,
			0,
			0.85,
		),
	],
};
