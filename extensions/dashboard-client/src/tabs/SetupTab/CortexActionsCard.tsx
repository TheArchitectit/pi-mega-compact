/**
 * SetupTab/CortexActionsCard.tsx — confirmation-gated Setup Cortex actions.
 *
 * fetch-model / bench / verify-asset. Uses the MaintenanceTab ActionDef +
 * window.confirm pattern; the POST body ALWAYS carries confirm:true (the
 * server hard-requires it). A 423 action_blocked_by_open_item surfaces the
 * gating blocker ids to the parent (which highlights the rows), a 400
 * confirmation_required and a 404 disabled are rendered honestly, and on a
 * successful run the returned logName is shown with a bounded log tail fetch.
 */
import type React from "react";
import { useState, useCallback } from "react";
import type {
	SetupCortexActionKind,
	SetupCortexStatusResponse,
} from "../../types/setup-cortex";
import {
	postSetupCortexAction,
	fetchSetupCortexActionLog,
} from "../../api/setup-cortex";
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
];

interface ActionResultDisplay {
	action: string;
	logName: string;
	tail: string | null;
	complete: boolean | null;
	message: string;
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

			{ACTIONS.map((def) => {
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
