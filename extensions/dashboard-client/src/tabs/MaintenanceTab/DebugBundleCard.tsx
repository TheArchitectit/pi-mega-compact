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
import { Button } from "../../components/ui/button";
import {
	Card,
	CardHeader,
	CardTitle,
	CardContent,
} from "../../components/ui/card";

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
		<Card>
			<CardHeader className="flex-row items-center justify-between space-y-0">
				<CardTitle>Debug Bundle</CardTitle>
				{criticalCount > 0 && (
					<span className="text-xs text-amber-400">
						{criticalCount} critical event{criticalCount !== 1 ? "s" : ""} found
					</span>
				)}
			</CardHeader>
			<CardContent>
				<p className="mb-3 text-sm text-muted-foreground">
					Gather a diagnostic bundle (recent events, config flags, schema health,
					store stats) to attach to a bug report. Critical/compaction events are
					highlighted.
				</p>
				<Button type="button" variant="glass" onClick={gather} disabled={loading}>
					{loading ? "Gathering…" : "Gather Debug Logs"}
				</Button>
				{error && <div className="mt-2 text-sm text-red-400">{error}</div>}
				{bundle && showJson && (
					<>
						<div className="mb-2 mt-3 flex gap-2">
							<Button type="button" variant="outline" size="sm" onClick={copyToClipboard}>
								Copy to clipboard
							</Button>
							<Button type="button" variant="outline" size="sm" onClick={downloadJson}>
								Download JSON
							</Button>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => setShowJson((v) => !v)}
							>
								{showJson ? "Hide" : "Show"}
							</Button>
						</div>
						{criticalCount > 0 && (
							<div className="mt-3">
								<div className="text-xs font-semibold text-amber-400">
									Critical events ({criticalCount})
								</div>
								<pre className="max-h-48 overflow-auto rounded-md border border-border/60 bg-bg-elevated/40 p-3 font-mono text-xs">
									{JSON.stringify(bundle.criticalEvents, null, 2)}
								</pre>
							</div>
						)}
						<pre className="mt-3 max-h-96 overflow-auto rounded-md border border-border/60 bg-bg-elevated/40 p-3 font-mono text-xs">
							{JSON.stringify(bundle, null, 2)}
						</pre>
					</>
				)}
			</CardContent>
		</Card>
	);
}
