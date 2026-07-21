/**
 * dashboard-client/src/components/RepoDetailModal.tsx — repo drill-down.
 *
 * Full detail from an /api/index row: token breakdown (kept/dropped), model
 * info, context window, dedup rate, reasoning flag. Click backdrop to close.
 */

import type React from "react";
import { useEffect } from "react";
import type { IndexesIndexRow } from "@contracts";

export interface RepoDetailModalProps {
	repo: IndexesIndexRow;
	onClose: () => void;
}

function fmt(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

/** Format bytes → MiB/KiB/B (matches html.ts fmtBytesTop). */
function fmtBytesTop(b: number): string {
	if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(1)} MiB`;
	if (b >= 1024) return `${(b / 1024).toFixed(1)} KiB`;
	return `${b} B`;
}

function formatTs(ts: number | null): string {
	if (ts === null || ts === undefined) return "never";
	try {
		return new Date(ts).toLocaleString();
	} catch {
		return String(ts);
	}
}

export function RepoDetailModal({
	repo,
	onClose,
}: RepoDetailModalProps): React.ReactElement {
	// Close on Escape key.
	useEffect(() => {
		const handler = (e: KeyboardEvent): void => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [onClose]);

	return (
		<div
			className="modal-backdrop"
			onClick={onClose}
			role="dialog"
			aria-modal="true"
		>
			<div className="modal-card" onClick={(e) => e.stopPropagation()}>
				<header className="modal-header">
					<h2>{repo.displayName}</h2>
					<button
						type="button"
						className="modal-close"
						onClick={onClose}
						aria-label="Close"
					>
						×
					</button>
				</header>
				<p className="modal-path">{repo.repoRoot}</p>
				<div className="modal-grid">
					<div className="modal-stat">
						<span className="modal-label">Checkpoints</span>
						<span className="modal-value">
							{repo.checkpointCount.toLocaleString()}
						</span>
					</div>
					<div className="modal-stat">
						<span className="modal-label">Sessions</span>
						<span className="modal-value">
							{repo.sessions.toLocaleString()}
						</span>
					</div>
					<div className="modal-stat modal-highlight">
						<span className="modal-label">Tokens saved</span>
						<span className="modal-value">{fmt(repo.tokensSaved)}</span>
					</div>
					<div className="modal-stat">
						<span className="modal-label">Tokens kept</span>
						<span className="modal-value">{fmt(repo.tokensKept)}</span>
					</div>
					<div className="modal-stat">
						<span className="modal-label">Tokens dropped</span>
						<span className="modal-value">{fmt(repo.tokensDropped)}</span>
					</div>
					<div className="modal-stat">
						<span className="modal-label">Dedup rate</span>
						<span className="modal-value">—</span>
					</div>
				</div>
				<h3>Model</h3>
				<dl className="modal-dl">
					<dt>Provider</dt>
					<dd>{repo.providerName ?? "—"}</dd>
					<dt>Model</dt>
					<dd>{repo.modelName ?? "—"}</dd>
					<dt>Input rate</dt>
					<dd>{repo.inputRate !== null ? `${repo.inputRate} tok/s` : "—"}</dd>
					<dt>Output rate</dt>
					<dd>{repo.outputRate !== null ? `${repo.outputRate} tok/s` : "—"}</dd>
					<dt>Context window</dt>
					<dd>{repo.contextWindow !== null ? fmt(repo.contextWindow) : "—"}</dd>
					<dt>Max tokens</dt>
					<dd>{repo.maxTokens !== null ? fmt(repo.maxTokens) : "—"}</dd>
					<dt>Reasoning</dt>
					<dd>
						{repo.reasoning === null ? "—" : repo.reasoning ? "on" : "off"}
					</dd>
				</dl>
				<h3>Activity</h3>
				<dl className="modal-dl">
					<dt>Last compacted</dt>
					<dd>{formatTs(repo.lastCompactedAt)}</dd>
					<dt>Last seen</dt>
					<dd>{formatTs(repo.lastSeen)}</dd>
					<dt>Compressed-Original</dt>
					<dd>{fmtBytesTop(repo.compressedOriginalBytes)}</dd>
				</dl>
			</div>
		</div>
	);
}
