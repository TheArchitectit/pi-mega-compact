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
		<div className="ov-stat-row">
			<span className="ov-stat-label">{label}</span>
			<span className="ov-stat-value">{value}</span>
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
		<div className="card repo-sessions-card">
			<h3>Repo (all sessions)</h3>
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
			<div className="ov-compression-meter">
				<div className="meter-track">
					<div
						className={`meter-fill ${barCls}`}
						style={{ width: `${barWidth}%` }}
					/>
				</div>
				<span className="meter-sub">{compressSub}</span>
			</div>
		</div>
	);
}
