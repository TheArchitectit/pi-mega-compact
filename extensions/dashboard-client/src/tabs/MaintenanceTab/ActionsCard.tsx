/**
 * dashboard-client/src/tabs/MaintenanceTab/ActionsCard.tsx — Actions card.
 *
 * Extracted from MaintenanceTab.tsx (delegate-shell split). One-time
 * maintenance operations (vacuum, checkpoint, reindex, prune, …) with a
 * results history.
 */
import type React from "react";
import { useState, useCallback } from "react";
import type {
	MaintenanceAction,
	MaintenanceActionResult,
} from "@contracts";
import { postMaintenanceAction } from "../../api/client";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader, CardTitle } from "../../components/ui/card";

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
// Actions card
// ---------------------------------------------------------------------------

export function ActionsCard(): React.ReactElement {
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
		<Card>
			<CardHeader>
				<CardTitle>Actions</CardTitle>
			</CardHeader>
			<div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
				{ACTIONS.map((def) => {
					const isRunning = running === def.key;
					const lastResult = results.find((r) => r.operation === def.key);
					return (
						<div
							key={def.key}
							className="flex items-start justify-between gap-3 rounded-lg border border-border/60 p-3"
						>
							<div className="min-w-0">
								<div className="flex flex-wrap items-center gap-2">
									<span className="font-semibold">{def.label}</span>
									{def.dangerous && <Badge variant="danger">DESTRUCTIVE</Badge>}
								</div>
								<div className="mt-1 text-xs text-muted-foreground">{def.desc}</div>
								{lastResult && (
									<div
										className={`mt-1 text-xs ${lastResult.success ? "text-emerald-400" : "text-red-400"}`}
									>
										{lastResult.summary}
									</div>
								)}
							</div>
							<div className="flex shrink-0 items-center gap-2">
								{def.daysOld && (
									<input
										type="number"
										min={1}
										max={365}
										value={days}
										onChange={(e) => setDays(e.target.value)}
										className="w-16 rounded-md border border-border bg-bg-elevated/50 px-2 py-1 text-sm outline-none focus:border-primary"
										disabled={isRunning}
									/>
								)}
								<Button
									type="button"
									variant={def.dangerous ? "ghost" : "default"}
									className={
										def.dangerous
											? "border border-red-500/50 text-red-400 hover:bg-red-500/10 hover:text-red-300"
											: undefined
									}
									disabled={running !== null}
									onClick={() => {
										if (def.confirm && !window.confirm(def.confirm)) return;
										handleAction(def);
									}}
								>
									{isRunning ? "Running…" : "Run"}
								</Button>
							</div>
						</div>
					);
				})}
			</div>
		</Card>
	);
}
