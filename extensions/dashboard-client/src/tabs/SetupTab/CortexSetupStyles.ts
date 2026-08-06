/**
 * SetupTab/CortexSetupStyles.ts — shared styles for the CortexSetup sub-tab.
 *
 * Mirrors EmbedderSetupStyles conventions so the Setup Cortex sub-tab reads
 * like the rest of the Setup tab. Split out so each Cortex card stays well
 * under the extensions/ soft line limit.
 */
import type React from "react";

export const styles: Record<string, React.CSSProperties> = {
	container: {
		padding: "1rem",
		maxWidth: "720px",
		margin: "0 auto",
		fontFamily: "system-ui, sans-serif",
		color: "#e0e0e0",
	},
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
	label: { fontWeight: 600, color: "#a0a0c0", marginRight: "0.5rem" },
	value: { color: "#e0e0e0" },
	row: { marginBottom: "0.4rem", fontSize: "0.9rem" },
	warning: {
		background: "#3a2a00",
		border: "1px solid #665500",
		borderRadius: "8px",
		padding: "0.75rem",
		marginTop: "0.5rem",
		color: "#ffcc00",
		fontSize: "0.85rem",
	},
	blocked: {
		background: "#3a1a1a",
		border: "1px solid #662222",
		borderRadius: "8px",
		padding: "0.75rem",
		marginTop: "0.5rem",
		color: "#ff6666",
		fontSize: "0.85rem",
	},
	badge: {
		display: "inline-block",
		padding: "0.15rem 0.5rem",
		borderRadius: "4px",
		fontSize: "0.8rem",
		fontWeight: 600,
		marginLeft: "0.5rem",
	},
	button: {
		background: "#3a5a9f",
		color: "#fff",
		border: "none",
		borderRadius: "6px",
		padding: "0.5rem 1rem",
		cursor: "pointer",
		fontSize: "0.9rem",
		fontWeight: 600,
	},
	buttonDanger: {
		background: "#6a2a2a",
		color: "#ffb3b3",
		border: "1px solid #662222",
		borderRadius: "6px",
		padding: "0.5rem 1rem",
		cursor: "pointer",
		fontSize: "0.9rem",
		fontWeight: 600,
	},
	blockerRow: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		gap: "0.5rem",
		padding: "0.5rem 0.6rem",
		borderRadius: "6px",
		marginBottom: "0.35rem",
		fontSize: "0.85rem",
	},
	blockerRowHighlighted: {
		background: "#3a1a1a",
		border: "1px solid #662222",
	},
	mono: { fontFamily: "ui-monospace, monospace", fontSize: "0.8rem" },
};
