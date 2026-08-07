/**
 * SetupTab/CortexRuntimeCardStyles.ts — extracted styles for CortexRuntimeCard.
 *
 * Split from CortexRuntimeCard.tsx to respect the extensions/ 400-line soft
 * limit (mirrors the EmbedderSetupStyles.tsx convention).
 */
import type React from "react";

export const styles: Record<string, React.CSSProperties> = {
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
		marginBottom: "0.25rem",
		color: "#e0e0e0",
	},
	subtitle: {
		fontSize: "0.85rem",
		color: "#a0a0c0",
		marginTop: 0,
		marginBottom: "0.75rem",
	},
	row: { marginBottom: "0.4rem", fontSize: "0.9rem" },
	label: { fontWeight: 600, color: "#a0a0c0", marginRight: "0.5rem" },
	value: { color: "#e0e0e0" },
	warning: {
		background: "#3a2a00",
		border: "1px solid #665500",
		borderRadius: "8px",
		padding: "0.75rem",
		marginTop: "0.5rem",
		color: "#ffcc00",
		fontSize: "0.85rem",
	},
	toggleRow: {
		display: "flex",
		alignItems: "center",
		gap: "0.5rem",
		marginBottom: "0.75rem",
		fontSize: "0.9rem",
	},
};
