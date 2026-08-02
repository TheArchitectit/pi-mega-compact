/**
 * HealthTab.tsx — Context Health dashboard tab.
 * Shows composite health gauge, sparkline trend, sub-score bars,
 * alerts, and per-model comparison. Polls /api/context-health every 5s.
 */

import { useState, useEffect, useCallback } from "react";
import { fetchContextHealth, type ContextHealthResponse } from "../api/health";

function healthColor(score: number): string {
	if (score > 0.8) return "#4ade80";
	if (score >= 0.5) return "#facc15";
	return "#f87171";
}

function HealthGauge({ score }: { score: number }): React.ReactElement {
	const r = 70;
	const circ = 2 * Math.PI * r;
	const offset = circ * (1 - Math.max(0, Math.min(1, score)));
	const color = healthColor(score);
	return (
		<div className="health-gauge-wrap">
			<svg width="180" height="180" viewBox="0 0 180 180">
				<circle cx="90" cy="90" r={r} fill="none" stroke="#1e293b" strokeWidth="14" />
				<circle
					cx="90"
					cy="90"
					r={r}
					fill="none"
					stroke={color}
					strokeWidth="14"
					strokeDasharray={circ}
					strokeDashoffset={offset}
					strokeLinecap="round"
					transform="rotate(-90 90 90)"
					style={{ transition: "stroke-dashoffset 0.5s ease" }}
				/>
				<text x="90" y="85" textAnchor="middle" fontSize="32" fontWeight="bold" fill={color}>
					{(score * 100).toFixed(0)}
				</text>
				<text x="90" y="108" textAnchor="middle" fontSize="14" fill="#94a3b8">/ 100</text>
			</svg>
			<div className="health-gauge-label">Context Health</div>
		</div>
	);
}

function HealthSparkline({ trend }: { trend: number[] }): React.ReactElement {
	if (trend.length < 2) return <div className="health-spark-empty">No trend data yet</div>;
	const w = 400;
	const h = 60;
	const max = 1;
	const min = 0;
	const pts = trend.map((v, i) => {
		const x = (i / (trend.length - 1)) * w;
		const y = h - ((v - min) / (max - min)) * h;
		return `${x.toFixed(1)},${y.toFixed(1)}`;
	});
	const last = trend[trend.length - 1];
	return (
		<svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="health-spark">
			<polyline points={pts.join(" ")} fill="none" stroke={healthColor(last)} strokeWidth="2" />
		</svg>
	);
}

function SubScoreBar({ label, value }: { label: string; value: number }): React.ReactElement {
	return (
		<div className="health-subscore">
			<span className="health-subscore-label">{label}</span>
			<div className="health-subscore-bar">
				<div
					className="health-subscore-fill"
					style={{ width: `${value * 100}%`, background: healthColor(value) }}
				/>
			</div>
			<span className="health-subscore-val">{(value * 100).toFixed(0)}%</span>
		</div>
	);
}

export default function HealthTab(): React.ReactElement {
	const [data, setData] = useState<ContextHealthResponse | null>(null);
	const [err, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	const poll = useCallback(() => {
		fetchContextHealth()
			.then(setData)
			.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
			.finally(() => setLoading(false));
	}, []);

	useEffect(() => {
		poll();
		const id = setInterval(poll, 5000);
		return () => clearInterval(id);
	}, [poll]);

	if (loading && !data) return <div className="health-loading">Loading health data…</div>;
	if (err && !data) return <div className="health-error">Error: {err}</div>;
	if (!data) return <div className="health-empty">No health data available.</div>;

	const latest = data.latest;
	const composite = latest?.composite ?? 0;

	return (
		<div className="health-tab">
			<div className="health-top-row">
				<HealthGauge score={composite} />
				<div className="health-subscores">
					<h3>Sub-Scores</h3>
					<SubScoreBar label="Drift" value={latest?.driftScore ?? 0} />
					<SubScoreBar label="Output Quality" value={latest?.outputQuality ?? 0} />
					<SubScoreBar label="Error Rate" value={latest?.errorScore ?? 0} />
					<SubScoreBar label="Cache Health" value={latest?.cacheHealth ?? 0} />
					<SubScoreBar label="Cache Poison" value={latest?.cachePoison ?? 0} />
				</div>
			</div>

			<div className="health-trend-section">
				<h3>Health Trend (last {data.trend.length} turns)</h3>
				<HealthSparkline trend={data.trend} />
			</div>

			{data.alerts.length > 0 && (
				<div className="health-alerts">
					<h3>Recent Alerts ({data.alerts.length})</h3>
					<div className="health-alert-list">
						{data.alerts.slice(-10).map((a) => (
							<div key={`${a.ts}-${a.turnIndex}`} className="health-alert-row">
								<span className="health-alert-time">{new Date(a.ts).toLocaleTimeString()}</span>
								<span className="health-alert-model">{a.modelId ?? "(unknown)"}</span>
								<span className="health-alert-score" style={{ color: healthColor(a.composite) }}>
									{(a.composite * 100).toFixed(0)}
								</span>
								{a.cachePoison < 0.3 && <span className="health-alert-tag">CACHE POISON</span>}
							</div>
						))}
					</div>
				</div>
			)}

			{data.perModel.length > 0 && (
				<div className="health-per-model">
					<h3>Health by Model</h3>
					<table className="health-model-table">
						<thead><tr><th>Model</th><th>Avg Health</th><th>Samples</th></tr></thead>
						<tbody>
							{data.perModel.map((m) => (
								<tr key={m.modelId}>
									<td>{m.modelId}</td>
									<td style={{ color: healthColor(m.avgComposite) }}>
										{(m.avgComposite * 100).toFixed(0)}%
									</td>
									<td>{m.sampleCount}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
