/**
 * perf-samples.ts — `perf_samples` table accessors (v0.8.8 Perf dashboard).
 *
 * Append-only local instrumentation store for the dashboard's Perf tab: model
 * endpoint latency, TPS, cache hit %, CPU/mem, and the snapshot() recompute /
 * disk-write cost. One row per sample; the dashboard server reads a rolling
 * window and derives p50/p95 + latest values.
 *
 * PREVENT-PI-004: local SQLite only, zero network.
 * PREVENT-002: all SQL parameterized (? placeholders). The optional `kind`
 *   filter is bound as a parameter (never string-concatenated); the only
 *   interpolated fragment is the code-controlled `AND kind = ?` clause toggle,
 *   never external input.
 * Pi-agnostic: no pi runtime types (mirrors game-scores.ts / meta.ts).
 */
import { getStateDir } from "../../store.js";
import { openStore } from "./utils.js";
import type { PrefixBreak } from "../../prefix-break.js";

/** Sample kinds recorded into perf_samples. */
export type PerfKind =
	| "turn_latency_ms"
	| "provider_latency_ms"
	| "tps"
	| "cache_hit_pct"
	| "prefix_break"
	| "rss_mb"
	| "heap_mb"
	| "cpu_user_ms"
	| "cpu_sys_ms"
	| "db_recompute_ms"
	| "disk_write_ms"
	| "cache_health";

/** Allow-list of valid perf sample kinds (mirrors the table's domain). */
export const PERF_KINDS: readonly PerfKind[] = [
	"turn_latency_ms",
	"provider_latency_ms",
	"tps",
	"cache_hit_pct",
	"prefix_break",
	"rss_mb",
	"heap_mb",
	"cpu_user_ms",
	"cpu_sys_ms",
	"db_recompute_ms",
	"disk_write_ms",
	"cache_health",
];

/** A single perf sample row (as stored + returned). */
export interface PerfSampleRow {
	id: number;
	ts: number;
	kind: PerfKind;
	value: number;
	meta: unknown;
}

function isPerfKind(k: string): k is PerfKind {
	return (PERF_KINDS as readonly string[]).includes(k);
}

/**
 * Record one perf sample. `ts` is set to Date.now(). SQL is fully parameterized
 * (PREVENT-002); the kind is validated against the fixed allow-list. Pi-agnostic.
 * Never throws on an unknown kind or non-finite value (silently ignored) so
 * instrumentation can never block the agent; a known kind + finite value always
 * writes.
 */
export function recordPerfSample(
	stateDir: string = getStateDir(),
	kind: PerfKind,
	value: number,
	meta?: unknown,
): void {
	if (!isPerfKind(kind)) return;
	if (!Number.isFinite(value)) return;
	const db = openStore(stateDir);
	db.prepare(
		`INSERT INTO perf_samples (ts, kind, value, meta)
		 VALUES (?, ?, ?, ?)`,
	).run(Date.now(), kind, value, meta != null ? JSON.stringify(meta) : null);
}

/**
 * Read perf samples since `sinceTs` (epoch ms), optionally filtered by kind.
 * Returns rows ascending by ts. The optional kind filter is bound as a
 * parameter (PREVENT-002). Pi-agnostic. `meta` is parsed defensively (null-safe:
 * PREVENT-001 — assigned to a variable before any property access).
 */
export function readPerfSamples(
	stateDir: string = getStateDir(),
	sinceTs: number = 0,
	kind?: PerfKind,
): PerfSampleRow[] {
	const db = openStore(stateDir);
	const sql = kind
		? `SELECT id, ts, kind, value, meta FROM perf_samples
		   WHERE ts >= ? AND kind = ? ORDER BY ts ASC`
		: `SELECT id, ts, kind, value, meta FROM perf_samples
		   WHERE ts >= ? ORDER BY ts ASC`;
	const params = kind ? [sinceTs, kind] : [sinceTs];
	const rows = db.prepare(sql).all(...params) as Array<{
		id: number;
		ts: number;
		kind: string;
		value: number;
		meta: string | null;
	}>;
	const out: PerfSampleRow[] = [];
	for (const r of rows) {
		if (!isPerfKind(r.kind)) continue; // defensive: unknown kind row skipped
		let meta: unknown = null;
		if (r.meta != null) {
			try {
				meta = JSON.parse(r.meta);
			} catch {
				meta = null;
			}
		}
		out.push({ id: r.id, ts: r.ts, kind: r.kind, value: r.value, meta });
	}
	return out;
}

// ─── Provider prompt-cache lifetime aggregates ────────────────

/** Lifetime provider prompt cache aggregates from `perf_samples`. */
export interface ProviderCacheLifetime {
	/** Total samples (turns) recorded. */
	sampleCount: number;
	/** Average cache hit rate across all samples (0-100). */
	avgHitPct: number;
	/** Sum of cacheRead tokens across all samples. */
	totalCacheRead: number;
	/** Sum of cacheWrite tokens across all samples. */
	totalCacheWrite: number;
	/** Sum of input (non-cached) tokens across all samples. */
	totalInput: number;
	/** ISO timestamp of the first sample, or null if no samples. */
	firstSampleAt: string | null;
	/** ISO timestamp of the most recent sample, or null if no samples. */
	latestSampleAt: string | null;
	/**
	 * Per-model breakdown of aggregates (F4). Samples without a model tag are
	 * omitted from this array (they remain in the flat totals above).
	 */
	byModel: ProviderCacheModelAgg[];
}

