/**
 * importance.ts — S40 importance scoring for compaction.
 *
 * A standalone, deterministic, pi-agnostic scoring module with no side
 * effects. Scores each context item by type, age decay, recency/retention
 * boosts, and selects the top-N for verbatim preservation (bypassing
 * summarization) so high-importance old messages (decisions, errors) are
 * not lost to compaction.
 *
 * PREVENT-PI-001 (anchor floor): importance scoring AUGMENTS, never
 * replaces, the boundary guard. `itemsToPreserve` only marks items the
 * caller already considered compactable; the caller's `computeDropRange`
 * still protects the most recent N user messages.
 * PREVENT-PI-002 (tool pairs): callers preserve pairs; `score()` itself
 * is pair-agnostic.
 * PREVENT-PI-PI-003 (no system role): scored items are surfaced via the
 * existing systemPrompt-prepend path, never as role:"system".
 *
 * @module
 */
import type { EngineMessage } from "./types.js";

/** The 8 content/item types that drive the type multiplier. */
export enum ContextItemType {
	UserMessage = "user_message",
	AssistantMessage = "assistant_message",
	SystemMessage = "system_message",
	CodeBlock = "code_block",
	Error = "error",
	Decision = "decision",
	FileModification = "file_modification",
	ToolExecution = "tool_execution",
}

/** A scored context item. */
export interface ScoredItem {
	/** Message index or checkpoint ID (caller-supplied). */
	id: string;
	type: ContextItemType;
	content: string;
	/** Raw role from EngineMessage ("user" | "assistant" | "tool" | "custom"). */
	role: string;
	/** Epoch ms. */
	timestamp: number;
	/** Type-based multiplier, before decay/boost. */
	rawMultiplier: number;
	/** 0–0.7 fraction SUBTRACTED from the score. */
	ageDecay: number;
	/** 1.0 or 1.2. */
	recencyBoost: number;
	/** 1.0 or 3.0. */
	retentionBoost: number;
	/** Composite score. */
	finalScore: number;
}

/** Result of a preservation pass. */
export interface PreservationResult {
	preservedIds: Set<string>;
	/** Score cutoff used. */
	threshold: number;
	totalScored: number;
	totalPreserved: number;
}

/**
 * Default type multipliers (ported from the Rust reference
 * `router/src/context/importance.rs`). Decisions (2.5x) and errors (2.0x)
 * dominate; system/filler (0.5x) sinks.
 */
export const DEFAULT_MULTIPLIERS: Record<ContextItemType, number> = {
	[ContextItemType.UserMessage]: 1.5,
	[ContextItemType.AssistantMessage]: 1.0,
	[ContextItemType.SystemMessage]: 0.5,
	[ContextItemType.CodeBlock]: 1.2,
	[ContextItemType.Error]: 2.0,
	[ContextItemType.Decision]: 2.5,
	[ContextItemType.FileModification]: 1.8,
	[ContextItemType.ToolExecution]: 1.3,
};

/**
 * Age decay: fraction to SUBTRACT from the score.
 * Formula: `min(maxDecay, (ageMs / 3_600_000) * decayRatePerHour)`.
 * 0 = fresh, 0.7 = very old. At 14h with 0.05/hr: 14 * 0.05 = 0.70 (capped).
 */
export function ageDecay(
	itemAgeMs: number,
	decayRatePerHour: number = 0.05,
	maxDecay: number = 0.7,
): number {
	if (itemAgeMs <= 0) return 0;
	const hours = itemAgeMs / 3_600_000;
	return Math.min(maxDecay, hours * decayRatePerHour);
}

/** Recency boost: 1.2 if `ageMs < thresholdMs` (default 5min), else 1.0. */
export function recencyBoost(
	ageMs: number,
	thresholdMs: number = 300_000,
): number {
	return ageMs < thresholdMs ? 1.2 : 1.0;
}

/**
 * Retention boost: 3.0 if the user flagged the item, else 1.0.
 * User-flagged items are also inferred by `detectItemType` returning
 * Decision or Error.
 */
export function retentionBoost(userFlagged: boolean): number {
	return userFlagged ? 3.0 : 1.0;
}

/**
 * Classify a content blob into a `ContextItemType`.
 *
 * Rules are ordered by priority — first match wins:
 * 1. role === "tool" → ToolExecution
 * 2. role === "custom" → SystemMessage
 * 3. error-ish content → Error
 * 4. decision-ish content → Decision
 * 5. fenced code block (≥20 chars) → CodeBlock
 * 6. file-modification verbs → FileModification
 * 7. role === "user" → UserMessage
 * 8. role === "assistant" → AssistantMessage
 * 9. Fallback → AssistantMessage
 */
