/**
 * SetupTab/EmbedderHealthCard.tsx — embedder health probe card (Part A).
 *
 * Round-trips a test embed through the active embedder and shows ✓ working /
 * ✗ unreachable + latency + dimensions. Polls every 30s.
 */
import type React from "react";
import { useState, useEffect, useCallback } from "react";
import type { EmbedderHealthResponse } from "@contracts";
import { fetchEmbedderHealth } from "../../api/client";

const styles: Record<string, React.CSSProperties> = {
	section: {
		background: "#1a1a2e",
		borderRadius: "8px",
		padding: "1rem",
		marginBottom: "1rem",
		border: "1px solid #2a2a4e",
	},
	sectionTitle: {
		fontSize: "1.1rem",
		fontWeight: 700,
		marginTop: 0,
		marginBottom: "0.75rem",
		color: "#e0e0e0",
		borderBottom: "1px solid #333",
		paddingBottom: "0.5rem",
	},
	label: { fontWeight: 600, color: "#a0a0c0", marginRight: "0.5rem" },
	value: { color: "#e0e0e0" },
	row: { marginBottom: "0.4rem", fontSize: "0.9rem" },
};

export default function EmbedderHealthCard(): React.ReactElement {
	const [health, setHealth] = useState<EmbedderHealthResponse | null>(null);
	const [error, setError] = useState<string | null>(null);

	const loadHealth = useCallback(() => {
		fetchEmbedderHealth()
			.then(setHealth)
			.catch((e: unknown) =>
				setError(e instanceof Error ? e.message : String(e)),
			);
	}, []);

	useEffect(() => {
		loadHealth();
	}, [loadHealth]);

	// Poll health every 30s
	useEffect(() => {
		const id = setInterval(loadHealth, 30000);
		return () => clearInterval(id);
	}, [loadHealth]);

	const ok = health?.status === "ok";
	const statusText =
		health?.status === "ok"
			? "Working"
			: health?.status === "unreachable"
				? "Unreachable"
				: "Error";
	const color = ok ? "#4caf50" : "#f44336";
	const icon = ok ? "✓" : "✗";

	return (
		<div style={styles.section}>
			<h3 style={styles.sectionTitle}>Embedder Health</h3>
			{error && (
				<p style={{ color: "#f44336", fontSize: "0.85rem" }}>
					Error: {error}
				</p>
			)}
			{!health && !error && (
				<p style={{ color: "#888", fontSize: "0.85rem" }}>
					Probing embedder...
				</p>
			)}
			{health && (
				<>
					<div style={styles.row}>
						<span style={{ ...styles.label, color: `${color}` }}>
							{icon} {statusText}:
						</span>
						<span style={styles.value}>{health.dim} dims</span>
						{health.latencyMs !== undefined && (
							<span style={{ color: "#a0a0c0", marginLeft: "0.5rem" }}>
								({health.latencyMs.toFixed(1)} ms)
							</span>
						)}
					</div>
					<div style={styles.row}>
						<span style={styles.label}>Endpoint:</span>
						<span style={styles.value}>
							{health.url ?? (
								<span style={{ color: "#888" }}>built-in (no URL)</span>
							)}
						</span>
					</div>
					{health.error && (
						<p style={{ color: "#f44336", fontSize: "0.85rem" }}>
							{health.error}
						</p>
					)}
				</>
			)}
		</div>
	);
}
