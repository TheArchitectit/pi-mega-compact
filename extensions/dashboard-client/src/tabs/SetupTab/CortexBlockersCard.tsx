/**
 * SetupTab/CortexBlockersCard.tsx — open hard-gate blockers card (VC9C + ENC-0e).
 *
 * Renders the STATUS payload's `blockers` rows (id, title, severity, status,
 * resolution). When an action returns 423 action_blocked_by_open_item, the
 * matching blocker rows are highlighted so the user sees exactly which open
 * item(s) gate the action they tried.
 *
 * ENC-0e: when the payload carries `darwinX64:{demoted:true,reason}`, an
 * explicitly-diagnosed row is rendered so an Intel-Mac operator sees exactly why
 * mode A is unreachable. Unaffected (renders nothing) when absent or not demoted.
 */
import type React from "react";
import type { BlockerV1 } from "../../types/setup-cortex";
import { styles } from "./CortexSetupStyles";

function severityColor(severity: BlockerV1["severity"]): string {
	switch (severity) {
		case "blocker":
			return "#f44336";
		case "high":
			return "#ff9800";
		default:
			return "#a0a0c0";
	}
}

export function CortexBlockersCard({
	blockers,
	highlight,
	darwinX64,
}: {
	blockers: BlockerV1[];
	highlight?: string[];
	darwinX64?: { demoted: boolean; reason?: string };
}): React.ReactElement {
	const highlighted = highlight ?? [];
	return (
		<div style={styles.section}>
			<h3 style={styles.sectionTitle}>
				Open Hard-Gate Blockers
				<span style={{ ...styles.badge, background: "#3a1a1a", color: "#f44336" }}>
					{blockers.length}
				</span>
			</h3>
			{blockers.length === 0 && (
				<p style={{ color: "#4caf50", fontSize: "0.85rem" }}>
					No open hard-gate blockers.
				</p>
			)}
			{darwinX64?.demoted === true && (
				<div style={styles.blockerRow} data-darwin-x64-demoted="true">
					<span style={{ ...styles.mono, fontWeight: 700 }}>HG-4</span>
					<span style={{ flex: 1, color: "#e0e0e0" }}>
						{darwinX64.reason || "darwin-x64: demoted to WASM (reason unavailable)"}
					</span>
					<span style={{ color: "#ff9800" }}>high</span>
					<span style={{ color: "#4caf50", fontStyle: "italic" }}>diagnosed</span>
				</div>
			)}
			{blockers.map((b) => {
				const isHighlighted = highlighted.includes(b.id);
				return (
					<div
						key={b.id}
						style={{
							...styles.blockerRow,
							...(isHighlighted ? styles.blockerRowHighlighted : {}),
						}}
					>
						<span style={{ ...styles.mono, fontWeight: 700 }}>{b.id}</span>
						<span style={{ flex: 1, color: "#e0e0e0" }}>{b.title}</span>
						<span style={{ color: severityColor(b.severity) }}>
							{b.severity}
						</span>
						<span style={{ color: "#a0a0c0", fontStyle: "italic" }}>
							{isHighlighted ? "gates this action" : b.status}
						</span>
					</div>
				);
			})}
			{highlighted.length > 0 && (
				<div style={styles.blocked}>
					<strong>Blocked:</strong> the requested action is gated by the
					highlighted open hard-gate item(s). It was not run.
				</div>
			)}
		</div>
	);
}
