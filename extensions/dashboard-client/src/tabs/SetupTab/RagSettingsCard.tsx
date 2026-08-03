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
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Switch } from "../../components/ui/switch";

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
		<Card className="electric-hover">
			<CardHeader>
				<CardTitle>RAG Settings</CardTitle>
			</CardHeader>
			<CardContent>
				<p className="mt-0 text-xs text-muted-foreground">
					Recall pipeline features. All default ON — toggle off to disable.
					Changes take effect after restart.
				</p>
				{error && (
					<p className="text-sm text-danger">Error: {error}</p>
				)}
				{settings?.flags.map((flag) => {
					const locked = flag.requiresLlm && !settings.llmActive;
					return (
						<div key={flag.key} className="flex items-start gap-3 border-b border-border py-2">
							<Switch
								checked={flag.enabled && !locked}
								disabled={locked || saving}
								onCheckedChange={(checked) => toggle(flag.key, checked)}
								aria-label={flag.label}
							/>
							<div>
								<div className="text-sm font-semibold">{flag.label}</div>
								<div className="text-xs text-muted-foreground">{flag.description}</div>
								{locked && (
									<div className="mt-0.5 text-xs text-warning">
										Requires an LLM embedder (Ollama/HTTP). Configure one in
										the Embedder section above first.
									</div>
								)}
							</div>
						</div>
					);
				})}
				{!settings && !error && (
					<p className="text-sm text-muted-foreground">Loading...</p>
				)}
				{restartBanner && (
					<div className="mt-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
						Settings saved. <strong>Restart pi</strong> to apply changes.
					</div>
				)}
			</CardContent>
		</Card>
	);
}
