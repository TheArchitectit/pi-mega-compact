/**
 * dashboard-client/src/tabs/MaintenanceTab.tsx — Maintenance tab (v0.11.2 S49B).
 *
 * Three cards:
 *   1. Schema Health (schema version + integrity + column audit)
 *   2. DB Stats (file sizes + table row counts)
 *   3. Actions (one-time maintenance operations with results history)
 *
 * All three fetch independently; failures in one do not block the others.
 */

import type React from "react";
import { useState, useCallback } from "react";
import type {
	DbStatsResponse,
	SchemaHealthResponse,
	MaintenanceAction,
	MaintenanceActionResult,
	DebugBundleResponse,
} from "@contracts";
import { useApi } from "../hooks/useApi";
import {
	fetchDbStats,
	fetchSchemaHealth,
	postMaintenanceAction,
	fetchDebugBundle,
} from "../api/client";

// ---------------------------------------------------------------------------
// Action config
// ---------------------------------------------------------------------------

interface ActionDef {
	key: string;
	label: string;
	desc: string;
	dangerous: boolean;
	confirm?: string;
	daysOld?: boolean;
}

const ACTIONS: ActionDef[] = [
	{
		key: "integrity-check",
		label: "Integrity Check",
		desc: "Run PRAGMA integrity_check",
		dangerous: false,
	},
	{
		key: "reconcile-dedup",
		label: "Reconcile Dedup Mirror",
		desc: "Fix orphan dedup rows + backfill refs",
		dangerous: false,
		confirm: "Reconcile dedup_mirror (safe read/write)?",
	},
	{
		key: "checkpoint",
		label: "WAL Checkpoint",
		desc: "Merge WAL into main DB (read-only)",
		dangerous: false,
	},
	{
		key: "vacuum",
		label: "VACUUM",
		desc: "Rebuild DB reclaiming free pages",
		dangerous: true,
		confirm: "VACUUM rewrites the entire DB. Continue?",
	},
	{
		key: "reindex",
		label: "REINDEX",
		desc: "Rebuild all indexes",
		dangerous: true,
		confirm: "REINDEX rebuilds indexes. Continue?",
	},
	{
		key: "fts5-rebuild",
		label: "FTS5 Rebuild",
		desc: "Rebuild full-text search index",
		dangerous: true,
		confirm: "Rebuild FTS5 trigram index. Continue?",
	},
	{
		key: "prune",
		label: "Prune Old Rows",
		desc: "Delete transcripts + epochs older than N days",
		dangerous: true,
		daysOld: true,
		confirm: "Delete old raw_transcript rows. Continue?",
	},
];

// ---------------------------------------------------------------------------
// Format helpers (local — matches html.ts fmtBytes)
// ---------------------------------------------------------------------------

