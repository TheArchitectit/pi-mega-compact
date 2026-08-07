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
		dim?: string,
		headers?: string,
		allowRemote?: boolean,
	) => void;
	configuring: string | null;
	/** ENC-1a surface active — true when the new setup-status fields are present. */
	inputEnabled: boolean;
	/** Server-reported "key is set" marker (the key itself is never returned). */
	apiKeySet: boolean;
	/** ENC-1b: the persisted `embeddingDim` value (numeric string), or undefined. One-shot seed. */
	embeddingDim: string | undefined;
	/** ENC-1b: server-reported "headers are set" marker (the raw JSON is never returned). */
	embeddingHeadersSet: boolean;
	/** ENC-1b: the persisted allow-remote flag, or undefined. One-shot seed. */
	allowRemoteEmbedder: boolean | undefined;
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
	embeddingDim,
	embeddingHeadersSet,
	allowRemoteEmbedder,
	configureResult,
	configureError,
}: CustomEndpointSectionProps): React.ReactElement {
	// The API key is intentionally local-only state: it always renders blank and
	// is never seeded from the persisted value (the server never returns it).
	const [customApiKey, setCustomApiKey] = useState("");
	// ENC-1b: the embedding dim, seeded once from the persisted value (never
	// re-seeded after a poll so the user's in-flight edits survive the 5s poll).
	const [dim, setDim] = useState("");
	const [dimSeeded, setDimSeeded] = useState(false);
	// ENC-1b: the headers JSON is local-only, write-only state: NEVER prefilled,
	// never seeded, never shown back — the server persists it verbatim and only
	// ever reports its presence via `embeddingHeadersSet`.
	const [headers, setHeaders] = useState("");
	// ENC-1b: allow-remote toggle, seeded once from the persisted flag.
	const [allowRemote, setAllowRemote] = useState(false);
	const [allowRemoteSeeded, setAllowRemoteSeeded] = useState(false);

	if (inputEnabled && !dimSeeded && typeof embeddingDim === "string") {
		setDim(embeddingDim);
		setDimSeeded(true);
	}
	if (inputEnabled && !allowRemoteSeeded && typeof allowRemoteEmbedder === "boolean") {
		setAllowRemote(allowRemoteEmbedder);
		setAllowRemoteSeeded(true);
	}

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
				{inputEnabled && embeddingHeadersSet && (
					<span
						style={{
							fontSize: "0.75rem",
							color: "#81c784",
							border: "1px solid #2a4e2a",
							borderRadius: "4px",
							padding: "0.15rem 0.45rem",
						}}
					>
						Headers saved
					</span>
				)}
				<button
					style={{ ...styles.button, opacity: customUrl ? 1 : 0.4 }}
					onClick={() =>
						applyEmbedder("custom", customUrl, customApiKey, dim, headers, allowRemote)
					}
					disabled={!customUrl || configuring !== null}
				>
					{configuring === "custom" ? "Writing..." : "Use Custom URL"}
				</button>
			</div>
			{inputEnabled && (
				<div style={{ marginTop: "0.75rem" }}>
					<div style={{ marginBottom: "0.5rem" }}>
						<label style={{ ...styles.label, display: "block", marginBottom: "0.25rem" }}>
							Embedding dim (optional)
						</label>
						<input
							type="number"
							min={1}
							placeholder="e.g. 384"
							value={dim}
							onChange={(e) => setDim(e.target.value)}
							style={{
								width: "200px",
								background: "#12122a",
								color: "#e0e0e0",
								border: "1px solid #2a2a4e",
								borderRadius: "6px",
								padding: "0.4rem 0.6rem",
								fontSize: "0.85rem",
								fontFamily: "monospace",
							}}
						/>
					</div>
					<div style={{ marginBottom: "0.5rem" }}>
						<label style={{ ...styles.label, display: "block", marginBottom: "0.25rem" }}>
							Embedding headers (JSON, write-only — never re-displayed)
						</label>
						<textarea
							placeholder={'{"Authorization": "Bearer ..."}'}
							value={headers}
							onChange={(e) => setHeaders(e.target.value)}
							aria-label="Embedding headers JSON (write-only — never re-displayed)"
							rows={2}
							style={{
								width: "100%",
								background: "#12122a",
								color: "#e0e0e0",
								border: "1px solid #2a2a4e",
								borderRadius: "6px",
								padding: "0.4rem 0.6rem",
								fontSize: "0.85rem",
								fontFamily: "monospace",
								resize: "vertical",
							}}
						/>
					</div>
					<label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem" }}>
						<input
							type="checkbox"
							checked={allowRemote}
							onChange={(e) => setAllowRemote(e.target.checked)}
							aria-label="Allow remote embedder (skips loopback-only check)"
						/>
						Allow remote embedder (skips loopback-only check)
					</label>
				</div>
			)}
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
