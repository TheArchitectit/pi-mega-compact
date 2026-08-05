/**
 * SetupTab/EmbedderSetupStyles.ts — extracted styles for EmbedderSetup.
 *
 * Split from EmbedderSetup.tsx to respect the extensions/ 400-line soft limit.
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
	badge: {
		display: "inline-block",
		padding: "0.15rem 0.5rem",
		borderRadius: "4px",
		fontSize: "0.8rem",
		fontWeight: 600,
		marginLeft: "0.5rem",
	},
	detectRow: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		padding: "0.5rem 0",
		borderBottom: "1px solid #2a2a4e",
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
};
