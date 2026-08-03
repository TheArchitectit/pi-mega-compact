/**
 * dashboard-client/src/components/PerfCards.tsx — 5 perf metric cards.
 *
 * Mirrors the old html.ts perf grid: model latency, throughput, process,
 * snapshot cost, and TUI lag proxy. Uses the existing perf-metric CSS
 * classes from repos-metrics.css plus metrics-extra.css for card headers.
 */

import type React from "react";
import type { PerfResponse } from "@contracts";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "../components/ui/card";

/** Format milliseconds (em-dash for null/undefined). */
function fmtMs(v: number | null | undefined): string {
	return v == null ? "\u2014" : v >= 100 ? `${Math.round(v)}ms` : `${v.toFixed(1)}ms`;
}

/** Format a number with fixed decimals (em-dash for null/non-number). */
function fmtNum(v: number | null | undefined, dec: number): string {
	return v == null || typeof v !== "number" ? "\u2014" : v.toFixed(dec);
}

/** Format a diag counter (em-dash for null). */
function fmtDiag(v: number | null | undefined): string {
	return v == null ? "\u2014" : String(v);
}

interface PerfCardsProps {
	perf: PerfResponse;
}

/** A single stat row inside a perf card. */
function Stat({ label, value }: { label: string; value: string }): React.ReactElement {
	return (
		<div className="flex items-baseline justify-between border-b border-border py-1 text-sm">
			<span className="text-xs text-muted-foreground">{label}</span>
			<span className="font-semibold">{value}</span>
		</div>
	);
}

/** Card wrapper with a title. */
function PerfCard({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
	return (
		<Card className="electric-hover">
			<CardHeader>
				<CardTitle>{title}</CardTitle>
			</CardHeader>
			<CardContent>{children}</CardContent>
		</Card>
	);
}

export function PerfCards({ perf }: PerfCardsProps): React.ReactElement {
	const cpuTxt = `${fmtNum(perf.cpu_user_ms.latest, 1)} / ${fmtNum(perf.cpu_sys_ms.latest, 1)} ms`;

	return (
		<div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
			<PerfCard title="Model latency">
				<Stat label="Turn p50" value={fmtMs(perf.turn_latency_ms.p50)} />
				<Stat label="Turn p95" value={fmtMs(perf.turn_latency_ms.p95)} />
				<Stat label="Provider p50" value={fmtMs(perf.provider_latency_ms.p50)} />
				<Stat label="Provider p95" value={fmtMs(perf.provider_latency_ms.p95)} />
			</PerfCard>

			<PerfCard title="Throughput">
				<Stat label="TPS (avg)" value={fmtNum(perf.tps.avg, 1)} />
				<Stat
					label="Cache hit %"
					value={`${fmtNum(perf.cache_hit_pct.avg, 1)}%`}
				/>
			</PerfCard>

			<PerfCard title="Process">
				<Stat label="RSS" value={`${fmtNum(perf.rss_mb.latest, 1)} MB`} />
				<Stat label="Heap" value={`${fmtNum(perf.heap_mb.latest, 1)} MB`} />
				<Stat label="CPU user / sys" value={cpuTxt} />
			</PerfCard>

			<PerfCard title="Snapshot cost">
				<Stat label="DB recompute p50" value={fmtMs(perf.db_recompute_ms.p50)} />
				<Stat label="DB recompute p95" value={fmtMs(perf.db_recompute_ms.p95)} />
				<Stat label="Disk write p50" value={fmtMs(perf.disk_write_ms.p50)} />
			</PerfCard>

			<PerfCard title="TUI lag proxy">
				<Stat label="Live-trim fires" value={fmtDiag(perf.diag?.liveTrimFires)} />
				<Stat label="Cache replays" value={fmtDiag(perf.diag?.liveTrimReplays)} />
				<Stat label="Fast-gate skips" value={fmtDiag(perf.diag?.ctxFastGate)} />
				<span className="text-xs text-muted-foreground">skip vs recompute vs replay cadence</span>
			</PerfCard>
		</div>
	);
}
