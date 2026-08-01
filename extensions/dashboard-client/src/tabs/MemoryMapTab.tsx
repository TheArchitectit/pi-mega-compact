/**
 * MemoryMapTab.tsx — S46 visual memory map (force-directed graph of checkpoints).
 *
 * Fetches graph data from /api/memory-map and renders an SVG-based
 * force-directed layout. Uses no external graph library (no @xyflow/react).
 * The simulation uses Coulomb repulsion + Hooke attraction + center gravity.
 */
import type React from "react";
import { useEffect, useRef, useState, useCallback, useMemo } from "react";

// ---------------------------------------------------------------------------
// Types (mirror of api-contracts/memory-map.ts — client-side only)
// ---------------------------------------------------------------------------

interface GraphNode {
  id: string;
  sessionId: string;
  label: string;
  summaryTruncated: string;
  tokenEstimate: number;
  timestamp: number;
  dedupStatus: string | undefined;
  raptorLevel: number;
  topicSummary: string | undefined;
  decisionCount: number;
  textSnippet: string;
}

interface GraphEdge {
  source: string;
  target: string;
  weight: number;
  type: "temporal" | "semantic" | "raptor_parent";
}

interface GraphMetadata {
  sessionCount: number;
  totalCheckpoints: number;
  totalEdges: number;
  semanticEdgeCount: number;
  temporalEdgeCount: number;
  raptorEdgeCount: number;
  similarityThresholdUsed: number;
  builtAt: number;
}

interface MemoryMapResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  metadata: GraphMetadata;
}

// ---------------------------------------------------------------------------
// Force-directed layout types
// ---------------------------------------------------------------------------

interface Position {
  x: number;
  y: number;
}

interface LayoutNode extends GraphNode {
  pos: Position;
  vx: number;
  vy: number;
  pinned: boolean;
}

interface LayoutEdge {
  source: number;
  target: number;
  weight: number;
  type: GraphEdge["type"];
}

// ---------------------------------------------------------------------------
// Force simulation constants
// ---------------------------------------------------------------------------

const REPULSION = 5_000;
const ATTRACTION = 0.005;
const CENTER_GRAVITY = 0.01;
const DAMPING = 0.9;
const MIN_VELOCITY = 0.1;
const MAX_ITERATIONS = 300;
const EDGE_ALPHA = 0.3;
const SVG_WIDTH = 900;
const SVG_HEIGHT = 600;
const PADDING = 40;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function edgeColor(type: GraphEdge["type"]): string {
  switch (type) {
    case "temporal":
      return "#6366f1"; // indigo
    case "semantic":
      return "#22c55e"; // green
    case "raptor_parent":
      return "#f59e0b"; // amber
  }
}

function nodeOpacity(dedupStatus: string | undefined): number {
  if (!dedupStatus || dedupStatus === "active") return 1;
  return 0.5;
}

// ---------------------------------------------------------------------------
// Force simulation engine
// ---------------------------------------------------------------------------

function buildLayout(data: MemoryMapResponse): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  const nodes: LayoutNode[] = data.nodes.map((n, i) => {
    const angle = (2 * Math.PI * i) / Math.max(data.nodes.length, 1);
    const radius = 200;
    return {
      ...n,
      pos: { x: Math.cos(angle) * radius + 300, y: Math.sin(angle) * radius + 200 },
      vx: 0,
      vy: 0,
      pinned: false,
    };
  });

  const nodeIndex = new Map<string, number>();
  nodes.forEach((n, i) => nodeIndex.set(n.id, i));

  const edges: LayoutEdge[] = data.edges
    .map((e) => {
      const si = nodeIndex.get(e.source);
      const ti = nodeIndex.get(e.target);
      if (si === undefined || ti === undefined || si === ti) return null;
      return { source: si, target: ti, weight: e.weight, type: e.type };
    })
    .filter((e): e is LayoutEdge => e !== null);

  return { nodes, edges };
}

