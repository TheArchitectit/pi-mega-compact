/**
 * SetupTab/VectorCortexCosineFpCard.tsx — cosine-FP bench recommendation card
 * (COS-FP-A).
 *
 * Reader-only card on the Setup Cortex sub-tab. Polls GET /api/cosine-fp-report
 * and shows the last synthetic bench's recommended default + per-content-type
 * overrides + report digest + grid summary. The endpoint 404s on flag-off
 * (MEGACOMPACT_COSINE_FP_BENCH=0): the card renders an honest "disabled" state
 * matching the server's deriveVcStatus off path. Counts + fractions + digest
 * only — never template text (EVAL-REDACT-002).
 *
 * PREVENT-PI-004: relative-path fetch to the same-origin dashboard server.
 */
import type React from "react";
import { useMemo } from "react";
import { useApi } from "../../hooks/useApi";
import { getJson, ApiError } from "../../api/client-http";
import type { CosineFpReportV1 } from "@contracts";

const styles: Record<string, React.CSSProperties> = {
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
	disabled: {
		background: "#1a1a2e",
		border: "1px solid #2a2a4e",
		borderRadius: "8px",
		padding: "1rem",
		marginBottom: "1rem",
		color: "#a0a0c0",
		fontSize: "0.85rem",
	},
};

export const VectorCortexCosineFpCard: React.FC = () => {
	// 404 (flag-off) resolves to null data; a live report resolves to the
	// CosineFpReportV1 payload. useApi<CosineFpReportV1 | null> lets us
	// distinguish "bench disabled" (null) from "loading/error".
	const { data, error, loading } = useApi<CosineFpReportV1 | null>(
		useMemo(
			() => () =>
				getJson<CosineFpReportV1>("/api/cosine-fp-report").catch((e: unknown) => {
					// 404 = flag-off: surface to the renderer as disabled.
					if (e instanceof ApiError && e.status === 404) return null;
					throw e;
				}),
			[],
		),
		{ pollInterval: 5000 },
	);

	// 404 (flag-off) resolves to null data with no error and loading done →
	// bench disabled.
	if (data === null && !error && !loading) {
		return (
			<div style={styles.disabled}>
				Cosine FP synthetic bench: disabled (MEGACOMPACT_COSINE_FP_BENCH=0).
			</div>
		);
	}

	return (
		<div style={styles.section}>
			<h3 style={styles.sectionTitle}>Cosine FP threshold</h3>
			<p style={styles.subtitle}>Last synthetic bench threshold recommendation</p>
			{error !== null ? (
				<p style={{ color: "#f44336", fontSize: "0.85rem" }}>
					Error loading report: {error.message}
				</p>
			) : data === null ? (
				<div style={styles.value}>Loading…</div>
			) : (
				<div>
					<div style={styles.row}>
						<span style={styles.label}>Recommended default:</span>
						<span style={styles.value}>
							{data.recommendedDefault ?? "—"} (shipped{" "}
							{data.shippedDefault})
						</span>
					</div>
					<div style={styles.row}>
						<span style={styles.label}>Overrides:</span>
						<span style={styles.value}>
							CODE {data.overrides?.code ?? "—"} · PROSE{" "}
							{data.overrides?.prose ?? "—"} · MIXED{" "}
							{data.overrides?.mixed ?? "—"}
						</span>
					</div>
					<div style={styles.row}>
						<span style={styles.label}>Grid:</span>
						<span style={styles.value}>
							{data.grid
								? `${data.grid.lo} → ${data.grid.hi} (${data.grid.points} points)`
								: "—"}
						</span>
					</div>
					<div style={styles.row}>
						<span style={styles.label}>Report digest:</span>
						<span
							style={styles.value}
							title={data.digest ?? undefined}
						>
							{data.digest ? data.digest.slice(0, 16) + "…" : "—"}
						</span>
					</div>
				</div>
			)}
		</div>
	);
};
