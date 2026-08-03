/**
 * dashboard-client/src/tabs/MaintenanceTab/DbStatsCard.tsx — DB Stats card.
 *
 * Extracted from MaintenanceTab.tsx (delegate-shell split). Renders file sizes
 * and table row counts from GET /api/maintenance.
 */
import type React from "react";
import type { DbStatsResponse } from "@contracts";
import {
	Card,
	CardHeader,
	CardTitle,
	CardContent,
} from "../../components/ui/card";

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
		<div className="mt-3">
			<div className="text-xs font-semibold text-muted-foreground">File Sizes</div>
			<table className="mt-1 w-full border-collapse text-sm">
				<tbody>
					<tr className="border-b border-border/50">
						<td className="px-2 py-1">sqlite.db</td>
						<td className="px-2 py-1 text-right font-semibold">
							{fmtBytes(files.dbBytes)}
						</td>
					</tr>
					{files.walBytes > 0 && (
						<tr className="border-b border-border/50">
							<td className="px-2 py-1">.wal</td>
							<td className="px-2 py-1 text-right font-semibold">
								{fmtBytes(files.walBytes)}
							</td>
						</tr>
					)}
					{files.shmBytes > 0 && (
						<tr className="border-b border-border/50">
							<td className="px-2 py-1">.shm</td>
							<td className="px-2 py-1 text-right font-semibold">
								{fmtBytes(files.shmBytes)}
							</td>
						</tr>
					)}
					<tr className="border-b border-border/50">
						<td className="px-2 py-1">Total</td>
						<td className="px-2 py-1 text-right font-semibold">
							{fmtBytes(total)}
						</td>
					</tr>
					<tr className="border-b border-border/50">
						<td className="px-2 py-1">Page size</td>
						<td className="px-2 py-1 text-right font-semibold">
							{fmtBytes(pageSize)}
						</td>
					</tr>
					<tr>
						<td className="px-2 py-1">Pages</td>
						<td className="px-2 py-1 text-right font-semibold">
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
		<div className="mt-3">
			<div className="text-xs font-semibold text-muted-foreground">
				Table Row Counts ({totalRows.toLocaleString()} total)
			</div>
			<table className="mt-1 w-full border-collapse text-sm">
				<thead>
					<tr>
						<th className="border-b border-border px-2 py-1 text-left font-medium text-muted-foreground">
							Table
						</th>
						<th className="border-b border-border px-2 py-1 text-right font-medium text-muted-foreground">
							Rows
						</th>
					</tr>
				</thead>
				<tbody>
					{tables.map((t) => (
						<tr key={t.table} className="border-b border-border/50">
							<td className="px-2 py-1">{t.table}</td>
							<td className="px-2 py-1 text-right">
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
		<Card>
			<CardHeader>
				<CardTitle>DB Stats</CardTitle>
			</CardHeader>
			<CardContent>
				{loading && !data && (
					<span className="text-sm text-muted-foreground">Loading…</span>
				)}
				{error && !data && (
					<span className="text-sm text-red-400">{error.message}</span>
				)}
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
			</CardContent>
		</Card>
	);
}
