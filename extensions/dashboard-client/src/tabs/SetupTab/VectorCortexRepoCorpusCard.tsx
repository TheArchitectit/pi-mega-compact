/**
 * SetupTab/VectorCortexRepoCorpusCard.tsx — REPO-A cross-repo corpus consent
 * status card.
 *
 * Reader-only card on the Setup Cortex sub-tab. Polls GET /api/repo-corpus and
 * shows each pseudonymous repo's consent state + cross-repo overlap + total
 * events. It NEVER submits consent — consent is CLI/ops-only (consent.mjs,
 * append-only). The endpoint 404s on flag-off (MEGACOMPACT_REPO_CORPUS=0): the
 * card renders an honest "disabled" state matching deriveVcStatus off. Counts +
 * IDs + status only — never payload content (EVAL-REDACT-002).
 *
 * PREVENT-PI-004: relative-path fetch to the same-origin dashboard server.
 */
import type React from "react";
import { useMemo } from "react";
import { useApi } from "../../hooks/useApi";
import { getJson, ApiError } from "../../api/client-http";
import type { RepoCorpusStatusV1 } from "@contracts";

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

export const VectorCortexRepoCorpusCard: React.FC = () => {
	const { data, error, loading } = useApi<RepoCorpusStatusV1 | null>(
		useMemo(
			() => () =>
				getJson<RepoCorpusStatusV1>("/api/repo-corpus").catch((e: unknown) => {
					// 404 = flag-off: surface to the renderer as disabled.
					if (e instanceof ApiError && e.status === 404) return null;
					throw e;
				}),
			[],
		),
		{ pollInterval: 5000 },
	);

	if (data === null && !error && !loading) {
		return (
			<div style={styles.disabled}>
				Cross-repo corpus: disabled (MEGACOMPACT_REPO_CORPUS=0).
			</div>
		);
	}

	return (
		<div style={styles.section}>
			<h3 style={styles.sectionTitle}>Cross-Repo Corpus</h3>
			<p style={styles.subtitle}>
				Pseudonymous consent status across donated repos
			</p>
			{error !== null ? (
				<p style={{ color: "#f44336", fontSize: "0.85rem" }}>
					Error loading corpus: {error.message}
				</p>
			) : data === null ? (
				<div style={styles.value}>Loading…</div>
			) : (
				<div>
					<div style={styles.row}>
						<span style={styles.label}>Status:</span>
						<span style={styles.value}>{data.status}</span>
					</div>
					<div style={styles.row}>
						<span style={styles.label}>Total events:</span>
						<span style={styles.value}>{data.totalEvents}</span>
					</div>
					<div style={styles.row}>
						<span style={styles.label}>Overlap pairs:</span>
						<span style={styles.value}>
							{data.corpus ? data.corpus.overlaps.length : 0}
						</span>
					</div>
					<div style={{ marginTop: "0.5rem" }}>
						{(data.perRepo ?? []).map((r) => (
							<div key={r.repoPseudonym} style={styles.row}>
								<span style={styles.label}>
									{r.repoPseudonym.slice(0, 8)}:
								</span>
								<span style={styles.value}>
									{r.sessions} sessions ·{" "}
									{r.consentedCrossRepo
										? r.revokedAt
											? `revoked ${r.revokedAt}`
											: "consented"
										: "not consented"}
								</span>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
};
