/**
 * dashboard-client/src/components/ProviderCacheCard.tsx — Provider prompt cache stats card.
 *
 * Displays lifetime provider prompt cache hit-rate aggregates + estimated
 * dollar savings from the /api/provider-cache endpoint.
 * Reuses the `ov-stat-row` / `StatRow` pattern from CacheHitsCard.tsx.
 *
 * B.2 spec: Cache Hit Rate with color classes, humanized token counts,
 * priced $ rows with green/red net, model name, locale date + relative time.
 */

import type React from "react";
import {
	fmtTokens,
	fmtDollars,
	fmtDate,
	fmtRelativeTime,
} from "../utils/format";

// ---------------------------------------------------------------------------
// Flattened props — destructured from ProviderCacheResponse in CacheTab.
// ---------------------------------------------------------------------------

export interface ProviderCacheCardProps {
	/** Cache hit rate percentage (0–100). */
	hitPct: number;
	/** Number of turns with cache_hit_pct samples. */
	turnCount: number;
	/** Total cache-read tokens across all sampled turns. */
	totalCacheRead: number;
	/** Total cache-write tokens across all sampled turns. */
	totalCacheWrite: number;
	/** Total input tokens across all sampled turns. */
	totalInput: number;
	/** $ saved from cache reads (null when unpriced). */
	cacheReadSaved: number | null;
	/** $ spent on cache writes (null when unpriced). */
	cacheWriteCost: number | null;
	/** netSaved = cacheReadSaved - cacheWriteCost (null when unpriced). */
	netSaved: number | null;
	/** Model display name (modelName || modelId, or null). */
	modelLabel: string | null;
	/** ISO timestamp of first recorded turn. */
	firstTurnAt: string | null;
	/** ISO timestamp of latest recorded turn. */
	latestTurnAt: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Hit-rate color: green ≥80, yellow ≥50, red <50. */
function hitPctClass(pct: number): string {
	if (pct >= 80) return "ov-stat-value-green";
	if (pct >= 50) return "ov-stat-value-yellow";
	return "ov-stat-value-red";
}

/** Net-saved color: green positive, red negative. */
function netClass(v: number | null): string {
	if (v == null) return "";
	return v >= 0 ? "ov-stat-value-green" : "ov-stat-value-red";
}

function StatRow({
	label,
	value,
	className,
	title,
}: {
	label: string;
	value: string;
	className?: string;
	title?: string;
}): React.ReactElement {
	return (
		<div className="ov-stat-row">
			<span className="ov-stat-label" title={title}>
				{label}
			</span>
			<span className={`ov-stat-value${className ? ` ${className}` : ""}`}>
				{value}
			</span>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export function ProviderCacheCard(
props: ProviderCacheCardProps,
): React.ReactElement {
return (
		<div className="card provider-cache-card">
			{/* --- Hit Rate + Turns --- */}
			<StatRow
				label="Cache Hit Rate"
				value={`${props.hitPct.toFixed(1)}%`}
				className={hitPctClass(props.hitPct)}
			/>
			<StatRow label="Turns Recorded" value={String(props.turnCount)} />

			{/* --- Token counts --- */}
			<StatRow
				label="Cache Read Tokens"
				value={fmtTokens(props.totalCacheRead)}
			/>
			<StatRow
				label="Cache Write Tokens"
				value={fmtTokens(props.totalCacheWrite)}
			/>
			<StatRow label="Input Tokens" value={fmtTokens(props.totalInput)} />

			{/* --- Dollar rows (null when unpriced) --- */}
			<StatRow
				label="$ Saved (reads)"
				value={fmtDollars(props.cacheReadSaved)}
			/>
			<StatRow
				label="Write Investment"
				value={fmtDollars(props.cacheWriteCost)}
			/>
			<StatRow
				label="Net Saved"
				value={fmtDollars(props.netSaved)}
				className={netClass(props.netSaved)}
			/>

			{/* --- Model + timestamps --- */}
			<StatRow label="Model" value={props.modelLabel ?? "\u2014"} />
			<StatRow label="Tracked Since" value={fmtDate(props.firstTurnAt)} />
			<StatRow
				label="Last Updated"
				value={fmtRelativeTime(props.latestTurnAt)}
			/>
		</div>
	);
}
