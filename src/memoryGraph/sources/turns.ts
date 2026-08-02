/**
 * turns.ts — turn structural + turn-content node builders (extracted from
 * sources.ts). Turns live in turns.db while raw_transcript lives in the main
 * db — can't JOIN across databases, so these query separately and merge in JS.
 */
import type { DatabaseSync } from "node:sqlite";
import type { MemoryGraphNode, MemoryGraphEdge } from "../../memoryGraph.js";
import { getOrComputeEmbedding, cosineSimilarity } from "../embedding.js";

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
