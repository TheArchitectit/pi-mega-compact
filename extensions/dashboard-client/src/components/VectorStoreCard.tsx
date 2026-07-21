/**
 * dashboard-client/src/components/VectorStoreCard.tsx — Vector Store (session) card.
 *
 * 9 fields: Checkpoints, Original (dropped), Kept (summaries), Freed,
 * Injected, Recall Relevance %, Storage Dedup %, Collapsed, Last ID.
 * Plus a compression meter bar (green ≥90%, yellow ≥60%, red <60%).
 *
 * NOTE: dedupHitRate, storageDedupRate, compressionPct, dedupPct are
 * 0–1 fractions at runtime (despite contract saying 0–100).
 * Tooltips copied verbatim from html.ts.
 */

import type React from "react";
import { fmtPctFromFraction } from "../utils/format";

export interface VectorStoreCardProps {
	checkpointCount: number;
	/** Original tokens dropped into compaction (session). */
	tokensIn: number;
	/** Kept summary tokens (session). */
	tokensOut: number;
	/** Tokens freed = dropped − kept (session). */
	tokensFreed: number;
	/** Recall injection count. */
	injectedCount: number;
	/** Recall relevance — 0–1 fraction. */
	dedupHitRate: number;
	/** Storage dedup rate — 0–1 fraction. */
	storageDedupRate: number;
	/** Duplicate chunks collapsed. */
	dedupCollapsed: number;
	/** Last checkpoint ID or null. */
	lastCheckpointId: string | null;
	/** Session compression ratio — 0–1 fraction. */
	compressionPct: number;
	/** Session dedup contribution — 0–1 fraction. */
	dedupPct: number;
}

/** Compression meter colour class (inverse of context: high = good). */
function compressClass(sp: number): string {
	if (sp >= 0.9) return "meter-green";
	if (sp >= 0.6) return "meter-yellow";
	return "meter-red";
}

/** Stat row with optional tooltip. */
function StatRow({
	label,
	value,
	title,
}: {
	label: string;
	value: string | number;
	title?: string;
}): React.ReactElement {
	return (
		<div className="ov-stat-row">
			<span className="ov-stat-label" title={title}>
				{label}
			</span>
			<span className="ov-stat-value">{value}</span>
		</div>
	);
}

export function VectorStoreCard(
	props: VectorStoreCardProps,
): React.ReactElement {
	const sp = props.compressionPct;
	const barCls = compressClass(sp);
	const barWidth = Math.max(sp * 100, 0.5);
	const compressSub = `${fmtPctFromFraction(sp)} tokens saved · dedup: ${fmtPctFromFraction(props.dedupPct)}`;

	return (
		<div className="card vector-store-card">
			<h3>Vector Store (session)</h3>
			<StatRow
				label="Checkpoints"
				value={props.checkpointCount.toLocaleString()}
				title="A saved summary of a chunk of your conversation that was compacted to free up space."
			/>
			<StatRow
				label="Original (dropped)"
				value={props.tokensIn.toLocaleString()}
				title="Total size of the original conversation text dropped into compaction this session, including redundant regions skipped by dedup. This is the 'in'."
			/>
			<StatRow
				label="Kept (summaries)"
				value={props.tokensOut.toLocaleString()}
				title="Compact summaries we are currently holding as 'memory' for this session (the 'out'). Smaller is better."
			/>
			<StatRow
				label="Freed"
				value={props.tokensFreed.toLocaleString()}
				title="Conversation space freed = dropped − kept (the 'saved')."
			/>
			<StatRow
				label="Injected"
				value={props.injectedCount}
				title="How many times old context was automatically brought back into the conversation because it was relevant to what you were doing."
			/>
			<StatRow
				label="Recall Relevance"
				value={fmtPctFromFraction(props.dedupHitRate)}
				title="Of the times we recalled old context, how often it was actually on-topic."
			/>
			<StatRow
				label="Storage Dedup"
				value={fmtPctFromFraction(props.storageDedupRate)}
				title="How often new content matched something we already had, so we skipped storing a duplicate copy. Higher = less wasted space."
			/>
			<StatRow
				label="Collapsed"
				value={props.dedupCollapsed}
				title="How many duplicate chunks we collapsed into one instead of storing separately."
			/>
			<StatRow
				label="Last ID"
				value={props.lastCheckpointId ?? "—"}
				title="The ID of the most recent saved checkpoint."
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
