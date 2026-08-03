/**
 * dashboard-client/src/tabs/WikiTab/TopicEvolutionGraph.tsx — D3 evolution.
 *
 * Force-directed graph of wiki topics over time. Nodes are topics (radius scales
 * with memoryCount); edges are merge/split curation events. A bucket scrubber
 * (from the response buckets) dims nodes that had no activity up to the selected
 * time window — a lightweight "growth over time" view.
 *
 * Self-contained force simulation (Coulomb repulsion + Hooke attraction +
 * center gravity) — the codebase deliberately avoids external graph libraries
 * (see memory-map-layout.ts). No data is fabricated: only real node/edge/bucket
 * fields from the contract are used. Styling is Tailwind.
 */

import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TopicEvolutionResponse } from "@contracts";

// ── Simulation constants ────────────────────────────────────────────────
const W = 900;
const H = 560;
const REPULSION = 60_000;
const ATTRACTION = 0.012;
const CENTER_GRAVITY = 0.012;
const DAMPING = 0.8;
const SPEED_LIMIT = 2;
const MIN_VELOCITY = 0.02;
const MAX_ITERATIONS = 250;

interface SimNode {
	id: string;
	label: string;
	memoryCount: number;
	pos: { x: number; y: number };
	vx: number;
	vy: number;
}

interface SimEdge {
	source: number;
	target: number;
	kind: "merge" | "split";
}

function edgeColor(kind: "merge" | "split"): string {
	return kind === "merge" ? "#f59e0b" : "#22c55e"; // amber / green
}

function initialLayout(nodes: TopicEvolutionResponse["nodes"]): SimNode[] {
	return nodes.map((n, i) => {
		const angle = (2 * Math.PI * i) / Math.max(nodes.length, 1);
		return {
			id: n.id,
			label: n.label,
			memoryCount: n.memoryCount,
			pos: { x: Math.cos(angle) * 220 + W / 2, y: Math.sin(angle) * 220 + H / 2 },
			vx: 0,
			vy: 0,
		};
	});
}

function applyForces(sim: { nodes: SimNode[]; edges: SimEdge[] }): void {
	const { nodes, edges } = sim;
	for (let i = 0; i < nodes.length; i++) {
		const n = nodes[i];
		let fx = 0;
		let fy = 0;
		for (let j = 0; j < nodes.length; j++) {
			if (i === j) continue;
			const dx = n.pos.x - nodes[j].pos.x;
			const dy = n.pos.y - nodes[j].pos.y;
			const distSq = dx * dx + dy * dy || 1;
			const dist = Math.sqrt(distSq);
			fx += (dx / dist) * (REPULSION / distSq);
			fy += (dy / dist) * (REPULSION / distSq);
		}
		for (const e of edges) {
			let other: number;
			if (e.source === i) other = e.target;
			else if (e.target === i) other = e.source;
			else continue;
			const dx = nodes[other].pos.x - n.pos.x;
			const dy = nodes[other].pos.y - n.pos.y;
			fx += dx * ATTRACTION;
			fy += dy * ATTRACTION;
		}
		fx -= n.pos.x * CENTER_GRAVITY;
		fy -= n.pos.y * CENTER_GRAVITY;
		n.vx = (n.vx + fx) * DAMPING;
		n.vy = (n.vy + fy) * DAMPING;
		const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
		if (speed > SPEED_LIMIT) {
			n.vx = (n.vx / speed) * SPEED_LIMIT;
			n.vy = (n.vy / speed) * SPEED_LIMIT;
		}
		if (speed > MIN_VELOCITY) {
			n.pos.x += n.vx;
			n.pos.y += n.vy;
		}
	}
}

interface Props {
	data: TopicEvolutionResponse;
}

