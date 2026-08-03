/**
 * dashboard-client/src/components/ActiveReposTable.tsx — Active repos table.
 *
 * Columns: Repo, Model, Tier, Context %, State, Compactions s/t,
 * Cache Hits s/t, Cache Hit %, Cache Read, Cache Write, Est. Saved,
 * Compact s/t (s), CacheHit s/t (s).
 * Data from fetchServers() via useApi with 10s polling.
 */

import type React from "react";
import type { ServerEntry } from "@contracts";
import { fmtTokens } from "@/utils/format.ts";
import { Card, CardContent } from "../components/ui/card";

export interface ActiveReposTableProps {
	servers: ServerEntry[];
}

/** Format seconds → human-readable duration (matches html.ts fmtSec). */
function fmtSec(s: number | undefined): string {
	const v = s ?? 0;
	if (v >= 3600) return `${(v / 3600).toFixed(1)}h`;
	if (v >= 60) return `${Math.round(v / 60)}m`;
	if (v >= 1) return `${v.toFixed(1)}s`;
	return `${Math.round(v * 1000)}ms`;
}

const HEADERS = [
	"Repo",
	"Model",
	"Tier",
	"Context %",
	"State",
	"Compactions (s/t)",
	"Cache Hits (s/t)",
	"Cache Hit %",
	"Est. Saved",
	"Cache Read",
	"Cache Write",
	"Compact s/t (s)",
	"CacheHit s/t (s)",
] as const;

export function ActiveReposTable({
	servers,
}: ActiveReposTableProps): React.ReactElement {
	return (
		<Card>
			<CardContent>
			<p className="mb-3 text-xs text-muted-foreground">
				Repos seen within the last 30 minutes, with their per-repo cache-hit,
				compaction, and time-saved (est.) totals pulled live from each
				repo&apos;s dashboard.json.
			</p>
			<div className="overflow-x-auto">
				<table className="w-full border-collapse text-sm">
					<thead>
						<tr>
							{HEADERS.map((h, i) => (
								<th
									key={h}
									className={`border-b border-border px-3 py-2 text-left font-medium text-muted-foreground${
										i >= 3 && i !== 4 ? " text-right" : ""
									}`}
								>
									{h}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{servers.length === 0 && (
							<tr>
								<td colSpan={HEADERS.length} className="px-3 py-4 text-muted-foreground">
									No active repositories.
								</td>
							</tr>
						)}
						{servers.map((r) => {
							const ch = r.cacheHits ?? {
								session: 0,
								total: 0,
								sessionTokensSaved: 0,
								totalTokensSaved: 0,
							};
							const cp = r.compacts ?? { session: 0, total: 0 };
							const ts = r.timeSaved ?? {
								compact: { sessionSec: 0, totalSec: 0 },
								cacheHit: { sessionSec: 0, totalSec: 0 },
							};
							return (
								<tr key={r.repoRoot}>
									<td title={r.repoRoot}>{r.displayName || r.repoRoot}</td>
									<td>{r.model ?? "\u2014"}</td>
									<td>{r.tier ?? "\u2014"}</td>
									<td className="num">
										{r.contextPct != null
											? `${Math.round(r.contextPct * 100)}%`
											: "\u2014"}
									</td>
									<td>{r.state ?? "\u2014"}</td>
									<td className="num">
										{cp.session} / {cp.total}
									</td>
									<td className="num">
										{ch.session} / {ch.total}
									</td>
									<td className="num">
										{r.providerCache != null
											? `${r.providerCache.avgHitPct.toFixed(1)}%`
											: "—"}
									</td>
									<td className="num">
										{r.providerCache?.estimatedSaved != null
											? `$${r.providerCache.estimatedSaved.toFixed(2)}`
											: "—"}
									</td>
									<td className="num">
										{r.providerCache?.cacheRead != null
											? fmtTokens(r.providerCache.cacheRead)
											: "—"}
									</td>
									<td className="num">
										{r.providerCache?.cacheWrite != null
											? fmtTokens(r.providerCache.cacheWrite)
											: "—"}
									</td>
									<td className="num">
										{fmtSec(ts.compact.sessionSec)} /{" "}
										{fmtSec(ts.compact.totalSec)}
									</td>
									<td className="num">
										{fmtSec(ts.cacheHit.sessionSec)} /{" "}
										{fmtSec(ts.cacheHit.totalSec)}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
			</CardContent>
		</Card>
	);
}
