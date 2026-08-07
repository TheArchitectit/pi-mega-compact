/**
 * SetupTab/CustomEndpointSection.tsx — custom remote embedder endpoint section.
 *
 * Extracted from EmbedderSetup.tsx to respect the extensions/ 400-line soft limit.
 *
 * ENC-1a: an additive "API key (optional Bearer)" password input sits beside the
 * existing custom-URL input. The key is NEVER prefilled (the setup-status GET does
 * not echo it — only an "is set" boolean, embeddingApiKeySet) and it is only ever
 * sent up via the POST /api/setup-configure body. When the ENC-1a surface is
 * inactive (flag off, the server omits the new GET fields) the key input is hidden
 * and only the pre-existing URL row remains — byte-identical to the predecessor.
 */
import type React from "react";
import { useState } from "react";
import type { SetupConfigureResponse } from "@contracts";
import { styles } from "./EmbedderSetupStyles";

/** ENC-1a surfaced a successful custom-endpoint persistence on the card. */
const SAVED_NOTICE = "Saved; takes effect on next session start";

interface CustomEndpointSectionProps {
	customUrl: string;
	setCustomUrl: (v: string) => void;
	applyEmbedder: (
		embedder: "ollama" | "llama" | "trigram" | "custom" | "onnx",
		url?: string,
		apiKey?: string,
	) => void;
	configuring: string | null;
	/** ENC-1a surface active — true when the new setup-status fields are present. */
	inputEnabled: boolean;
	/** Server-reported "key is set" marker (the key itself is never returned). */
	apiKeySet: boolean;
	configureResult: SetupConfigureResponse | null;
	configureError: string | null;
}

export default function CustomEndpointSection({
	customUrl,
	setCustomUrl,
	applyEmbedder,
	configuring,
	inputEnabled,
	apiKeySet,
	configureResult,
	configureError,
}: CustomEndpointSectionProps): React.ReactElement {
	// The API key is intentionally local-only state: it always renders blank and
	// is never seeded from the persisted value (the server never returns it).
	const [customApiKey, setCustomApiKey] = useState("");

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
				{inputEnabled && (
					<input
						type="password"
						autoComplete="new-password"
						aria-label="API key (optional Bearer)"
						placeholder="API key (optional Bearer)"
						value={customApiKey}
						onChange={(e) => setCustomApiKey(e.target.value)}
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
				)}
				{inputEnabled && apiKeySet && (
					<span
						style={{
							fontSize: "0.75rem",
							color: "#81c784",
							border: "1px solid #2a4e2a",
							borderRadius: "4px",
							padding: "0.15rem 0.45rem",
						}}
					>
						API key saved
					</span>
				)}
				<button
					style={{ ...styles.button, opacity: customUrl ? 1 : 0.4 }}
					onClick={() => applyEmbedder("custom", customUrl, customApiKey)}
					disabled={!customUrl || configuring !== null}
				>
					{configuring === "custom" ? "Writing..." : "Use Custom URL"}
				</button>
			</div>
			{configureError !== null && (
				<p style={{ color: "#f44336", fontSize: "0.85rem", marginTop: "0.5rem" }}>
					Configure error: {configureError}
				</p>
			)}
			{configureResult !== null && configureResult.embedder === "custom" && (
				<div style={styles.warning}>{SAVED_NOTICE}</div>
			)}
			<div style={styles.warning}>
				<strong>Heads up:</strong> a remote endpoint receives the text you embed
				(it does NOT receive your full conversation — only the strings passed to
				<code> embed()</code> for recall/dedup). Verify the endpoint's privacy
				policy before use.
			</div>
		</div>
	);
}
