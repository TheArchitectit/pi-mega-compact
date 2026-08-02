/**
 * dashboard-client/src/tabs/MaintenanceTab/HealthMitigationCard.tsx — Health
 * Mitigation card.
 *
 * Extracted from MaintenanceTab.tsx (delegate-shell split). Toggles auto-
 * mitigation for degraded context (forced compaction / prefix break).
 */
import type React from "react";
import { useState, useCallback, useEffect } from "react";

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
		<div className="stat-section maintenance-card">
			<div className="stat-label">Context Health Mitigation</div>
			{loading ? (
				<p className="repo-none">Loading…</p>
			) : (
				<>
					<div className="health-mitigate-row">
						<label className="health-mitigate-toggle">
							<input
								type="checkbox"
								checked={mitigate}
								onChange={toggle}
								disabled={saving}
							/>
							<span>Auto-mitigation {mitigate ? "ON" : "OFF"}</span>
						</label>
					</div>
					<div className="health-mitigate-info">
						<p>
							When <strong>ON</strong>, the extension automatically intervenes when
							context health degrades:
						</p>
						<ul>
							<li><strong>Forced compaction</strong> — when the composite health score
							drops below 0.4 (severe drift or garbled output), a compaction is
							triggered to flush the degraded context and rebuild from clean
							checkpoints, even if the context window isn&apos;t full.</li>
							<li><strong>Prefix break</strong> — when KV cache poison is detected
							(score &lt; 0.3), the cached prefix is invalidated to force a cache
							miss on the next turn, bypassing the corrupted KV state.</li>
						</ul>
						<p className="health-mitigate-warning">
							WARNING: both interventions have costs — forced compaction discards
							live context, and prefix breaks kill cache savings. Only enable when
							you&apos;re seeing degraded output (garbled text, hallucinations,
							loss of coherence) and the Health tab confirms low scores.
						</p>
						<p>
							Also settable via env var: <code>MEGACOMPACT_CONTEXT_HEALTH_MITIGATE=1</code>.
							The dashboard toggle persists to the store and takes precedence.
						</p>
						{error && <p className="health-mitigate-error">Error: {error}</p>}
					</div>
				</>
			)}
		</div>
	);
}