export function detectItemType(
	content: string,
	role: "user" | "assistant" | "tool" | "custom",
): ContextItemType {
	const c = content ?? "";
	if (role === "tool") return ContextItemType.ToolExecution;
	if (role === "custom") return ContextItemType.SystemMessage;
	// (3) errors — traceback / panic / E#### / exception / failure / crash.
	if (/error|exception|failure|crash|panic|traceback|E\d{4}/i.test(c)) {
		return ContextItemType.Error;
	}
	// (4) decisions — "we decided", "going with", "switching to", etc.
	if (
		/decided|we chose|going with|switching to|using .* instead|final decision|let's go with/i.test(
			c,
		)
	) {
		return ContextItemType.Decision;
	}
	// (5) fenced code block ≥20 chars.
	if (/```[\s\S]{20,}/.test(c)) {
		return ContextItemType.CodeBlock;
	}
	// (6) file modification verbs.
	if (/(wrote|edited|created|modified|updated|patched)\s+\S+\.\w+/i.test(c)) {
		return ContextItemType.FileModification;
	}
	if (role === "user") return ContextItemType.UserMessage;
	if (role === "assistant") return ContextItemType.AssistantMessage;
	// (9) Fallback.
	return ContextItemType.AssistantMessage;
}

/**
 * Composite score for a single item.
 *
 * Formula:
 *   type = detectItemType(content, role)
 *   rawMult = multipliers[type] ?? DEFAULT_MULTIPLIERS[type]
 *   decay = ageDecay(now - timestamp, decayRatePerHour, maxDecay)
 *   recency = recencyBoost(now - timestamp, recencyThresholdMs)
 *   retention = retentionBoost(userFlagged)
 *   finalScore = rawMult * (1 - decay) * recency * retention
 *
 * Clamps `finalScore` to a minimum of 0.01 (never zero, so an item is
 * always a candidate unless explicitly filtered).
 */
export function score(
	item: {
		id: string;
		content: string;
		role: string;
		timestamp: number;
		userFlagged?: boolean;
	},
	now: number,
	multipliers?: Partial<Record<ContextItemType, number>>,
	opts?: {
		decayRatePerHour?: number;
		maxDecay?: number;
		recencyThresholdMs?: number;
	},
): ScoredItem {
	const content = item.content ?? "";
	// detectItemType expects the 4-role union; narrow defensively.
	const role = (["user", "assistant", "tool", "custom"].includes(item.role)
		? item.role
		: "assistant") as "user" | "assistant" | "tool" | "custom";
	const type = detectItemType(content, role);
	const rawMultiplier =
		multipliers?.[type] ?? DEFAULT_MULTIPLIERS[type];
	const ageMs = Math.max(0, now - item.timestamp);
	const decay = ageDecay(
		ageMs,
		opts?.decayRatePerHour,
		opts?.maxDecay,
	);
	const recency = recencyBoost(ageMs, opts?.recencyThresholdMs);
	const retention = retentionBoost(item.userFlagged === true);
	const finalScore = Math.max(
		0.01,
		rawMultiplier * (1 - decay) * recency * retention,
	);
	return {
		id: item.id,
		type,
		content,
		role,
		timestamp: item.timestamp,
		rawMultiplier,
		ageDecay: decay,
		recencyBoost: recency,
		retentionBoost: retention,
		finalScore,
	};
}

/**
 * Score cutoff at the `preserveRatio` percentile boundary.
 *
 * Sorts items by `finalScore` descending; returns the score at the
 * `preserveRatio` quantile. Items with `finalScore >= threshold` are
 * preserved.
 *
 * - `ratio = 1.0` → return 0 (preserve all)
 * - `ratio = 0` → return Infinity (preserve none)
 * - empty input → return Infinity
 */
export function preservationCutoff(
	items: ScoredItem[],
	preserveRatio: number,
): number {
	if (items.length === 0) return Infinity;
	if (preserveRatio >= 1) return 0;
	if (preserveRatio <= 0) return Infinity;
	// Sort descending; the top `preserveRatio` fraction is preserved.
	const sorted = [...items].sort((a, b) => b.finalScore - a.finalScore);
	// Index of the lowest-scoring item in the preserved set.
	// ceil(N * ratio) - 1, clamped to [0, N-1].
	const cutoffIdx = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil(sorted.length * preserveRatio) - 1),
	);
	return sorted[cutoffIdx].finalScore;
}

/**
 * Select which items to preserve verbatim based on `preserveRatio`.
 *
 * Returns the IDs of items with `finalScore >= threshold`. The caller
 * is responsible for excluding items inside the anchor window (the
 * boundary guard already protects those).
 */
export function itemsToPreserve(
	items: ScoredItem[],
	preserveRatio: number,
): PreservationResult {
	const threshold = preservationCutoff(items, preserveRatio);
	const preservedIds = new Set(
		items.filter((i) => i.finalScore >= threshold).map((i) => i.id),
	);
	return {
		preservedIds,
		threshold,
		totalScored: items.length,
		totalPreserved: preservedIds.size,
	};
}

/**
 * Convenience: score a list of `EngineMessage`s in position order using
 * approximate ages from their index (1 minute per position, oldest first).
 * Real timestamps should be threaded through the extension adapter when
 * available; this is the position-based fallback documented in S40B-2.
 *
 * The returned `ScoredItem[]` is in the SAME ORDER as the input — callers
 * index back into `messages` by `id` (which is the stringified index).
 */
export function scoreEngineMessages(
	messages: EngineMessage[],
	now: number,
	multipliers?: Partial<Record<ContextItemType, number>>,
	opts?: {
		decayRatePerHour?: number;
		maxDecay?: number;
		recencyThresholdMs?: number;
	},
): ScoredItem[] {
	return messages.map((m, i) => {
		// Oldest message (i=0) is `messages.length` minutes ago; newest is 1 min.
		const timestamp = now - (messages.length - i) * 60_000;
		return score(
			{
				id: String(i),
				content: m.text ?? "",
				role: m.role,
				timestamp,
				userFlagged: false,
			},
			now,
			multipliers,
			opts,
		);
	});
}
