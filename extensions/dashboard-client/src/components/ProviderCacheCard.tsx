/**
 * dashboard-client/src/components/ProviderCacheCard.tsx — Provider prompt cache stats card.
 *
 * Displays lifetime provider prompt cache hit-rate aggregates + estimated
 * dollar savings from the /api/provider-cache endpoint.
 * Mirrors the PerfCards pattern (perf-metric CSS classes).
 */

import type React from "react";
import type { ProviderCacheResponse } from "@contracts";

/** Format milliseconds (em-dash for null/undefined).
function fmtMs(v: number | null | undefined): string {
	return v == null
		? "\u2014"
		: v >= 100
			? `${Math.round(v)}ms`
			: `${v.toFixed(1)}ms`;
}

/** Format a number with fixed decimals (em-dash for null/non-number). */
function fmtNum(v: number | null | undefined, dec: number): string {
	return v == null || typeof v !== "number" ? "\u2014" : v.toFixed(dec);
}

/** Format tokens as human-readable. */
function fmtTokens(v: number | null | undefined): string {
	if (v == null) return "\u2014";
	if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
	if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
	return String(v);
}

/** Format dollars with micro-cent precision for < $0.01. */
function fmtDollars(v: number): string {
	const abs = Math.abs(v);
	if (abs < 0.0001) return "$0.00";
	if (abs < 0.01) return `$${v.toFixed(4)}`;
	if (abs < 1) return `$${v.toFixed(4)}`;
	return `$${v.toFixed(2)}`;
}

interface Props {
	data: ProviderCacheResponse;
}

/** A single stat row. */
function Stat({
	label,
	value,
}: {
	label: string;
	value: string;
}): React.ReactElement {
	return (
		<div className="perf-metric">
			<span className="perf-label">{label}</span>
			<span className="perf-value">{value}</span>
		</div>
	);
}

/** Card wrapper with a title. */
function Card({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<div className="perf-card">
			<h3 className="perf-card-title">{title}</h3>
			<div className="perf-card-body">{children}</div>
		</div>
	);
}

export function ProviderCacheCard({ data }: Props): React.ReactElement {
	const { cache, savings } = data;
	const { avgHitPct, turnCount, totalCacheRead, totalCacheWrite, totalInput } =
		cache;

	const pctStr = turnCount > 0 ? `${fmtNum(avgHitPct, 1)}%` : "\u2014";

	const netSavedStr = savings != null ? fmtDollars(savings.netSaved) : "\u2014";

	const modelLabel = savings?.model ?? "\u2014";
	const rateLabel =
		savings?.inputRate != null
			? `$${fmtNum(savings.inputRate / 1_000_000, 2)}/M tok`
			: "\u2014";

	return (
		<div className="perf-cards-grid">
			<Card title="Provider cache hits">
				<Stat label="Lifetime avg" value={pctStr} />
				<Stat label="Samples" value={String(turnCount)} />
				<Stat label="Cache read" value={fmtTokens(totalCacheRead)} />
				<Stat label="Cache write" value={fmtTokens(totalCacheWrite)} />
				<Stat label="Total input" value={fmtTokens(totalInput)} />
			</Card>

			<Card title="Estimated savings">
				<Stat label="Net saved" value={netSavedStr} />
				<Stat label="Model" value={modelLabel} />
				<Stat label="Input rate" value={rateLabel} />
				{savings != null && (
					<>
						<Stat
							label="Read saved"
							value={fmtDollars(savings.cacheReadSaved)}
						/>
						<Stat
							label="Write cost"
							value={fmtDollars(savings.cacheWriteCost)}
						/>
					</>
				)}
			</Card>
		</div>
	);
}
