/**
 * SetupTab/CustomEndpointSection.tsx — custom remote embedder endpoint section.
 *
 * Extracted from EmbedderSetup.tsx to respect the extensions/ 400-line soft limit.
 */
import type React from "react";
import { styles } from "./EmbedderSetupStyles";

interface CustomEndpointSectionProps {
	customUrl: string;
	setCustomUrl: (v: string) => void;
	applyEmbedder: (embedder: "ollama" | "llama" | "trigram" | "custom" | "onnx", url?: string) => void;
	configuring: string | null;
}

export default function CustomEndpointSection({
	customUrl,
	setCustomUrl,
	applyEmbedder,
	configuring,
}: CustomEndpointSectionProps): React.ReactElement {
	return (
		<div style={styles.section}>
			<h3 style={styles.sectionTitle}>Custom Endpoint (remote / third-party)</h3>
			<p style={{ fontSize: "0.85rem", color: "#a0a0c0", marginTop: 0 }}>
				Point at any OpenAI-compatible embeddings API or hosted endpoint.
				This opts in to a non-loopback connection (sets{" "}
				<code>MEGACOMPACT_ALLOW_REMOTE_EMBEDDER=1</code>) — your prompts'
				embedding requests will be sent to the URL you enter. Default is
				loopback-only.
			</p>
			<div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
				<input
					type="url"
					placeholder="https://api.example.com/v1/embeddings"
					value={customUrl}
					onChange={(e) => setCustomUrl(e.target.value)}
					style={{
						flex: "1 1 300px",
						background: "#12122a",
						color: "#e0e0e0",
						border: "1px solid #2a2a4e",
						borderRadius: "6px",
						padding: "0.4rem 0.6rem",
						fontSize: "0.85rem",
						fontFamily: "monospace",
					}}
				/>
				<button
					style={{ ...styles.button, opacity: customUrl ? 1 : 0.4 }}
					onClick={() => applyEmbedder("custom", customUrl)}
					disabled={!customUrl || configuring !== null}
				>
					{configuring === "custom" ? "Writing..." : "Use Custom URL"}
				</button>
			</div>
			<div style={styles.warning}>
				<strong>Heads up:</strong> a remote endpoint receives the text you embed
				(it does NOT receive your full conversation — only the strings passed to
				<code> embed()</code> for recall/dedup). Verify the endpoint's privacy
				policy before use.
			</div>
		</div>
	);
}
