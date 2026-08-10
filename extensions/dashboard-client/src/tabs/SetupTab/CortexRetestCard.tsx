/**
 * SetupTab/CortexRetestCard.tsx — native onnxruntime qualification retest
 * card (ENC-2b).
 *
 * Pure render. When `SetupStatusResponse.nativeOrtInstalledVersion` is non-null
 * (the ENC-2a guide detected an install) AND `nativeOrtRetestResult` is non-null
 * (the retest ran), this card surfaces the qualification outcome: platform,
 * version, verdict badge, p95 latency, RSS, tested-at timestamp, and the
 * effective backend after the retest.
 *
 * NO client-side execution of the binding — the retest runs server-side. The
 * "Retest now" button POSTs {nativeOrtRetest: true} and then refreshes the poll.
 * Data comes exclusively from the existing /api/setup-status poll.
 */
import type React from "react";
import { useState, useCallback, useEffect } from "react";
import type { SetupStatusResponse } from "@contracts";
import { fetchSetupStatus, configureEmbedder } from "../../api/client";
import { styles } from "./CortexSetupStyles";

// The retest shape mirrors the server `RetestResult` interface; derived via
// indexed access from the exported response type so no contract file changes.
type RetestResult = NonNullable<SetupStatusResponse["nativeOrtRetestResult"]>;

const VERDICT_STYLE: Record<RetestResult["verdict"], React.CSSProperties> = {
	qualified: { ...styles.badge, background: "#1f3a2a", color: "#4caf50" },
	degraded: { ...styles.badge, background: "#3a2f00", color: "#ff9800" },
	failed: { ...styles.badge, background: "#3a1a1a", color: "#ff5252" },
};

export default function CortexRetestCard(): React.ReactElement {
	const [status, setStatus] = useState<SetupStatusResponse | null>(null);
	const [retesting, setRetesting] = useState(false);

	const loadStatus = useCallback(() => {
		fetchSetupStatus()
			.then(setStatus)
			.catch(() => {
				/* best-effort poll; hide card when unavailable */
			});
	}, []);

	useEffect(() => {
		loadStatus();
		const id = setInterval(loadStatus, 5000);
		return () => clearInterval(id);
	}, [loadStatus]);

	const onRetest = useCallback(() => {
		setRetesting(true);
		// `embedder: "trigram"` satisfies the required request field; the server
		// handles the additive nativeOrtRetest key BEFORE embedder validation, so
		// the value is never read on this path.
		configureEmbedder({ embedder: "trigram", nativeOrtRetest: true })
			.then(() => loadStatus())
			.finally(() => setRetesting(false));
	}, [loadStatus]);

	const installedVersion = status?.nativeOrtInstalledVersion ?? null;
	const retest = status?.nativeOrtRetestResult ?? null;
	const effectiveBackend = status?.nativeOrtBackendEffective ?? null;
	if (installedVersion === null || retest === null) return <></>;

	return (
		<div style={styles.section}>
			<h3 style={styles.sectionTitle}>Encoder Runtime Retest</h3>
			<div style={styles.row}>
				<span style={styles.label}>Platform:</span>
				<span style={styles.value}>{retest.platform}</span>
			</div>
			<div style={styles.row}>
				<span style={styles.label}>Version:</span>
				<span style={styles.value}>{retest.version}</span>
			</div>
			<div style={styles.row}>
				<span style={styles.label}>Verdict:</span>
				<span style={VERDICT_STYLE[retest.verdict]}>{retest.verdict}</span>
			</div>
			<div style={styles.row}>
				<span style={styles.label}>p95 latency:</span>
				<span style={styles.value}>{retest.p95Ms} ms</span>
			</div>
			<div style={styles.row}>
				<span style={styles.label}>RSS:</span>
				<span style={styles.value}>{retest.rssMiB} MiB</span>
			</div>
			<div style={styles.row}>
				<span style={styles.label}>Tested:</span>
				<span style={styles.value}>
					{new Date(retest.testedAt).toISOString()}
				</span>
			</div>
			{effectiveBackend !== null && (
				<div style={styles.row}>
					<span style={styles.label}>Effective backend (measured):</span>
					<span style={styles.value}>{effectiveBackend}</span>
				</div>
			)}
			{effectiveBackend !== null &&
				status?.encoderBackend != null &&
				effectiveBackend !== status.encoderBackend && (
					<p style={{ fontSize: "0.8rem", color: "#a0a0c0", marginTop: "0.25rem" }}>
						Measured backend differs from the selected backend above: the retest
						benchmarked the native binding and found it over the p95/RSS gates, so
						the runtime is demoted to <strong>{effectiveBackend}</strong> despite
						the binding being installed.
					</p>
				)}
			<button type="button" onClick={onRetest} disabled={retesting}>
				{retesting ? "Retesting…" : "Retest now"}
			</button>
		</div>
	);
}
