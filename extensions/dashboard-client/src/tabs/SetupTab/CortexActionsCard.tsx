/**
 * SetupTab/CortexActionsCard.tsx — confirmation-gated Setup Cortex actions.
 *
 * fetch-model / bench / verify-asset, plus the ENC-2c install-native-ort action
 * (rendered only while the native binding is NOT installed — derived from the
 * /api/setup-status poll's nativeOrtInstalledVersion). Uses the MaintenanceTab
 * ActionDef + window.confirm pattern; the POST body ALWAYS carries confirm:true
 * (the server hard-requires it). A 423 action_blocked_by_open_item surfaces the
 * gating blocker ids to the parent (which highlights the rows), a 400
 * confirmation_required and a 404 disabled are rendered honestly, and on a
 * successful run the returned logName is shown with a bounded log tail fetch.
 * For install-native-ort the returned nativeOrtRetestResult (verdict/p95/RSS) is
 * rendered inline.
 */
import type React from "react";
import { useState, useCallback, useEffect } from "react";
import type {
	SetupCortexActionKind,
	SetupCortexStatusResponse,
} from "../../types/setup-cortex";
import type { SetupStatusResponse } from "@contracts";
import {
	postSetupCortexAction,
	fetchSetupCortexActionLog,
} from "../../api/setup-cortex";
import { fetchSetupStatus } from "../../api/client";
import { styles } from "./CortexSetupStyles";

interface ActionDef {
	key: SetupCortexActionKind;
	label: string;
	desc: string;
	dangerous: boolean;
	confirm: string;
}

const ACTIONS: ActionDef[] = [
	{
		key: "fetch-model",
		label: "Fetch Model",
		desc: "Fetch the qualified encoder model asset",
		dangerous: true,
		confirm:
			"Fetch the encoder model asset onto this host? (Gated by any open hard gate.)",
	},
	{
		key: "bench",
		label: "Bench Encoder",
		desc: "Benchmark the encoder runtime on this host",
		dangerous: true,
		confirm:
			"Run an encoder benchmark on this host? (Gated by any open hard gate.)",
	},
	{
		key: "verify-asset",
		label: "Verify Asset",
		desc: "Re-verify the committed encoder asset",
		dangerous: false,
		confirm: "Re-verify the committed encoder asset?",
	},
	{
		key: "install-native-ort",
		label: "Install Native ORT",
		desc: "Lazy-download + install the native onnxruntime binding",
		dangerous: true,
		confirm:
			"Download + install the native onnxruntime binding on this host? (npm-mediated, sha256-verified; then re-qualified.)",
	},
];

/** ENC-2c: the retest portion rendered after a successful install-native-ort. */
interface RetestDisplay {
	verdict: string;
	p95Ms: number;
	rssMiB: number;
	backend: string | null;
}

interface ActionResultDisplay {
	action: string;
	logName: string;
	tail: string | null;
	complete: boolean | null;
	message: string;
	retest: RetestDisplay | null;
}

