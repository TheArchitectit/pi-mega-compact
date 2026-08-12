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

// ── Per-runtime PMA-2 timing state ────────────────────────────────────
// Kept off MegaRuntime (a module-private WeakMap) so runtime.ts stays a
// pure field-declaration shell under the soft-limit headroom gate. The
// adapter is the sole reader/writer of this transient per-turn state.

interface PmaTiming {
	providerStart: number;
	ttft: number;
	correlationId: string | null;
}

const pmaTimings = new WeakMap<object, PmaTiming>();

function getPma(rt: object): PmaTiming {
	let s = pmaTimings.get(rt);
	if (!s) {
		s = { providerStart: 0, ttft: 0, correlationId: null };
		pmaTimings.set(rt, s);
	}
	return s;
}

/** @internal Test-only accessor — production code uses getPma() in-module. */
export function __pmaTimingForTest(rt: object): PmaTiming {
	return getPma(rt);
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
			const pma = getPma(runtime);
			pma.correlationId = corrId;
			pma.providerStart = 0; // reset; stamped at before_provider_request
			pma.ttft = 0;

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
			const pma = getPma(runtime);
			pma.providerStart = Date.now();
			const corrId = pma.correlationId;
			if (!corrId) return;
			const provider = runtime.currentModel?.provider;
			const model = runtime.currentModel?.modelId;
			const fact: RequestEventFact = {
				id: `${corrId}_selected`,
				correlationId: corrId,
				sessionId: runtime.rt.sessionId,
				eventKind: "provider_selected",
				observedAt: pma.providerStart,
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
			const pma = getPma(runtime);
			if (pma.ttft > 0) return; // already captured this turn
			if (pma.providerStart <= 0) return; // no provider start stamp
			const chunkType = (event as { assistantMessageEvent?: { type?: string } })
				.assistantMessageEvent?.type;
			if (chunkType !== "text_start" && chunkType !== "text_delta") return;
			pma.ttft = Date.now() - pma.providerStart;
		} catch {
			/* non-fatal */
		}
	});

	// ── turn_end: emit terminal fact with tokens, latency, ttft, status ─

	pi.on("turn_end", async (event) => {
		try {
			const pma = getPma(runtime);
			const corrId = pma.correlationId;
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
				ttftMs: pma.ttft > 0 ? pma.ttft : undefined,
				source: "host_adapter",
				quality: {
					...qualityFor(provider, model),
					...(pma.ttft > 0 ? {} : { note: "TTFT not captured (no first-token event)" }),
				},
			};
			storeFor(runtime.currentStateDir).asWriter().appendRequestEvent(fact);

			// Reset per-turn state.
			pma.correlationId = null;
			pma.ttft = 0;
		} catch {
			/* non-fatal */
		}
	});
}
