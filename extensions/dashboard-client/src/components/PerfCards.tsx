/**
 * dashboard-client/src/components/PerfCards.tsx — 5 perf metric cards.
 *
 * Mirrors the old html.ts perf grid: model latency, throughput, process,
 * snapshot cost, and TUI lag proxy. Uses the existing perf-metric CSS
 * classes from repos-metrics.css plus metrics-extra.css for card headers.
 */

import type React from "react";
import type { PerfResponse } from "@contracts";

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
		<div className="perf-metric">
			<span className="perf-label">{label}</span>
			<span className="perf-value">{value}</span>
		</div>
	);
}

/** Card wrapper with a title. */
function Card({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
	return (
		<div className="perf-card">
			<h3 className="perf-card-title">{title}</h3>
			<div className="perf-card-body">{children}</div>
		</div>
	);
}

export function PerfCards({ perf }: PerfCardsProps): React.ReactElement {
	const cpuTxt = `${fmtNum(perf.cpu_user_ms.latest, 1)} / ${fmtNum(perf.cpu_sys_ms.latest, 1)} ms`;

	return (
		<div className="perf-cards-grid">
			<Card title="Model latency">
				<Stat label="Turn p50" value={fmtMs(perf.turn_latency_ms.p50)} />
				<Stat label="Turn p95" value={fmtMs(perf.turn_latency_ms.p95)} />
				<Stat label="Provider p50" value={fmtMs(perf.provider_latency_ms.p50)} />
				<Stat label="Provider p95" value={fmtMs(perf.provider_latency_ms.p95)} />
			</Card>

			<Card title="Throughput">
				<Stat label="TPS (avg)" value={fmtNum(perf.tps.avg, 1)} />
				<Stat
					label="Cache hit %"
					value={`${fmtNum(perf.cache_hit_pct.avg, 1)}%`}
				/>
			</Card>

			<Card title="Process">
				<Stat label="RSS" value={`${fmtNum(perf.rss_mb.latest, 1)} MB`} />
				<Stat label="Heap" value={`${fmtNum(perf.heap_mb.latest, 1)} MB`} />
				<Stat label="CPU user / sys" value={cpuTxt} />
			</Card>

			<Card title="Snapshot cost">
				<Stat label="DB recompute p50" value={fmtMs(perf.db_recompute_ms.p50)} />
				<Stat label="DB recompute p95" value={fmtMs(perf.db_recompute_ms.p95)} />
				<Stat label="Disk write p50" value={fmtMs(perf.disk_write_ms.p50)} />
			</Card>

			<Card title="TUI lag proxy">
				<Stat label="Live-trim fires" value={fmtDiag(perf.diag?.liveTrimFires)} />
				<Stat label="Cache replays" value={fmtDiag(perf.diag?.liveTrimReplays)} />
				<Stat label="Fast-gate skips" value={fmtDiag(perf.diag?.ctxFastGate)} />
				<span className="perf-card-note">skip vs recompute vs replay cadence</span>
			</Card>
		</div>
	);
}
