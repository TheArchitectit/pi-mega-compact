/**
 * dashboard-client/src/components/ActiveReposTable.tsx — Active repos table.
 *
 * 9 columns: Repo, Model, Tier, Context %, State, Compactions s/t,
 * Cache Hits s/t, Compact s/t, CacheHit s/t.
 * Data from fetchServers() via useApi with 10s polling.
 */

import type React from "react";
import type { ServerEntry } from "@contracts";

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
	"Compact s/t (s)",
	"CacheHit s/t (s)",
] as const;

export function ActiveReposTable({
	servers,
}: ActiveReposTableProps): React.ReactElement {
	return (
		<div className="active-repos-section">
			<p className="legend-note">
				Repos seen within the last 30 minutes, with their per-repo
				cache-hit, compaction, and time-saved (est.) totals pulled live
				from each repo&apos;s dashboard.json.
			</p>
			<div className="table-scroll">
				<table className="active-repos-table">
					<thead>
						<tr>
							{HEADERS.map((h, i) => (
								<th
									key={h}
									className={i >= 3 && i !== 4 ? "num" : undefined}
								>
									{h}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{servers.length === 0 && (
							<tr>
								<td colSpan={9} className="repo-empty">
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
									<td title={r.repoRoot}>
										{r.displayName || r.repoRoot}
									</td>
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
		</div>
	);
}
