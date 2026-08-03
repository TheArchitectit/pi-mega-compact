/**
 * MemoryMapTab/RaptorTreeView.tsx — RAPTOR tree sub-tab (Part B).
 *
 * Fetches the hierarchical RAPTOR tree from /api/raptor-tree (defaults to the
 * most recent session with nodes) and renders it as level-indented summary
 * cards. No D3 needed — CSS indentation encodes hierarchy.
 */
import type React from "react";
import { useEffect, useState } from "react";
import { fetchRaptorTree, fetchRaptorBuildHistory } from "../../api/client";
import type {
	RaptorTreeResponse,
	RaptorNodeDTO,
	RaptorBuildHistoryResponse,
} from "@contracts";

/** Per-level border color for node cards. */
function levelColor(level: number): string {
	if (level === 0) return "#d4a017"; // gold — root
	if (level === 1) return "#3b82f6"; // blue
	return "#14b8a6"; // teal — level 2+
}

function formatDate(ts: number): string {
	if (!ts) return "—";
	return new Date(ts).toLocaleString();
}

function NodeCard({ node }: { node: RaptorNodeDTO }): React.ReactElement {
	const border = levelColor(node.level);
	const childrenLabel =
		node.children.length > 0
			? `${node.children.length} child${node.children.length === 1 ? "" : "ren"}`
			: "leaf";
	return (
		<div
			style={{
				background: "#14142b",
				border: `1px solid ${border}`,
				borderRadius: "8px",
				padding: "0.75rem 1rem",
				marginBottom: "0.6rem",
				marginLeft: node.level * 24,
				maxWidth: "90%",
			}}
		>
			<div style={{ display: "flex", gap: "0.75rem", alignItems: "center", marginBottom: "0.35rem" }}>
				<span
					style={{
						display: "inline-block",
						background: border,
						color: "#fff",
						borderRadius: "10px",
						padding: "1px 8px",
						fontSize: "11px",
						fontWeight: 600,
					}}
				>
					L{node.level}
				</span>
				<span style={{ fontSize: "12px", color: "#6b7280" }}>
					{childrenLabel} · {node.tokenEstimate} tok · {node.qualityMarker}
				</span>
				<span style={{ fontSize: "12px", color: "#6b7280", marginLeft: "auto" }}>
					{formatDate(node.builtAt)}
				</span>
			</div>
			<div style={{ fontSize: "0.92rem", color: "#e5e7eb" }}>{node.summary}</div>
		</div>
	);
}

export default function RaptorTreeView(): React.ReactElement {
	const [data, setData] = useState<RaptorTreeResponse | null>(null);
	const [history, setHistory] = useState<RaptorBuildHistoryResponse | null>(null);
	const [loading, setLoading] = useState<boolean>(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		Promise.all([fetchRaptorTree(), fetchRaptorBuildHistory()])
			.then(([d, h]) => {
				if (!cancelled) {
					setData(d);
					setHistory(h);
					setLoading(false);
				}
			})
			.catch((e: unknown) => {
				if (!cancelled) {
					setError(e instanceof Error ? e.message : "Unknown error");
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, []);

	if (loading) {
		return (
			<div className="rounded-lg border border-border bg-bg-card p-6 text-center text-sm text-muted-foreground">
				Loading RAPTOR tree...
			</div>
		);
	}

	if (error) {
		return (
			<div className="rounded-lg border border-dashed border-border bg-bg-card p-8 text-center text-sm">
				<p className="text-red-400">Failed to load RAPTOR tree: {error}</p>
			</div>
		);
	}

	if (!data || data.empty || data.nodes.length === 0) {
		return (
			<div className="rounded-lg border border-dashed border-border bg-bg-card p-8 text-center text-sm text-muted-foreground">
				<p>
					No RAPTOR tree built yet — run a compaction (the tree builds during
					compaction).
				</p>
			</div>
		);
	}

	const latestBuild = history && !history.empty ? history.builds[0] : null;
	const coherencePct = latestBuild?.coherenceScore != null
		? Math.round(latestBuild.coherenceScore * 100)
		: null;

	return (
		<div className="w-full p-4">
			<div className="mb-4 flex items-center gap-6 text-sm text-muted-foreground">
				<span>
					<strong>{data.nodes.length}</strong> nodes
				</span>
				<span>
					<strong>{data.levels + 1}</strong> levels
				</span>
				<span>Built {formatDate(data.builtAt ?? 0)}</span>
				{latestBuild && (
					<>
						<span>
							Coherence:{" "}
							<strong style={{ color: coherencePct != null && coherencePct >= 70 ? "#22c55e" : "#f59e0b" }}>
								{coherencePct != null ? `${coherencePct}%` : "—"}
							</strong>
						</span>
						<span>
							Leaves: <strong>{latestBuild.leafCount}</strong>
						</span>
						<span>
							Depth: <strong>{latestBuild.depth}</strong>
						</span>
						{latestBuild.timedOut && (
							<span style={{ color: "#ef4444" }}>budget timeout</span>
						)}
					</>
				)}
			</div>
			{history && !history.empty && history.builds.length > 1 && (
				<details className="mb-4">
					<summary className="cursor-pointer text-xs text-muted-foreground">
						Build history ({history.builds.length} builds)
					</summary>
					<div className="mt-2 space-y-1">
						{history.builds.slice(0, 10).map((b) => (
							<div key={b.buildId} className="flex items-center gap-4 text-xs text-muted-foreground">
								<span>{formatDate(b.completedAt)}</span>
								<span>{b.nodeCount} nodes</span>
								<span>{b.leafCount} leaves</span>
								<span>depth {b.depth}</span>
								<span>
									coherence{" "}
									{b.coherenceScore != null
										? `${Math.round(b.coherenceScore * 100)}%`
										: "—"}
								</span>
								{b.timedOut && <span style={{ color: "#ef4444" }}>timeout</span>}
							</div>
						))}
					</div>
				</details>
			)}
			{data.nodes.map((node) => (
				<NodeCard key={node.id} node={node} />
			))}
		</div>
	);
}