export function CortexActionsCard({
	data,
	onBlocked,
	onAction,
}: {
	data: SetupCortexStatusResponse | null;
	onBlocked: (blockerIds: string[]) => void;
	onAction: () => void;
}): React.ReactElement {
	const [running, setRunning] = useState<SetupCortexActionKind | null>(null);
	const [result, setResult] = useState<ActionResultDisplay | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [disabled, setDisabled] = useState(false);
	// ENC-2c: poll the general setup status so we can hide the install button once
	// the native binding is present (CortexActionsCard's cortex status prop does
	// not carry nativeOrtInstalledVersion).
	const [setupStatus, setSetupStatus] = useState<SetupStatusResponse | null>(null);

	const loadSetupStatus = useCallback(() => {
		fetchSetupStatus()
			.then(setSetupStatus)
			.catch(() => {
				/* best-effort poll; hide install button when unavailable */
			});
	}, []);

	useEffect(() => {
		loadSetupStatus();
		const id = setInterval(loadSetupStatus, 5000);
		return () => clearInterval(id);
	}, [loadSetupStatus]);

	const nativeInstalled = (setupStatus?.nativeOrtInstalledVersion ?? null) !== null;

	const runAction = useCallback(
		async (def: ActionDef) => {
			setRunning(def.key);
			setActionError(null);
			setResult(null);
			setDisabled(false);
			onBlocked([]);
			try {
				const outcome = await postSetupCortexAction({
					action: def.key,
					confirm: true,
				});
				if (outcome.ok) {
					const r = outcome.result;
					let tail: string | null = null;
					let complete: boolean | null = null;
					try {
						const log = await fetchSetupCortexActionLog(r.logName);
						tail = log.tail;
						complete = log.complete;
					} catch {
						/* log tail is best-effort */
					}
					setResult({
						action: r.action,
						logName: r.logName,
						tail,
						complete,
						message: r.ok
							? `${r.action} completed (spawned: ${r.spawned})`
							: `${r.action} did not complete cleanly`,
						retest:
							r.nativeOrtRetestResult != null
								? {
										verdict: r.nativeOrtRetestResult.verdict,
										p95Ms: r.nativeOrtRetestResult.p95Ms,
										rssMiB: r.nativeOrtRetestResult.rssMiB,
										backend: r.nativeOrtBackendEffective ?? null,
									}
								: null,
					});
					onAction();
				} else if (outcome.error.error === "action_blocked_by_open_item") {
					onBlocked(outcome.error.blockers);
					setActionError(
						"The action is blocked by an open hard-gate item and was not run.",
					);
				} else if (outcome.error.error === "confirmation_required") {
					setActionError(
						"The server rejected the action: explicit confirmation is required.",
					);
				} else {
					setDisabled(true);
					setActionError(
						outcome.status === 404
							? "Setup Cortex actions are disabled (off)."
							: `Action failed (${outcome.status}).`,
					);
				}
			} catch (e) {
				setActionError(e instanceof Error ? e.message : String(e));
			} finally {
				setRunning(null);
			}
		},
		[onBlocked, onAction],
	);

	const handleClick = (def: ActionDef) => {
		if (!window.confirm(def.confirm)) return;
		void runAction(def);
	};

	return (
		<div style={styles.section}>
			<h3 style={styles.sectionTitle}>Cortex Actions</h3>

			{ACTIONS.filter(
				// ENC-2c: hide the install button once the native binding is present.
				(def) => def.key !== "install-native-ort" || !nativeInstalled,
			).map((def) => {
				const isRunning = running === def.key;
				return (
					<div
						key={def.key}
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							gap: "0.5rem",
							padding: "0.5rem 0",
							borderBottom: "1px solid #2a2a4e",
						}}
					>
						<div>
							<div style={{ fontWeight: 600 }}>{def.label}</div>
							<div style={{ fontSize: "0.8rem", color: "#a0a0c0" }}>
								{def.desc}
							</div>
						</div>
						<button
							style={def.dangerous ? styles.buttonDanger : styles.button}
							disabled={running !== null}
							onClick={() => handleClick(def)}
						>
							{isRunning ? "Running…" : "Run"}
						</button>
					</div>
				);
			})}

			{disabled && (
				<div style={styles.blocked}>
					Setup Cortex actions are disabled. Enable MEGACOMPACT_VC9B to run
					them.
				</div>
			)}
			{actionError && !disabled && (
				<p style={{ color: "#f44336", fontSize: "0.85rem", marginTop: "0.5rem" }}>
					{actionError}
				</p>
			)}
			{result && (
				<div style={styles.warning} data-testid="cortex-action-result">
					<strong>Result ({result.action}):</strong> {result.message}
					{result.logName && (
						<span style={{ ...styles.mono, marginLeft: "0.5rem" }}>
							log: {result.logName}
						</span>
					)}
					{result.retest !== null && (
						<div
							style={{
								marginTop: "0.5rem",
								fontSize: "0.85rem",
								display: "flex",
								flexWrap: "wrap",
								gap: "0.75rem",
							}}
						>
							<span style={styles.label}>
								Re-qualified:{" "}
								<span style={{ color: "#4caf50", fontWeight: 600 }}>
									{result.retest.verdict}
								</span>
							</span>
							<span style={styles.label}>
								p95: {result.retest.p95Ms.toFixed(1)} ms
							</span>
							<span style={styles.label}>
								RSS: {result.retest.rssMiB.toFixed(1)} MiB
							</span>
							{result.retest.backend !== null && (
								<span style={styles.label}>
									backend: {result.retest.backend}
								</span>
							)}
						</div>
					)}
					{result.tail !== null && (
						<pre
							style={{
								whiteSpace: "pre-wrap",
								wordBreak: "break-word",
								fontSize: "0.75rem",
								maxHeight: "12rem",
								overflow: "auto",
								marginTop: "0.5rem",
							}}
						>
							{result.tail}
							{result.complete === false && "\n… (truncated)"}
						</pre>
					)}
				</div>
			)}
			{!data?.enabled && !disabled && (
				<p style={{ color: "#a0a0c0", fontSize: "0.8rem", marginTop: "0.5rem" }}>
					Cortex status unavailable — actions may not be schedulable.
				</p>
			)}
		</div>
	);
}
