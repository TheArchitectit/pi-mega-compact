/**
 * dashboard-client/src/tabs/MaintenanceTab/DebugBundleCard.tsx — Debug Bundle card.
 *
 * Extracted from MaintenanceTab.tsx (delegate-shell split). Gather a diagnostic
 * bundle (events, config, schema health, store stats) and let the user copy or
 * download it for bug reports.
 */
import type React from "react";
import { useState, useCallback } from "react";
import type { DebugBundleResponse } from "@contracts";
import { fetchDebugBundle } from "../../api/client";

// ---------------------------------------------------------------------------
// Debug bundle card — gather diagnostic info for bug reports
// ---------------------------------------------------------------------------

export function DebugBundleCard(): React.ReactElement {
	const [bundle, setBundle] = useState<DebugBundleResponse | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [showJson, setShowJson] = useState(false);

	const gather = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await fetchDebugBundle();
			setBundle(res);
			setShowJson(true);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, []);

	const copyToClipboard = useCallback(() => {
		if (!bundle) return;
		const text = JSON.stringify(bundle, null, 2);
		void navigator.clipboard.writeText(text).catch(() => {});
	}, [bundle]);

	const downloadJson = useCallback(() => {
		if (!bundle) return;
		const text = JSON.stringify(bundle, null, 2);
		const blob = new Blob([text], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `mega-compact-debug-bundle-${bundle.builtAt}.json`;
		a.click();
		URL.revokeObjectURL(url);
	}, [bundle]);

	const criticalCount = bundle?.criticalEvents.length ?? 0;

	return (
		<div className="card">
			<div className="card-header">
				Debug Bundle
				{criticalCount > 0 && (
					<span className="text-warn" style={{ marginLeft: "1em" }}>
						{criticalCount} critical event{criticalCount !== 1 ? "s" : ""} found
					</span>
				)}
			</div>
			<div className="card-body">
				<p className="text-muted" style={{ marginBottom: "0.75em" }}>
					Gather a diagnostic bundle (recent events, config flags, schema health,
					store stats) to attach to a bug report. Critical/compaction events are
					highlighted.
				</p>
				<button onClick={gather} disabled={loading} style={{ marginRight: "0.5em" }}>
					{loading ? "Gathering…" : "Gather Debug Logs"}
				</button>
				{error && <div className="text-error">{error}</div>}
				{bundle && showJson && (
					<>
						<div style={{ marginTop: "0.75em", marginBottom: "0.5em" }}>
							<button onClick={copyToClipboard} style={{ marginRight: "0.5em" }}>
								Copy to clipboard
							</button>
							<button onClick={downloadJson}>Download JSON</button>
							<button
								onClick={() => setShowJson((v) => !v)}
								style={{ marginLeft: "0.5em" }}
							>
								{showJson ? "Hide" : "Show"}
							</button>
						</div>
						{criticalCount > 0 && (
							<div className="stat-section">
								<div className="stat-label text-warn">
									Critical events ({criticalCount})
								</div>
								<pre className="text-mono" style={{ maxHeight: "12em", overflow: "auto" }}>
									{JSON.stringify(bundle.criticalEvents, null, 2)}
								</pre>
							</div>
						)}
						<pre className="text-mono" style={{ maxHeight: "24em", overflow: "auto" }}>
							{JSON.stringify(bundle, null, 2)}
						</pre>
					</>
				)}
			</div>
		</div>
	);
}
