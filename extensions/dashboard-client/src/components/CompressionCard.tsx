/**
 * dashboard-client/src/components/CompressionCard.tsx — compression stats.
 *
 * Stat grid: tokens in → out, freed amount highlighted, compression %,
 * dedup contribution %. Consumes snapshot.compression.repo.
 */

import type React from "react";

export interface CompressionCardProps {
	/** Repo-level compression stats (tokens in/out/freed + percentages). */
	tokensIn: number;
	tokensOut: number;
	tokensFreed: number;
	/** Compression ratio (percent, 0–100). */
	compressionPct: number;
	/** Dedup contribution (percent, 0–100). */
	dedupPct: number;
}

function fmt(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

export function CompressionCard({
	tokensIn,
	tokensOut,
	tokensFreed,
	compressionPct,
	dedupPct,
}: CompressionCardProps): React.ReactElement {
	return (
		<div className="card compression-card">
			<h3>Compression (repo)</h3>
			<div className="stat-grid">
				<div className="stat">
					<span className="stat-label">In</span>
					<span className="stat-value">{fmt(tokensIn)}</span>
				</div>
				<div className="stat">
					<span className="stat-label">Out</span>
					<span className="stat-value">{fmt(tokensOut)}</span>
				</div>
				<div className="stat stat-highlight">
					<span className="stat-label">Freed</span>
					<span className="stat-value">{fmt(tokensFreed)}</span>
				</div>
				<div className="stat">
					<span className="stat-label">Ratio</span>
					<span className="stat-value">{compressionPct.toFixed(1)}%</span>
				</div>
				<div className="stat">
					<span className="stat-label">Dedup</span>
					<span className="stat-value">{dedupPct.toFixed(1)}%</span>
				</div>
			</div>
		</div>
	);
}
