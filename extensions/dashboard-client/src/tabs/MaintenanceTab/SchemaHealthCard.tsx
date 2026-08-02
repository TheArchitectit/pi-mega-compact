/**
 * dashboard-client/src/tabs/MaintenanceTab/SchemaHealthCard.tsx — Schema Health card.
 *
 * Extracted from MaintenanceTab.tsx (delegate-shell split). Renders schema
 * version, integrity check, column audit, and FK check from
 * GET /api/maintenance/schema-health.
 */
import type React from "react";
import type { SchemaHealthResponse } from "@contracts";

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
		<div className="stat-section">
			<div className="stat-label">
				Column Audit ({columns.length} columns, {missing.length} missing)
			</div>
			<table className="compact-table">
				<thead>
					<tr>
						<th>Table</th>
						<th>Column</th>
						<th>Decl</th>
						<th>Status</th>
					</tr>
				</thead>
				<tbody>
					{columns.map((c) => (
						<tr key={`${c.table}.${c.column}`}>
							<td>{c.table}</td>
							<td>{c.column}</td>
							<td className="text-mono">{c.expectedDecl}</td>
							<td className={c.present ? "text-ok" : "text-error"}>
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
		<div className="card">
			<div className="card-header">
				Schema Health
				{data && (
					<span className={`badge ${data.healthy ? "badge-ok" : "badge-bad"}`}>
						{data.healthy ? "HEALTHY" : "DEGRADED"}
					</span>
				)}
			</div>
			<div className="card-body">
				{loading && !data && <span className="text-muted">Loading…</span>}
				{error && !data && <span className="text-error">{error.message}</span>}
				{data && (
					<>
						<div className="stat-row">
							<span className="stat-label">Schema version</span>
							<span className="num">{data.schemaVersion}</span>
						</div>
						<div className="stat-row">
							<span className="stat-label">Integrity</span>
							<span
								className={
									data.integrity[0] === "ok" ? "text-ok" : "text-error"
								}
							>
								{data.integrity.join("; ")}
							</span>
						</div>
						<ColumnAuditCard columns={data.columns} />
						{data.fkCheck.length > 0 && (
							<div className="stat-section">
								<div className="stat-label text-warn">
									FK Check ({data.fkCheck.length})
								</div>
								{data.fkCheck.map((line, i) => (
									<div key={i} className="text-warn text-mono">
										{line}
									</div>
								))}
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}
