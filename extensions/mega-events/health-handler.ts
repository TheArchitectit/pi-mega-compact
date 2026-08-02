/**
 * health-handler.ts — Context Health turn_end hook (v0.12).
 *
 * Computes a composite 0-1 health score per turn from five sub-scores
 * (drift, output quality, error rate, cache health, cache poison),
 * persists it to the context_health SQLite table, and emits a dashboard
 * event. All paths non-fatal — health monitoring never breaks the agent loop.
 *
 * PREVENT-PI-004: zero network (local TrigramEmbedder + SQLite only).
 */

import type { MegaRuntime } from "../mega-runtime.js";
import type { MegaConfig } from "../mega-config.js";
import { defaultEmbedder } from "../../src/embedder.js";
import { computeOutputQuality } from "../../src/contextHealth/outputQuality.js";
import {
	computeTopicDrift,
	computeErrorEscalation,
	computePrefixInstability,
	computeDriftScore,
} from "../../src/contextHealth/drift.js";
import {
	computePrefixHash,
	checkPrefixHash,
	evaluateCachePoison,
} from "../../src/contextHealth/cachePoison.js";
import {
	computeHealthScore,
	recordContextHealth,
	type ContextHealthSubScores,
} from "../../src/contextHealth.js";
import {
	recordCachePoisonEvent,
} from "../../src/store/sqlite/context-health.js";
import { getHealthMitigate } from "../../src/store/sqlite/meta.js";

const RING_MAX = 5;

/** Extract assistant text from the turn_end event message. */
function extractAssistantText(event: { message?: { role?: string; content?: unknown } }): string {
	const msg = event.message;
	if (!msg || msg.role !== "assistant") return "";
	const c = msg.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c
			.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text?: string }).text ?? "") : ""))
			.join(" ");
	}
	return "";
}

/** Extract messages as string array for prefix hash (cache poison Layer 1). */
function extractMessageTexts(event: { message?: { content?: unknown } }): string[] {
	const c = event?.message?.content;
	if (typeof c === "string") return [c];
	if (Array.isArray(c)) {
		return c.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text?: string }).text ?? "") : ""));
	}
	return [];
}

interface TurnEvent {
	turnIndex: number;
	message?: { role?: string; content?: unknown; stopReason?: string; usage?: { cacheRead?: number } };
}

export interface HealthMitigationSignal {
	/** Force a compaction to flush degraded context (composite < 0.4). */
	forceCompact: boolean;
	/** Inject a prefix break to bypass corrupted KV cache (cachePoison < 0.3). */
	breakPrefix: boolean;
	/** The composite health score that triggered mitigation (if any). */
	composite: number;
}

/** Handle turn_end: compute + persist context health. Non-fatal.
 * Returns mitigation signals for the caller to act on (agent-handlers has ctx). */
export function handleTurnEndHealth(
	event: TurnEvent,
	runtime: MegaRuntime,
	config: MegaConfig,
): HealthMitigationSignal {
	const noSignal: HealthMitigationSignal = { forceCompact: false, breakPrefix: false, composite: 1 };
	if (!config.contextHealth) return noSignal;
	try {
		const text = extractAssistantText(event);
		const embedder = defaultEmbedder();
		const emb = text.length > 0 ? embedder.embed(text) : [];

		// Output quality sub-score
		let outputQuality = 1.0;
		let repetitionRatio = 0;
		let coherenceScore = 1.0;
		if (config.contextHealthOutputQuality && text.length > 0) {
			const oq = computeOutputQuality(text, embedder);
			outputQuality = oq.score;
			repetitionRatio = oq.repetitionRatio;
			coherenceScore = oq.coherenceScore;
		}

		// Drift sub-score
		let drift = 1.0;
		if (config.contextHealthDrift) {
			const topic = computeTopicDrift(emb, runtime.recentTurnEmbeddings);
			const error = computeErrorEscalation(runtime.recentErrorCategories);
			const prefix = computePrefixInstability(0, 5);
			drift = computeDriftScore(topic, error, prefix);
		}

		// Error rate sub-score (1 = no errors)
		const errorScore = computeErrorEscalation(runtime.recentErrorCategories);

		// Cache health (from perf-handler)
		const cacheHealth = runtime.rt._lastCacheHealthScore ?? 1.0;

		// Cache poison sub-score
		let cachePoison = 1.0;
		if (config.contextHealthCachePoison) {
			const msgTexts = extractMessageTexts(event);
			const currentHash = computePrefixHash(msgTexts);
			const cacheRead = event.message?.usage?.cacheRead ?? 0;
			const l1 = checkPrefixHash(currentHash, runtime.lastPrefixHash, cacheRead);
			const result = evaluateCachePoison({
				currentHash,
				storedHash: runtime.lastPrefixHash,
				cacheRead,
				qualityByCacheHit: [],
				qualityByCacheMiss: [],
				errorRateCacheHit: 0,
				errorRateCacheMiss: 0,
				sampleCount: 0,
			});
			cachePoison = result.score;
			if (l1.poisoned) {
				try {
					recordCachePoisonEvent(runtime.currentStateDir, {
						ts: Date.now(),
						turnIndex: event.turnIndex,
						sessionId: runtime.rt.sessionId,
						layer: 1,
						detail: l1.detail,
						severity: "warn",
					});
				} catch { /* non-fatal */ }
			}
			runtime.lastPrefixHash = currentHash;
		}

		// Composite
		const sub: ContextHealthSubScores = {
			drift,
			outputQuality,
			errorRate: errorScore,
			cacheHealth,
			cachePoison,
		};
		const composite = computeHealthScore(sub);

		// Persist
		recordContextHealth(runtime.currentStateDir, {
			ts: Date.now(),
			turnIndex: event.turnIndex,
			sessionId: runtime.rt.sessionId,
			driftScore: drift,
			outputQuality,
			errorScore,
			cacheHealth,
			cachePoison,
			composite,
			modelId: runtime.currentModel?.modelId,
			repetitionRatio,
			coherenceScore,
			prefixHash: runtime.lastPrefixHash ?? undefined,
		});

		// Emit dashboard event
		runtime.dashboard.event("context_health", {
			composite,
			drift,
			outputQuality,
			errorRate: errorScore,
			cacheHealth,
			cachePoison,
			turnIndex: event.turnIndex,
		});

		// Mitigation: check the runtime-toggleable flag (meta table), not just
		// the env var. The dashboard Maintenance tab toggles this at runtime.
		const mitigate = config.contextHealthMitigate ||
			getHealthMitigate(runtime.currentStateDir);

		// Update ring buffers
		runtime.recentTurnEmbeddings.push(emb);
		if (runtime.recentTurnEmbeddings.length > RING_MAX) {
			runtime.recentTurnEmbeddings.shift();
		}
		runtime.recentErrorCategories.push(runtime.lastErrorCategory);
		if (runtime.recentErrorCategories.length > RING_MAX) {
			runtime.recentErrorCategories.shift();
		}

		// Return mitigation signals so agent-handlers.ts (which has ctx) can act.
		if (mitigate) {
			return {
				forceCompact: composite < 0.4,
				breakPrefix: cachePoison < 0.3,
				composite,
			};
		}
		return { forceCompact: false, breakPrefix: false, composite };
	} catch (e) {
		runtime.logger?.error("context_health_failed", {
			error: String(e instanceof Error ? e.message : e),
		});
		return noSignal;
	}
}
