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
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
			onClick={onClose}
			role="dialog"
			aria-modal="true"
		>
			<div
				className="max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-xl border border-border bg-bg-card p-5 shadow-panel"
				onClick={(e) => e.stopPropagation()}
			>
				<header className="mb-2 flex items-start justify-between gap-4">
					<h2 className="font-heading text-lg font-semibold">{repo.displayName}</h2>
					<button
						type="button"
						className="text-2xl leading-none text-muted-foreground hover:text-foreground"
						onClick={onClose}
						aria-label="Close"
					>
						×
					</button>
				</header>
				<p className="mb-4 break-all font-mono text-xs text-muted-foreground">{repo.repoRoot}</p>
				<div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
					<div className="rounded-md border border-border/50 bg-bg-elevated/40 p-3">
						<span className="block text-xs text-muted-foreground">Checkpoints</span>
						<span className="text-xl font-semibold">
							{repo.checkpointCount.toLocaleString()}
						</span>
					</div>
					<div className="rounded-md border border-border/50 bg-bg-elevated/40 p-3">
						<span className="block text-xs text-muted-foreground">Sessions</span>
						<span className="text-xl font-semibold">
							{repo.sessions.toLocaleString()}
						</span>
					</div>
					<div className="rounded-md border border-border/50 bg-primary/10 p-3">
						<span className="block text-xs text-muted-foreground">Tokens saved</span>
						<span className="text-xl font-semibold">{fmt(repo.tokensSaved)}</span>
					</div>
					<div className="rounded-md border border-border/50 bg-bg-elevated/40 p-3">
						<span className="block text-xs text-muted-foreground">Tokens kept</span>
						<span className="text-xl font-semibold">{fmt(repo.tokensKept)}</span>
					</div>
					<div className="rounded-md border border-border/50 bg-bg-elevated/40 p-3">
						<span className="block text-xs text-muted-foreground">Tokens dropped</span>
						<span className="text-xl font-semibold">{fmt(repo.tokensDropped)}</span>
					</div>
					<div className="rounded-md border border-border/50 bg-bg-elevated/40 p-3">
						<span className="block text-xs text-muted-foreground">Dedup rate</span>
						<span className="text-xl font-semibold">—</span>
					</div>
				</div>
				<h3 className="mb-2 font-heading text-sm font-semibold">Model</h3>
				<dl className="mb-4 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
					<dt className="text-muted-foreground">Provider</dt>
					<dd className="text-right">{repo.providerName ?? "—"}</dd>
					<dt className="text-muted-foreground">Model</dt>
					<dd className="text-right">{repo.modelName ?? "—"}</dd>
					<dt className="text-muted-foreground">Input rate</dt>
					<dd className="text-right">{repo.inputRate !== null ? `${repo.inputRate} tok/s` : "—"}</dd>
					<dt className="text-muted-foreground">Output rate</dt>
					<dd className="text-right">{repo.outputRate !== null ? `${repo.outputRate} tok/s` : "—"}</dd>
					<dt className="text-muted-foreground">Context window</dt>
					<dd className="text-right">{repo.contextWindow !== null ? fmt(repo.contextWindow) : "—"}</dd>
					<dt className="text-muted-foreground">Max tokens</dt>
					<dd className="text-right">{repo.maxTokens !== null ? fmt(repo.maxTokens) : "—"}</dd>
					<dt className="text-muted-foreground">Reasoning</dt>
					<dd className="text-right">
						{repo.reasoning === null ? "—" : repo.reasoning ? "on" : "off"}
					</dd>
				</dl>
				<h3 className="mb-2 font-heading text-sm font-semibold">Activity</h3>
				<dl className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
					<dt className="text-muted-foreground">Last compacted</dt>
					<dd className="text-right">{formatTs(repo.lastCompactedAt)}</dd>
					<dt className="text-muted-foreground">Last seen</dt>
					<dd className="text-right">{formatTs(repo.lastSeen)}</dd>
					<dt className="text-muted-foreground">Compressed-Original</dt>
					<dd className="text-right">{fmtBytesTop(repo.compressedOriginalBytes)}</dd>
				</dl>
			</div>
		</div>
	);
}
