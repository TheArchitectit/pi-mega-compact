/**
 * dashboard-client/src/components/RepoAllSessionsCard.tsx — Repo (all sessions) card.
 *
 * 7 fields: Checkpoints, Original, Kept, Freed, Sessions, Collapsed, Storage Dedup.
 * Plus a compression meter bar (green ≥90%, yellow ≥60%, red <60%).
 *
 * NOTE: storageDedupRate, compressionPct, dedupPct are 0–1 fractions
 * at runtime (despite contract saying 0–100).
 */

import type React from "react";
import { fmtPctFromFraction } from "../utils/format";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

export interface RepoAllSessionsCardProps {
	checkpointCount: number;
	/** Original tokens dropped (repo-level). */
	tokensIn: number;
	/** Kept summary tokens (repo-level). */
	tokensOut: number;
	/** Tokens freed (repo-level). */
	tokensFreed: number;
	/** Number of sessions. */
	sessionCount: number;
	/** Duplicate chunks collapsed (repo-level). */
	dedupCollapsed: number;
	/** Storage dedup rate — 0–1 fraction. */
	storageDedupRate: number;
	/** Repo compression ratio — 0–1 fraction. */
	compressionPct: number;
	/** Repo dedup contribution — 0–1 fraction. */
	dedupPct: number;
}

function compressClass(sp: number): string {
	if (sp >= 0.9) return "meter-green";
	if (sp >= 0.6) return "meter-yellow";
	return "meter-red";
}

function StatRow({
	label,
	value,
}: {
	label: string;
	value: string | number;
}): React.ReactElement {
	return (
		<div className="flex items-baseline justify-between border-b border-border py-1 text-sm">
			<span className="text-xs text-muted-foreground">{label}</span>
			<span className="font-semibold">{value}</span>
		</div>
	);
}

export function RepoAllSessionsCard(
	props: RepoAllSessionsCardProps,
): React.ReactElement {
	const sp = props.compressionPct;
	const barCls = compressClass(sp);
	const barWidth = Math.max(sp * 100, 0.5);
	const compressSub = `${fmtPctFromFraction(sp)} tokens saved · dedup: ${fmtPctFromFraction(props.dedupPct)}`;

	return (
		<Card className="electric-hover">
			<CardHeader>
				<CardTitle>Repo (all sessions)</CardTitle>
			</CardHeader>
			<CardContent>
			<StatRow
				label="Checkpoints"
				value={props.checkpointCount.toLocaleString()}
			/>
			<StatRow
				label="Original"
				value={props.tokensIn.toLocaleString()}
			/>
			<StatRow
				label="Kept"
				value={props.tokensOut.toLocaleString()}
			/>
			<StatRow
				label="Freed"
				value={props.tokensFreed.toLocaleString()}
			/>
			<StatRow
				label="Sessions"
				value={props.sessionCount.toLocaleString()}
			/>
			<StatRow label="Collapsed" value={props.dedupCollapsed} />
			<StatRow
				label="Storage Dedup"
				value={fmtPctFromFraction(props.storageDedupRate)}
			/>
			<div>
				<div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-bg-elevated">
					<div
						className={`meter-fill h-full ${barCls}`}
						style={{ width: `${barWidth}%` }}
					/>
				</div>
				<span className="mt-1 block text-xs text-muted-foreground">{compressSub}</span>
			</div>
			</CardContent>
		</Card>
	);
}
