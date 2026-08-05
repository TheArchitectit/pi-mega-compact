/**
 * context-handler/afterCompact.ts — post-compaction DB persistence + maintenance.
 *
 * Extracted from context-handler.ts (delegate-shell split). Runs after a live
 * compaction: writes the checkpoint_epoch row (deterministic nonce), stamps turn
 * epochs, rebuilds the auto-categorizing wiki, seeds the topic model from
 * raw_transcript, and fire-and-forgets the dedup pipeline. All best-effort +
 * non-fatal — a failure never breaks the agent loop.
 */
import {
	openStore,
	writeCheckpointEpoch,
	type CheckpointEpoch,
} from "../../../src/store/sqlite.js";
import { epochIdFor } from "../../../src/mirror/epoch.js";
import type { MegaRuntime } from "../../mega-runtime.js";
import { stampTurnsEpochFor } from "../../mega-turn-store.js";
import { TurnsConfig } from "../../../src/config/turns.js";
import { openTurnStore } from "../../../src/store/turns/connection.js";
import {
	buildTopicModel,
	createTopicStore,
	bumpWikiCompactCounter,
	applyOverridesAfterRebuild,
	applyFullOverridesAfterRebuild,
} from "../../../src/topics/index.js";
import { assignNewMemoriesIncremental } from "../../../src/wiki/index.js";
import { TrigramEmbedder } from "../../../src/embedder.js";
import type { EmbeddedChunk } from "../../../src/topics/types.js";
import type { MegaConfig } from "../../mega-config.js";
import { reportClosureOptimized } from "../../../src/vector-cortex/heal/emit.js";
import { reportRepairPlanned } from "../../../src/vector-cortex/heal/repair-emit.js";
import { VC6A_ENABLED, VC6C_ENABLED } from "../../../src/config/vector-cortex.js";

/** Shape of the compact result consumed by the epoch/maintenance writes. */
interface CompactResult {
	checkpointId?: string;
	compactedFrom: number;
	summary: string;
	tokenEstimate?: number;
	originalTokenEstimate?: number;
}

/**
 * Persist the checkpoint_epoch, stamp turns, rebuild the auto-wiki, seed the
 * topic model, and dedup — gated on dbMirror. Non-fatal end-to-end.
 */
