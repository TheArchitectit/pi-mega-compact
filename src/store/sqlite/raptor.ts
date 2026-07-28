/**
 * raptor.ts — Sprint 13 RAPTOR node persistence.
 */
import { getStateDir, normalizeSessionId } from "../../store.js";
import {
	openStore,
	withTx,
	jsonText,
	encodeEmbedding,
	decodeEmbedding,
} from "./utils.js";

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
export function upsertRaptorNode(
	node: StoredRaptorNode,
	stateDir: string = getStateDir(),
): void {
	const db = openStore(stateDir);
	db.prepare(
		`INSERT INTO raptor_nodes(id, session_id, level, parent_id, children, summary, embedding_blob, quality_marker, token_estimate, built_at)
     VALUES(@id, @session_id, @level, @parent_id, @children, @summary, @embedding_blob, @quality_marker, @token_estimate, @built_at)
     ON CONFLICT(session_id, id) DO UPDATE SET
       level=excluded.level, parent_id=excluded.parent_id, children=excluded.children,
       summary=excluded.summary, embedding_blob=excluded.embedding_blob,
       quality_marker=excluded.quality_marker, token_estimate=excluded.token_estimate,
       built_at=excluded.built_at`,
	).run({
		id: node.id,
		session_id: node.sessionId,
		level: node.level,
		parent_id: node.parentId,
		children: jsonText(node.children),
		summary: node.summary,
		embedding_blob: encodeEmbedding(node.embedding),
		quality_marker: node.qualityMarker,
		token_estimate: node.tokenEstimate,
		built_at: node.builtAt,
	});
}

/** Persist an entire built RAPTOR tree for a session (shadow or live). */
export function saveRaptorTree(
	sessionId: string,
	tree: {
		nodes: Map<
			string,
			{
				id: string;
				level: number;
				parentId: string | null;
				children: string[];
				summary: string;
				embedding: number[];
				qualityMarker: string;
				tokenEstimate: number;
			}
		>;
	},
	builtAt: number,
	stateDir: string = getStateDir(),
): void {
	const nsid = normalizeSessionId(sessionId);
	const db = openStore(stateDir);
	withTx(db, () => {
		db.prepare("DELETE FROM raptor_nodes WHERE session_id = ?").run(nsid);
		for (const node of tree.nodes.values()) {
			upsertRaptorNode(
				{
					id: node.id,
					sessionId: nsid,
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
	});
}

/** Safe JSON array parse — returns [] on corrupt input. */
function safeJsonArray(raw: unknown): string[] {
	if (typeof raw !== "string" || !raw) return [];
	try { return JSON.parse(raw) as string[]; }
	catch { return []; }
}

/** Load all RAPTOR nodes for a session. */
export function listRaptorNodes(
	sessionId: string,
	stateDir: string = getStateDir(),
): StoredRaptorNode[] {
	const db = openStore(stateDir);
	const rows = db
		.prepare(
			"SELECT * FROM raptor_nodes WHERE session_id = ? ORDER BY level ASC, id ASC",
		)
		.all(normalizeSessionId(sessionId)) as any[];
	return rows.map((row) => ({
		id: row.id,
		sessionId: row.session_id,
		level: row.level,
		parentId: row.parent_id ?? null,
		children: safeJsonArray(row.children),
		summary: row.summary ?? "",
		embedding: decodeEmbedding(row.embedding_blob),
		qualityMarker: row.quality_marker ?? "low",
		tokenEstimate: row.token_estimate ?? 0,
		builtAt: Number(row.built_at ?? 0),
	}));
}

/** Delete all RAPTOR nodes for a session (rollback/cleanup). */
export function clearRaptorNodes(
	sessionId: string,
	stateDir: string = getStateDir(),
): void {
	const db = openStore(stateDir);
	db.prepare("DELETE FROM raptor_nodes WHERE session_id = ?").run(
		normalizeSessionId(sessionId),
	);
}

/**
 * S25: newest built_at for a session's RAPTOR tree (0 if no nodes exist).
 * Cheap indexed MAX query used by raptorSearchHits to validate cache freshness
 * without rehydrating the full node Map.
 */
export function maxRaptorNodeBuiltAt(
	sessionId: string,
	stateDir: string = getStateDir(),
): number {
	const db = openStore(stateDir);
	const row = db
		.prepare(
			`SELECT MAX(built_at) AS max_built FROM raptor_nodes WHERE session_id = ?`,
		)
		.get(normalizeSessionId(sessionId)) as
		| { max_built: number | null }
		| undefined;
	return row?.max_built ?? 0;
}
