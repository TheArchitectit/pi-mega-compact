/**
 * dashboard-client/src/components/DataSafetyCard.tsx — Data Safety / Shield.
 *
 * 4 fields: Regions Retained, Compressed-Original bytes, Dedup Duplicates,
 * Permanently Deleted (always 0B, shown in green).
 * Plus the safe-note text (verbatim from html.ts).
 */

import type React from "react";
import { fmtBytes } from "../utils/format";

export interface DataSafetyCardProps {
	regionsRetained: number;
	/** Original byte size of compressed data (bytes). */
	compressedOriginalBytes: number;
	/** Number of duplicate chunks collapsed. */
	duplicatesCollapsed: number;
	/** Bytes permanently deleted (always 0). */
	bytesPermanentlyDeleted: number;
}

export function DataSafetyCard(
	props: DataSafetyCardProps,
): React.ReactElement {
	return (
		<div className="card data-safety-card">
			<h3>🛡 Data Safety</h3>
			<div className="ov-stat-row">
				<span className="ov-stat-label">Regions Retained</span>
				<span className="ov-stat-value">
					{props.regionsRetained.toLocaleString()}
				</span>
			</div>
			<div className="ov-stat-row">
				<span className="ov-stat-label">Compressed-Original</span>
				<span className="ov-stat-value">
					{fmtBytes(props.compressedOriginalBytes)}
				</span>
			</div>
			<div className="ov-stat-row">
				<span className="ov-stat-label">Dedup Duplicates</span>
				<span className="ov-stat-value">
					{props.duplicatesCollapsed.toLocaleString()}
				</span>
			</div>
			<div className="ov-stat-row">
				<span className="ov-stat-label">Permanently Deleted</span>
				<span className="ov-stat-value ov-value-ok">
					{fmtBytes(props.bytesPermanentlyDeleted)}
				</span>
			</div>
			<p className="safe-note">
				Every compacted region is kept verbatim (compressed). &quot;Drop&quot; =
				removed from the live window only. We never delete your data.
			</p>
		</div>
	);
}
