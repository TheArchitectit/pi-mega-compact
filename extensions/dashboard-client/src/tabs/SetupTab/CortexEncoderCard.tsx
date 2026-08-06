/**
 * SetupTab/CortexEncoderCard.tsx — encoder gate status card (VC9C).
 *
 * Projects the VC9A reader status: effective triad mode A/B/C, asset digest
 * prefix, qualification verdict + threshold failures, and encoder health. The
 * header carries the shared VcStatusBadge driven by the payload's status field
 * (VC0E honest-status pattern). Pure projection of the polled payload — never
 * payload bytes/prompts/ledger.
 */
import type React from "react";
import type { SetupCortexStatusResponse } from "../../types/setup-cortex";
import { VcStatusBadge } from "../VcStatusBadge";
import { styles } from "./CortexSetupStyles";

function modeLabel(mode: "A" | "B" | "C" | undefined): string {
	switch (mode) {
		case "A":
			return "A — qualified learned encoder asset";
		case "B":
			return "B — demoted (heuristic/trigram)";
		case "C":
			return "C — absent (asset not verified)";
		default:
			return "—";
	}
}

function verdictBadge(
	verdict: "qualified" | "demoted" | "unavailable" | undefined,
): React.ReactElement {
	const bg =
		verdict === "qualified"
			? "#1a5a1a"
			: verdict === "demoted"
				? "#3a3a1a"
				: "#3a1a1a";
	const color =
		verdict === "qualified"
			? "#4caf50"
			: verdict === "demoted"
				? "#ffcc00"
				: "#f44336";
	return (
		<span style={{ ...styles.badge, background: bg, color }}>
			{verdict ?? "unknown"}
		</span>
	);
}

export function CortexEncoderCard({
	data,
	error,
}: {
	data: SetupCortexStatusResponse | null;
	error: string | null;
}): React.ReactElement {
	return (
		<div style={styles.section}>
			<h3 style={styles.sectionTitle}>
				<span style={{ marginRight: "0.5rem" }}>Cortex Encoder</span>
				<VcStatusBadge status={data?.status} />
			</h3>

			{error && (
				<p style={{ color: "#f44336", fontSize: "0.85rem" }}>Error: {error}</p>
			)}
			{!data && !error && (
				<p style={{ color: "#888", fontSize: "0.85rem" }}>
					Loading cortex status...
				</p>
			)}
			{!data?.enabled && (
				<p style={{ color: "#f44336", fontSize: "0.85rem" }}>
					Cortex status disabled (VC9A off).
				</p>
			)}

			<div style={styles.row}>
				<span style={styles.label}>Mode:</span>
				<span style={styles.value}>{modeLabel(data?.encoderHealth.mode)}</span>
			</div>
			<div style={styles.row}>
				<span style={styles.label}>Asset digest prefix:</span>
				<span style={{ ...styles.value, ...styles.mono }}>
					{data?.assetDigestPrefix ?? (
						<span style={{ color: "#888" }}>not available</span>
					)}
				</span>
			</div>
			<div style={styles.row}>
				<span style={styles.label}>Qualification:</span>
				{verdictBadge(data?.qualification.verdict)}
			</div>
			{(data?.qualification.thresholdFailures.length ?? 0) > 0 && (
				<div style={styles.warning}>
					<strong>Threshold failure(s):</strong>{" "}
					{data?.qualification.thresholdFailures.join(", ")}
				</div>
			)}
			{data?.status === "awaiting_data" && (
				<p style={{ color: "#a0a0c0", fontSize: "0.85rem" }}>
					Awaiting encoder data. Qualification will appear once an asset is
					present.
				</p>
			)}
			{data?.status === "deferred" && (
				<p style={{ color: "#a0a0c0", fontSize: "0.85rem" }}>
					Encoder status deferred.
				</p>
			)}
		</div>
	);
}