function applyForces(layout: { nodes: LayoutNode[]; edges: LayoutEdge[] }): void {
  const { nodes, edges } = layout;
  const n = nodes.length;
  if (n === 0) return;

  for (let i = 0; i < n; i++) {
    if (nodes[i].pinned) continue;
    let fx = 0;
    let fy = 0;

    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const dx = nodes[i].pos.x - nodes[j].pos.x;
      const dy = nodes[i].pos.y - nodes[j].pos.y;
      const distSq = dx * dx + dy * dy || 1;
      const force = REPULSION / distSq;
      const dist = Math.sqrt(distSq);
      fx += (dx / dist) * force;
      fy += (dy / dist) * force;
    }

    for (const e of edges) {
      let other: number;
      if (e.source === i) other = e.target;
      else if (e.target === i) other = e.source;
      else continue;
      const dx = nodes[other].pos.x - nodes[i].pos.x;
      const dy = nodes[other].pos.y - nodes[i].pos.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      fx += dx * ATTRACTION * e.weight;
      fy += dy * ATTRACTION * e.weight;
    }

    fx -= nodes[i].pos.x * CENTER_GRAVITY;
    fy -= nodes[i].pos.y * CENTER_GRAVITY;

    nodes[i].vx = (nodes[i].vx + fx) * DAMPING;
    nodes[i].vy = (nodes[i].vy + fy) * DAMPING;

    const speed = Math.sqrt(nodes[i].vx * nodes[i].vx + nodes[i].vy * nodes[i].vy);
    if (speed > 50) {
      nodes[i].vx = (nodes[i].vx / speed) * 50;
      nodes[i].vy = (nodes[i].vy / speed) * 50;
    }

    if (speed > MIN_VELOCITY) {
      nodes[i].pos.x += nodes[i].vx;
      nodes[i].pos.y += nodes[i].vy;
    }
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const MemoryMapTab: React.FC = () => {
  const [data, setData] = useState<MemoryMapResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [filterSession, setFilterSession] = useState<string>("");
  const [frame, setFrame] = useState<number>(0);

  const layoutRef = useRef<{ nodes: LayoutNode[]; edges: LayoutEdge[] } | null>(null);
  const animRef = useRef<number>(0);

  // Fetch graph data when filterSession changes
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (filterSession) params.set("sessionId", filterSession);
    params.set("threshold", "0.7");
    params.set("maxEdgesPerNode", "4");

    setLoading(true);
    setError(null);

    fetch(`/api/memory-map?${params.toString()}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<MemoryMapResponse>;
      })
      .then((d) => {
        if (!cancelled) {
          setData(d);
          layoutRef.current = buildLayout(d);
          setFrame(1);
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
      cancelAnimationFrame(animRef.current);
    };
  }, [filterSession]);

  // Run force simulation via requestAnimationFrame
  useEffect(() => {
    if (!layoutRef.current || frame === 0) return;

    const layout = layoutRef.current;
    let iter = 0;

    const tick = () => {
      if (iter >= MAX_ITERATIONS) return;
      applyForces(layout);
      iter++;
      setFrame(iter);
      animRef.current = requestAnimationFrame(tick);
    };

    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
  }, [frame]);

  // Toggle pin / select a node
  const handleNodeClick = useCallback((node: LayoutNode, index: number) => {
    const layout = layoutRef.current;
    if (!layout) return;
    layout.nodes[index].pinned = !layout.nodes[index].pinned;
    if (!layout.nodes[index].pinned) {
      layout.nodes[index].vx = 0;
      layout.nodes[index].vy = 0;
    }
    setSelectedNode((prev) => (prev?.id === node.id ? null : (node as unknown as GraphNode)));
    setFrame((s) => s + 1);
  }, []);

  // Filtered node indices for search
  const filteredSet = useMemo<Set<number> | null>(() => {
    const layout = layoutRef.current;
    if (!layout || !searchQuery) return null;
    const q = searchQuery.toLowerCase();
    return new Set(
      layout.nodes
        .map((n, i) =>
          n.summaryTruncated.toLowerCase().includes(q) || n.label.toLowerCase().includes(q) ? i : -1,
        )
        .filter((i) => i >= 0),
    );
  }, [searchQuery]);

  // ---------- Loading state ----------

  if (loading) {
    return <div className="memory-map-loading">Loading memory graph...</div>;
  }

  // ---------- Error state ----------

  if (error) {
    return (
      <div className="memory-map-error">
        <p>Failed to load memory map: {error}</p>
        <button
          className="memory-map-retry-btn"
          onClick={() => setFrame((s) => s + 1)}
        >
          Retry
        </button>
      </div>
    );
  }

  // ---------- Empty state ----------

  if (!data || !layoutRef.current) {
    return <div className="memory-map-empty">No memory data available.</div>;
  }

  const layout = layoutRef.current;

  // ---------- Render ----------

  return (
    <div className="memory-map-container">
      {/* Toolbar */}
      <div className="memory-map-toolbar">
        <input
          type="text"
          placeholder="Search memories..."
          value={searchQuery}
          onInput={(e: React.FormEvent<HTMLInputElement>) =>
            setSearchQuery((e.target as HTMLInputElement).value)
          }
          className="memory-map-search"
        />
        <span className="memory-map-stats">
          {data.nodes.length} memories, {data.edges.length} edges
          <br />
          Sessions: {data.metadata.sessionCount} | Threshold:{" "}
          {data.metadata.similarityThresholdUsed.toFixed(2)}
        </span>
      </div>

      {/* Legend */}
      <div className="memory-map-legend">
        <span style={{ color: edgeColor("semantic") }}>Semantic</span>
        <span style={{ color: edgeColor("temporal") }}>Temporal</span>
        <span style={{ color: edgeColor("raptor_parent") }}>Raptor</span>
      </div>

      {/* SVG graph */}
      <svg
        width={SVG_WIDTH}
        height={SVG_HEIGHT}
        viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
        className="memory-map-svg"
      >
        {/* Edges */}
        {layout.edges.map((e, i) => {
          const src = layout.nodes[e.source];
          const tgt = layout.nodes[e.target];
          const color = edgeColor(e.type);
          const strokeW = Math.max(1, e.weight * 2.5);
          return (
            <line
              key={`edge-${i}`}
              x1={PADDING + (src.pos.x / (layout.nodes.length || 1)) * (SVG_WIDTH - 2 * PADDING)}
              y1={PADDING + (src.pos.y / (layout.nodes.length || 1)) * (SVG_HEIGHT - 2 * PADDING)}
              x2={PADDING + (tgt.pos.x / (layout.nodes.length || 1)) * (SVG_WIDTH - 2 * PADDING)}
              y2={PADDING + (tgt.pos.y / (layout.nodes.length || 1)) * (SVG_HEIGHT - 2 * PADDING)}
              stroke={color}
              strokeWidth={strokeW}
              opacity={EDGE_ALPHA}
            />
          );
        })}

        {/* Nodes */}
        {layout.nodes.map((n, i) => {
          const cx =
            PADDING + (n.pos.x / (layout.nodes.length || 1)) * (SVG_WIDTH - 2 * PADDING);
          const cy =
            PADDING + (n.pos.y / (layout.nodes.length || 1)) * (SVG_HEIGHT - 2 * PADDING);
          const radius = Math.min(20, 8 + n.tokenEstimate / 500);
          const isFiltered = filteredSet ? filteredSet.has(i) : true;
          const isSelected = selectedNode?.id === n.id;
          const nodeLabel = n.label.length > 20 ? n.label.slice(0, 18) + "..." : n.label;

          return (
            <g key={`node-${i}`} className="memory-map-node-group">
              <circle
                cx={cx}
                cy={cy}
                r={isSelected ? radius + 3 : radius}
                fill={isFiltered ? (n.raptorLevel > 0 ? "#f59e0b" : "#6366f1") : "#d1d5db"}
                opacity={nodeOpacity(n.dedupStatus)}
                stroke={isSelected ? "#ef4444" : "none"}
                strokeWidth={isSelected ? 2 : 0}
                className="memory-map-node"
                onClick={() => handleNodeClick(n, i)}
              />
              <text
                x={cx}
                y={cy + radius + 12}
                textAnchor="middle"
                fontSize="9px"
                fill="#374151"
                className="memory-map-label"
              >
                {nodeLabel}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Node detail panel */}
      {selectedNode ? (
        <div className="memory-map-detail">
          <h3>{selectedNode.label}</h3>
          <p>{selectedNode.summaryTruncated}</p>
          {selectedNode.topicSummary ? (
            <p className="memory-map-topic">Topic: {selectedNode.topicSummary}</p>
          ) : null}
          <p>
            Tokens: {selectedNode.tokenEstimate} | Decisions: {selectedNode.decisionCount}
          </p>
          <p>Session: {selectedNode.sessionId}</p>
          <p>Raptor Level: {selectedNode.raptorLevel}</p>
          <p className="memory-map-snippet">{selectedNode.textSnippet}</p>
        </div>
      ) : null}
    </div>
  );
};

export default MemoryMapTab;
