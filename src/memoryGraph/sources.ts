/**
 * sources.ts — D3 data-source builders for the memory graph.
 *
 * Four source builders: checkpoint, turn (structural), turn-content
 * (raw_transcript join), and memory. Each reads from SQLite using
 * parameterized queries (PREVENT-002) and pushes nodes+edges into
 * caller-supplied arrays.
 *
 * RAPTOR annotation is also here since it enriches checkpoint nodes.
 */
import type { DatabaseSync } from "node:sqlite";
import type { MemoryGraphNode, MemoryGraphEdge } from "../memoryGraph.js";
import { listRaptorNodes } from "../store/sqlite/raptor.js";
import { decodeEmbedding } from "../store/sqlite/utils.js";
import { getOrComputeEmbedding, cosineSimilarity } from "./embedding.js";

// ---------------------------------------------------------------------------
// Feature flags and env helpers
// ---------------------------------------------------------------------------

function flagEnabled(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return v === "true" || v === "1";
}

export function areTurnsEnabled(): boolean {
  return flagEnabled("MEGACOMPACT_MEMORY_GRAPH_SEED_TURNS", true);
}

export function isTurnContentEnabled(): boolean {
  return flagEnabled("MEGACOMPACT_MEMORY_GRAPH_SEED_TURN_CONTENT", true) &&
         flagEnabled("MEGACOMPACT_DB_MIRROR", false);
}

export function isTurnContentFlaggedOn(): boolean {
  return flagEnabled("MEGACOMPACT_MEMORY_GRAPH_SEED_TURN_CONTENT", true);
}

export function areMemoriesEnabled(): boolean {
  return flagEnabled("MEGACOMPACT_MEMORY_GRAPH_SEED_MEMORIES", true);
}

// ---------------------------------------------------------------------------
// Source: checkpoints (from context_chunks table)
// ---------------------------------------------------------------------------

export function buildCheckpointNodes(
  db: DatabaseSync,
  sessionId: string,
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
): void {
  const rows = sessionId
    ? (db
        .prepare(
          `SELECT id, session_id, summary, token_estimate, timestamp,
                  dedup_status, topic_summary, key_decisions,
                  normalized_text, embedding_blob
           FROM context_chunks
           WHERE session_id = ?
           ORDER BY timestamp ASC`,
        )
        .all(sessionId) as Array<Record<string, unknown>>)
    : (db
        .prepare(
          `SELECT id, session_id, summary, token_estimate, timestamp,
                  dedup_status, topic_summary, key_decisions,
                  normalized_text, embedding_blob
           FROM context_chunks
           ORDER BY timestamp ASC`,
        )
        .all() as Array<Record<string, unknown>>);

  if (rows.length === 0) return;

  let prevId: string | null = null;
  for (const row of rows) {
    const id = String(row.id);
    const rowSessionId = sessionId || String(row.session_id ?? "");
    const summary = String(row.summary ?? "");
    const node: MemoryGraphNode = {
      id,
      sessionId: rowSessionId,
      label: id,
      summaryTruncated: summary.length > 200 ? summary.slice(0, 197) + "..." : summary,
      tokenEstimate: Number(row.token_estimate ?? 0),
      timestamp: Number(row.timestamp ?? Date.now()),
      dedupStatus: row.dedup_status ? String(row.dedup_status) : undefined,
      raptorLevel: 0,
      topicSummary: row.topic_summary ? String(row.topic_summary) : undefined,
      decisionCount: row.key_decisions ? safeJsonCount(String(row.key_decisions)) : 0,
      textSnippet: summary.length > 200 ? summary.slice(0, 197) + "..." : summary,
      nodeType: "checkpoint",
    };
    nodes.push(node);

    if (prevId !== null) {
      edges.push({ source: prevId, target: id, weight: 1.0, type: "temporal" });
    }
    prevId = id;
  }

  addCheckpointSemanticEdges(rows, edges);
}

