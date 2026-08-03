/**
 * dashboard-client/src/components/RepoTable.tsx — sortable, searchable repo table.
 *
 * 6 columns: Repo, Model, Checkpoints, Tokens Saved, Retained, Last Compacted.
 * Client-side sort (click header to toggle asc/desc). Search by displayName
 * (case-insensitive substring). Default sort: Last Compacted DESC.
 * Row click opens RepoDetailModal.
 */

import type React from "react";
import { useState, useMemo } from "react";
import type { IndexesIndexRow } from "@contracts";
import { Card, CardContent } from "../components/ui/card";

export interface RepoTableProps {
	repos: IndexesIndexRow[];
	/** Called when a row is clicked — opens the detail modal. */
	onSelect: (repo: IndexesIndexRow) => void;
}

type SortKey =
	| "displayName"
	| "modelName"
	| "checkpointCount"
	| "tokensSaved"
	| "compressedOriginalBytes"
	| "lastCompactedAt";

type SortDir = "asc" | "desc";

const COLUMNS: Array<{ key: SortKey; label: string }> = [
	{ key: "displayName", label: "Repo" },
	{ key: "modelName", label: "Model" },
	{ key: "checkpointCount", label: "Checkpoints" },
	{ key: "tokensSaved", label: "Tokens Saved" },
	{ key: "compressedOriginalBytes", label: "Retained" },
	{ key: "lastCompactedAt", label: "Last Compacted" },
];

/** Format bytes → MiB/KiB/B (matches html.ts fmtBytesTop). */
function fmtBytesTop(b: number): string {
	if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(1)} MiB`;
	if (b >= 1024) return `${(b / 1024).toFixed(1)} KiB`;
	return `${b} B`;
}

function formatTs(ts: number | null): string {
	if (ts === null || ts === undefined) return "\u2014";
	try {
		return new Date(ts).toLocaleString();
	} catch {
		return String(ts);
	}
}

export function RepoTable({
	repos,
	onSelect,
}: RepoTableProps): React.ReactElement {
	const [search, setSearch] = useState("");
	const [sortKey, setSortKey] = useState<SortKey>("lastCompactedAt");
	const [sortDir, setSortDir] = useState<SortDir>("desc");

	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase();
		const list = q
			? repos.filter((r) => r.displayName.toLowerCase().includes(q))
			: repos.slice();
		list.sort((a, b) => {
			const av = a[sortKey];
			const bv = b[sortKey];
			// nulls last on desc, first on asc (consistent UX)
			const aNull = av === null || av === undefined;
			const bNull = bv === null || bv === undefined;
			if (aNull && bNull) return 0;
			if (aNull) return sortDir === "desc" ? 1 : -1;
			if (bNull) return sortDir === "desc" ? -1 : 1;
			const cmp =
				typeof av === "number" && typeof bv === "number"
					? av - bv
					: String(av).localeCompare(String(bv));
			return sortDir === "desc" ? -cmp : cmp;
		});
		return list;
	}, [repos, search, sortKey, sortDir]);

	const handleSort = (key: SortKey): void => {
		if (sortKey === key) {
			setSortDir((d) => (d === "asc" ? "desc" : "asc"));
		} else {
			setSortKey(key);
			setSortDir(
				key === "lastCompactedAt" ||
				key === "tokensSaved" ||
				key === "compressedOriginalBytes"
					? "desc"
					: "asc",
			);
		}
	};

	return (
		<Card>
			<CardContent>
			<input
				type="search"
				className="mb-3 w-full rounded-md border border-border bg-bg-elevated/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/60"
				placeholder="Search repos…"
				value={search}
				onChange={(e) => setSearch(e.target.value)}
				aria-label="Search repos"
			/>
			<div className="overflow-x-auto">
			<table className="w-full border-collapse text-sm">
				<thead>
					<tr>
						{COLUMNS.map((col) => (
							<th key={col.key} className="border-b border-border px-3 py-2 text-left">
								<button
									type="button"
									className={`font-medium text-muted-foreground transition-colors hover:text-foreground ${
										sortKey === col.key ? "text-neon" : ""
									}`}
									onClick={() => handleSort(col.key)}
								>
									{col.label}
									{sortKey === col.key && (
										<span>{sortDir === "asc" ? " ▲" : " ▼"}</span>
									)}
								</button>
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{filtered.length === 0 && (
						<tr>
							<td colSpan={COLUMNS.length} className="px-3 py-4 text-muted-foreground">
								{repos.length === 0
									? "No repositories registered yet."
									: "No repos match your search."}
							</td>
						</tr>
					)}
					{filtered.map((repo) => (
						<tr
							key={repo.stateDir}
							onClick={() => onSelect(repo)}
							className="cursor-pointer border-b border-border/50 transition-colors hover:bg-bg-elevated/40"
						>
							<td className="px-3 py-2 font-medium" title={repo.repoRoot}>
								{repo.displayName}
							</td>
							<td className="px-3 py-2 text-muted-foreground">{repo.modelName ?? "\u2014"}</td>
							<td className="px-3 py-2 text-right">{repo.checkpointCount.toLocaleString()}</td>
							<td className="px-3 py-2 text-right">{repo.tokensSaved.toLocaleString()}</td>
							<td className="px-3 py-2 text-right">{fmtBytesTop(repo.compressedOriginalBytes)}</td>
							<td className="px-3 py-2 text-right">{formatTs(repo.lastCompactedAt)}</td>
						</tr>
					))}
				</tbody>
			</table>
			</div>
			</CardContent>
		</Card>
	);
}
