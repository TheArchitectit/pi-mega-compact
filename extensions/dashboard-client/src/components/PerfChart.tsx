/**
 * dashboard-client/src/components/PerfChart.tsx — perf stat chart.
 *
 * The /api/perf endpoint returns rolling-window aggregates (not time-series),
 * so this renders a stat-card "chart": p50/p95 latency bars, TPS, cache hit %,
 * db recompute + disk write. Each metric shows a normalized bar + numeric.
 */

import type React from "react";
import type { PerfResponse } from "@contracts";

export interface PerfChartProps {
  perf: PerfResponse;
}

function fmtMs(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n.toFixed(0)}ms`;
}

interface BarProps {
  /** Current value. */
  value: number;
  /** Value that represents 100% bar fill (the "max" reference). */
  max: number;
  /** Color class. */
  colorClass: string;
}

function Bar({ value, max, colorClass }: BarProps): React.ReactElement {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="perf-bar-track">
      <div className={`perf-bar-fill ${colorClass}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function PerfChart({ perf }: PerfChartProps): React.ReactElement {
  // Reference maxes: p95 is the upper bound for latency bars; rates scale to a
  // reasonable reference (tok/s) so bars are visually meaningful even with
  // small samples. cache_hit_pct is already 0-100.
  const latencyMax = Math.max(perf.turn_latency_ms.p95, perf.provider_latency_ms.p95, 1);
  const tpsRef = Math.max(perf.tps.avg, 1);

  return (
    <div className="perf-chart">
      <div className="perf-header">
        <h3>Performance</h3>
        <span className="perf-window">{perf.windowMinutes}min window · {perf.sampleCount} samples</span>
      </div>
      <div className="perf-grid">
        <div className="perf-metric">
          <span className="perf-label">Turn latency p50 / p95</span>
          <span className="perf-value">{fmtMs(perf.turn_latency_ms.p50)} / {fmtMs(perf.turn_latency_ms.p95)}</span>
          <Bar value={perf.turn_latency_ms.p95} max={latencyMax} colorClass="perf-blue" />
        </div>
        <div className="perf-metric">
          <span className="perf-label">Provider latency p50 / p95</span>
          <span className="perf-value">{fmtMs(perf.provider_latency_ms.p50)} / {fmtMs(perf.provider_latency_ms.p95)}</span>
          <Bar value={perf.provider_latency_ms.p95} max={latencyMax} colorClass="perf-purple" />
        </div>
        <div className="perf-metric">
          <span className="perf-label">Tokens/sec (avg)</span>
          <span className="perf-value">{perf.tps.avg.toFixed(1)}</span>
          <Bar value={perf.tps.avg} max={tpsRef} colorClass="perf-green" />
        </div>
        <div className="perf-metric">
          <span className="perf-label">Cache hit (avg / latest)</span>
          <span className="perf-value">{perf.cache_hit_pct.avg.toFixed(1)}% / {perf.cache_hit_pct.latest.toFixed(1)}%</span>
          <Bar value={perf.cache_hit_pct.avg} max={100} colorClass="perf-green" />
        </div>
        <div className="perf-metric">
          <span className="perf-label">DB recompute p95</span>
          <span className="perf-value">{fmtMs(perf.db_recompute_ms.p95)}</span>
          <Bar value={perf.db_recompute_ms.p95} max={latencyMax} colorClass="perf-yellow" />
        </div>
        <div className="perf-metric">
          <span className="perf-label">Disk write p95</span>
          <span className="perf-value">{fmtMs(perf.disk_write_ms.p95)}</span>
          <Bar value={perf.disk_write_ms.p95} max={latencyMax} colorClass="perf-yellow" />
        </div>
      </div>
      <div className="perf-resources">
        <div className="perf-metric">
          <span className="perf-label">RSS</span>
          <span className="perf-value">{perf.rss_mb.latest.toFixed(0)} MB</span>
        </div>
        <div className="perf-metric">
          <span className="perf-label">Heap</span>
          <span className="perf-value">{perf.heap_mb.latest.toFixed(0)} MB</span>
        </div>
        <div className="perf-metric">
          <span className="perf-label">CPU user</span>
          <span className="perf-value">{(perf.cpu_user_ms.latest / 1000).toFixed(1)}s</span>
        </div>
        <div className="perf-metric">
          <span className="perf-label">CPU sys</span>
          <span className="perf-value">{(perf.cpu_sys_ms.latest / 1000).toFixed(1)}s</span>
        </div>
      </div>
      {perf.diag && (
        <div className="perf-diag">
          <span className="perf-label">Fast-gate fires: {perf.diag.ctxFastGate}</span>
          <span className="perf-label">Live trim fires: {perf.diag.liveTrimFires}</span>
          <span className="perf-label">Live trim replays: {perf.diag.liveTrimReplays}</span>
        </div>
      )}
    </div>
  );
}
