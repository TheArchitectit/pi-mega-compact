/**
 * SetupTab/CortexRuntimeInstallCard.tsx — operator-run install guide card
 * (ENC-2a).
 *
 * Pure render. When `SetupStatusResponse.nativeOrtInstallGuide` is non-null
 * (opt-in on, effective runtime still wasm, platform installable), this card
 * surfaces the three copy-paste steps the operator runs OUTSIDE the dashboard:
 * install onnxruntime-node, restart via pi, and the expected next status. When
 * the guide is null the card hides entirely (the modifiers card already
 * surfaces the honest ENC-0g state).
 *
 * NO client-side execution — the install script is never spawned from here.
 * Data comes exclusively from the existing /api/setup-status poll.
 */
import type React from "react";
import { useState, useCallback, useEffect } from "react";
import type { SetupStatusResponse } from "@contracts";
import { fetchSetupStatus } from "../../api/client";
import { styles } from "./CortexSetupStyles";

function useCopyState(): [boolean, (text: string) => Promise<void>] {
	const [copied, setCopied] = useState(false);
	const copy = useCallback(async (text: string) => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1500);
		} catch {
			setCopied(false);
		}
	}, []);
	return [copied, copy];
}

export default function CortexRuntimeInstallCard(): React.ReactElement {
	const [status, setStatus] = useState<SetupStatusResponse | null>(null);
	const [copied, copy] = useCopyState();

	const loadStatus = useCallback(() => {
		fetchSetupStatus()
			.then(setStatus)
			.catch(() => {
				/* best-effort poll; hide card when unavailable */
			});
	}, []);

	useEffect(() => {
		loadStatus();
		const id = setInterval(loadStatus, 5000);
		return () => clearInterval(id);
	}, [loadStatus]);

	const guide = status?.nativeOrtInstallGuide ?? null;
	const installedVersion = status?.nativeOrtInstalledVersion ?? null;
	if (!guide) return <></>;

	return (
		<div style={styles.section}>
			<h3 style={styles.sectionTitle}>Encoder Runtime Install</h3>
			<p style={{ ...styles.label, fontSize: "0.85rem", marginBottom: "0.75rem" }}>
				Platform: {guide.platform}
			</p>
			{installedVersion !== null && (
				<div style={styles.row}>
					<span style={styles.label}>Detected:</span>
					<span style={styles.value}>{installedVersion}</span>
				</div>
			)}
			{guide.commands.map((command, i) => (
				<div key={`${i}-${command}`} style={styles.row}>
					<span style={styles.label}>Step {i + 1}:</span>
					<code
						style={{
							...styles.mono,
							display: "inline-block",
							marginTop: "0.15rem",
						}}
					>
						{command}
					</code>
					<button
						type="button"
						onClick={() => {
							void copy(command);
						}}
						style={{ marginLeft: "0.5rem", fontSize: "0.8rem" }}
					>
						Copy
					</button>
				</div>
			))}
			<p style={{ ...styles.row, fontSize: "0.85rem" }}>
				<span style={styles.label}>Script:</span>{" "}
				<code style={styles.mono}>{guide.scriptPath}</code>
			</p>
			{copied && (
				<p style={{ color: "#4caf50", fontSize: "0.8rem", margin: "0.25rem 0 0" }}>
					Copied to clipboard
				</p>
			)}
		</div>
	);
}