export async function persistEpochAndMaintain(
	runtime: MegaRuntime,
	config: MegaConfig,
	ran: { result: CompactResult },
): Promise<void> {
	// S27 DB-mirror: write checkpoint_epoch with deterministic nonce.
	// This makes the cache key stable across identical compactions.
	if (config.dbMirror) {
		try {
			const db = openStore(runtime.currentStateDir);
			const cpId = ran.result.checkpointId ?? `epoch-${Date.now()}`;
			const epoch: CheckpointEpoch = {
				epochId: epochIdFor(cpId),
				sessionId: runtime.rt.sessionId,
				startedSeq: 0,
				committedSeq: ran.result.compactedFrom,
				checkpointId: cpId,
				cutIndex: ran.result.compactedFrom,
				summaryMessageText: ran.result.summary,
				createdAt: Date.now(),
			};
			writeCheckpointEpoch(db, epoch);
			// S50B: link this session's turns to the epoch that just compacted
			// them (compression-by-conversation-epoch metrics). Isolated-store
			// only; best-effort + non-fatal.
			try {
				stampTurnsEpochFor(
					config,
					runtime.rt.sessionId,
					epoch.epochId,
					runtime.currentStateDir,
				);
			} catch {
				/* non-fatal: epoch stamping never breaks compaction */
			}

			// S51B: auto-categorizing wiki rebuild — every Nth compaction, derived
			// from real context_chunks embeddings. Isolated-store only, gated on
			// AUTO_WIKI_ENABLED; best-effort + non-fatal (never breaks compaction).
			// Fire regardless of dbMirror — context_chunks is the isolated store.
			// Uses the already-open db when inside the dbMirror block; opens its own
			// connection otherwise.
			// from real context_chunks embeddings. Isolated-store only, gated on
			// AUTO_WIKI_ENABLED; best-effort + non-fatal (never breaks compaction).
			try {
				if (config.autoWikiEnabled && config.turnsDbEnabled) {
					const every = Math.max(
						1,
						TurnsConfig.WIKI_REBUILD_EVERY_N_COMPACTS,
					);
					const tdb = openTurnStore(runtime.currentStateDir);
					const n = bumpWikiCompactCounter(tdb);
					// W5-B: on the Nth compact we full-rebuild; otherwise try the
					// cheap incremental path (assign new memories to nearest
					// centroid) and only force a full rebuild when the mean
					// silhouette has degraded below the configured floor.
					let rebuildNow = n % every === 0;
					if (
						!rebuildNow &&
						TurnsConfig.WIKI_INCREMENTAL_ENABLED &&
						TurnsConfig.WIKI_ENHANCED_ENABLED
					) {
						const inc = assignNewMemoriesIncremental(
							db,
							runtime.currentStateDir,
						);
						if (
							inc.silhouette !== null &&
							inc.silhouette < TurnsConfig.WIKI_INCREMENTAL_SILHOUETTE_MIN
						) {
							// Silhouette degraded — fall through to a full rebuild.
							rebuildNow = true;
						} else {
							runtime.logger.info("wiki_incremental", {
								assigned: inc.assigned,
								pending: inc.pending,
								silhouetteScore: inc.silhouette,
								uncalibrated: false,
							});
						}
					}
					if (rebuildNow) {
						const model = buildTopicModel(db, {
							kRange: [TurnsConfig.WIKI_K_MIN, TurnsConfig.WIKI_K_MAX],
							labelTopTerms: TurnsConfig.WIKI_LABEL_TOP_TERMS,
							restarts: 5,
							seed: 0x9e3779b9,
						});
						createTopicStore(runtime.currentStateDir).replaceTopicModel(
							model,
						);
						// W5-A: full hybrid replay — label + merge + split overrides
						// survive the rebuild (feature A, not just the label fast path).
						applyFullOverridesAfterRebuild(tdb);
						// SSE push so the dashboard Wiki/Evolution views refresh (non-fatal).
						runtime.dashboard.event("wiki_rebuilt", {
							topicCount: model.k,
						});
						runtime.logger.info("wiki_rebuild", {
							clusterCount: model.k,
							totalChunks: model.totalChunks,
							method: "kmeans+tfidf",
							criterion: model.criterion,
							silhouetteScore: model.silhouetteScore,
							uncalibrated: false,
						});
					}
				}
			} catch (wikiErr) {
				runtime.logger.warn("wiki_rebuild_failed", {
					error: String(wikiErr),
				});
			}

			// D1: seed the topic model from raw_transcript when context_chunks is
			// thin (pre-compaction). Gated on WIKI_SEED_FROM_TURNS; non-fatal.
			// Seeds buildTopicModel with on-the-fly trigram embeddings from
			// recent raw_transcript rows for the current session.
			try {
				if (
					config.autoWikiEnabled &&
					config.turnsDbEnabled &&
					TurnsConfig.WIKI_SEED_FROM_TURNS
				) {
					const floor = 50;
					const countRow = db
						.prepare(
							`SELECT COUNT(*) AS cnt FROM context_chunks WHERE session_id = ?`,
						)
						.get(runtime.rt.sessionId) as { cnt: number } | undefined;
					const chunkCount = countRow?.cnt ?? 0;
					if (chunkCount < floor) {
						const transcriptRows = db
							.prepare(
								`SELECT DISTINCT content_bytes
		       FROM raw_transcript
		       WHERE session_id = ?
		         AND length(content_bytes) > 10
		       ORDER BY seq ASC
		       LIMIT 200`,
							)
							.all(runtime.rt.sessionId) as Array<{
							content_bytes: string;
						}>;
						if (transcriptRows.length > 0) {
							const embedder = new TrigramEmbedder();
							const seedChunks: EmbeddedChunk[] = [];
							for (let i = 0; i < transcriptRows.length; i++) {
								const text = transcriptRows[i].content_bytes.trim();
								if (text.length === 0) continue;
								const vec = embedder.embed(text);
								seedChunks.push({
									chunkId: `seed_transcript_${i}`,
									sessionId: runtime.rt.sessionId,
									vec,
									text,
								});
							}
							if (seedChunks.length > 0) {
								const model = buildTopicModel(
									db,
									{
										kRange: [
											TurnsConfig.WIKI_K_MIN,
											TurnsConfig.WIKI_K_MAX,
										],
										labelTopTerms:
											TurnsConfig.WIKI_LABEL_TOP_TERMS,
										restarts: 5,
										seed: 0x9e3779b9,
									},
									seedChunks,
								);
								createTopicStore(
									runtime.currentStateDir,
								).replaceTopicModel(model);
								// Re-stamp custom label overrides wiped by the seed rebuild.
								applyOverridesAfterRebuild(
									openTurnStore(runtime.currentStateDir),
								);
								runtime.logger.info("wiki_seed", {
									clusterCount: model.k,
									sourceChunks: seedChunks.length,
									totalChunks: model.totalChunks,
									method: "kmeans+tfidf",
								});
							}
						}
					}
				}
			} catch (seedErr) {
				runtime.logger.warn("wiki_seed_failed", {
					error: String(seedErr),
				});
			}

				// S27 Task 6: Fire-and-forget dedup pipeline.
				// Deduplicates raw_transcript rows for the compacted range.
				try {
					const { dedupTranscript } = await import("../../../src/mirror/dedup.js");
					dedupTranscript(
						db,
						runtime.rt.sessionId,
						0,
						ran.result.compactedFrom,
					);
				} catch (_dedupErr) {
					// Fire-and-forget: dedup failure is non-fatal
				}
		} catch (e) {
			runtime.logger.warn("db-mirror-epoch-fail", { error: String(e) });
		}
	}

	// VC6 Heal lifecycle emits (post-compact). Wiring stubs — dashboard graph +
	// event counts move; real gap detection/rebuild is a future sprint.
	// VC6A: closure-optimization savings from the compact token delta.
	const savings = Math.max(
		0,
		(ran.result.originalTokenEstimate ?? 0) - (ran.result.tokenEstimate ?? 0),
	);
	if (VC6A_ENABLED()) {
		try {
			reportClosureOptimized(
				(name, payload) =>
					runtime.appendEvent(name, payload as Record<string, unknown>),
				{
					sessionId: runtime.rt.sessionId,
					removed: 0,
					retained: ran.result.compactedFrom,
					savings,
				},
			);
		} catch {
			/* non-fatal: VC6A heal emit never breaks compaction */
		}
	}
	// VC6C: repair-planner placeholder (no real gap detection yet).
	if (VC6C_ENABLED()) {
		try {
			reportRepairPlanned(
				(name, payload) =>
					runtime.appendEvent(name, payload as Record<string, unknown>),
				{
					subsystem: "post_compact",
					generation: 1,
					backoffMs: 0,
					gapSize: 0,
				},
			);
		} catch {
			/* non-fatal: VC6C heal emit never breaks compaction */
		}
	}
}
