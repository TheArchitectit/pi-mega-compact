/**
 * SetupTab/CortexRuntimeCard.tsx — Encoder Runtime selection card (ENC-1b +
 * ENC-2a budget knob).
 *
 * Rendered on the Setup Cortex sub-tab. Reads the ENC-1b Cortex trio AND the
 * ENC-2a install-budget knob from the SAME /api/setup-status endpoint (and
 * /api/setup-configure writer) the Embedder sub-tab uses — a single endpoint,
 * no /api/setup-cortex-status read.
 *
 * The native opt-in toggle POSTs `encoderNativeOptIn`; the install-budget
 * input POSTs `nativeOrtBudgetMib` (positive integer MiB string, 1..8192). The
 * effective backend (`wasm` | `native`), any demotion reason, AND the effective
 * budget (`installBudgetMib()` operand, incl. the 300 MiB default fallback)
 * are surfaced reader-only — no selection/install logic is reimplemented on
 * the client.
 *
 * PREVENT-PI-004: all data comes from localhost dashboard API endpoints.
 */
import type React from "react";
import { useState, useEffect, useCallback } from "react";
import type { SetupStatusResponse } from "@contracts";
import { fetchSetupStatus, configureEmbedder } from "../../api/client";
import { styles } from "./CortexRuntimeCardStyles";

const BUDGET_INPUT_MAX = 8192;

export default function CortexRuntimeCard(): React.ReactElement {
	const [status, setStatus] = useState<SetupStatusResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	// ENC-2a: local input state for the budget field, seeded from the persisted
	// value once when the ENC-2a surface becomes active (one-shot seed mirrors
	// CustomEndpointSection's dim-input pattern).
	const [budgetInput, setBudgetInput] = useState<string>("");
	const [budgetSeeded, setBudgetSeeded] = useState(false);

	const loadStatus = useCallback(() => {
		fetchSetupStatus()
			.then(setStatus)
			.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
	}, []);

	useEffect(() => {
		loadStatus();
	}, [loadStatus]);

	// Poll status every 5s — the same cadence as the Embedder sub-tab so the
	// runtime card reflects persisted opt-in + effective backend changes live.
	useEffect(() => {
		const id = setInterval(loadStatus, 5000);
		return () => clearInterval(id);
	}, [loadStatus]);

	// The card is only meaningful when the ENC-1b surface is active (the server
	// carries the Cortex trio). Flag off → the keys are absent → hide the card.
	const enabled = status !== null && "encoderNativeOptIn" in status;

	// ENC-2a: seed the budget input once, when the ENC-2a surface becomes active
	// AND the persisted value is present. Falls back to the effective operand
	// (the runtime's resolution, incl. the 300 default) so the input shows the
	// operand the dashboard is actually using.
	const budgetEffective = status?.nativeOrtBudgetEffectiveMib;
	useEffect(() => {
		if (!budgetSeeded && status && "nativeOrtBudgetEffectiveMib" in status) {
			const seed = status.nativeOrtBudgetMib ?? status.nativeOrtBudgetEffectiveMib ?? "";
			if (typeof seed === "string") setBudgetInput(seed);
			setBudgetSeeded(true);
		}
	}, [budgetSeeded, status]);

	// Omit embedder/url when the card only manages runtime keys — the server's
	// tryEnc1bConfigure handles pure additive configure (no embedder change) and
	// returns before the embedder-validation gate.
	const toggleNative = useCallback(
		(next: boolean) => {
			setSaving(true);
			setError(null);
			configureEmbedder({ encoderNativeOptIn: next })
				.then(() => {
					setSaving(false);
					loadStatus();
				})
				.catch((e: unknown) => {
					setError(e instanceof Error ? e.message : String(e));
					setSaving(false);
				});
		},
		[loadStatus],
	);

	const saveBudget = useCallback(() => {
		const trimmed = budgetInput.trim();
		// Client-side guard mirrors the server's ENC_2BUDGET_MAX_MIB clamp.
		// The server re-validates; this is purely a fast UX pre-check.
		if (!/^\d+$/.test(trimmed)) {
			setError("Install budget must be a positive integer (MiB)");
			return;
		}
		const n = Number(trimmed);
		if (!Number.isSafeInteger(n) || n < 1 || n > BUDGET_INPUT_MAX) {
			setError(`Install budget must be between 1 and ${BUDGET_INPUT_MAX} MiB`);
			return;
		}
		setSaving(true);
		setError(null);
		configureEmbedder({ nativeOrtBudgetMib: trimmed })
			.then(() => {
				setSaving(false);
				loadStatus();
			})
			.catch((e: unknown) => {
				setError(e instanceof Error ? e.message : String(e));
				setSaving(false);
			});
	}, [budgetInput, status, loadStatus]);

	if (!enabled) return <></>;

	const backend = status?.encoderBackend ?? "wasm";
	const demotion = status?.encoderDemotionReason ?? null;
	const budgetVisible = status !== null && "nativeOrtBudgetEffectiveMib" in status;

	return (
		<div style={styles.section}>
			<h3 style={styles.sectionTitle}>Encoder Runtime</h3>
			<p style={styles.subtitle}>ONNX backend selection</p>
			<div style={styles.toggleRow}>
				<input
					type="checkbox"
					checked={status?.encoderNativeOptIn === true}
					onChange={(e) => toggleNative(e.target.checked)}
					disabled={saving}
					aria-label="Native ONNX runtime (onnxruntime-node)"
				/>
				<label>Native ONNX runtime (onnxruntime-node)</label>
				{saving && (
					<span style={{ fontSize: "0.8rem", color: "#a0a0c0" }}>saving...</span>
				)}
			</div>
			<div style={styles.row}>
				<span style={styles.label}>Effective backend (selected):</span>
				<span style={styles.value}>{backend}</span>
			</div>
			{budgetVisible && (
				<div style={styles.row}>
					<label
						htmlFor="enc2-budget-input"
						style={{ ...styles.label, marginRight: "0.5rem" }}
					>
						Native install budget (MiB):
					</label>
					<input
						id="enc2-budget-input"
						type="number"
						min={1}
						max={BUDGET_INPUT_MAX}
						step={1}
						value={budgetInput}
						onChange={(e) => setBudgetInput(e.target.value)}
						disabled={saving}
						style={{ width: "6rem" }}
						aria-label="Native onnxruntime install budget in MiB"
					/>
					<button
						type="button"
						onClick={saveBudget}
						disabled={saving || budgetInput.trim().length === 0}
						style={{ marginLeft: "0.5rem" }}
					>
						Save
					</button>
					{budgetEffective !== undefined && (
						<span style={{ ...styles.value, marginLeft: "0.5rem" }}>
							(effective: {budgetEffective} MiB)
						</span>
					)}
				</div>
			)}
			{demotion !== null && (
				<div style={styles.warning}>
					<strong>Demoted:</strong> {demotion}
				</div>
			)}
			{error && (
				<p style={{ color: "#f44336", fontSize: "0.85rem" }}>Error: {error}</p>
			)}
		</div>
	);
}
