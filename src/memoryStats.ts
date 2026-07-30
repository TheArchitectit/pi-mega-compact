/**
 * memoryStats.ts — S53B durable-memory effectiveness aggregates.
 *
 * Answers the questions the dashboard could not answer before this sprint:
 * how many memories exist, how many are actually being served ("referenced"
 * = selected by auto-recall), how often recall proved useful enough to be
 * recorded into turn_recall (source='memory', checkpointId `memory#<id>`),
 * and which memories are stable enough to treat as prompt-cache-friendly.
 *
 * Data sources (both local, PREVENT-PI-004):
 * - `memories` table in the main store (store.ts openStore) — server-stamped
 *   `last_referenced` (auto-recall selected it) / `last_recalled_at`
 *   (manual /mega-conflict paths).
 * - `turn_recall` in turns.db (S49 isolated store) — per-turn recall
 *   provenance written by the extension from S53B onward; empty before that.
 *
 * Pi-agnostic. Parameterized SQL only (PREVENT-002); defensive parses
 * (PREVENT-001); no `any` (PREVENT-011 — store helpers here use the existing
 * loosely-typed rows, narrowed at the boundary).
 */

import { openStore } from "./store/sqlite/utils.js";
import { openTurnStore } from "./store/turns/connection.js";

/** Recall-frequency normalization: 10 served-injections in 30d → freq = 1. */
const FREQ_FULL_MARK = 10;
/** Stability blend weights (recall frequency / recency / avg score). */
const W_FREQ = 0.5;
const W_RECENCY = 0.3;
const W_SCORE = 0.2;
/** Stability at/above which a memory counts as "stable". */
const STABLE_THRESHOLD = 0.6;
const DAY_MS = 86_400_000;

/** Flag gate (engineering practices: default ON, env OFF). */
export function isMemoryStabilityEnabled(): boolean {
	const v = process.env.MEGACOMPACT_MEMORY_STABILITY;
	return v !== "0" && v !== "false";
}

/** Parse the memory id out of a turn_recall checkpointId `memory#<id>…`. */
export function parseMemoryCheckpointId(checkpointId: string): number | null {
	const m = /^memory#(\d+)\b/.exec(checkpointId);
	if (!m) return null;
	const id = Number(m[1]);
	return Number.isSafeInteger(id) ? id : null;
}

/** Per-memory stability blend. `events30d` is clamped by FREQ_FULL_MARK;
 *  `daysSinceReferenced` uses createdAt when never referenced. Pure. */
export function computeMemoryStability(input: {
	events30d: number;
	avgScore: number | null;
	daysSinceReferenced: number;
}): number {
	const freq = Math.min(Math.max(input.events30d, 0) / FREQ_FULL_MARK, 1);
	const recency = 1 / (1 + Math.max(input.daysSinceReferenced, 0));
	const score = input.avgScore != null ? Math.min(Math.max(input.avgScore, 0), 1) : 0;
	return W_FREQ * freq + W_RECENCY * recency + W_SCORE * score;
}

export interface MemoryStabilityRow {
	readonly id: number;
	readonly kind: string;
	readonly category: string | null;
	readonly stability: number;
	readonly events30d: number;
	readonly avgScore: number | null;
	readonly lastReferencedAt: number | null;
}

export interface MemoryEffectiveness {
	readonly totalMemories: number;
	readonly neverReferenced: number;
	readonly recallEvents30d: number;
	readonly distinctRecalled30d: number;
	readonly avgRecallScore: number | null;
	readonly stableCount: number | null;
	readonly topStable: MemoryStabilityRow[];
	readonly stabilityEnabled: boolean;
}

interface RecallEventRow {
	checkpoint_id: string;
	score: number;
}

interface MemoryAggRow {
	id: number;
	kind: string;
	category: string | null;
	created_at: number;
	last_referenced: number | null;
	last_recalled_at: number | null;
}

/**
 * Aggregate memory effectiveness for one repo scope.
 *
 * @param repo     null → machine-wide aggregate across all repos
 * @param stateDir main store location (turns.db resolves beside it)
 * @param opts.now injectable clock for tests (ms epoch)
 */