/** Per-model provider cache aggregate (F4). */
export interface ProviderCacheModelAgg {
	/** Model label (modelName || modelId from meta, or null for untagged). */
	model: string;
	/** Average hit rate for this model (0-100). */
	hitPct: number;
	/** Sum of cache-read tokens for this model. */
	totalCacheRead: number;
	/** Sum of cache-write tokens for this model. */
	totalCacheWrite: number;
	/** Number of samples for this model. */
	sampleCount: number;
}

/**
 * Extract a model label from parsed meta (modelName or modelId), or null.
 */
function extractModelLabel(
	meta: Record<string, unknown>,
): string | null {
	if (typeof meta.modelName === "string" && meta.modelName.length > 0)
		return meta.modelName;
	if (typeof meta.modelId === "string" && meta.modelId.length > 0)
		return meta.modelId;
	return null;
}

/**
 * Build sorted byModel array from the model aggregation map.
 */
function byModelFromMap(
	map: Map<string, { sumCr: number; sumCw: number; sumInp: number; sumHitPct: number; hitCount: number; samples: number }>,
): ProviderCacheModelAgg[] {
	const out: ProviderCacheModelAgg[] = [];
	for (const [model, m] of map) {
		out.push({
			model,
			hitPct: m.hitCount > 0 ? m.sumHitPct / m.hitCount : 0,
			totalCacheRead: m.sumCr,
			totalCacheWrite: m.sumCw,
			sampleCount: m.samples,
		});
	}
	out.sort((a, b) => b.sampleCount - a.sampleCount);
	return out;
}

/**
 * Aggregate `cache_hit_pct` rows (ts + parsed meta) into a
 * `ProviderCacheLifetime`. Shared by the lifetime and window readers so both
 * use the identical aggregation formula. `meta` is parsed defensively
 * (PREVENT-001 null-safe). Rows must be ascending by ts.
 */
function aggregateCacheRows(
	rows: Array<{ ts: number; meta: string | null }>,
): ProviderCacheLifetime {
	if (rows.length === 0) {
		return {
			sampleCount: 0,
			avgHitPct: 0,
			totalCacheRead: 0,
			totalCacheWrite: 0,
			totalInput: 0,
			firstSampleAt: null,
			latestSampleAt: null,
			byModel: [],
		};
	}
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalInput = 0;
	let sumHitPct = 0;
	let hitPctCount = 0;
	const modelMap = new Map<
		string,
		{
			sumCr: number;
			sumCw: number;
			sumInp: number;
			sumHitPct: number;
			hitCount: number;
			samples: number;
		}
	>();
	for (const r of rows) {
		if (r.meta != null) {
			let meta: Record<string, unknown> | null = null;
			try {
				meta = JSON.parse(r.meta) as Record<string, unknown>;
			} catch {
				meta = null;
			}
			if (meta != null) {
				const cr =
					typeof meta.cacheRead === "number"
						? meta.cacheRead
						: typeof meta.cache_read === "number"
							? meta.cache_read
							: 0;
				const cw =
					typeof meta.cacheWrite === "number"
						? meta.cacheWrite
						: typeof meta.cache_write === "number"
							? meta.cache_write
							: 0;
				const inp = typeof meta.input === "number" ? meta.input : 0;
				totalCacheRead += cr;
				totalCacheWrite += cw;
				totalInput += inp;
				// Compute hit pct for this sample (same formula as perf-handler.ts)
				const denom = cr + inp + cw;
				if (denom > 0) {
					sumHitPct += (cr / denom) * 100;
					hitPctCount++;
				}
				// Per-model grouping (F4)
				const modelLabel = extractModelLabel(meta);
				if (modelLabel != null) {
					let m = modelMap.get(modelLabel);
					if (!m) {
						m = {
							sumCr: 0,
							sumCw: 0,
							sumInp: 0,
							sumHitPct: 0,
							hitCount: 0,
							samples: 0,
						};
						modelMap.set(modelLabel, m);
					}
					m.sumCr += cr;
					m.sumCw += cw;
					m.sumInp += inp;
					m.samples++;
					if (denom > 0) {
						m.sumHitPct += (cr / denom) * 100;
						m.hitCount++;
					}
				}
				// Untagged samples are omitted from byModel
			}
		}
	}
	return {
		sampleCount: rows.length,
		avgHitPct: hitPctCount > 0 ? sumHitPct / hitPctCount : 0,
		totalCacheRead,
		totalCacheWrite,
		totalInput,
		firstSampleAt: new Date(rows[0].ts).toISOString(),
		latestSampleAt: new Date(rows[rows.length - 1].ts).toISOString(),
		byModel: byModelFromMap(modelMap),
	};
}

