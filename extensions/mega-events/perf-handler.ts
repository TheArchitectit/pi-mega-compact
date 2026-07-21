/**
 * mega-events/perf-handler.ts — local perf instrumentation handlers (v0.8.8).
 *
 * Captures cheap, local-only telemetry into the `perf_samples` SQLite table for
 * the dashboard's Perf tab: turn + provider latency, TPS, cache hit %, and (via
 * MegaRuntime.ensurePerfInterval) a 5s cpu/mem interval. All capture is wrapped in
 * try/catch — instrumentation NEVER blocks the agent loop (non-fatal).
 *
 * PREVENT-PI-004: Date.now / process.cpuUsage / process.memoryUsage + local
 *   SQLite only, zero network.
 * PREVENT-011: no `any` — the usage block is narrowed structurally.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type MegaRuntime } from "../mega-runtime.js";
import { recordPerfSample } from "../../src/store/sqlite.js";

/** Structural view of an AssistantMessage usage block (no pi-ai import). */
interface UsageBlock {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Narrow a turn_end message to its usage block when it is an assistant msg. */
function usageOf(
	msg: { role?: string; usage?: UsageBlock },
): UsageBlock | null {
	if (msg.role !== "assistant" || !msg.usage) return null;
	return msg.usage;
}

/** Register perf instrumentation handlers + start the 5s cpu/mem interval. */
export function registerPerfHandler(
	pi: ExtensionAPI,
	runtime: MegaRuntime,
): void {
	// turn_start: record the wall-clock start of the turn. Using Date.now() (not
	// event.timestamp) so the turn_end duration is on ONE clock — mixing pi's
	// timestamp with Date.now() would skew the delta. Also (re)arms the cpu/mem
	// interval so a new session after a dispose() resumes sampling on its first
	// turn (the interval is cleared in runtime.dispose()).
	pi.on("turn_start", async () => {
		try {
			runtime.perfTurnStart = Date.now();
			runtime.ensurePerfInterval();
		} catch {
			/* non-fatal */
		}
	});

	// turn_end: compute turn latency + TPS + cache hit % from the assistant
	// message's usage block. One perf_samples row per metric per turn.
	pi.on("turn_end", async (event) => {
		try {
			if (runtime.perfTurnStart > 0) {
				const durMs = Date.now() - runtime.perfTurnStart;
				recordPerfSample(runtime.currentStateDir, "turn_latency_ms", durMs, {
					turnIndex: event.turnIndex,
				});
				const u = usageOf(event.message);
				if (u) {
					const durSec = Math.max(durMs / 1000, 0.001);
					recordPerfSample(
						runtime.currentStateDir,
						"tps",
						u.output / durSec,
						{ outputTokens: u.output },
					);
					const denom = u.cacheRead + u.input + u.cacheWrite;
					const hitPct = denom > 0 ? (u.cacheRead / denom) * 100 : 0;
					recordPerfSample(
						runtime.currentStateDir,
						"cache_hit_pct",
						hitPct,
						{ input: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite },
					);
			}
		}
		} catch {
			/* non-fatal: instrumentation must never break the agent loop */
		}
	});

	// before_provider_request -> after_provider_response: raw round-trip latency
	// to the model endpoint (HTTP status carried on the response event).
	pi.on("before_provider_request", async () => {
		try {
			runtime.perfProviderStart = Date.now();
		} catch {
			/* non-fatal */
		}
	});
	pi.on("after_provider_response", async (event) => {
		try {
			if (runtime.perfProviderStart > 0) {
				const lat = Date.now() - runtime.perfProviderStart;
				recordPerfSample(
					runtime.currentStateDir,
					"provider_latency_ms",
					lat,
					{ status: event.status },
				);
			}
		} catch {
			/* non-fatal */
		}
	});

	// Start the 5s cpu/mem sampling interval (one per MegaRuntime; cleared in
	// runtime.dispose()). Idempotent — safe to call again after a dispose().
	runtime.ensurePerfInterval();
}
