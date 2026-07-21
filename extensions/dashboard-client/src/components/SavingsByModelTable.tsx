/**
 * dashboard-client/src/components/SavingsByModelTable.tsx — Savings by Model.
 *
 * 14 columns aggregated client-side from /api/index repos by model.
 * Replicates html.ts renderByModel logic: group by modelName, accumulate
 * tokens/cost/sessions, collapse numeric ranges when repos disagree.
 */

import type React from "react";
import { useMemo } from "react";
import type { IndexesIndexRow } from "@contracts";

export interface SavingsByModelTableProps {
	repos: IndexesIndexRow[];
}

interface ModelGroup {
	model: string;
	provider: string;
	checkpoints: number;
	tokensSaved: number;
	tokensIn: number;
	tokensOut: number;
	sessions: number;
	usd: number;
	inRates: number[];
	outRates: number[];
	ctxWindows: number[];
	maxTokens: number[];
	reasoning: boolean | null;
	lastAt: number;
}

/** Collapse numeric samples: "—" | single | "lo–hi" (matches html.ts). */
function collapseNum(samples: number[]): string {
	if (!samples.length) return "\u2014";
	const lo = Math.min(...samples);
	const hi = Math.max(...samples);
	return lo === hi
		? lo.toLocaleString()
		: `${lo.toLocaleString()}\u2013${hi.toLocaleString()}`;
}

/** Collapse rate samples: "—" | "$rate" | "$lo–$hi" (matches html.ts). */
function collapseRate(samples: number[]): string {
	if (!samples.length) return "\u2014";
	const lo = Math.min(...samples);
	const hi = Math.max(...samples);
	const fmt = (v: number): string => `$${v.toFixed(6)}`;
	return lo === hi ? fmt(lo) : `${fmt(lo)}\u2013${fmt(hi)}`;
}

/** Group repos by model, accumulate totals, sort by tokensSaved desc. */
function aggregate(repos: IndexesIndexRow[]): ModelGroup[] {
	const map: Record<string, ModelGroup> = {};
	for (const r of repos) {
		const key = (r.modelName && r.modelName.trim()) || "(unknown)";
		if (!map[key]) {
			map[key] = {
				model: key,
				provider: r.providerName ?? r.provider ?? "\u2014",
				checkpoints: 0,
				tokensSaved: 0,
				tokensIn: 0,
				tokensOut: 0,
				sessions: 0,
				usd: 0,
				inRates: [],
				outRates: [],
				ctxWindows: [],
				maxTokens: [],
				reasoning: null,
				lastAt: 0,
			};
		}
		const g = map[key];
		g.checkpoints += r.checkpointCount || 0;
		g.tokensSaved += r.tokensSaved || 0;
		g.tokensIn += r.tokensDropped || 0;
		g.tokensOut += r.tokensKept || 0;
		g.sessions += r.sessions || 0;
		if (r.inputRate) {
			g.usd += (r.tokensSaved || 0) * r.inputRate;
			g.inRates.push(r.inputRate);
		}
		if (r.outputRate) g.outRates.push(r.outputRate);
		if (r.contextWindow) g.ctxWindows.push(r.contextWindow);
		if (r.maxTokens) g.maxTokens.push(r.maxTokens);
		if (r.reasoning != null) g.reasoning = r.reasoning;
		if (r.lastCompactedAt && r.lastCompactedAt > g.lastAt)
			g.lastAt = r.lastCompactedAt;
	}
	return Object.values(map).sort((a, b) => b.tokensSaved - a.tokensSaved);
}

/** Tooltip text copied verbatim from html.ts title attributes. */
const TOOLTIPS = {
	tokensIn: "Tokens dropped from context by compaction (the input reclaimed)",
	tokensOut:
		"Tokens kept as compacted summaries still in context (the output retained)",
	ctxWindow: "Model context window (max input tokens the model accepts)",
	maxOut: "Model max output tokens per turn",
	reas: "Reasoning-capable model",
	sessions: "Distinct sessions with at least one checkpoint",
	inRate: "USD per input token",
	outRate: "USD per output token",
} as const;

export function SavingsByModelTable({
	repos,
}: SavingsByModelTableProps): React.ReactElement {
	const groups = useMemo(() => aggregate(repos), [repos]);

	return (
		<div className="savings-by-model">
			<p className="legend-note">
				How much context &amp; cost mega-compact has reclaimed, grouped by
				the model you were running. Compression ratio reflects
				workload/content, not model quality.
			</p>
			<div className="table-scroll">
				<table className="savings-table">
					<thead>
						<tr>
							<th>Model</th>
							<th>Provider</th>
							<th className="num" title={TOOLTIPS.tokensIn}>
								Tokens In
							</th>
							<th className="num" title={TOOLTIPS.tokensOut}>
								Tokens Out
							</th>
							<th className="num">Freed</th>
							<th className="num" title={TOOLTIPS.ctxWindow}>
								Ctx Window
							</th>
							<th className="num" title={TOOLTIPS.maxOut}>
								Max Out
							</th>
							<th className="num" title={TOOLTIPS.reas}>
								Reas.
							</th>
							<th className="num" title={TOOLTIPS.sessions}>
								Sessions
							</th>
							<th className="num">Checkpoints</th>
							<th className="num" title={TOOLTIPS.inRate}>
								In $/tok
							</th>
							<th className="num" title={TOOLTIPS.outRate}>
								Out $/tok
							</th>
							<th className="num">$ Saved</th>
							<th className="num">Last Used</th>
						</tr>
					</thead>
					<tbody>
						{groups.length === 0 && (
							<tr>
								<td colSpan={14} className="repo-empty">
									No repositories registered yet.
								</td>
							</tr>
						)}
						{groups.map((g) => {
							const freed = (g.tokensIn || 0) - (g.tokensOut || 0);
							const usd =
								g.usd > 0 ? `$${g.usd.toFixed(4)}` : "\u2014";
							const when = g.lastAt
								? new Date(g.lastAt).toLocaleString()
								: "\u2014";
							const reas =
								g.reasoning == null
									? "\u2014"
									: g.reasoning
										? "yes"
										: "no";
							return (
								<tr key={g.model}>
									<td className="repo-model">{g.model}</td>
									<td>{g.provider}</td>
									<td className="num">
										{g.tokensIn.toLocaleString()}
									</td>
									<td className="num">
										{g.tokensOut.toLocaleString()}
									</td>
									<td className="num">
										{freed.toLocaleString()}
									</td>
									<td className="num">
										{collapseNum(g.ctxWindows)}
									</td>
									<td className="num">
										{collapseNum(g.maxTokens)}
									</td>
									<td className="num">{reas}</td>
									<td className="num">
										{g.sessions.toLocaleString()}
									</td>
									<td className="num">
										{g.checkpoints.toLocaleString()}
									</td>
									<td className="num">
										{collapseRate(g.inRates)}
									</td>
									<td className="num">
										{collapseRate(g.outRates)}
									</td>
									<td className="num">{usd}</td>
									<td className="num">{when}</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
			<p className="legend-note">
				Tokens In = Σ original region tokens dropped by compaction. Tokens
				Out = Σ compacted summary tokens still retained in context. Freed =
				Tokens In − Tokens Out (net context reclaimed). Ctx Window / Max Out
				/ Reas. come from the latest captured model snapshot for each repo.
			</p>
		</div>
	);
}
