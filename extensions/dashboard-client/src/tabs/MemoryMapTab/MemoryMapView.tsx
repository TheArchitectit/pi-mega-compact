/**
 * MemoryMapTab/MemoryMapView.tsx — D3 memory map with force-directed graph.
 * Node shape encodes nodeType: checkpoint=filled circle, turn=hollow circle,
 * turn-content=hollow+ring, memory=diamond.
 * Fetches from /api/memory-map, renders SVG force layout.
 */
import type React from "react";
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { renderNodeShape, NODE_COLORS, NODE_TYPE_LABELS } from "../../memory-map-shapes.js";
import type { NodeType } from "../../memory-map-shapes.js";
import { buildLayout, applyForces } from "../../memory-map-layout.js";
import type { LayoutNode, LayoutEdge } from "../../memory-map-layout.js";

// Types (mirror of api-contracts/memory-map.ts — client-side only)

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
  /** Source type discriminator for UI node-shape encoding. */
  nodeType: "checkpoint" | "turn" | "turn-content" | "memory";
}

interface GraphEdge {
  source: string;
  target: string;
  weight: number;
  type: "temporal" | "semantic" | "raptor_parent";
}

interface GraphValidationReport {
  readonly gatesRun: number;
  readonly gatesPassed: number;
  readonly dropped: { nodes: number; edges: number };
  readonly warnings: Array<{ gate: string; code: string; count: number }>;
  readonly sources: {
    checkpoint: number;
    turn: number;
    turnContent: number;
    memory: number;
  };
  readonly builtAt: number;
}

interface GraphMetadata {
  totalNodes: number;
  totalEdges: number;
  avgWeight: number;
  nodeTypeBreakdown: Record<string, number>;
  edgeTypeBreakdown: Record<string, number>;
}

interface MemoryMapResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  metadata: GraphMetadata;
  /** Validation report from the 9-gate pipeline. Optional for backward compat. */
  validation?: GraphValidationReport;
}

// Simulation rendering constants (layout math is in memory-map-layout.ts)

const MAX_ITERATIONS = 300;
const EDGE_ALPHA = 0.3;
const SVG_WIDTH = 900;
const SVG_HEIGHT = 600;
const PADDING = 40;

// Helpers

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

// Minimal legend swatch component
interface SwatchProps {
  type: "node" | "edge";
  color: string;
  shape: "filled-circle" | "hollow-circle" | "hollow-ring" | "diamond" | "line";
  label: string;
}
const Swatch: React.FC<SwatchProps> = ({ color, shape, label }) => {
  const base: React.CSSProperties = {
    display: "inline-block",
    width: "10px",
    height: "10px",
    verticalAlign: "middle",
    marginRight: "3px",
    borderRadius: shape.startsWith("hollow") || shape === "filled-circle" ? "50%" : undefined,
  };
  let swatch: JSX.Element;
  if (shape === "line") {
    return <span style={{ color, marginRight: "6px" }}>{label}</span>;
  } else if (shape === "filled-circle") {
    swatch = <span style={{ ...base, backgroundColor: color }} />;
  } else if (shape === "hollow-circle") {
    swatch = <span style={{ ...base, border: `2px solid ${color}`, backgroundColor: "transparent" }} />;
  } else if (shape === "hollow-ring") {
    swatch = (
      <span style={{ ...base, border: `2px solid ${color}`, backgroundColor: "transparent", position: "relative" }}>
        <span style={{ display: "block", width: "4px", height: "4px", borderRadius: "50%", backgroundColor: color, margin: "2px auto" }} />
      </span>
    );
  } else {
    swatch = <span style={{ ...base, clipPath: "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)", backgroundColor: color }} />;
  }
  return <><span className="memory-map-legend-item">{swatch}{label}</span> </>;
};