function fmtBytes(b: number): string {
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

function DbStatsCard({
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

function SchemaHealthCard({
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

// ---------------------------------------------------------------------------
// Actions card
// ---------------------------------------------------------------------------

function ActionsCard(): React.ReactElement {
	const [results, setResults] = useState<MaintenanceActionResult[]>([]);
	const [running, setRunning] = useState<string | null>(null);
	const [days, setDays] = useState("30");

	const handleAction = useCallback(
		async (def: ActionDef) => {
			const action: MaintenanceAction = def.daysOld
				? { action: "prune", daysOld: Number(days) }
				: ({ action: def.key } as MaintenanceAction);

			setRunning(def.key);
			try {
				const res = await postMaintenanceAction(action);
				setResults((prev) =>
					[{ ...res, timestamp: Date.now() }, ...prev].slice(0, 20),
				);
			} catch (err) {
				setResults((prev) =>
					[
						{
							operation: def.key,
							success: false,
							affected: 0,
							reclaimedBytes: 0,
							summary: err instanceof Error ? err.message : String(err),
							timestamp: Date.now(),
						},
						...prev,
					].slice(0, 20),
				);
			} finally {
				setRunning(null);
			}
		},
		[days],
	);

	return (
		<div className="card">
			<div className="card-header">Actions</div>
			<div className="card-body">
				<div className="action-grid">
					{ACTIONS.map((def) => {
						const isRunning = running === def.key;
						const lastResult = results.find((r) => r.operation === def.key);
						return (
							<div key={def.key} className="action-item">
								<div className="action-info">
									<div className="action-label">
										{def.label}
										{def.dangerous && (
											<span className="badge badge-warn">DESTRUCTIVE</span>
										)}
									</div>
									<div className="action-desc">{def.desc}</div>
									{lastResult && (
										<div
											className={`action-result ${lastResult.success ? "text-ok" : "text-error"}`}
										>
											{lastResult.summary}
										</div>
									)}
								</div>
								<div className="action-controls">
									{def.daysOld && (
										<input
											type="number"
											min={1}
											max={365}
											value={days}
											onChange={(e) => setDays(e.target.value)}
											className="days-input"
											disabled={isRunning}
										/>
									)}
									<button
										className={`btn ${def.dangerous ? "btn-danger" : "btn-primary"}`}
										disabled={running !== null}
										onClick={() => {
											if (def.confirm && !window.confirm(def.confirm)) return;
											handleAction(def);
										}}
									>
										{isRunning ? "Running…" : "Run"}
									</button>
								</div>
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Debug bundle card — gather diagnostic info for bug reports
// ---------------------------------------------------------------------------

function DebugBundleCard(): React.ReactElement {
	const [bundle, setBundle] = useState<DebugBundleResponse | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [showJson, setShowJson] = useState(false);

	const gather = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await fetchDebugBundle();
			setBundle(res);
			setShowJson(true);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, []);

	const copyToClipboard = useCallback(() => {
		if (!bundle) return;
		const text = JSON.stringify(bundle, null, 2);
		void navigator.clipboard.writeText(text).catch(() => {});
	}, [bundle]);

	const downloadJson = useCallback(() => {
		if (!bundle) return;
		const text = JSON.stringify(bundle, null, 2);
		const blob = new Blob([text], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `mega-compact-debug-bundle-${bundle.builtAt}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}, [bundle]);

	const criticalCount = bundle?.criticalEvents.length ?? 0;

	return (
		<div className="card">
			<div className="card-header">
				Debug Bundle
				{criticalCount > 0 && (
					<span className="text-warn" style={{ marginLeft: "1em" }}>
						{criticalCount} critical event{criticalCount !== 1 ? "s" : ""} found
					</span>
				)}
			</div>
			<div className="card-body">
				<p className="text-muted" style={{ marginBottom: "0.75em" }}>
					Gather a diagnostic bundle (recent events, config flags, schema health,
					store stats) to attach to a bug report. Critical/compaction events are
					highlighted.
				</p>
				<button onClick={gather} disabled={loading} style={{ marginRight: "0.5em" }}>
					{loading ? "Gathering…" : "Gather Debug Logs"}
				</button>
				{error && <div className="text-error">{error}</div>}
				{bundle && showJson && (
					<>
						<div style={{ marginTop: "0.75em", marginBottom: "0.5em" }}>
							<button onClick={copyToClipboard} style={{ marginRight: "0.5em" }}>
								Copy to clipboard
							</button>
							<button onClick={downloadJson}>Download JSON</button>
							<button
								onClick={() => setShowJson((v) => !v)}
								style={{ marginLeft: "0.5em" }}
							>
								{showJson ? "Hide" : "Show"}
							</button>
						</div>
						{criticalCount > 0 && (
							<div className="stat-section">
								<div className="stat-label text-warn">
									Critical events ({criticalCount})
								</div>
								<pre className="text-mono" style={{ maxHeight: "12em", overflow: "auto" }}>
									{JSON.stringify(bundle.criticalEvents, null, 2)}
								</pre>
							</div>
						)}
						<pre className="text-mono" style={{ maxHeight: "24em", overflow: "auto" }}>
							{JSON.stringify(bundle, null, 2)}
						</pre>
					</>
				)}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Main tab component
// ---------------------------------------------------------------------------

export default function MaintenanceTab(): React.ReactElement {
	const {
		data: dbStats,
		loading: statsLoading,
		error: statsError,
	} = useApi<DbStatsResponse>(
		useCallback(() => fetchDbStats(), []),
		{ pollInterval: 15000 },
	);

	const {
		data: schemaHealth,
		loading: healthLoading,
		error: healthError,
	} = useApi<SchemaHealthResponse>(
		useCallback(() => fetchSchemaHealth(), []),
		{ pollInterval: 10000 },
	);

	return (
		<div className="maintenance-tab">
			<div className="card-grid">
				<SchemaHealthCard
					data={schemaHealth}
					loading={healthLoading}
					error={healthError}
				/>
				<DbStatsCard data={dbStats} loading={statsLoading} error={statsError} />
			</div>
			<ActionsCard />
			<DebugBundleCard />
		</div>
	);
}
