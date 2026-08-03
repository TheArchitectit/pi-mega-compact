/**
 * model-thresholds.ts — `model_thresholds` table (per-model compaction
 * thresholds, S52 / v0.16.1).
 *
 * Users wanted (2026-08-03 incident follow-up) to tune the compaction safety
 * margin + fire point PER MODEL — different providers'/models' context
 * windows range 8K to 1M+, so one global % is wrong. This table stores the
 * override; absence of a row means "use env/default" (the existing
 * MEGACOMPACT_TIER + the fix-2 default 5% safety margin).
 *
 * Guardrails: PREVENT-001 (null-safe JSON never touches this), PREVENT-002
 * (parameterized — no string concat into SQL), PREVENT-011 (no `any`).
 */
import type { DatabaseSync } from "node:sqlite";
import { getStateDir } from "../../store.js";
import { openStore } from "./utils.js";

/** A per-model compaction threshold override. */
export interface ModelThreshold {
	modelId: string;
	/** 0-20: % of context window reserved AFTER summary + maxOutput as a
	 * safety buffer against turn-growth-between-gates. 0% = aggressive
	 * (risks "too long even after compaction" errors); 20% = conservative. */
	safetyMarginPct: number;
	/** 10-90: % of context window at which compaction FIRES. Lower = compact
	 * earlier (more headroom); higher = compact later (more context before
	 * compaction). Default 70 (matches the high tier in config/dedup.ts). */
	firePointPct: number;
	updatedAt: number | null;
}

/** Default safety margin (%) when no per-model override exists. */
export const DEFAULT_SAFETY_MARGIN_PCT = 5;
/** Default fire point (%) when no per-model + no env override exists. */
export const DEFAULT_FIRE_POINT_PCT = 70;
export const MIN_SAFETY_MARGIN_PCT = 0;
export const MAX_SAFETY_MARGIN_PCT = 20;
export const MIN_FIRE_POINT_PCT = 10;
export const MAX_FIRE_POINT_PCT = 90;

function rowToThreshold(r: Record<string, unknown>): ModelThreshold {
	return {
		modelId: r.model_id as string,
		safetyMarginPct: r.safety_margin_pct as number,
		firePointPct: r.fire_point_pct as number,
		updatedAt: (r.updated_at as number) ?? null,
	};
}

/** Get the per-model threshold override, or null when none exists. */
export function getModelThreshold(
	modelId: string,
	stateDir: string = getStateDir(),
): ModelThreshold | null {
	const db = openStore(stateDir);
	const row = db
		.prepare(
			"SELECT model_id, safety_margin_pct, fire_point_pct, updated_at FROM model_thresholds WHERE model_id = ?",
		)
		.get(modelId) as Record<string, unknown> | undefined;
	return row ? rowToThreshold(row) : null;
}

/** List ALL stored per-model thresholds (for the dashboard table). */
export function listModelThresholds(
	stateDir: string = getStateDir(),
): ModelThreshold[] {
	const db = openStore(stateDir);
	const rows = db
		.prepare(
			"SELECT model_id, safety_margin_pct, fire_point_pct, updated_at FROM model_thresholds ORDER BY updated_at DESC",
		)
		.all() as Record<string, unknown>[];
	return rows.map(rowToThreshold);
}

/** Validate a threshold value range. Throws on out-of-bounds. */
export function assertValidPct(
	pct: number,
	min: number,
	max: number,
	label: string,
): void {
	if (!Number.isFinite(pct)) {
		throw new Error(`${label} must be a finite number, got ${pct}`);
	}
	if (pct < min || pct > max) {
		throw new Error(`${label} must be in [${min}, ${max}], got ${pct}`);
	}
}

/** Upsert a per-model threshold. Validates ranges (0-20, 10-90). */
export function putModelThreshold(
	modelId: string,
	safetyMarginPct: number,
	firePointPct: number,
	stateDir: string = getStateDir(),
): ModelThreshold {
	if (!modelId || typeof modelId !== "string") {
		throw new Error("modelId is required");
	}
	assertValidPct(
		safetyMarginPct,
		MIN_SAFETY_MARGIN_PCT,
		MAX_SAFETY_MARGIN_PCT,
		"safetyMarginPct",
	);
	assertValidPct(
		firePointPct,
		MIN_FIRE_POINT_PCT,
		MAX_FIRE_POINT_PCT,
		"firePointPct",
	);
	const db: DatabaseSync = openStore(stateDir);
	const now = Date.now();
	db.prepare(
		`INSERT INTO model_thresholds (model_id, safety_margin_pct, fire_point_pct, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(model_id) DO UPDATE SET
       safety_margin_pct = excluded.safety_margin_pct,
       fire_point_pct   = excluded.fire_point_pct,
       updated_at       = excluded.updated_at`,
	).run(modelId, safetyMarginPct, firePointPct, now);
	return {
		modelId,
		safetyMarginPct,
		firePointPct,
		updatedAt: now,
	};
}

/** Delete a per-model threshold (revert to env/defaults). */
export function deleteModelThreshold(
	modelId: string,
	stateDir: string = getStateDir(),
): boolean {
	const db = openStore(stateDir);
	const r = db
		.prepare("DELETE FROM model_thresholds WHERE model_id = ?")
		.run(modelId);
	return (r.changes ?? 0) > 0;
}

/**
 * Resolve the EFFECTIVE threshold value for a model: per-model override if
 * present, otherwise the fallback. Used by context-handler.ts to pick the
 * safety margin + fire point without each call duplicating the lookup.
 */
export function resolveModelThreshold(
	modelId: string | null | undefined,
	opts: {
		safetyMarginFallback: number;
		firePointFallback: number;
		stateDir?: string;
	},
): { safetyMarginPct: number; firePointPct: number } {
	const fallback = {
		safetyMarginPct: opts.safetyMarginFallback,
		firePointPct: opts.firePointFallback,
	};
	if (!modelId) return fallback;
	const row = getModelThreshold(modelId, opts.stateDir ?? getStateDir());
	if (!row) return fallback;
	return {
		safetyMarginPct: row.safetyMarginPct,
		firePointPct: row.firePointPct,
	};
}