/**
 * Read lifetime provider prompt cache aggregates from `perf_samples`.
 *
 * Aggregates `cache_creation_input_tokens` / `cache_read_input_tokens` from
 * the `meta` JSON column of `cache_hit_pct` samples (`json_extract`,
 * available in node:sqlite >=22.13 / SQLite >=3.38). Returns a zeroed
 * `ProviderCacheLifetime` when no samples exist (never undefined).
 */
export function readProviderCacheLifetime(
	stateDir: string = getStateDir(),
): ProviderCacheLifetime {
	const db = openStore(stateDir);
	const rows = db
		.prepare(
			`SELECT ts, meta FROM perf_samples
	       WHERE kind = ?
	       ORDER BY ts ASC`,
		)
		.all("cache_hit_pct") as Array<{
		ts: number;
		meta: string | null;
	}>;
	return aggregateCacheRows(rows);
}

/**
 * Read provider prompt cache aggregates over a trailing window of `minutes`
 * (samples with ts >= now - minutes*60_000). Same aggregate shape as
 * `readProviderCacheLifetime`; the existing lifetime reader is untouched.
 * Returns a zeroed `ProviderCacheLifetime` when no samples fall in the window.
 */
export function readProviderCacheWindow(
	stateDir: string = getStateDir(),
	minutes: number,
): ProviderCacheLifetime {
	const db = openStore(stateDir);
	const sinceTs = Date.now() - minutes * 60_000;
	const rows = db
		.prepare(
			`SELECT ts, meta FROM perf_samples
	       WHERE kind = ? AND ts >= ?
	       ORDER BY ts ASC`,
		)
		.all("cache_hit_pct", sinceTs) as Array<{
		ts: number;
		meta: string | null;
	}>;
	return aggregateCacheRows(rows);
}

// ... keep every function below unchanged ...

/**
 * Read the most recent `cache_hit_pct` value from `perf_samples`.
 *
 * Returns 0 when no samples exist (never NaN/undefined). When multiple
 * rows share the same timestamp the tie is broken by highest id (most
 * recently inserted).
 */
export function readLatestCacheHitPct(
	stateDir: string = getStateDir(),
): number {
	const db = openStore(stateDir);
	const row = db
		.prepare(
			`SELECT value FROM perf_samples
	       WHERE kind = ?
	       ORDER BY ts DESC, id DESC
	       LIMIT 1`,
		)
		.get("cache_hit_pct") as { value: number } | undefined;
	if (!row || typeof row.value !== "number" || !Number.isFinite(row.value))
		return 0;
	return row.value;
}

/**
 * Read provider cache lifetime aggregates for a specific repo by state directory.
 *
 * This is a convenience alias over `readProviderCacheLifetime(stateDir)` —
 * both open the same underlying global store database. Accepts an explicit
 * `stateDir` rather than relying on the implicit default, making it suitable
 * for per-repo dashboard handlers.
 */
export function readProviderCacheForRepo(
	stateDir: string,
): ProviderCacheLifetime {
	return readProviderCacheLifetime(stateDir);
}

// ─── Prefix-break reader (S53A) ───────────────────────────────────────────────

/** Re-exported for consumers that import via perf-samples. */
export type { PrefixBreak } from "../../prefix-break.js";

/**
 * Read `prefix_break` samples in a time window.
 *
 * @param stateDir  State directory for this repo.
 * @param sinceTs   Lower bound (epoch ms). Pass 0 for no lower bound.
 * @param untilTs   Upper bound (epoch ms). Pass 0 for no upper bound.
 *                  Rows with ts > untilTs are excluded.
 * @returns         Sorted ascending array of PrefixBreak rows.
 *
 * SQL is fully parameterized (PREVENT-002). `meta` is parsed defensively
 * (PREVENT-001 null-safe). When no rows exist the return is an empty array.
 */
export function readPrefixBreaks(
	stateDir: string = getStateDir(),
	sinceTs: number = 0,
	untilTs: number = 0,
): PrefixBreak[] {
	const db = openStore(stateDir);
	let rows: Array<{
		id: number;
		ts: number;
		value: number;
		meta: string | null;
	}>;

	if (untilTs > 0) {
		const sql = `SELECT id, ts, value, meta FROM perf_samples
		   WHERE kind = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC`;
		rows = db.prepare(sql).all("prefix_break", sinceTs, untilTs) as typeof rows;
	} else {
		const sql = `SELECT id, ts, value, meta FROM perf_samples
		   WHERE kind = ? AND ts >= ? ORDER BY ts ASC`;
		rows = db.prepare(sql).all("prefix_break", sinceTs) as typeof rows;
	}

	const out: PrefixBreak[] = [];
	for (const r of rows) {
		let meta: unknown = null;
		if (r.meta != null) {
			try {
				meta = JSON.parse(r.meta);
			} catch {
				meta = null;
			}
		}
		out.push({
			id: r.id,
			ts: r.ts,
			kind: "prefix_break",
			value: r.value,
			meta: meta as PrefixBreak["meta"],
		});
	}
	return out;
}
