/**
 * dashboard-client/src/tabs/MaintenanceTab/HealthMitigationCard.tsx — Health
 * Mitigation card.
 *
 * Extracted from MaintenanceTab.tsx (delegate-shell split). Toggles auto-
 * mitigation for degraded context (forced compaction / prefix break).
 */
import type React from "react";
import { useState, useCallback, useEffect } from "react";
import { Switch } from "../../components/ui/switch";
import {
	Card,
	CardHeader,
	CardTitle,
	CardContent,
} from "../../components/ui/card";

// ---------------------------------------------------------------------------
// Health Mitigation card — toggle auto-mitigation for degraded context
// ---------------------------------------------------------------------------

export function HealthMitigationCard(): React.ReactElement {
	const [mitigate, setMitigate] = useState(false);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const { fetchHealthSettings } = await import("../../api/health");
			const s = await fetchHealthSettings();
			setMitigate(s.mitigate);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => { void load(); }, [load]);

	const toggle = useCallback(async () => {
		setSaving(true);
		setError(null);
		try {
			const { setHealthMitigate } = await import("../../api/health");
			const next = !mitigate;
			await setHealthMitigate(next);
			setMitigate(next);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	}, [mitigate]);

	return (
		<Card>
			<CardHeader>
				<CardTitle>Context Health Mitigation</CardTitle>
			</CardHeader>
			<CardContent>
				{loading ? (
					<p className="text-sm text-muted-foreground">Loading…</p>
				) : (
					<>
						<div className="flex items-center gap-2">
							<Switch
								checked={mitigate}
								onCheckedChange={toggle}
								disabled={saving}
								aria-label="Context health auto-mitigation"
							/>
							<span className="text-sm">
								Auto-mitigation {mitigate ? "ON" : "OFF"}
							</span>
						</div>
						<div className="mt-3 space-y-2 text-sm">
							<p>
								When <strong>ON</strong>, the extension automatically intervenes
								when context health degrades:
							</p>
							<ul className="list-disc space-y-1 pl-5">
								<li>
									<strong>Forced compaction</strong> — when the composite health
									score drops below 0.4 (severe drift or garbled output), a
									compaction is triggered to flush the degraded context and
									rebuild from clean checkpoints, even if the context window
									isn&apos;t full.
								</li>
								<li>
									<strong>Prefix break</strong> — when KV cache poison is
									detected (score &lt; 0.3), the cached prefix is invalidated to
									force a cache miss on the next turn, bypassing the corrupted KV
									state.
								</li>
							</ul>
							<p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-amber-400">
								WARNING: both interventions have costs — forced compaction discards
								live context, and prefix breaks kill cache savings. Only enable
								when you&apos;re seeing degraded output (garbled text,
								hallucinations, loss of coherence) and the Health tab confirms low
								scores.
							</p>
							<p className="text-muted-foreground">
								Also settable via env var:{" "}
								<code>MEGACOMPACT_CONTEXT_HEALTH_MITIGATE=1</code>. The dashboard
								toggle persists to the store and takes precedence.
							</p>
							{error && <p className="text-sm text-red-400">Error: {error}</p>}
						</div>
					</>
				)}
			</CardContent>
		</Card>
	);
}
