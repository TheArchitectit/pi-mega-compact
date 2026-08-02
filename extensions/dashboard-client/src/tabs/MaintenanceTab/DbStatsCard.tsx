/**
 * dashboard-client/src/tabs/MaintenanceTab/DbStatsCard.tsx — DB Stats card.
 *
 * Extracted from MaintenanceTab.tsx (delegate-shell split). Renders file sizes
 * and table row counts from GET /api/maintenance.
 */
import type React from "react";
import type { DbStatsResponse } from "@contracts";

// ---------------------------------------------------------------------------
// Format helpers (local — matches html.ts fmtBytes)
// ---------------------------------------------------------------------------

export function fmtBytes(b: number): string {
	if (b < 1024) return `${b} B`;
	if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
	return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// DB Stats card
// ---------------------------------------------------------------------------

function FileSizesCard({
	files,
	pageSize,
	pageCount,
	freelistPages,
}: {
	files: DbStatsResponse["storage"]["files"];
	pageSize: number;
	pageCount: number;
	freelistPages: number;
}): React.ReactElement {
	const total = files.dbBytes + files.walBytes + files.shmBytes;
	return (
		<div className="stat-section">
			<div className="stat-label">File Sizes</div>
			<table className="compact-table">
				<tbody>
					<tr>
						<td>sqlite.db</td>
						<td className="num">{fmtBytes(files.dbBytes)}</td>
					</tr>
					{files.walBytes > 0 && (
						<tr>
							<td>.wal</td>
							<td className="num">{fmtBytes(files.walBytes)}</td>
						</tr>
					)}
					{files.shmBytes > 0 && (
						<tr>
							<td>.shm</td>
							<td className="num">{fmtBytes(files.shmBytes)}</td>
						</tr>
					)}
					<tr>
						<td>Total</td>
						<td className="num">{fmtBytes(total)}</td>
					</tr>
					<tr>
						<td>Page size</td>
						<td className="num">{fmtBytes(pageSize)}</td>
					</tr>
					<tr>
						<td>Pages</td>
						<td className="num">
							{pageCount.toLocaleString()} ({freelistPages.toLocaleString()}{" "}
							free)
						</td>
					</tr>
				</tbody>
			</table>
		</div>
	);
}

function TableRowCountsCard({
	tables,
}: {
	tables: DbStatsResponse["tables"];
}): React.ReactElement {
	const totalRows = tables.reduce((s, t) => s + Math.max(0, t.rowCount), 0);
	return (
		<div className="stat-section">
			<div className="stat-label">
				Table Row Counts ({totalRows.toLocaleString()} total)
			</div>
			<table className="compact-table">
				<thead>
					<tr>
						<th>Table</th>
						<th className="num">Rows</th>
					</tr>
				</thead>
				<tbody>
					{tables.map((t) => (
						<tr key={t.table}>
							<td>{t.table}</td>
							<td className="num">
								{t.rowCount >= 0 ? t.rowCount.toLocaleString() : "—"}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

export function DbStatsCard({
	data,
	loading,
	error,
}: {
	data: DbStatsResponse | null;
	loading: boolean;
	error: Error | null;
}): React.ReactElement {
	return (
		<div className="card">
			<div className="card-header">DB Stats</div>
			<div className="card-body">
				{loading && !data && <span className="text-muted">Loading…</span>}
				{error && !data && <span className="text-error">{error.message}</span>}
				{data && (
					<>
						<FileSizesCard
							files={data.storage.files}
							pageSize={data.storage.pageSize}
							pageCount={data.storage.pageCount}
							freelistPages={data.storage.freelistPages}
						/>
						<TableRowCountsCard tables={data.tables} />
					</>
				)}
			</div>
		</div>
	);
}
