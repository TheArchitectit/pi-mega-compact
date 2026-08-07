/**
 * SetupTab/EmbedderSetup.tsx — Embedder setup section (P0b).
 *
 * Shows current embedder configuration, warns about trigram recall quality,
 * and mirrors the /megasetup command with detection results. Extracted from
 * SetupTab.tsx to respect the extensions/ 500-line file limit.
 *
 * PREVENT-PI-004: all data comes from localhost dashboard API endpoints —
 * no external network calls.
 */
import type React from "react";
import { useState, useEffect, useCallback } from "react";
import type { SetupStatusResponse, SetupDetectResponse, SetupConfigureResponse } from "@contracts";
import { fetchSetupStatus, fetchSetupDetect, configureEmbedder } from "../../api/client";
import EmbedderHealthCard from "./EmbedderHealthCard";
import SettingsPanel from "./SettingsPanel";
import CustomEndpointSection from "./CustomEndpointSection";
import { styles } from "./EmbedderSetupStyles";
import { detectBadge, CurrentConfigSection } from "./EmbedderSetupHelpers";

export default function EmbedderSetup(): React.ReactElement {
	const [status, setStatus] = useState<SetupStatusResponse | null>(null);
	const [detect, setDetect] = useState<SetupDetectResponse | null>(null);
	const [statusError, setStatusError] = useState<string | null>(null);
	const [detectError, setDetectError] = useState<string | null>(null);
	const [runningDetect, setRunningDetect] = useState(false);
	const [configuring, setConfiguring] = useState<string | null>(null);
	const [configResult, setConfigResult] = useState<SetupConfigureResponse | null>(null);
	const [configError, setConfigError] = useState<string | null>(null);
	const [customUrl, setCustomUrl] = useState("");
	// True once the URL field has been seeded from the persisted endpoint URL —
	// seeding runs only on the first status load that carries the field so the
	// user's in-flight edits are never clobbered by a poll refresh.
	const [customUrlSeeded, setCustomUrlSeeded] = useState(false);

	const loadStatus = useCallback(() => {
		fetchSetupStatus()
			.then(setStatus)
			.catch((e: unknown) =>
				setStatusError(e instanceof Error ? e.message : String(e)),
			);
	}, []);

	const applyEmbedder = useCallback(
		(
			embedder: "ollama" | "llama" | "trigram" | "custom" | "onnx",
			url?: string,
			apiKey?: string,
			dim?: string,
			headers?: string,
			allowRemote?: boolean,
		) => {
			setConfiguring(embedder);
			setConfigError(null);
			setConfigResult(null);
			// ENC-1a: optional custom-endpoint URL + bearer key ride on the setup-configure POST (additive; flag-off ignores them).
			// ENC-1b: the dim / headers / allow-remote fields are forwarded additively, gated on the same
			// `embeddingHeadersSet` presence marker the aggregator/server uses (no separate client env read).
			const enc1bOn = "embeddingHeadersSet" in (status ?? {});
			configureEmbedder({
				embedder,
				url,
				embeddingEndpointUrl: url,
				embeddingApiKey: apiKey,
				...(enc1bOn
					? { embeddingDim: dim, embeddingHeaders: headers, allowRemoteEmbedder: allowRemote }
					: {}),
			})
				.then((r) => {
					setConfigResult(r);
					setConfiguring(null);
					loadStatus();
				})
				.catch((e: unknown) => {
					setConfigError(e instanceof Error ? e.message : String(e));
					setConfiguring(null);
				});
		},
		[loadStatus, status],
	);

	const runDetect = useCallback(() => {
		setRunningDetect(true);
		setDetectError(null);
		fetchSetupDetect()
			.then((d) => {
				setDetect(d);
				setRunningDetect(false);
			})
			.catch((e: unknown) => {
				setDetectError(e instanceof Error ? e.message : String(e));
				setRunningDetect(false);
			});
	}, []);

	useEffect(() => {
		loadStatus();
	}, [loadStatus]);

	// Seed the custom-endpoint URL field once from the persisted
	// `embeddingEndpointUrl` (ENC-1a). Later poll refreshes do NOT re-seed —
	// only the first load, so typed edits survive the 5s status poll.
	useEffect(() => {
		if (customUrlSeeded) return;
		if (status && typeof status.embeddingEndpointUrl === "string" && status.embeddingEndpointUrl.length > 0) {
			setCustomUrl(status.embeddingEndpointUrl);
			setCustomUrlSeeded(true);
		}
	}, [status, customUrlSeeded]);

	// Poll status every 5s — the same cadence the Setup Cortex sub-tab uses
	// (see useSetupCortexPoll) so the embedder + cortex sub-tabs share one poll
	// contract (VC9D consolidation). Detection is memoized server-side, so the
	// periodic detect refresh below hits the cache rather than re-spawning.
	useEffect(() => {
		const id = setInterval(loadStatus, 5000);
		return () => clearInterval(id);
	}, [loadStatus]);

	// Auto-refresh the (server-memoized) detection at the same 5s cadence so the
	// embedder sub-tab reflects cached detect changes without manual clicks; the
	// manual "Run Detection" button still works for an explicit refresh.
	useEffect(() => {
		runDetect();
		const id = setInterval(runDetect, 5000);
		return () => clearInterval(id);
	}, [runDetect]);

	return (
		<div style={styles.container}>
			<h2 style={{ fontSize: "1.3rem", marginTop: 0, marginBottom: "1rem" }}>
				Embedder Setup
			</h2>

			<EmbedderHealthCard />

			{/* Current Config Section */}
			<CurrentConfigSection status={status} statusError={statusError} />

			{/* Detection Section */}
			<div style={styles.section}>
				<h3 style={styles.sectionTitle}>Local Embedder Detection</h3>
				<p style={{ fontSize: "0.85rem", color: "#a0a0c0", marginTop: 0 }}>
					Detect which local embedding backends are available on this machine.
					No software is installed — detection only.
				</p>

				{detect && (
					<>
						{/* Ollama */}
						<div style={styles.detectRow}>
							<span>
								<strong>Ollama</strong>
							</span>
							{detect.ollama !== null ? (
								<span>
									{detectBadge(detect.ollama.installed)}
									{detect.ollama.installed && (
										<span style={{ fontSize: "0.8rem", color: "#a0a0c0", marginLeft: "0.5rem" }}>
											{detect.ollama.running
												? `server running, ${detect.ollama.models.length} model(s)`
												: "server not running"}
										</span>
									)}
								</span>
							) : (
								<span style={{ color: "#888", fontSize: "0.85rem" }}>
									not checked
								</span>
							)}
						</div>

						{/* llama.cpp */}
						<div style={styles.detectRow}>
							<span>
								<strong>llama.cpp</strong>
							</span>
							{detect.llamaCpp !== null ? (
								<span>
									{detectBadge(detect.llamaCpp.installed)}
									{detect.llamaCpp.installed && detect.llamaCpp.detail && (
										<span style={{ fontSize: "0.8rem", color: "#a0a0c0", marginLeft: "0.5rem" }}>
											{detect.llamaCpp.detail}
										</span>
									)}
								</span>
							) : (
								<span style={{ color: "#888", fontSize: "0.85rem" }}>
									not checked
								</span>
							)}
						</div>

						{/* ONNX */}
						<div style={styles.detectRow}>
							<span>
								<strong>ONNX Runtime</strong>
							</span>
							{detect.onnx !== null ? (
								<span>
									{detectBadge(detect.onnx.installed)}
									{detect.onnx.installed && detect.onnx.detail && (
										<span style={{ fontSize: "0.8rem", color: "#a0a0c0", marginLeft: "0.5rem" }}>
											{detect.onnx.detail}
										</span>
									)}
								</span>
							) : (
								<span style={{ color: "#888", fontSize: "0.85rem" }}>
									not checked
								</span>
							)}
						</div>

						{detect.error && (
							<p style={{ color: "#f44336", fontSize: "0.8rem", marginTop: "0.5rem" }}>
								Detection error: {detect.error}
							</p>
						)}
					</>
				)}

				{detectError && (
					<p style={{ color: "#f44336", fontSize: "0.85rem" }}>
						Error: {detectError}
					</p>
				)}

				<div style={{ marginTop: "1rem" }}>
					<button
						style={styles.button}
						onClick={runDetect}
						disabled={runningDetect}
					>
						{runningDetect ? "Detecting..." : "Run Detection"}
					</button>
					<span style={{ fontSize: "0.8rem", color: "#888", marginLeft: "0.75rem" }}>
						Or run <code>/megasetup</code> in the chat for an interactive wizard.
					</span>
				</div>

				{/* Configure buttons — appear after detection runs */}
				{detect && (
					<div style={{ marginTop: "1rem", paddingTop: "0.75rem", borderTop: "1px solid #2a2a4e" }}>
						<div style={{ fontSize: "0.9rem", fontWeight: 600, marginBottom: "0.5rem" }}>
							Configure
						</div>
						<div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
							<button
								style={{ ...styles.button, opacity: detect.ollama?.installed ? 1 : 0.4 }}
								onClick={() => applyEmbedder("ollama")}
								disabled={!detect.ollama?.installed || configuring !== null}
							>
								{configuring === "ollama" ? "Writing..." : "Use Ollama"}
							</button>
							<button
								style={{ ...styles.button, opacity: detect.llamaCpp?.installed ? 1 : 0.4 }}
								onClick={() => applyEmbedder("llama")}
								disabled={!detect.llamaCpp?.installed || configuring !== null}
							>
								{configuring === "llama" ? "Writing..." : "Use llama.cpp"}
							</button>
							<button
								style={{ ...styles.button, opacity: detect.onnx?.installed ? 1 : 0.4 }}
								onClick={() => applyEmbedder("onnx")}
								disabled={!detect.onnx?.installed || configuring !== null}
							>
								{configuring === "onnx" ? "Writing..." : "Use ONNX"}
							</button>
							<button
								style={{ ...styles.button, background: "#444" }}
								onClick={() => applyEmbedder("trigram")}
								disabled={configuring !== null}
							>
								{configuring === "trigram" ? "Writing..." : "Use Trigram (default)"}
							</button>
						</div>
						{configResult && configResult.embedder !== "custom" && (
							<div style={styles.warning}>
								{configResult.alreadyActive
									? "Already active — no restart needed."
									: `Configured ${configResult.embedder}. Restart pi to activate (config written to ${configResult.envPath}).`}
							</div>
						)}
						{configError && (
							<p style={{ color: "#f44336", fontSize: "0.85rem", marginTop: "0.5rem" }}>
								Configure error: {configError}
							</p>
						)}
					</div>
				)}
			</div>

			{/* Custom (remote) embedder — third-party / hosted endpoint */}
			<CustomEndpointSection
				customUrl={customUrl}
				setCustomUrl={setCustomUrl}
				applyEmbedder={applyEmbedder}
				configuring={configuring}
				inputEnabled={status !== null && "embeddingApiKeySet" in status}
				apiKeySet={status?.embeddingApiKeySet === true}
				embeddingDim={status?.embeddingDim}
				embeddingHeadersSet={status?.embeddingHeadersSet === true}
				allowRemoteEmbedder={status?.allowRemoteEmbedder}
				configureResult={configResult}
				configureError={configError}
			/>

			{/* Help Section */}
			<div style={styles.section}>
				<h3 style={styles.sectionTitle}>How to Upgrade</h3>
				<ul style={{ fontSize: "0.85rem", lineHeight: 1.6, paddingLeft: "1.25rem" }}>
					<li>
						<strong>Ollama:</strong> Install from{" "}
						<a
							href="https://ollama.com"
							style={{ color: "#6a9fff" }}
							target="_blank"
							rel="noopener noreferrer"
						>
							ollama.com
						</a>
						, then <code>ollama pull nomic-embed-text</code> and restart pi.
						Set <code>MEGACOMPACT_EMBEDDING_URL=http://localhost:11434/api/embeddings</code>.
					</li>
					<li>
						<strong>llama.cpp:</strong> Build or install llama.cpp, run{" "}
						<code>llama-server</code> with an embedding model, and set
						the URL accordingly.
					</li>
					<li>
						<strong>ONNX Runtime:</strong> Run a local text-embeddings
						server (e.g. TEI) and click <strong>Use ONNX</strong> above.
						Default URL: <code>http://localhost:8081/v1/embeddings</code>.
					</li>
				</ul>
			</div>
			{/* Settings Section — every adjustable MEGACOMPACT_* setting */}
			<div style={styles.section}>
				<h3 style={styles.sectionTitle}>Settings</h3>
				<SettingsPanel />
			</div>
		</div>
	);
}
