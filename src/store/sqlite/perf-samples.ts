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

/** Sample kinds recorded into perf_samples. */
export type PerfKind =
	| "turn_latency_ms"
	| "provider_latency_ms"
	| "tps"
	| "cache_hit_pct"
	| "cache_prefix_break"
	| "rss_mb"
	| "heap_mb"
	| "cpu_user_ms"
	| "cpu_sys_ms"
	| "db_recompute_ms"
	| "disk_write_ms";

/** Allow-list of valid perf sample kinds (mirrors the table's domain). */
export const PERF_KINDS: readonly PerfKind[] = [
	"turn_latency_ms",
	"provider_latency_ms",
	"tps",
	"cache_hit_pct",
	"cache_prefix_break",
	"rss_mb",
	"heap_mb",
	"cpu_user_ms",
	"cpu_sys_ms",
	"db_recompute_ms",
	"disk_write_ms",
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
	).run(
		Date.now(),
		kind,
		value,
		meta != null ? JSON.stringify(meta) : null,
	);
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

// ---------------------------------------------------------------------------
// S53A — provider prompt-cache aggregates (Cache tab data source)
// ---------------------------------------------------------------------------

/**
 * Aggregated provider prompt-cache stats over `cache_hit_pct` samples.
 * Token totals are summed from the per-sample meta {input, cacheRead,
 * cacheWrite}; rows with missing/malformed meta contribute to the hit-rate
 * averages (their value) but not to the token totals.
 */
export interface ProviderCacheStats {
	/** Number of cache_hit_pct samples aggregated. */
	readonly sampleCount: number;
	/** Σ meta.input (fresh, uncached input tokens). */
	readonly totalInput: number;
	/** Σ meta.cacheRead (tokens served from the provider cache). */
	readonly totalCacheRead: number;
	/** Σ meta.cacheWrite (tokens written into the provider cache). */
	readonly totalCacheWrite: number;
	/** Mean hit rate across samples (percent, 0–100). */
	readonly avgHitPct: number;
	/** Most recent sample's hit rate (percent, 0–100). */
	readonly latestHitPct: number;
	/** ts of the oldest sample, or null when empty. */
	readonly oldestTs: number | null;
	/** ts of the newest sample, or null when empty. */
	readonly newestTs: number | null;
}

/** Narrow a parsed meta block to its numeric token fields (PREVENT-011). */
function metaTokens(meta: unknown): {
	input: number;
	cacheRead: number;
	cacheWrite: number;
} | null {
	if (meta == null || typeof meta !== "object") return null;
	const m = meta as Record<string, unknown>;
	const input = m.input;
	const cacheRead = m.cacheRead;
	const cacheWrite = m.cacheWrite;
	if (
		typeof input !== "number" ||
		typeof cacheRead !== "number" ||
		typeof cacheWrite !== "number"
	)
		return null;
	if (
		!Number.isFinite(input) ||
		!Number.isFinite(cacheRead) ||
		!Number.isFinite(cacheWrite)
	)
		return null;
	return { input, cacheRead, cacheWrite };
}

/**
 * Aggregate all `cache_hit_pct` samples since `sinceTs` (default 0 =
 * all-time). Unlike the rolling-window /api/perf path there is no default
 * window, so the dashboard Cache tab shows lifetime provider cache data even
 * when the session has been idle past the perf window. Pi-agnostic,
 * parameterized (PREVENT-002), defensive meta parse (PREVENT-001).
 */
export function readProviderCacheStats(
	stateDir: string = getStateDir(),
	sinceTs: number = 0,
): ProviderCacheStats {
	const rows = readPerfSamples(stateDir, sinceTs, "cache_hit_pct");
	if (rows.length === 0) {
		return {
			sampleCount: 0,
			totalInput: 0,
			totalCacheRead: 0,
			totalCacheWrite: 0,
			avgHitPct: 0,
			latestHitPct: 0,
			oldestTs: null,
			newestTs: null,
		};
	}
	let totalInput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let hitSum = 0;
	for (const r of rows) {
		hitSum += r.value;
		const t = metaTokens(r.meta);
		if (t) {
			totalInput += t.input;
			totalCacheRead += t.cacheRead;
			totalCacheWrite += t.cacheWrite;
		}
	}
	// rows are ASC by ts — last row is the most recent sample.
	return {
		sampleCount: rows.length,
		totalInput,
		totalCacheRead,
		totalCacheWrite,
		avgHitPct: hitSum / rows.length,
		latestHitPct: rows[rows.length - 1].value,
		oldestTs: rows[0].ts,
		newestTs: rows[rows.length - 1].ts,
	};
}
