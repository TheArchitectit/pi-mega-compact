/**
 * dashboard-client/src/components/TimeSavedCard.tsx — Time Saved (est.) card.
 *
 * 4 fields: Compact (session), Compact (total),
 * Cache Hit (session), Cache Hit (total).
 */

import type React from "react";
import { fmtSec } from "../utils/format";

export interface TimeSavedCardProps {
	/** Seconds saved by compaction this session. */
	compactSessionSec: number;
	/** Total seconds saved by compaction. */
	compactTotalSec: number;
	/** Seconds saved by cache hits this session. */
	cacheHitSessionSec: number;
	/** Total seconds saved by cache hits. */
	cacheHitTotalSec: number;
}

function StatRow({
	label,
	value,
}: {
	label: string;
	value: string;
}): React.ReactElement {
	return (
		<div className="ov-stat-row">
			<span className="ov-stat-label">{label}</span>
			<span className="ov-stat-value">{value}</span>
		</div>
	);
}

export function TimeSavedCard(
	props: TimeSavedCardProps,
): React.ReactElement {
	return (
		<div className="card time-saved-card">
			<h3>⏱ Time Saved (est.)</h3>
			<StatRow
				label="Compact (session)"
				value={fmtSec(props.compactSessionSec)}
			/>
			<StatRow
				label="Compact (total)"
				value={fmtSec(props.compactTotalSec)}
			/>
			<StatRow
				label="Cache Hit (session)"
				value={fmtSec(props.cacheHitSessionSec)}
			/>
			<StatRow
				label="Cache Hit (total)"
				value={fmtSec(props.cacheHitTotalSec)}
			/>
		</div>
	);
}
