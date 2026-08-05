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

	const loadStatus = useCallback(() => {
		fetchSetupStatus()
			.then(setStatus)
			.catch((e: unknown) =>
				setStatusError(e instanceof Error ? e.message : String(e)),
			);
	}, []);

	const applyEmbedder = useCallback((embedder: "ollama" | "llama" | "trigram" | "custom" | "onnx", url?: string) => {
		setConfiguring(embedder);
		setConfigError(null);
		setConfigResult(null);
		configureEmbedder({ embedder, url })
			.then((r) => {
				setConfigResult(r);
				setConfiguring(null);
				loadStatus();
			})
			.catch((e: unknown) => {
				setConfigError(e instanceof Error ? e.message : String(e));
				setConfiguring(null);
			});
	}, [loadStatus]);

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

	// Poll status every 30s
	useEffect(() => {
		const id = setInterval(loadStatus, 30000);
		return () => clearInterval(id);
	}, [loadStatus]);

	const embedderLabel = (e: string): string => {
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
	};

	const trigramWarning = status?.currentEmbedder === "trigram" && (
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

	const detectBadge = (installed: boolean): React.ReactElement => {
		const bg = installed ? "#1a5a1a" : "#3a1a1a";
		const color = installed ? "#4caf50" : "#f44336";
		return (
			<span style={{ ...styles.badge, background: bg, color }}>
				{installed ? "Detected" : "Not found"}
			</span>
		);
	};

	return (
		<div style={styles.container}>
			<h2 style={{ fontSize: "1.3rem", marginTop: 0, marginBottom: "1rem" }}>
				Embedder Setup
			</h2>

			<EmbedderHealthCard />

			{/* Current Config Section */}
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
						{trigramWarning}
					</>
				)}
				{!status && !statusError && (
					<p style={{ color: "#888", fontSize: "0.85rem" }}>
						Loading configuration...
					</p>
				)}
			</div>

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
						{configResult && (
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
