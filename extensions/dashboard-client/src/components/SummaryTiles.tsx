/**
 * dashboard-client/src/components/SummaryTiles.tsx — aggregate header tiles.
 *
 * 4 tiles: Repositories, Total Checkpoints, Total Tokens Saved,
 * Compressed-Original. Matches old dashboard #panel-summary tiles.
 */

import type React from "react";

export interface SummaryTilesProps {
	/** Total repos in the registry. */
	totalRepos: number;
	/** Total checkpoints across all repos. */
	totalCheckpoints: number;
	/** Total tokens saved across all repos. */
	totalTokensSaved: number;
	/** Total compressed-original bytes across all repos. */
	compressedOriginalBytes: number;
}

/** Format bytes → MiB/KiB/B (matches html.ts fmtBytesTop). */
function fmtBytesTop(b: number): string {
	if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(1)} MiB`;
	if (b >= 1024) return `${(b / 1024).toFixed(1)} KiB`;
	return `${b} B`;
}

/** Format large numbers with K/M suffix. */
function fmt(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

export function SummaryTiles({
	totalRepos,
	totalCheckpoints,
	totalTokensSaved,
	compressedOriginalBytes,
}: SummaryTilesProps): React.ReactElement {
	return (
		<div className="summary-tiles">
			<div className="tile">
				<span className="tile-label">Repositories</span>
				<span className="tile-value">{totalRepos.toLocaleString()}</span>
			</div>
			<div className="tile">
				<span className="tile-label">Total Checkpoints</span>
				<span className="tile-value">{totalCheckpoints.toLocaleString()}</span>
			</div>
			<div className="tile tile-highlight">
				<span className="tile-label">Total Tokens Saved</span>
				<span className="tile-value">{fmt(totalTokensSaved)}</span>
			</div>
			<div className="tile">
				<span className="tile-label">Compressed-Original</span>
				<span className="tile-value">{fmtBytesTop(compressedOriginalBytes)}</span>
			</div>
		</div>
	);
}
