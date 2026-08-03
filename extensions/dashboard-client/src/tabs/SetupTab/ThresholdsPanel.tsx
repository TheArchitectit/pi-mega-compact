/**
 * SetupTab/ThresholdsPanel.tsx — per-model compaction thresholds (S52 / v0.16.1).
 *
 * Lists every known model (from model_snapshots) with two sliders each:
 *   - Safety Margin (0-20%): reserved after summary + maxOutput. Lower =
 *     more usable tail but risks the "too long even after compaction" error.
 *   - Fire Point (10-90%): % of window where compaction fires. Lower = compact
 *     earlier (more headroom); higher = more context before compaction.
 *
 * Warnings fire on <5% safety (overflow risk) and >85% fire point (aggressive
 * — may hit the cap before compaction triggers). Changes save immediately via
 * PUT /api/model-thresholds; a "Reset to default" button DELETEs the override.
 *
 * PREVENT-PI-004: all data comes from localhost dashboard API endpoints.
 */
import type React from "react";
import { useState, useEffect, useCallback } from "react";
import {
	fetchModelThresholds,
	putModelThreshold,
	deleteModelThreshold,
} from "../../api/client";
import type { ModelThresholdsResponse } from "@contracts";

interface ModelRow {
	readonly modelId: string;
	readonly provider: string;
	readonly modelName: string | null;
	readonly contextWindow: number;
	readonly maxTokens: number;
	readonly hasOverride: boolean;
	readonly threshold: {
		readonly safetyMarginPct: number;
		readonly firePointPct: number;
		readonly isOverride: boolean;
	};
}

function fmtWindow(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1000) return `${Math.round(n / 1000)}K`;
	return String(n);
}

/** Live preview of the usable tail budget for a model + slider values. */
function usableTail(
	ctxWindow: number,
	maxTokens: number,
	safetyPct: number,
): string {
	if (ctxWindow <= 0) return "—";
	const maxOut = maxTokens > 0 ? maxTokens : Math.ceil(ctxWindow * 0.1);
	const reserve = maxOut + Math.ceil(ctxWindow * (safetyPct / 100));
	const usable = ctxWindow - reserve;
	if (usable <= 0) return "0 (at risk)";
	return `${fmtWindow(usable)} tokens`;
}

function ThresholdSlider({
	label,
	value,
	min,
	max,
	step = 1,
	onChange,
	warning,
}: {
	readonly label: string;
	readonly value: number;
	readonly min: number;
	readonly max: number;
	readonly step?: number;
	readonly onChange: (v: number) => void;
	readonly warning?: string;
}): React.ReactElement {
	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center justify-between text-xs">
				<span className="font-medium text-fg-muted">{label}</span>
				<span
					className={`font-mono ${warning ? "text-warning" : "text-fg"}`}
					title={warning}
				>
					{value}%
				</span>
			</div>
			<input
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				onChange={(e) => onChange(Number(e.target.value))}
				className="threshold-slider w-full"
			/>
			{warning && <p className="text-[10px] text-warning">⚠ {warning}</p>}
		</div>
	);
}

