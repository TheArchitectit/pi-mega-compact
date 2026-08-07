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
