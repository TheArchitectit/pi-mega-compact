/**
 * SetupTab/SettingsPanel.tsx — comprehensive adjustable-settings panel.
 *
 * Renders every MEGACOMPACT_* setting from /api/rag-settings, grouped into
 * collapsible categories. Each setting renders by type (boolean → Switch,
 * number/string → styled input) and writes back via POST /api/rag-settings on
 * change. Switches POST immediately; text/number inputs POST after a 500ms
 * debounce. Requires-LLM settings show an amber badge when no LLM embedder is
 * active. A restart-required toast appears after a successful write.
 *
 * PREVENT-PI-004: all data comes from localhost dashboard API endpoints.
 */
import type React from "react";
import { useState, useEffect, useCallback, useRef } from "react";
import type { SettingsResponse, SettingState } from "@contracts";
import { fetchSettings, postSetting } from "../../api/client";
import { Switch } from "../../components/ui/switch";
import SettingsSection from "./SettingsSection";

const INPUT_CLASS =
	"rounded-md border border-border bg-bg-elevated/50 px-2 py-1 text-sm outline-none transition-colors focus:border-primary disabled:cursor-not-allowed disabled:opacity-50";

function LlmBadge(): React.ReactElement {
	return (
		<span
			className="ml-2 inline-flex items-center rounded-md border border-warning/40 bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning"
			title="Requires an LLM embedder (Ollama/HTTP) to be effective"
		>
			LLM
		</span>
	);
}

interface RowProps {
	readonly setting: SettingState;
	readonly id: string;
	readonly llmActive: boolean;
	readonly saving: boolean;
	readonly onUpdate: (key: string, raw: string) => Promise<string | null>;
}

function SettingRow({
	setting,
	id,
	llmActive,
	saving,
	onUpdate,
}: RowProps): React.ReactElement {
	const [error, setError] = useState<string | null>(null);
	const locked = setting.requiresLlm && !llmActive;
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, []);

	const submit = useCallback(
		(raw: string) => {
			onUpdate(setting.key, raw)
				.then((msg) => setError(msg))
				.catch((e: unknown) =>
					setError(e instanceof Error ? e.message : String(e)),
				);
		},
		[onUpdate, setting.key],
	);

	const scheduleSave = useCallback(
		(raw: string) => {
			if (timerRef.current) clearTimeout(timerRef.current);
			timerRef.current = setTimeout(() => submit(raw), 500);
		},
		[submit],
	);

	const inputDisabled = saving || locked;

	return (
		<div className="py-2.5">
			<div className="flex items-start justify-between gap-3">
				<div>
					<div className="flex items-center text-sm font-semibold text-foreground">
						<label htmlFor={`${id}-input`} className="cursor-pointer">
							{setting.label}
						</label>
						{setting.requiresLlm && !llmActive && <LlmBadge />}
					</div>
					<div className="mt-0.5 text-xs text-muted-foreground">
						{setting.description}
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{setting.type === "boolean" ? (
						<Switch
							id={`${id}-input`}
							checked={Boolean(setting.value)}
							disabled={inputDisabled || locked}
							onCheckedChange={(checked) => submit(String(checked))}
							aria-label={setting.label}
						/>
					) : (
						<>
							<input
								id={`${id}-input`}
								type={setting.type === "number" ? "number" : "text"}
								defaultValue={String(setting.value ?? "")}
								min={setting.min}
								max={setting.max}
								disabled={inputDisabled}
								onChange={(e) => scheduleSave(e.target.value)}
								className={`${INPUT_CLASS} ${setting.type === "number" ? "w-24" : "w-56"}`}
							/>
							{setting.unit && (
								<span className="text-xs text-muted-foreground">{setting.unit}</span>
							)}
						</>
					)}
				</div>
			</div>
			{error && <p className="mt-1 text-xs text-danger">Error: {error}</p>}
		</div>
	);
}

export default function SettingsPanel(): React.ReactElement {
	const [settings, setSettings] = useState<SettingsResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [toast, setToast] = useState<string | null>(null);

	const load = useCallback(() => {
		fetchSettings()
			.then(setSettings)
			.catch((e: unknown) =>
				setError(e instanceof Error ? e.message : String(e)),
			);
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	const handleUpdate = useCallback(
		async (key: string, raw: string): Promise<string | null> => {
			setSaving(true);
			try {
				const res = await postSetting({ key, value: raw });
				setToast(
					res.restartRequired
						? "Saved — restart pi to apply changes."
						: "Saved.",
				);
				// Refresh to pick up the server's normalized value (and to keep the
				// controlled Switch in sync with the persisted state).
				load();
				return null;
			} catch (e) {
				return e instanceof Error ? e.message : String(e);
			} finally {
				setSaving(false);
			}
		},
		[load],
	);

	return (
		<div className="flex flex-col gap-3">
			{error && <p className="text-sm text-danger">Error: {error}</p>}
			{!settings && !error && (
				<p className="text-sm text-muted-foreground">Loading settings...</p>
			)}
			{settings?.categories.map((cat) => (
				<SettingsSection key={cat.name} title={cat.name}>
					{cat.settings.map((setting) => (
						<SettingRow
							key={setting.key}
							setting={setting}
							id={`${cat.name.replace(/[^a-z0-9]+/gi, "-")}-${setting.key}`}
							llmActive={settings.llmActive}
							saving={saving}
							onUpdate={handleUpdate}
						/>
					))}
				</SettingsSection>
			))}
			{toast && (
				<div
					className="mt-1 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning"
					role="status"
				>
					{toast}
				</div>
			)}
		</div>
	);
}
