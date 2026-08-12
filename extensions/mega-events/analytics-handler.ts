/**
 * analytics-handler.ts — PMA-2 verified ingestion adapter.
 *
 * Registers event handlers that capture request-lifecycle facts from verified
 * pi event seams (proven in PMA-0) into the isolated analytics.db (built in
 * PMA-1). Mirrors the perf-handler.ts pattern: closure over `runtime`, non-fatal
 * try/catch on every handler, flag-gated.
 *
 * Event-to-fact mapping (all seams verified in docs/specs/pma-0-discovery-findings.md):
 *   turn_start               → request_started (observedAt, provider/model)
 *   before_provider_request  → provider_selected (same correlationId)
 *   message_update[text_start] → TTFT stamp (attached to terminal fact)
 *   turn_end                 → request_completed/request_failed (tokens, latency, ttft, status)
 *
 * Everything is best-effort: AppendResult carries accepted/duplicate/failed
 * without throwing into the host. When the flag is OFF, no handlers are
 * registered and no DB is opened.
 *
 * PREVENT-PI-004: no network. PREVENT-PI-003: no system-role messages.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type MegaRuntime } from "../mega-runtime.js";
import { type MegaConfig } from "../mega-config.js";
import {
	createAnalyticsStore,
	closeAllAnalyticsDbs,
	type AnalyticsStore,
	type RequestEventFact,
	type RequestEventKind,
	type QualityNote,
} from "../../src/store/analytics/index.js";

// ── Per-stateDir store cache (mirrors mega-turn-store.ts storeFor) ─────

const stores = new Map<string, AnalyticsStore>();

function storeFor(stateDir: string): AnalyticsStore {
	let s = stores.get(stateDir);
	if (!s) {
		s = createAnalyticsStore({ stateDir });
		stores.set(stateDir, s);
	}
	return s;
}

/** Close all cached analytics stores (test teardown / shutdown). */
export function closeAnalyticsStores(): void {
	closeAllAnalyticsDbs();
	stores.clear();
}

// ── Usage block narrowing (same as perf-handler) ──────────────────────

interface UsageBlock {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

function usageOf(msg: { role?: string; usage?: UsageBlock }): UsageBlock | null {
	if (msg.role === "assistant" && msg.usage) return msg.usage;
	return null;
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Build a QualityNote with provider/model availability. */
function qualityFor(provider: string | undefined, model: string | undefined): QualityNote {
	if (!provider || !model) return { unavailable: true, note: "provider/model not captured" };
	return {};
}

// ── Registration ──────────────────────────────────────────────────────

/** Register the analytics event handlers. Flag-gated: OFF = complete no-op. */
export function registerAnalyticsHandler(
	pi: ExtensionAPI,
	runtime: MegaRuntime,
	config: MegaConfig,
): void {
	if (!config.providerModelAnalytics) return; // flag OFF — no DB, no handlers

	// ── turn_start: stamp the request start + emit request_started ──────

	pi.on("turn_start", async (event) => {
		try {
			const now = Date.now();
			const corrId = `req_${runtime.rt.sessionId}_${event.turnIndex}`;
			runtime.pendingAnalyticsCorrelationId = corrId;
			runtime.analyticsProviderStart = 0; // reset; stamped at before_provider_request
			runtime.analyticsTtft = 0;

			const provider = runtime.currentModel?.provider;
			const model = runtime.currentModel?.modelId;
			const fact: RequestEventFact = {
				id: `${corrId}_started`,
				correlationId: corrId,
				sessionId: runtime.rt.sessionId,
				turnId: String(event.turnIndex),
				eventKind: "request_started",
				observedAt: now,
				provider,
				model,
				source: "host_adapter",
				quality: qualityFor(provider, model),
			};
			storeFor(runtime.currentStateDir).asWriter().appendRequestEvent(fact);
		} catch {
			/* non-fatal: analytics never breaks the agent loop */
		}
	});

	// ── before_provider_request: stamp provider start + emit provider_selected

	pi.on("before_provider_request", async () => {
		try {
			runtime.analyticsProviderStart = Date.now();
			const corrId = runtime.pendingAnalyticsCorrelationId;
			if (!corrId) return;
			const provider = runtime.currentModel?.provider;
			const model = runtime.currentModel?.modelId;
			const fact: RequestEventFact = {
				id: `${corrId}_selected`,
				correlationId: corrId,
				sessionId: runtime.rt.sessionId,
				eventKind: "provider_selected",
				observedAt: runtime.analyticsProviderStart,
				provider,
				model,
				source: "host_adapter",
				quality: qualityFor(provider, model),
			};
			storeFor(runtime.currentStateDir).asWriter().appendRequestEvent(fact);
		} catch {
			/* non-fatal */
		}
	});

	// ── message_update: capture TTFT on first text token ────────────────
	// Net-new seam — no existing handler registers message_update.
	// Proven available in PMA-0 (agent-loop.js:201-227).

	pi.on("message_update", async (event) => {
		try {
			if (runtime.analyticsTtft > 0) return; // already captured this turn
			if (runtime.analyticsProviderStart <= 0) return; // no provider start stamp
			const chunkType = (event as { assistantMessageEvent?: { type?: string } })
				.assistantMessageEvent?.type;
			if (chunkType !== "text_start" && chunkType !== "text_delta") return;
			runtime.analyticsTtft = Date.now() - runtime.analyticsProviderStart;
		} catch {
			/* non-fatal */
		}
	});

	// ── turn_end: emit terminal fact with tokens, latency, ttft, status ─

	pi.on("turn_end", async (event) => {
		try {
			const corrId = runtime.pendingAnalyticsCorrelationId;
			if (!corrId) return;

			const now = Date.now();
			const durationMs = runtime.perfTurnStart > 0 ? now - runtime.perfTurnStart : undefined;
			const u = usageOf(event.message as { role?: string; usage?: UsageBlock });
			const stopReason = (event.message as { stopReason?: string }).stopReason;
			const provider = runtime.currentModel?.provider;
			const model = runtime.currentModel?.modelId;

			const isFailed = stopReason === "error" || stopReason === "aborted";
			const eventKind: RequestEventKind = isFailed ? "request_failed" : "request_completed";

			const fact: RequestEventFact = {
				id: `${corrId}_${eventKind}`,
				correlationId: corrId,
				sessionId: runtime.rt.sessionId,
				turnId: String(event.turnIndex),
				eventKind,
				observedAt: now,
				provider,
				model,
				status: stopReason ?? undefined,
				inputTokens: u?.input,
				outputTokens: u?.output,
				cacheReadTokens: u?.cacheRead,
				cacheWriteTokens: u?.cacheWrite,
				durationMs,
				ttftMs: runtime.analyticsTtft > 0 ? runtime.analyticsTtft : undefined,
				source: "host_adapter",
				quality: {
					...qualityFor(provider, model),
					...(runtime.analyticsTtft > 0 ? {} : { note: "TTFT not captured (no first-token event)" }),
				},
			};
			storeFor(runtime.currentStateDir).asWriter().appendRequestEvent(fact);

			// Reset per-turn state.
			runtime.pendingAnalyticsCorrelationId = null;
			runtime.analyticsTtft = 0;
		} catch {
			/* non-fatal */
		}
	});
}
