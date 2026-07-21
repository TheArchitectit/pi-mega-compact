import type React from "react";
export interface MemoryStatusProps {
	retained: number;
	compressedKiB: number;
	dedupPct: number;
	deleted: number;
}
export function MemoryStatusCard({
	retained,
	compressedKiB,
	dedupPct,
	deleted,
}: MemoryStatusProps): React.ReactElement {
	return (
		<div className="memory-card">
			<h4>Memory Status</h4>
			<div>
				Retained regions: {retained} · Compressed-Original:{" "}
				{compressedKiB.toFixed(1)} KiB · Dedup: {dedupPct}% · Permanently
				deleted: {deleted}
			</div>
		</div>
	);
}
