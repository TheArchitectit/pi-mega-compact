/**
 * Shared internal types for the pi-mega-compact engine.
 *
 * Kept independent of pi's runtime types (src/ is pi-agnostic; the extension
 * entry in extensions/ adapts between the two). See RESEARCH.md for the pi
 * AgentMessage contract this must eventually satisfy.
 */

/** A lightweight message shape the engine reasons about (role only matters). */
export interface EngineMessage {
  role: "user" | "assistant" | "tool" | "custom";
  text: string;
  toolName?: string;
}

/** A persisted compaction checkpoint (Layer 4 → vector store). */
export interface Checkpoint {
  checkpointId: string; // chkpt_001
  sessionId: string; // sess_xxx (normalized)
  summary: string;
  keyDecisions: string[];
  nextSteps: string[];
  filesModified: string[];
  tokenEstimate: number;
  regionHash: string; // dedup sentinel key
  timestamp: number;
}

/** Result of a Trident run over a set of messages. */
export interface TridentResult {
  superseded: string[];
  collapsed: string;
  checkpoints: Checkpoint[];
}