function ModelThresholdRow({
	model,
	defaults,
	safetyRange,
	fireRange,
	onSave,
	onReset,
	saving,
}: {
	readonly model: ModelRow;
	readonly defaults: { safetyMarginPct: number; firePointPct: number };
	readonly safetyRange: readonly [number, number];
	readonly fireRange: readonly [number, number];
	readonly onSave: (
		modelId: string,
		safetyMarginPct: number,
		firePointPct: number,
	) => Promise<void>;
	readonly onReset: (modelId: string) => Promise<void>;
	readonly saving: boolean;
}): React.ReactElement {
	const [safety, setSafety] = useState(model.threshold.safetyMarginPct);
	const [fire, setFire] = useState(model.threshold.firePointPct);
	const [dirty, setDirty] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	// Re-sync when the server data changes (e.g. after reset).
	useEffect(() => {
		setSafety(model.threshold.safetyMarginPct);
		setFire(model.threshold.firePointPct);
		setDirty(false);
	}, [model.threshold.safetyMarginPct, model.threshold.firePointPct]);

	const safetyWarning =
		safety < 5
			? `Low safety margin — risks "conversation too long" errors when a single turn injects a large tool output between gate fires.`
			: undefined;
	const fireWarning =
		fire > 85
			? `High fire point — compaction may trigger close to the window cap; a single large turn can overshoot before the gate fires.`
			: undefined;

	const save = useCallback(async () => {
		setErr(null);
		try {
			await onSave(model.modelId, safety, fire);
			setDirty(false);
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		}
	}, [model.modelId, safety, fire, onSave]);

	return (
		<div className="rounded-md border border-border bg-bg-elevated/30 p-3">
			<div className="mb-2 flex items-start justify-between">
				<div>
					<div className="flex items-center gap-2">
						<span className="text-sm font-semibold text-fg">
							{model.modelName ?? model.modelId}
						</span>
						{model.threshold.isOverride && (
							<span
								className="rounded border border-primary/40 bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-primary"
								title="This model has a custom override (not the default)"
							>
								Override
							</span>
						)}
					</div>
					<div className="text-[11px] text-fg-muted">
						{model.provider} · {fmtWindow(model.contextWindow)} window ·{" "}
						{fmtWindow(model.maxTokens)} output
					</div>
				</div>
				<div className="text-right text-[11px] text-fg-muted">
					<div>
						Usable tail:{" "}
						<span className="font-mono text-fg">
							{usableTail(model.contextWindow, model.maxTokens, safety)}
						</span>
					</div>
					<div>
						Compaction fires at:{" "}
						<span className="font-mono text-fg">
							{fmtWindow(Math.ceil(model.contextWindow * (fire / 100)))}
						</span>
					</div>
				</div>
			</div>
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<ThresholdSlider
					label="Safety margin"
					value={safety}
					min={safetyRange[0]}
					max={safetyRange[1]}
					onChange={(v) => {
						setSafety(v);
						setDirty(true);
					}}
					warning={safetyWarning}
				/>
				<ThresholdSlider
					label="Fire point"
					value={fire}
					min={fireRange[0]}
					max={fireRange[1]}
					onChange={(v) => {
						setFire(v);
						setDirty(true);
					}}
					warning={fireWarning}
				/>
			</div>
			<div className="mt-2 flex items-center gap-2">
				<button
					type="button"
					onClick={save}
					disabled={!dirty || saving}
					className="rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-primary-fg disabled:cursor-not-allowed disabled:opacity-50"
				>
					{dirty ? "Save override" : "Saved"}
				</button>
				{model.threshold.isOverride && (
					<button
						type="button"
						onClick={() => onReset(model.modelId)}
						disabled={saving}
						className="rounded-md border border-border px-2.5 py-1 text-xs text-fg-muted disabled:cursor-not-allowed disabled:opacity-50"
					>
						Reset to default ({defaults.safetyMarginPct}% /{" "}
						{defaults.firePointPct}%)
					</button>
				)}
				{err && <span className="text-[11px] text-error">{err}</span>}
			</div>
		</div>
	);
}

export default function ThresholdsPanel(): React.ReactElement {
	const [data, setData] = useState<ModelThresholdsResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const load = useCallback(async () => {
		try {
			setError(null);
			setData(await fetchModelThresholds());
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	const onSave = useCallback(
		async (modelId: string, safetyMarginPct: number, firePointPct: number) => {
			setSaving(true);
			try {
				await putModelThreshold({ modelId, safetyMarginPct, firePointPct });
				await load();
			} finally {
				setSaving(false);
			}
		},
		[load],
	);

	const onReset = useCallback(
		async (modelId: string) => {
			setSaving(true);
			try {
				await deleteModelThreshold(modelId);
				await load();
			} finally {
				setSaving(false);
			}
		},
		[load],
	);

	if (loading)
		return <div className="p-4 text-sm text-fg-muted">Loading thresholds…</div>;
	if (error)
		return <div className="p-4 text-sm text-error">Error: {error}</div>;
	if (!data) return <div className="p-4 text-sm text-fg-muted">No data.</div>;

	return (
		<div className="flex flex-col gap-4">
			<div className="rounded-md border border-border bg-bg-elevated/20 p-3">
				<h3 className="text-sm font-semibold">
					Per-Model Compaction Thresholds
				</h3>
				<p className="mt-1 text-[11px] text-fg-muted">
					Tune when compaction fires + how much safety margin to reserve,
					<strong> per model</strong>. Different providers' models range from 8K
					to 1M+ context — one global % is wrong. Defaults:{" "}
					<span className="font-mono">
						{data.defaults.safetyMarginPct}% safety
					</span>{" "}
					/{" "}
					<span className="font-mono">{data.defaults.firePointPct}% fire</span>.
					Values outside the safe band show warnings.
				</p>
			</div>
			{data.models.length === 0 ? (
				<div className="rounded-md border border-border p-4 text-sm text-fg-muted">
					No models captured yet. Start a pi session in any repo to populate
					model snapshots, then return here to tune per-model thresholds.
				</div>
			) : (
				<div className="flex flex-col gap-3">
					{data.models.map((m) => (
						<ModelThresholdRow
							key={m.modelId}
							model={m}
							defaults={data.defaults}
							safetyRange={data.defaults.safetyMarginRange}
							fireRange={data.defaults.firePointRange}
							onSave={onSave}
							onReset={onReset}
							saving={saving}
						/>
					))}
				</div>
			)}
		</div>
	);
}
