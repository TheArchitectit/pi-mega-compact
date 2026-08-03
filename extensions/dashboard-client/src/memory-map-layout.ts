/**
 * memory-map-layout.ts — Force-directed layout engine for MemoryMapTab (D3).
 *
 * Uses Coulomb repulsion + Hooke attraction + center gravity to arrange nodes.
 * No external graph library. Mutates layout in place.
 * Self-contained types: only needs id + edges from graph data.
 */

// ---------------------------------------------------------------------------
// Types (self-contained — mirrors the subset used by the layout engine)
// ---------------------------------------------------------------------------

interface GraphNodeMin {
  readonly id: string;
  readonly nodeType: string;
  readonly label: string;
  readonly summaryTruncated: string;
  readonly tokenEstimate: number;
  readonly timestamp: number;
  readonly dedupStatus: string | undefined;
  readonly raptorLevel: number;
  readonly topicSummary: string | undefined;
  readonly decisionCount: number;
  readonly textSnippet: string;
  readonly sessionId: string;
}

interface GraphEdgeMin {
  readonly source: string;
  readonly target: string;
  readonly weight: number;
  readonly type: "temporal" | "semantic" | "raptor_parent";
}

export interface Position {
  x: number;
  y: number;
}

export interface LayoutNode extends GraphNodeMin {
  pos: Position;
  vx: number;
  vy: number;
  pinned: boolean;
}

export interface LayoutEdge {
  source: number;
  target: number;
  weight: number;
  type: GraphEdgeMin["type"];
}

export interface Layout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPULSION = 5_000;
const ATTRACTION = 0.005;
const CENTER_GRAVITY = 0.01;
const DAMPING = 0.9;
const MIN_VELOCITY = 0.1;
const SPEED_LIMIT = 50;

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/** Build initial layout from graph data. */
export function buildLayout(data: { nodes: GraphNodeMin[]; edges: GraphEdgeMin[] }): Layout {
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

// ---------------------------------------------------------------------------
// Apply forces
// ---------------------------------------------------------------------------

/** Apply one iteration of the force simulation. Mutates layout in place. */
export function applyForces(layout: Layout): void {
  const { nodes, edges } = layout;
  const n = nodes.length;
  if (n === 0) return;

  for (let i = 0; i < n; i++) {
    if (nodes[i].pinned) continue;
    let fx = 0;
    let fy = 0;

    // Coulomb repulsion
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

    // Hooke attraction along edges
    for (const e of edges) {
      let other: number;
      if (e.source === i) other = e.target;
      else if (e.target === i) other = e.source;
      else continue;
      const dx = nodes[other].pos.x - nodes[i].pos.x;
      const dy = nodes[other].pos.y - nodes[i].pos.y;
      fx += dx * ATTRACTION * e.weight;
      fy += dy * ATTRACTION * e.weight;
    }

    // Center gravity
    fx -= nodes[i].pos.x * CENTER_GRAVITY;
    fy -= nodes[i].pos.y * CENTER_GRAVITY;

    nodes[i].vx = (nodes[i].vx + fx) * DAMPING;
    nodes[i].vy = (nodes[i].vy + fy) * DAMPING;

    const speed = Math.sqrt(nodes[i].vx * nodes[i].vx + nodes[i].vy * nodes[i].vy);
    if (speed > SPEED_LIMIT) {
      nodes[i].vx = (nodes[i].vx / speed) * SPEED_LIMIT;
      nodes[i].vy = (nodes[i].vy / speed) * SPEED_LIMIT;
    }

    if (speed > MIN_VELOCITY) {
      nodes[i].pos.x += nodes[i].vx;
      nodes[i].pos.y += nodes[i].vy;
    }
  }
}
