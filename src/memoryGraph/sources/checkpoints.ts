/**
 * checkpoints.ts — checkpoint node builder (extracted from sources.ts).
 */
import type { DatabaseSync } from "node:sqlite";
import type { MemoryGraphNode, MemoryGraphEdge } from "../../memoryGraph.js";
import { decodeEmbedding } from "../../store/sqlite/utils.js";
import { cosineSimilarity } from "../embedding.js";
import { safeJsonCount } from "./helpers.js";

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
