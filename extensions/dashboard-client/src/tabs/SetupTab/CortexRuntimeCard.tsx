/**
 * SetupTab/CortexRuntimeCard.tsx — Encoder Runtime selection card (ENC-1b).
 *
 * Rendered on the Setup Cortex sub-tab. Reads the ENC-1b Cortex trio from the
 * SAME /api/setup-status endpoint (and /api/setup-configure writer) the
 * Embedder sub-tab uses — a single endpoint, no /api/setup-cortex-status read.
 *
 * The native opt-in toggle POSTs `encoderNativeOptIn`; the effective backend
 * (`wasm` | `native`) and any demotion reason are surfaced reader-only from the
 * status — no selection/install logic is reimplemented on the client.
 *
 * PREVENT-PI-004: all data comes from localhost dashboard API endpoints.
 */
import type React from "react";
import { useState, useEffect, useCallback } from "react";
import type { SetupStatusResponse } from "@contracts";
import { fetchSetupStatus, configureEmbedder } from "../../api/client";
import { styles } from "./CortexRuntimeCardStyles";

export default function CortexRuntimeCard(): React.ReactElement {
	const [status, setStatus] = useState<SetupStatusResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const loadStatus = useCallback(() => {
		fetchSetupStatus()
			.then(setStatus)
			.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
	}, []);

	useEffect(() => {
		loadStatus();
	}, [loadStatus]);

	// Poll status every 5s — the same cadence as the Embedder sub-tab so the
	// runtime card reflects persisted opt-in + effective backend changes live.
	useEffect(() => {
		const id = setInterval(loadStatus, 5000);
		return () => clearInterval(id);
	}, [loadStatus]);

	// The card is only meaningful when the ENC-1b surface is active (the server
	// carries the Cortex trio). Flag off → the keys are absent → hide the card.
	const enabled = status !== null && "encoderNativeOptIn" in status;

	const toggleNative = useCallback(
		(next: boolean) => {
			setSaving(true);
			setError(null);
			configureEmbedder({
				embedder: "custom",
				url: status?.embeddingEndpointUrl ?? undefined,
				encoderNativeOptIn: next,
			})
				.then(() => {
					setSaving(false);
					loadStatus();
				})
				.catch((e: unknown) => {
					setError(e instanceof Error ? e.message : String(e));
					setSaving(false);
				});
		},
		[status, loadStatus],
	);

	if (!enabled) return <></>;

	const backend = status?.encoderBackend ?? "wasm";
	const demotion = status?.encoderDemotionReason ?? null;

	return (
		<div style={styles.section}>
			<h3 style={styles.sectionTitle}>Encoder Runtime</h3>
			<p style={styles.subtitle}>ONNX backend selection</p>
			<div style={styles.toggleRow}>
				<input
					type="checkbox"
					checked={status?.encoderNativeOptIn === true}
					onChange={(e) => toggleNative(e.target.checked)}
					disabled={saving}
					aria-label="Native ONNX runtime (onnxruntime-node)"
				/>
				<label>Native ONNX runtime (onnxruntime-node)</label>
				{saving && (
					<span style={{ fontSize: "0.8rem", color: "#a0a0c0" }}>saving...</span>
				)}
			</div>
			<div style={styles.row}>
				<span style={styles.label}>Effective backend:</span>
				<span style={styles.value}>{backend}</span>
			</div>
			{demotion !== null && (
				<div style={styles.warning}>
					<strong>Demoted:</strong> {demotion}
				</div>
			)}
			{error && (
				<p style={{ color: "#f44336", fontSize: "0.85rem" }}>Error: {error}</p>
			)}
		</div>
	);
}
