/**
 * dashboard-client/src/tabs/MaintenanceTab/SchemaHealthCard.tsx — Schema Health card.
 *
 * Extracted from MaintenanceTab.tsx (delegate-shell split). Renders schema
 * version, integrity check, column audit, and FK check from
 * GET /api/maintenance/schema-health.
 */
import type React from "react";
import type { SchemaHealthResponse } from "@contracts";
import { Badge } from "../../components/ui/badge";
import {
	Card,
	CardHeader,
	CardTitle,
	CardContent,
} from "../../components/ui/card";

// ---------------------------------------------------------------------------
// Schema Health card
// ---------------------------------------------------------------------------

function ColumnAuditCard({
	columns,
}: {
	columns: SchemaHealthResponse["columns"];
}): React.ReactElement {
	const missing = columns.filter((c) => !c.present);
	return (
		<div className="mt-3">
			<div className="text-xs font-semibold text-muted-foreground">
				Column Audit ({columns.length} columns, {missing.length} missing)
			</div>
			<table className="mt-1 w-full border-collapse text-sm">
				<thead>
					<tr>
						<th className="border-b border-border px-2 py-1 text-left font-medium text-muted-foreground">
							Table
						</th>
						<th className="border-b border-border px-2 py-1 text-left font-medium text-muted-foreground">
							Column
						</th>
						<th className="border-b border-border px-2 py-1 text-left font-medium text-muted-foreground">
							Decl
						</th>
						<th className="border-b border-border px-2 py-1 text-left font-medium text-muted-foreground">
							Status
						</th>
					</tr>
				</thead>
				<tbody>
					{columns.map((c) => (
						<tr key={`${c.table}.${c.column}`} className="border-b border-border/50">
							<td className="px-2 py-1">{c.table}</td>
							<td className="px-2 py-1">{c.column}</td>
							<td className="px-2 py-1 font-mono">{c.expectedDecl}</td>
							<td className={`px-2 py-1 ${c.present ? "text-emerald-400" : "text-red-400"}`}>
								{c.present ? "✓" : "MISSING"}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

export function SchemaHealthCard({
	data,
	loading,
	error,
}: {
	data: SchemaHealthResponse | null;
	loading: boolean;
	error: Error | null;
}): React.ReactElement {
	return (
		<Card>
			<CardHeader className="flex-row items-center justify-between space-y-0">
				<CardTitle>Schema Health</CardTitle>
				{data && (
					<Badge variant={data.healthy ? "success" : "danger"}>
						{data.healthy ? "HEALTHY" : "DEGRADED"}
					</Badge>
				)}
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
						<div className="flex items-baseline justify-between border-b border-border py-1 text-sm">
							<span className="text-muted-foreground">Schema version</span>
							<span className="font-semibold">{data.schemaVersion}</span>
						</div>
						<div className="flex items-baseline justify-between border-b border-border py-1 text-sm">
							<span className="text-muted-foreground">Integrity</span>
							<span
								className={
									data.integrity[0] === "ok"
										? "text-emerald-400"
										: "text-red-400"
								}
							>
								{data.integrity.join("; ")}
							</span>
						</div>
						<ColumnAuditCard columns={data.columns} />
						{data.fkCheck.length > 0 && (
							<div className="mt-3">
								<div className="text-xs font-semibold text-amber-400">
									FK Check ({data.fkCheck.length})
								</div>
								{data.fkCheck.map((line, i) => (
									<div key={i} className="font-mono text-xs text-amber-400">
										{line}
									</div>
								))}
							</div>
						)}
					</>
				)}
			</CardContent>
		</Card>
	);
}