function addCheckpointSemanticEdges(
  rows: Array<Record<string, unknown>>,
  edges: MemoryGraphEdge[],
): void {
  const embeddings: Array<{ id: string; blob: Buffer | null }> = [];
  for (const row of rows) {
    const blob = row.embedding_blob;
    embeddings.push({
      id: String(row.id),
      blob: blob instanceof Buffer ? blob : null,
    });
  }

  for (let i = 0; i < embeddings.length; i++) {
    if (!embeddings[i].blob) continue;
    const a = decodeEmbedding(embeddings[i].blob!);
    for (let j = i + 1; j < embeddings.length; j++) {
      if (!embeddings[j].blob) continue;
      const b = decodeEmbedding(embeddings[j].blob!);
      const sim = cosineSimilarity(a, b);
      if (sim > 0) {
        edges.push({
          source: embeddings[i].id,
          target: embeddings[j].id,
          weight: sim,
          type: "semantic",
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Source A: turn structural nodes (from turns table, metadata-only)
// ---------------------------------------------------------------------------

export function buildTurnNodes(
  db: DatabaseSync,
  sessionId: string,
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
): void {
  const existingIds = new Set(nodes.map((n) => n.id));
  const rows = sessionId
    ? (db
        .prepare(
          `SELECT turn_index, session_id, role, pressure_band, ctx_tokens, ctx_percent,
                  epoch_id, ended_at
           FROM turns
           WHERE session_id = ?
           ORDER BY turn_index ASC`,
        )
        .all(sessionId) as Array<Record<string, unknown>>)
    : (db
        .prepare(
          `SELECT turn_index, session_id, role, pressure_band, ctx_tokens, ctx_percent,
                  epoch_id, ended_at
           FROM turns
           ORDER BY turn_index ASC`,
        )
        .all() as Array<Record<string, unknown>>);

  if (rows.length === 0) return;

  let prevId: string | null = null;
  for (const row of rows) {
    const ti = Number(row.turn_index);
    const rowSessionId = sessionId || String(row.session_id ?? "");
    const nodeId = `turn:${rowSessionId}:${ti}`;
    if (existingIds.has(nodeId)) continue;
    existingIds.add(nodeId);

    const role = row.role ? String(row.role) : "unknown";
    const endedAt = row.ended_at ? Number(row.ended_at) : Date.now();

    const node: MemoryGraphNode = {
      id: nodeId,
      sessionId: rowSessionId,
      label: `Turn ${ti}`,
      summaryTruncated: `Turn ${ti}: ${role}${row.epoch_id ? ` (epoch: ${String(row.epoch_id)})` : ""}`,
      tokenEstimate: row.ctx_tokens ? Number(row.ctx_tokens) : 0,
      timestamp: endedAt,
      dedupStatus: undefined,
      raptorLevel: 0,
      topicSummary: undefined,
      decisionCount: 0,
      textSnippet: `Turn ${ti}: ${role} — ${String(row.ctx_tokens ?? "?")} tokens`,
      nodeType: "turn",
      epochId: row.epoch_id ? String(row.epoch_id) : undefined,
    };
    nodes.push(node);

    if (prevId !== null) {
      edges.push({ source: prevId, target: nodeId, weight: 1.0, type: "temporal" });
    }
    prevId = nodeId;
  }
}

// ---------------------------------------------------------------------------
// Source B: turn-content nodes (from turns JOIN raw_transcript)
// ---------------------------------------------------------------------------

export function buildTurnContentNodes(
  turnDb: DatabaseSync,
  mainDb: DatabaseSync,
  sessionId: string,
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
): void {
  // Local dedup only — DON'T skip ids from Source A (turn-structural). Source A
  // and Source B share the same node id (turn:<session>:<idx>); Gate 2
  // (identity_merge) merges them with the richest nodeType winning. Using the
  // global nodes array here would skip every node (Source A already added them).
  const seen = new Set<string>();

  // turns live in turns.db, raw_transcript in the main db — can't JOIN across
  // databases, so query separately and merge in JS.
  const turnRows = sessionId
    ? (turnDb
        .prepare(
          `SELECT turn_index, role, ended_at
           FROM turns
           WHERE session_id = ?
           ORDER BY turn_index ASC`,
        )
        .all(sessionId) as Array<Record<string, unknown>>)
    : (turnDb
        .prepare(
          `SELECT turn_index, role, ended_at
           FROM turns
           ORDER BY turn_index ASC`,
        )
        .all() as Array<Record<string, unknown>>);

  // Build a map of (session_id, turn_index) → content from raw_transcript.
  const contentMap = new Map<string, string>();
  try {
    const transcriptRows = sessionId
      ? (mainDb
          .prepare(
            `SELECT turn_index, content_bytes FROM raw_transcript WHERE session_id = ?`,
          )
          .all(sessionId) as Array<Record<string, unknown>>)
      : (mainDb
          .prepare(
            `SELECT turn_index, content_bytes FROM raw_transcript`,
          )
          .all() as Array<Record<string, unknown>>);
    for (const r of transcriptRows) {
      contentMap.set(String(r.turn_index), String(r.content_bytes ?? ""));
    }
  } catch {
    // raw_transcript may not exist in the main db (dbMirror off) — return empty.
    return;
  }

  // Merge: only produce nodes where both a turn row AND transcript content exist.
  const rows = turnRows
    .filter((t) => contentMap.has(String(t.turn_index)))
    .map((t) => ({
      turn_index: t.turn_index,
      role: t.role,
      ended_at: t.ended_at,
      content_bytes: contentMap.get(String(t.turn_index)) ?? "",
    }));

  if (rows.length === 0) return;

  const turnContentNodes: MemoryGraphNode[] = [];

  for (const row of rows) {
    const ti = Number(row.turn_index);
    const nodeId = `turn:${sessionId}:${ti}`;
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);

    const contentBytes = row.content_bytes ? String(row.content_bytes) : "";
    const snippet = contentBytes.length > 200 ? contentBytes.slice(0, 197) + "..." : contentBytes;

    const node: MemoryGraphNode = {
      id: nodeId,
      sessionId,
      label: `Turn ${ti}`,
      summaryTruncated: snippet,
      tokenEstimate: contentBytes.length,
      timestamp: row.ended_at ? Number(row.ended_at) : Date.now(),
      dedupStatus: undefined,
      raptorLevel: 0,
      topicSummary: undefined,
      decisionCount: 0,
      textSnippet: snippet,
      nodeType: "turn-content",
      epochId: undefined,
    };
    turnContentNodes.push(node);
  }

  if (turnContentNodes.length > 1) {
    const embeddings = turnContentNodes.map((n) => {
      try {
        return { id: n.id, vec: getOrComputeEmbedding(mainDb, n.textSnippet) };
      } catch {
        return { id: n.id, vec: null as number[] | null };
      }
    });

    for (let i = 0; i < embeddings.length; i++) {
      if (!embeddings[i].vec) continue;
      for (let j = i + 1; j < embeddings.length; j++) {
        if (!embeddings[j].vec) continue;
        const sim = cosineSimilarity(embeddings[i].vec!, embeddings[j].vec!);
        if (sim > 0) {
          edges.push({
            source: embeddings[i].id,
            target: embeddings[j].id,
            weight: sim,
            type: "semantic",
          });
        }
      }
    }

    linkTurnToCheckpointEdges(mainDb, sessionId, turnContentNodes, edges);
  }

  nodes.push(...turnContentNodes);
}

// ---------------------------------------------------------------------------
// Source C: memory nodes
// ---------------------------------------------------------------------------

export function buildMemoryNodes(
  db: DatabaseSync,
  sessionId: string,
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
): void {
  const existingIds = new Set(nodes.map((n) => n.id));
  const rows = db
    .prepare(
      `SELECT id, content, source_turn, created_at
       FROM memories
       ORDER BY created_at ASC`,
    )
    .all() as Array<Record<string, unknown>>;

  if (rows.length === 0) return;

  const memoryNodes: MemoryGraphNode[] = [];

  for (const row of rows) {
    const id = `mem:${String(row.id)}`;
    if (existingIds.has(id)) continue;
    existingIds.add(id);

    const content = row.content ? String(row.content) : "";
    const snippet = content.length > 200 ? content.slice(0, 197) + "..." : content;

    const node: MemoryGraphNode = {
      id,
      sessionId,
      label: `Memory ${String(row.id)}`,
      summaryTruncated: snippet,
      tokenEstimate: content.length,
      timestamp: row.created_at ? Number(row.created_at) : Date.now(),
      dedupStatus: undefined,
      raptorLevel: 0,
      topicSummary: undefined,
      decisionCount: 0,
      textSnippet: snippet,
      nodeType: "memory",
      epochId: undefined,
    };
    memoryNodes.push(node);
  }

  if (memoryNodes.length > 1) {
    const embeddings = memoryNodes.map((n) => {
      try {
        return { id: n.id, vec: getOrComputeEmbedding(db, n.textSnippet) };
      } catch {
        return { id: n.id, vec: null as number[] | null };
      }
    });

    for (let i = 0; i < embeddings.length; i++) {
      if (!embeddings[i].vec) continue;
      for (let j = i + 1; j < embeddings.length; j++) {
        if (!embeddings[j].vec) continue;
        const sim = cosineSimilarity(embeddings[i].vec!, embeddings[j].vec!);
        if (sim > 0) {
          edges.push({
            source: embeddings[i].id,
            target: embeddings[j].id,
            weight: sim,
            type: "semantic",
          });
        }
      }
    }

    crossLinkMemoryToCheckpoints(memoryNodes, nodes, edges);
  }

  nodes.push(...memoryNodes);
}

// ---------------------------------------------------------------------------
// RAPTOR annotations
// ---------------------------------------------------------------------------

export function addRaptorAnnotations(
  sessionId: string,
  stateDir: string,
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
): void {
  const raptorNodes = listRaptorNodes(sessionId, stateDir);
  if (!raptorNodes || raptorNodes.length === 0) return;

  const nodeIndex = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) {
    nodeIndex.set(nodes[i].id, i);
  }

  for (const rn of raptorNodes) {
    const idx = nodeIndex.get(rn.id);
    if (idx !== undefined) {
      nodes[idx].raptorLevel = rn.level;
    }
    if (!rn.parentId) continue;
    if (nodeIndex.has(rn.id) && nodeIndex.has(rn.parentId)) {
      edges.push({
        source: rn.id,
        target: rn.parentId,
        weight: Math.max(0.1, 1.0 - rn.level * 0.1),
        type: "raptor_parent",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Cross-source edge linking
// ---------------------------------------------------------------------------

function linkTurnToCheckpointEdges(
  db: DatabaseSync,
  sessionId: string,
  turnNodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
): void {
  const checkpoints = db
    .prepare(
      `SELECT id, timestamp FROM context_chunks WHERE session_id = ? ORDER BY timestamp ASC`,
    )
    .all(sessionId) as Array<{ id: string; timestamp: number }>;

  for (const tn of turnNodes) {
    let bestCp: { id: string; diff: number } | null = null;
    for (const cp of checkpoints) {
      const diff = Math.abs(tn.timestamp - cp.timestamp);
      if (bestCp === null || diff < bestCp.diff) {
        bestCp = { id: cp.id, diff };
      }
    }
    if (bestCp) {
      edges.push({
        source: tn.id,
        target: bestCp.id,
        weight: 1.0,
        type: "temporal",
      });
    }
  }
}

function crossLinkMemoryToCheckpoints(
  memoryNodes: MemoryGraphNode[],
  allNodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
): void {
  for (const mn of memoryNodes) {
    let bestNeighbor: { id: string; diff: number } | null = null;
    for (const n of allNodes) {
      if (n.nodeType !== "checkpoint" && n.nodeType !== "turn-content") continue;
      if (n.id === mn.id) continue;
      const diff = Math.abs(mn.timestamp - n.timestamp);
      if (bestNeighbor === null || diff < bestNeighbor.diff) {
        bestNeighbor = { id: n.id, diff };
      }
    }
    if (bestNeighbor) {
      edges.push({
        source: mn.id,
        target: bestNeighbor.id,
        weight: 0.85,
        type: "semantic",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Edge deduplication
// ---------------------------------------------------------------------------

export function deduplicateEdges(edges: MemoryGraphEdge[]): MemoryGraphEdge[] {
  const seen = new Map<string, MemoryGraphEdge>();

  for (const e of edges) {
    const keyA = `${e.source}|${e.target}`;
    const keyB = `${e.target}|${e.source}`;
    const existing = seen.get(keyA) ?? seen.get(keyB);
    if (existing) {
      if (e.weight > existing.weight) {
        seen.set(keyA, e);
      }
    } else {
      seen.set(keyA, e);
    }
  }

  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeJsonCount(raw: string | null | undefined): number {
  if (!raw || typeof raw !== "string") return 0;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

