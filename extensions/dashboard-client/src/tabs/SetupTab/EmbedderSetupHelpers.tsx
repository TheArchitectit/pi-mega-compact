/**
 * SetupTab/EmbedderSetupHelpers.tsx — extracted render helpers for EmbedderSetup.
 *
 * Split from EmbedderSetup.tsx to respect the extensions/ 400-line soft limit
 * (ENC-1a pushed the embedder card over its cap, so the helpers were extracted).
 */
import type React from "react";
import type { SetupStatusResponse } from "@contracts";
import { styles } from "./EmbedderSetupStyles";

/** Human label for an embedder identifier. */
export function embedderLabel(e: string): string {
	switch (e) {
		case "trigram":
			return "TrigramEmbedder (heuristic, default)";
		case "http":
			return "HTTP Embedder (BYO localhost)";
		case "minilm":
			return "MiniLM (experimental)";
		default:
			return "Unknown";
	}
}

/** Warn when the active embedder is the heuristic trigram default. */
export function trigramWarning(status: SetupStatusResponse | null): React.ReactElement | null {
	if (status?.currentEmbedder !== "trigram") return null;
	return (
		<div style={styles.warning}>
			<strong>Note:</strong> TrigramEmbedder is a heuristic-strength default
			embedder. It works without any setup but recall quality may be lower
			than a dedicated embedding backend. If you notice poor recall results,
			consider installing Ollama and running the{" "}
			<code>/megasetup</code> command, or set{" "}
			<code>MEGACOMPACT_EMBEDDING_URL</code> to point at your own localhost
			embedding server.
		</div>
	);
}

/** Installed / not-found badge dot for a detection row. */
export function detectBadge(installed: boolean): React.ReactElement {
	const bg = installed ? "#1a5a1a" : "#3a1a1a";
	const color = installed ? "#4caf50" : "#f44336";
	return (
		<span style={{ ...styles.badge, background: bg, color }}>
			{installed ? "Detected" : "Not found"}
		</span>
	);
}

/** The "Current Embedder Configuration" readout block. */
export function CurrentConfigSection({
	status,
	statusError,
}: {
	status: SetupStatusResponse | null;
	statusError: string | null;
}): React.ReactElement {
	return (
		<div style={styles.section}>
			<h3 style={styles.sectionTitle}>Current Embedder Configuration</h3>
			{statusError && (
				<p style={{ color: "#f44336", fontSize: "0.85rem" }}>
					Error: {statusError}
				</p>
			)}
			{status && (
				<>
					<div style={styles.row}>
						<span style={styles.label}>Active Embedder:</span>
						<span style={styles.value}>
							{embedderLabel(status.currentEmbedder)}
						</span>
					</div>
					{"configuredEmbedder" in status && status.configuredEmbedder !== status.currentEmbedder && (
						<div style={styles.warning}>
							<strong>Configured but not active:</strong>{" "}
							{embedderLabel(status.configuredEmbedder)} is configured in
							.mega-compact.env but not yet loaded.{" "}
							<strong>Restart pi</strong> to activate it.
							{status.configuredUrl && (
								<> ({status.configuredUrl})</>
							)}
						</div>
					)}
					{"restartRequired" in status && status.restartRequired && (
						<div style={{ ...styles.row, color: "#ff9800" }}>
							<span style={styles.label}>Status:</span>
							<span style={styles.value}>
								Restart required to activate the configured embedder
							</span>
						</div>
					)}
					<div style={styles.row}>
						<span style={styles.label}>Embedding URL:</span>
						<span style={styles.value}>
							{status.embeddingUrl ?? (
								<span style={{ color: "#888" }}>not set</span>
							)}
						</span>
					</div>
					<div style={styles.row}>
						<span style={styles.label}>Embed Cache:</span>
						<span style={styles.value}>
							{status.embedCache ?? (
								<span style={{ color: "#888" }}>not set</span>
							)}
						</span>
					</div>
					<div style={styles.row}>
						<span style={styles.label}>MiniLM:</span>
						<span style={styles.value}>{status.minilm ? "enabled" : "disabled"}</span>
					</div>
					{trigramWarning(status)}
				</>
			)}
			{!status && !statusError && (
				<p style={{ color: "#888", fontSize: "0.85rem" }}>
					Loading configuration...
				</p>
			)}
		</div>
	);
}
