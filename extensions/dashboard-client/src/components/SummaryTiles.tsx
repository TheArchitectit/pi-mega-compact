/**
 * dashboard-client/src/components/SummaryTiles.tsx — aggregate header tiles.
 *
 * 4 tiles: Repositories, Total Checkpoints, Total Tokens Saved,
 * Compressed-Original. Matches old dashboard #panel-summary tiles.
 */

import type React from "react";
import { Card, CardContent } from "../components/ui/card";

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
		<div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
			<Card className="electric-hover">
				<CardContent>
					<span className="tile-label">Repositories</span>
					<div className="text-xl font-semibold">{totalRepos.toLocaleString()}</div>
				</CardContent>
			</Card>
			<Card className="electric-hover">
				<CardContent>
					<span className="tile-label">Total Checkpoints</span>
					<div className="text-xl font-semibold">{totalCheckpoints.toLocaleString()}</div>
				</CardContent>
			</Card>
			<Card className="electric-hover">
				<CardContent>
					<span className="tile-label">Total Tokens Saved</span>
					<div className="text-xl font-semibold">{fmt(totalTokensSaved)}</div>
				</CardContent>
			</Card>
			<Card className="electric-hover">
				<CardContent>
					<span className="tile-label">Compressed-Original</span>
					<div className="text-xl font-semibold">{fmtBytesTop(compressedOriginalBytes)}</div>
				</CardContent>
			</Card>
		</div>
	);
}