export default function TopicEvolutionGraph({
	data,
}: Props): React.ReactElement {
	const simRef = useRef<{
		nodes: SimNode[];
		edges: SimEdge[];
		timeByActivity: Map<string, number> | null;
	} | null>(null);
	const animRef = useRef(0);
	const [, setFrame] = useState(0);
	const [scrub, setScrub] = useState<number>(0);

	// Initialize simulation from data (re-run when data changes).
	useEffect(() => {
		const nodes = initialLayout(data.nodes);
		const indexById = new Map(nodes.map((n, i) => [n.id, i]));
		const edges: SimEdge[] = data.edges
			.map((e) => {
				const si = indexById.get(e.source);
				const ti = indexById.get(e.target);
				if (si === undefined || ti === undefined || si === ti) return null;
				return { source: si, target: ti, kind: e.kind };
			})
			.filter((e): e is SimEdge => e !== null);
		// Latest activity per node (from merge/split edge timestamps).
		const timeByActivity = new Map<string, number>();
		for (const e of data.edges) {
			timeByActivity.set(e.source, Math.max(timeByActivity.get(e.source) ?? 0, e.at));
			timeByActivity.set(e.target, Math.max(timeByActivity.get(e.target) ?? 0, e.at));
		}
		simRef.current = { nodes, edges, timeByActivity };
		setFrame(1);
		return () => cancelAnimationFrame(animRef.current);
	}, [data]);

	// Run the force simulation to stable layout.
	useEffect(() => {
		if (!simRef.current) return;
		let iter = 0;
		const tick = () => {
			if (!simRef.current || iter >= MAX_ITERATIONS) return;
			applyForces(simRef.current);
			iter++;
			setFrame(iter);
			animRef.current = requestAnimationFrame(tick);
		};
		animRef.current = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(animRef.current);
	}, [data]);

	const sim = simRef.current;

	const scrubMax = Math.max(data.buckets.length - 1, 0);
	const scrubBucket = useMemo(() => {
		if (data.buckets.length === 0) return null;
		const idx = Math.min(scrub, data.buckets.length - 1);
		return data.buckets[idx].bucket;
	}, [scrub, data.buckets]);

	if (!sim || data.nodes.length === 0) {
		return (
			<div className="rounded-lg border border-border bg-bg-card p-6 text-sm text-muted-foreground">
				No evolution data yet. Merge or split topics to see connections, then
				check back after a rebuild.
			</div>
		);
	}

	const activeSet =
		scrubBucket == null || !sim.timeByActivity
			? null
			: new Set(
					[...sim.timeByActivity.entries()]
						.filter(([, t]) => t <= scrubBucket)
						.map(([id]) => id),
				);

	return (
		<div className="flex flex-col gap-3">
			{/* Scrubber */}
			{data.buckets.length > 1 && (
				<div className="flex items-center gap-3">
					<input
						type="range"
						min={0}
						max={scrubMax}
						value={scrub}
						onChange={(e) => setScrub(Number(e.target.value))}
						className="w-full accent-primary"
						aria-label="Scrub through topic activity time"
					/>
					<span className="whitespace-nowrap text-xs text-muted-foreground">
						{scrubBucket ? new Date(scrubBucket).toLocaleDateString() : "all"}
					</span>
				</div>
			)}

			{/* SVG graph */}
			<svg
				width="100%"
				height={H}
				viewBox={`0 0 ${W} ${H}`}
				role="img"
				aria-label="Topic evolution graph"
				className="rounded-lg border border-border/60 bg-bg-card"
			>
				{sim.edges.map((e, i) => {
					const a = sim.nodes[e.source];
					const b = sim.nodes[e.target];
					return (
						<line
							key={`edge-${i}`}
							x1={a.pos.x}
							y1={a.pos.y}
							x2={b.pos.x}
							y2={b.pos.y}
							stroke={edgeColor(e.kind)}
							strokeWidth={1.5}
							strokeDasharray={e.kind === "split" ? "4 3" : undefined}
							opacity={0.5}
						/>
					);
				})}
				{sim.nodes.map((n, i) => {
					const active =
						activeSet == null || activeSet.size === 0 || activeSet.has(n.id);
					const r = Math.min(32, 8 + n.memoryCount * 3);
					return (
						<g key={`node-${i}`} opacity={active ? 1 : 0.15}>
							<circle
								cx={n.pos.x}
								cy={n.pos.y}
								r={r}
								fill="hsl(var(--primary) / 0.18)"
								stroke="hsl(var(--primary))"
								strokeWidth={1.5}
							/>
							<text
								x={n.pos.x}
								y={n.pos.y + 4}
								textAnchor="middle"
								fontSize="10px"
								fill="hsl(var(--foreground))"
								className="pointer-events-none"
							>
								{n.label.length > 16 ? n.label.slice(0, 15) + "…" : n.label}
							</text>
						</g>
					);
				})}
			</svg>

			<div className="flex items-center gap-4 text-xs text-muted-foreground">
				<span className="flex items-center gap-1.5">
					<span className="inline-block h-0.5 w-6 bg-amber-500" /> merge
				</span>
				<span className="flex items-center gap-1.5">
					<span className="inline-block h-0.5 w-6 border-t border-dashed border-green-500" />
					split
				</span>
				<span>
					{data.nodes.length} nodes · {data.edges.length} curation events
				</span>
			</div>
		</div>
	);
}