// Force simulation engine (delegated to memory-map-layout.ts)
const MemoryMapView: React.FC = () => {
  const [data, setData] = useState<MemoryMapResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [filterSession] = useState<string>("");
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

  // Health indicator helpers (D3)

  /**
   * Derive graph health from validation report:
   * green = all gates passed + no warnings
   * yellow = warnings present but no critical gate failed
   * red = a critical gate (gatesRun > gatesPassed) failed
   */
  const graphHealth = useMemo<{ level: "green" | "yellow" | "red"; label: string }>(() => {
    const v = data?.validation;
    if (!v) return { level: "yellow", label: "No validation" };
    if (v.gatesPassed < v.gatesRun) return { level: "red", label: "Gate failure" };
    if (v.warnings.length > 0) return { level: "yellow", label: `${v.warnings.length} warning(s)` };
    return { level: "green", label: "Healthy" };
  }, [data?.validation]);

  const healthColor: Record<string, string> = {
    green: "#22c55e",
    yellow: "#eab308",
    red: "#ef4444",
  };

  // Source availability indicators (D3)

  /** Count badge fragments from validation.sources. */
  const countBadge = useMemo<string>(() => {
    const v = data?.validation;
    if (!v) {
      const totalNodes = data?.metadata.totalNodes ?? 0;
      return `${totalNodes} nodes`;
    }
    const parts: string[] = [];
    if (v.sources.checkpoint > 0) parts.push(`${v.sources.checkpoint} checkpoints`);
    if (v.sources.turn > 0) parts.push(`${v.sources.turn} turns`);
    if (v.sources.turnContent > 0) parts.push(`${v.sources.turnContent} turn-content`);
    if (v.sources.memory > 0) parts.push(`${v.sources.memory} memories`);
    if (parts.length === 0) {
      parts.push(`${data?.metadata.totalNodes ?? 0} nodes`);
    }
    return parts.join(" · ");
  }, [data?.validation, data?.metadata.totalNodes]);

  /** Per-source availability: ✓ for available sources, ✗ for empty ones. */
  const sourceAvail = useMemo<string>(() => {
    const v = data?.validation;
    if (!v) return "";
    const parts: string[] = [];
    parts.push(v.sources.checkpoint > 0 ? "✓ checkpoints" : "✗ checkpoints");
    parts.push(v.sources.turn > 0 ? "✓ turns" : "✗ turns");
    parts.push(v.sources.turnContent > 0 ? "✓ turn-content" : "✗ turn-content");
    parts.push(v.sources.memory > 0 ? "✓ memories" : "✗ memories");
    return parts.join(" | ");
  }, [data?.validation]);

  /** Whether all four sources are empty (true empty state). */
  const allSourcesEmpty = useMemo<boolean>(() => {
    const v = data?.validation;
    if (!v) return data?.metadata.totalNodes === 0;
    return (
      v.sources.checkpoint === 0 &&
      v.sources.turn === 0 &&
      v.sources.turnContent === 0 &&
      v.sources.memory === 0
    );
  }, [data?.validation, data?.metadata.totalNodes]);

  // Loading state

  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-bg-card p-6 text-center text-sm text-muted-foreground">
        Loading memory graph...
      </div>
    );
  }

  // Error state

  if (error) {
    return (
      <div className="rounded-lg border border-border bg-bg-card p-6 text-center text-sm">
        <p className="text-red-400">Failed to load memory map: {error}</p>
        <button
          className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-bg-elevated hover:text-foreground"
          onClick={() => setFrame((s) => s + 1)}
        >
          Retry
        </button>
      </div>
    );
  }

  // Empty state (D2)

  if (!data || !layoutRef.current || allSourcesEmpty) {
    return (
      <div className="rounded-lg border border-border bg-bg-card p-6 text-sm text-muted-foreground">
        <p>Memories appear after your first compaction. The graph shows checkpoints (compaction summaries) linked by semantic similarity and time. Run a longer session or lower the compaction tier to see it sooner.</p>
      </div>
    );
  }

  const layout = layoutRef.current;

  // Render

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Search memories..."
          value={searchQuery}
          onInput={(e: React.FormEvent<HTMLInputElement>) =>
            setSearchQuery((e.target as HTMLInputElement).value)
          }
          className="w-56 rounded-md border border-border bg-bg-elevated/50 px-3 py-2 text-sm outline-none transition-colors focus:border-primary"
        />
        <span className="text-xs text-muted-foreground">
          <span>{countBadge}</span>
          {" · "}
          <span>{data.edges.length} edges</span>
        </span>
        {/* Graph-health indicator */}
        <span
          className="ml-auto rounded-full px-2 py-1 text-[11px] font-semibold text-white"
          style={{ backgroundColor: healthColor[graphHealth.level] ?? "#6b7280" }}
          title={`Validation: ${graphHealth.label}`}
        >
          {graphHealth.level === "green" ? "Healthy" : graphHealth.level === "yellow" ? "Warnings" : "Critical"}
        </span>
      </div>

      {/* Source availability indicators */}
      {sourceAvail ? (
        <div className="text-[11px] text-muted-foreground">{sourceAvail}</div>
      ) : null}

      {/* Legend — node types + edge types */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border/60 bg-bg-card px-3 py-2 text-xs">
        <span className="font-semibold text-muted-foreground">Nodes:</span>
        <Swatch type="node" color={NODE_COLORS.checkpoint} shape="filled-circle" label="Checkpoint" />
        <Swatch type="node" color={NODE_COLORS.turn} shape="hollow-circle" label="Turn" />
        <Swatch type="node" color={NODE_COLORS["turn-content"]} shape="hollow-ring" label="Turn Content" />
        <Swatch type="node" color={NODE_COLORS.memory} shape="diamond" label="Memory" />
        <span className="font-semibold text-muted-foreground">Edges:</span>
        <Swatch type="edge" color={edgeColor("semantic")} shape="line" label="Semantic" />
        <Swatch type="edge" color={edgeColor("temporal")} shape="line" label="Temporal" />
        <Swatch type="edge" color={edgeColor("raptor_parent")} shape="line" label="Raptor" />
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

        {/* Nodes — shape encodes nodeType */}
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
            <g
              key={`node-${i}`}
              className="memory-map-node-group"
              onClick={() => handleNodeClick(n, i)}
              style={{ cursor: "pointer" }}
            >
              {renderNodeShape(cx, cy, radius, n.nodeType as NodeType, isSelected, isFiltered, n.dedupStatus)}
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
        <div className="rounded-lg border border-border/60 bg-bg-card p-4 text-sm">
          <h3 className="font-heading text-base font-semibold">
            <span className="mr-1.5 text-xs font-normal text-muted-foreground">
              {NODE_TYPE_LABELS[selectedNode.nodeType]}
            </span>
            {selectedNode.label}
          </h3>
          <p className="mt-1">{selectedNode.summaryTruncated}</p>
          {selectedNode.topicSummary ? (
            <p className="mt-1">Topic: {selectedNode.topicSummary}</p>
          ) : null}
          <p className="mt-1">
            Tokens: {selectedNode.tokenEstimate} | Decisions: {selectedNode.decisionCount}
          </p>
          <p>Session: {selectedNode.sessionId}</p>
          <p>Raptor Level: {selectedNode.raptorLevel}</p>
          <p className="mt-1 text-muted-foreground">{selectedNode.textSnippet}</p>
        </div>
      ) : null}
    </div>
  );
};

export default MemoryMapView;
