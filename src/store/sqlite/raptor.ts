/**
 * raptor.ts — Sprint 13 RAPTOR node persistence.
 */
import { getStateDir, normalizeSessionId } from "../../store.js";
import { openStore, jsonText, encodeEmbedding, decodeEmbedding } from "./utils.js";

export interface StoredRaptorNode {
  id: string;
  sessionId: string;
  level: number;
  parentId: string | null;
  children: string[];
  summary: string;
  embedding: number[];
  qualityMarker: string;
  tokenEstimate: number;
  /** S25: epoch ms when the tree containing this node was built. */
  builtAt: number;
}

/** Persist a single RAPTOR node (upsert by (session_id, id)). */
export function upsertRaptorNode(node: StoredRaptorNode, stateDir: string = getStateDir()): void {
  const db = openStore(stateDir);
  db.prepare(
    `INSERT INTO raptor_nodes(id, session_id, level, parent_id, children, summary, embedding_blob, quality_marker, token_estimate, built_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, id) DO UPDATE SET
       level=excluded.level, parent_id=excluded.parent_id, children=excluded.children,
       summary=excluded.summary, embedding_blob=excluded.embedding_blob,
       quality_marker=excluded.quality_marker, token_estimate=excluded.token_estimate,
       built_at=excluded.built_at`,
  ).run(
    node.id,
    node.sessionId,
    node.level,
    node.parentId,
    jsonText(node.children),
    node.summary,
    encodeEmbedding(node.embedding),
    node.qualityMarker,
    node.tokenEstimate,
    node.builtAt,
  );
}

/** Persist an entire built RAPTOR tree for a session (shadow or live). */
export function saveRaptorTree(
  sessionId: string,
  tree: {
    nodes: Map<string, {
      id: string;
      level: number;
      parentId: string | null;
      children: string[];
      summary: string;
      embedding: number[];
      qualityMarker: string;
      tokenEstimate: number;
    }>
  },
  builtAt: number,
  stateDir: string = getStateDir(),
): void {
  for (const node of tree.nodes.values()) {
    upsertRaptorNode(
      {
        id: node.id,
        sessionId,
        level: node.level,
        parentId: node.parentId,
        children: node.children,
        summary: node.summary,
        embedding: node.embedding,
        qualityMarker: node.qualityMarker,
        tokenEstimate: node.tokenEstimate,
        builtAt,
      },
      stateDir,
    );
  }
}

/** Load all RAPTOR nodes for a session. */
export function listRaptorNodes(sessionId: string, stateDir: string = getStateDir()): StoredRaptorNode[] {
  const db = openStore(stateDir);
  const rows = db
    .prepare("SELECT * FROM raptor_nodes WHERE session_id = ? ORDER BY level ASC, id ASC")
    .all(normalizeSessionId(sessionId)) as any[];
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    level: row.level,
    parentId: row.parent_id ?? null,
    children: row.children ? JSON.parse(row.children) : [],
    summary: row.summary ?? "",
    embedding: decodeEmbedding(row.embedding_blob),
    qualityMarker: row.quality_marker ?? "low",
    tokenEstimate: row.token_estimate ?? 0,
    builtAt: Number(row.built_at ?? 0),
  }));
}

/** Delete all RAPTOR nodes for a session (rollback/cleanup). */
export function clearRaptorNodes(sessionId: string, stateDir: string = getStateDir()): void {
  const db = openStore(stateDir);
  db.prepare("DELETE FROM raptor_nodes WHERE session_id = ?").run(normalizeSessionId(sessionId));
}
