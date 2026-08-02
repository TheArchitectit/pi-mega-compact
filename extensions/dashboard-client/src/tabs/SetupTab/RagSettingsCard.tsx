/**
 * SetupTab/RagSettingsCard.tsx — RAG feature flag toggles (S57 B1–B5).
 *
 * Shows each RAG flag as a checkbox toggle. Reads/writes the .mega-compact.env
 * file via the /api/rag-settings endpoint. HyDE (B5) is greyed out when no
 * LLM embedder (HttpEmbedder) is active — it requires an LLM to function.
 *
 * PREVENT-PI-004: all data comes from localhost dashboard API endpoints.
 */
import type React from "react";
import { useState, useEffect, useCallback } from "react";
import type { RagSettingsResponse } from "@contracts";
import { fetchRagSettings, postRagSettings } from "../../api/client";

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
	flagRow: {
		display: "flex",
		alignItems: "flex-start",
		gap: "0.5rem",
		padding: "0.5rem 0",
		borderBottom: "1px solid #2a2a4e",
	},
	checkbox: {
		marginTop: "0.15rem",
		cursor: "pointer",
	},
	label: {
		fontWeight: 600,
		color: "#e0e0e0",
		fontSize: "0.9rem",
	},
	description: {
		fontSize: "0.8rem",
		color: "#a0a0c0",
		marginTop: "0.15rem",
	},
	hint: {
		fontSize: "0.75rem",
		color: "#ff9800",
		marginTop: "0.15rem",
	},
	banner: {
		background: "#3a2a00",
		border: "1px solid #665500",
		borderRadius: "6px",
		padding: "0.5rem 0.75rem",
		marginTop: "0.5rem",
		color: "#ffcc00",
		fontSize: "0.8rem",
	},
};

export default function RagSettingsCard(): React.ReactElement {
	const [settings, setSettings] = useState<RagSettingsResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [restartBanner, setRestartBanner] = useState(false);

	const load = useCallback(() => {
		fetchRagSettings()
			.then(setSettings)
			.catch((e: unknown) =>
				setError(e instanceof Error ? e.message : String(e)),
			);
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	useEffect(() => {
		const id = setInterval(load, 30000);
		return () => clearInterval(id);
	}, [load]);

	const toggle = useCallback(
		(key: string, enabled: boolean) => {
			if (!settings) return;
			const flag = settings.flags.find((f) => f.key === key);
			if (!flag || (flag.requiresLlm && !settings.llmActive)) return;
			setSaving(true);
			postRagSettings({ flags: { [key]: enabled } })
				.then(() => {
					setRestartBanner(true);
					setSaving(false);
					load();
				})
				.catch((e: unknown) => {
					setError(e instanceof Error ? e.message : String(e));
					setSaving(false);
				});
		},
		[settings, load],
	);

	return (
		<div style={styles.section}>
			<h3 style={styles.sectionTitle}>RAG Settings</h3>
			<p style={{ fontSize: "0.8rem", color: "#a0a0c0", marginTop: 0 }}>
				Recall pipeline features. All default ON — toggle off to disable.
				Changes take effect after restart.
			</p>
			{error && (
				<p style={{ color: "#f44336", fontSize: "0.85rem" }}>Error: {error}</p>
			)}
			{settings?.flags.map((flag) => {
				const locked = flag.requiresLlm && !settings.llmActive;
				return (
					<div key={flag.key} style={styles.flagRow}>
						<input
							type="checkbox"
							style={{
								...styles.checkbox,
								opacity: locked ? 0.4 : 1,
								cursor: locked ? "not-allowed" : "pointer",
							}}
							checked={flag.enabled && !locked}
							disabled={locked || saving}
							onChange={(e) => toggle(flag.key, e.currentTarget.checked)}
						/>
						<div>
							<div style={styles.label}>{flag.label}</div>
							<div style={styles.description}>{flag.description}</div>
							{locked && (
								<div style={styles.hint}>
									Requires an LLM embedder (Ollama/HTTP). Configure one in
									the Embedder section above first.
								</div>
							)}
						</div>
					</div>
				);
			})}
			{!settings && !error && (
				<p style={{ color: "#888", fontSize: "0.85rem" }}>Loading...</p>
			)}
			{restartBanner && (
				<div style={styles.banner}>
					Settings saved. <strong>Restart pi</strong> to apply changes.
				</div>
			)}
		</div>
	);
}