export function readMemoryEffectiveness(
	repo: string | null,
	stateDir: string,
	opts: { now?: number } = {},
): MemoryEffectiveness {
	const now = opts.now ?? Date.now();
	const windowStartMs = now - 30 * DAY_MS;
	const stabilityOn = isMemoryStabilityEnabled();

	// ── memories table (main store) ─────────────────────────────────────
	const db = openStore(stateDir);
	const memRows = (
		repo
			? db
					.prepare(
						`SELECT id, kind, category, created_at, last_referenced, last_recalled_at
						 FROM memories WHERE repo = ?`,
					)
					.all(repo)
			: db
					.prepare(
						`SELECT id, kind, category, created_at, last_referenced, last_recalled_at
						 FROM memories`,
					)
					.all()
	) as unknown as MemoryAggRow[];

	const totalMemories = memRows.length;
	const neverReferenced = memRows.filter(
		(r) => r.last_referenced == null && r.last_recalled_at == null,
	).length;

	// ── turn_recall memory-source events in the 30d window (turns.db) ───
	// turns.db may be absent/disabled — degrade to empty (non-fatal).
	let recallRows: RecallEventRow[] = [];
	try {
		const tdb = openTurnStore(stateDir);
		// turns.ended_at is epoch ms (extension writes Date.now()).
		recallRows = tdb
			.prepare(
				`SELECT r.checkpoint_id AS checkpoint_id, r.score AS score
				 FROM turn_recall r
				 JOIN turns t ON t.id = r.turn_id
				 WHERE r.source = 'memory' AND t.ended_at >= ?`,
			)
			.all(windowStartMs) as unknown as RecallEventRow[];
	} catch {
		recallRows = [];
	}

	const eventsById = new Map<number, { n: number; scoreSum: number }>();
	for (const r of recallRows) {
		const id = parseMemoryCheckpointId(r.checkpoint_id);
		if (id == null || !Number.isFinite(r.score)) continue;
		const cur = eventsById.get(id) ?? { n: 0, scoreSum: 0 };
		cur.n += 1;
		cur.scoreSum += r.score;
		eventsById.set(id, cur);
	}

	let scoreTotal = 0;
	let scoreN = 0;
	for (const v of eventsById.values()) {
		scoreTotal += v.scoreSum;
		scoreN += v.n;
	}
	const avgRecallScore = scoreN > 0 ? scoreTotal / scoreN : null;

	// ── stability blend per memory (flagged) ────────────────────────────
	let stableCount: number | null = null;
	let topStable: MemoryStabilityRow[] = [];
	if (stabilityOn) {
		const withStability: MemoryStabilityRow[] = memRows.map((m) => {
			const ev = eventsById.get(m.id);
			const lastRefSec = m.last_referenced ?? m.last_recalled_at ?? null;
			// memories timestamps are unix SECONDS (see addMemory).
			const refMs = lastRefSec != null ? lastRefSec * 1000 : m.created_at * 1000;
			const daysSince = Math.max((now - refMs) / DAY_MS, 0);
			return {
				id: m.id,
				kind: m.kind,
				category: m.category,
				stability: computeMemoryStability({
					events30d: ev?.n ?? 0,
					avgScore: ev != null && ev.n > 0 ? ev.scoreSum / ev.n : null,
					daysSinceReferenced: daysSince,
				}),
				events30d: ev?.n ?? 0,
				avgScore: ev != null && ev.n > 0 ? ev.scoreSum / ev.n : null,
				lastReferencedAt: lastRefSec != null ? lastRefSec * 1000 : null,
			};
		});
		withStability.sort((a, b) => b.stability - a.stability);
		stableCount = withStability.filter(
			(r) => r.stability >= STABLE_THRESHOLD,
		).length;
		topStable = withStability.slice(0, 10);
	}

	return {
		totalMemories,
		neverReferenced,
		recallEvents30d: recallRows.length,
		distinctRecalled30d: eventsById.size,
		avgRecallScore,
		stableCount,
		topStable,
		stabilityEnabled: stabilityOn,
	};
}
