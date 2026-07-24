/**
 * score.ts — paired scoring per session.
 *
 * For each session: extract ground-truth facts → run every compactor →
 * score each against ground truth → compute per-session deltas vs baseline.
 *
 * Paired deltas (per-session delta vs raw-truncate baseline), never marginal
 * medians for the headline — marginal comparison can mislead (pi-vcc §3.4).
 */

import type { Facts } from "./facts.js";
import { weightedRecall, weightedFactDensity, precision } from "./facts.js";
import type { Compactor } from "./compactors.js";
import { extractFromTranscript, extractFromBrief } from "./extract.js";
import type { BenchmarkMessage } from "./corpus.js";

// ── Per-session scores ───────────────────────────────────────────────────────

export interface SessionScores {
	sessionId: string;
	/** Number of messages in the raw session. */
	messageCount: number;
	/** Total chars in the raw session. */
	totalChars: number;
	/** Scores per compactor. Keyed by Compactor.name. */
	compactors: Record<string, CompactorScore>;
}

export interface CompactorScore {
	/** Weighted recall against ground truth. */
	recall: number;
	/** Weighted fact density (value per 1k chars). */
	density: number;
	/** Mean fact-weight of the brief's own facts. */
	precision: number;
	/** Brief output size in chars. */
	size: number;
	/** Duplicate facts in the brief (redundancy signal). */
	duplicateFacts: number;
	/** Compaction time in ms. */
	latencyMs: number;
}

// ── Scoring function ─────────────────────────────────────────────────────────

export const scoreSession = (
	sessionId: string,
	messages: BenchmarkMessage[],
	compactors: Compactor[],
): SessionScores => {
	const { facts: groundTruth, messageCount, totalChars } = extractFromTranscript(messages);

	const compactorsScores: Record<string, CompactorScore> = {};

	for (const compactor of compactors) {
		const start = performance.now();
		const brief = compactor.build({ messages });
		const latencyMs = performance.now() - start;

		const briefFacts = extractFromBrief(brief);
		const size = brief.length;

		compactorsScores[compactor.name] = {
			recall: weightedRecall(groundTruth, briefFacts),
			density: weightedFactDensity(groundTruth, briefFacts, size),
			precision: precision(briefFacts),
			size,
			duplicateFacts: briefFacts.commandExactDupes + briefFacts.toolDupes,
			latencyMs,
		};
	}

	return { sessionId, messageCount, totalChars, compactors: compactorsScores };
};

// ── Aggregation (honest statistics: median + mean + IQR, never just mean) ────

