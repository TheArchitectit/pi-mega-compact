/**
 * memory-map-shapes.tsx — Node shape rendering utilities for MemoryMapTab (D3).
 *
 * Node shape encodes nodeType: checkpoint = filled circle, turn = hollow circle,
 * turn-content = hollow+ring, memory = diamond.
 * Delegate-shell pattern: thin rendering helpers, no state, no side effects.
 */
import type React from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NodeType = "checkpoint" | "turn" | "turn-content" | "memory";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const NODE_COLORS: Record<NodeType, string> = {
  checkpoint: "#6366f1",
  turn: "#58a6ff",
  "turn-content": "#22c55e",
  memory: "#f59e0b",
};

export const NODE_TYPE_LABELS: Record<NodeType, string> = {
  checkpoint: "Checkpoint",
  turn: "Turn",
  "turn-content": "Turn Content",
  memory: "Memory",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SVG path for a diamond centered at (0,0) with given half-width/height. */
function diamondPath(hw: number, hh: number): string {
  return `M 0,-${hh} L ${hw},0 L 0,${hh} L -${hw},0 Z`;
}

function nodeOpacity(dedupStatus: string | undefined): number {
  if (!dedupStatus || dedupStatus === "active") return 1;
  return 0.5;
}

// ---------------------------------------------------------------------------
// Render function
// ---------------------------------------------------------------------------

/** Render an SVG shape for a node based on its nodeType. */
export function renderNodeShape(
  cx: number,
  cy: number,
  radius: number,
  nodeType: NodeType,
  isSelected: boolean,
  isFiltered: boolean,
  dedupStatus: string | undefined,
): React.ReactElement {
  const fill = isFiltered ? NODE_COLORS[nodeType] ?? "#6366f1" : "#d1d5db";
  const strokeColor = isSelected ? "#ef4444" : "none";
  const opacity = nodeOpacity(dedupStatus);

  switch (nodeType) {
    case "checkpoint":
      return (
        <circle
          cx={cx}
          cy={cy}
          r={isSelected ? radius + 3 : radius}
          fill={fill}
          opacity={opacity}
          stroke={strokeColor}
          strokeWidth={isSelected ? 2 : 0}
        />
      );
    case "turn":
      return (
        <circle
          cx={cx}
          cy={cy}
          r={isSelected ? radius + 3 : radius}
          fill="none"
          stroke={fill}
          strokeWidth={2.5}
          opacity={opacity}
        />
      );
    case "turn-content":
      return (
        <g>
          <circle
            cx={cx}
            cy={cy}
            r={isSelected ? radius + 3 : radius}
            fill="none"
            stroke={fill}
            strokeWidth={2.5}
            opacity={opacity}
          />
          <circle
            cx={cx}
            cy={cy}
            r={Math.max(3, radius * 0.3)}
            fill={fill}
            opacity={opacity}
          />
        </g>
      );
    case "memory":
      const hw = radius * 0.85;
      const hh = radius * 0.85;
      return (
        <path
          d={diamondPath(hw, hh)}
          transform={`translate(${cx}, ${cy})`}
          fill={fill}
          opacity={opacity}
          stroke={strokeColor}
          strokeWidth={isSelected ? 2 : 0}
        />
      );
  }
}