const median = (arr: number[]): number => {
	if (arr.length === 0) return 0;
	const sorted = [...arr].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

const mean = (arr: number[]): number =>
	arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length;

const iqr = (arr: number[]): number => {
	if (arr.length < 4) return 0;
	const sorted = [...arr].sort((a, b) => a - b);
	const q1 = sorted[Math.floor(sorted.length * 0.25)];
	const q3 = sorted[Math.floor(sorted.length * 0.75)];
	return q3 - q1;
};

export interface AggregatedScores {
	/** Number of sessions scored. */
	sessionCount: number;
	/** Aggregate per compactor. Keyed by Compactor.name. */
	compactors: Record<string, AggregatedCompactorScore>;
	/** Per-session deltas (vs raw-truncate baseline). Keyed by compactor name. */
	deltas: Record<string, AggregatedDelta>;
}

export interface AggregatedCompactorScore {
	recall: { median: number; mean: number; iqr: number };
	density: { median: number; mean: number; iqr: number };
	precision: { median: number; mean: number; iqr: number };
	size: { median: number; mean: number; total: number };
	duplicateFacts: { median: number; mean: number };
	latencyMs: { median: number; mean: number; p95: number };
}

export interface AggregatedDelta {
	recall: { median: number; mean: number };
	density: { median: number; mean: number };
	precision: { median: number; mean: number };
	size: { median: number; mean: number };
}

export const aggregateScores = (sessions: SessionScores[], baselineName = "raw-truncate"): AggregatedScores => {
	if (sessions.length === 0) {
		return { sessionCount: 0, compactors: {}, deltas: {} };
	}

	const compactorNames = Object.keys(sessions[0].compactors);

	const aggregate = (compName: string): AggregatedCompactorScore => {
		const values = sessions.map((s) => s.compactors[compName]).filter(Boolean);
		if (values.length === 0) {
			return {
				recall: { median: 0, mean: 0, iqr: 0 },
				density: { median: 0, mean: 0, iqr: 0 },
				precision: { median: 0, mean: 0, iqr: 0 },
				size: { median: 0, mean: 0, total: 0 },
				duplicateFacts: { median: 0, mean: 0 },
				latencyMs: { median: 0, mean: 0, p95: 0 },
			};
		}

		const recalls = values.map((v) => v.recall);
		const densities = values.map((v) => v.density);
		const precisions = values.map((v) => v.precision);
		const sizes = values.map((v) => v.size);
		const dupes = values.map((v) => v.duplicateFacts);
		const latencies = values.map((v) => v.latencyMs).sort((a, b) => a - b);

		return {
			recall: { median: median(recalls), mean: mean(recalls), iqr: iqr(recalls) },
			density: { median: median(densities), mean: mean(densities), iqr: iqr(densities) },
			precision: { median: median(precisions), mean: mean(precisions), iqr: iqr(precisions) },
			size: { median: median(sizes), mean: mean(sizes), total: sizes.reduce((s, v) => s + v, 0) },
			duplicateFacts: { median: median(dupes), mean: mean(dupes) },
			latencyMs: {
				median: median(latencies),
				mean: mean(latencies),
				p95: latencies[Math.floor(latencies.length * 0.95)] ?? latencies[latencies.length - 1] ?? 0,
			},
		};
	};

	const aggCompactors: Record<string, AggregatedCompactorScore> = {};
	for (const name of compactorNames) aggCompactors[name] = aggregate(name);

	// Paired deltas vs baseline (pi-vcc §3.4: per-session, not marginal).
	const aggDeltas: Record<string, AggregatedDelta> = {};
	const baseline = baselineName;
	for (const name of compactorNames) {
		if (name === baseline) continue;
		const recallDeltas: number[] = [];
		const densityDeltas: number[] = [];
		const precisionDeltas: number[] = [];
		const sizeDeltas: number[] = [];
		for (const s of sessions) {
			const base = s.compactors[baseline];
			const cur = s.compactors[name];
			if (!base || !cur) continue;
			recallDeltas.push(cur.recall - base.recall);
			densityDeltas.push(cur.density - base.density);
			precisionDeltas.push(cur.precision - base.precision);
			sizeDeltas.push(cur.size - base.size);
		}
		aggDeltas[name] = {
			recall: { median: median(recallDeltas), mean: mean(recallDeltas) },
			density: { median: median(densityDeltas), mean: mean(densityDeltas) },
			precision: { median: median(precisionDeltas), mean: mean(precisionDeltas) },
			size: { median: median(sizeDeltas), mean: mean(sizeDeltas) },
		};
	}

	return { sessionCount: sessions.length, compactors: aggCompactors, deltas: aggDeltas };
};

// ── Results table (text table for console + docs) ────────────────────────────

export const formatResultsTable = (agg: AggregatedScores): string => {
	const pct = (n: number) => (n * 100).toFixed(1) + "%";
	const num = (n: number) => n.toFixed(2);
	const chars = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toFixed(0));
	const names = Object.keys(agg.compactors);

	const header = `| Metric | ${names.map((n) => `**${n}**`).join(" | ")} |`;
	const sep = `|---|${names.map(() => "---").join("|")}|`;
	const rows = [
		["recall (median)", ...names.map((n) => pct(agg.compactors[n].recall.median))],
		["recall (mean ± IQR)", ...names.map((n) => `${pct(agg.compactors[n].recall.mean)} ± ${pct(agg.compactors[n].recall.iqr)}`)],
		["density (median)", ...names.map((n) => num(agg.compactors[n].density.median))],
		["precision (median wt)", ...names.map((n) => num(agg.compactors[n].precision.median))],
		["size (median)", ...names.map((n) => chars(agg.compactors[n].size.median))],
		["size (total)", ...names.map((n) => chars(agg.compactors[n].size.total))],
		["dup facts (median)", ...names.map((n) => num(agg.compactors[n].duplicateFacts.median))],
		["latency (median)", ...names.map((n) => `${num(agg.compactors[n].latencyMs.median)}ms`)],
		["latency (p95)", ...names.map((n) => `${num(agg.compactors[n].latencyMs.p95)}ms`)],
	];

	return [
		`Session count: ${agg.sessionCount}`,
		"",
		header,
		sep,
		...rows.map((row) => `| ${row[0]} | ${row.slice(1).join(" | ")} |`),
	].join("\n");
};

export const formatDeltasTable = (agg: AggregatedScores): string => {
	const pct = (n: number) => {
		const sign = n >= 0 ? "+" : "";
		return `${sign}${(n * 100).toFixed(1)}%`;
	};
	const chars = (n: number) => {
		const sign = n >= 0 ? "+" : "";
		return n >= 1000 || n <= -1000
			? `${sign}${(n / 1000).toFixed(1)}k`
			: `${sign}${n.toFixed(0)}`;
	};

	const deltas = Object.entries(agg.deltas);
	if (deltas.length === 0) return "(no baseline configured)";

	const header = `| Delta vs raw-truncate | ${deltas.map(([n]) => `**${n}**`).join(" | ")} |`;
	const sep = `|---|${deltas.map(() => "---").join("|")}|`;
	const rows = [
		["recall (median Δ)", ...deltas.map(([, d]) => pct(d.recall.median))],
		["density (median Δ)", ...deltas.map(([, d]) => `${d.density.median >= 0 ? "+" : ""}${d.density.median.toFixed(2)}`)],
		["precision (median Δ)", ...deltas.map(([, d]) => `${d.precision.median >= 0 ? "+" : ""}${d.precision.median.toFixed(2)}`)],
		["size (median Δ)", ...deltas.map(([, d]) => chars(d.size.median))],
	];

	return [
		"Paired per-session deltas (vs raw-truncate baseline):",
		"",
		header,
		sep,
		...rows.map((row) => `| ${row[0]} | ${row.slice(1).join(" | ")} |`),
	].join("\n");
};
