/**
 * perf.ts — extracted perf-interval sampling for MegaRuntime.
 *
 * The 5s cpu/mem sampling interval + its teardown. Keeps the setInterval
 * boilerplate out of the main state.ts class body.
 */

import { recordPerfSample } from "../../src/store/sqlite.js";

// ---------------------------------------------------------------------- types

export interface PerfContext {
	readonly currentStateDir: string;
	perfCpuInterval: NodeJS.Timeout | null;
	perfCpuBaseline: { user: number; sys: number } | undefined;
}

/**
 * RT2 (audit): the tracked deferred durable-trim timer (the setTimeout(500)
 * ctx.compact() recheck armed by the agent_end durable trim, the context/
 * poisoned error handlers, and the context handler's race-guarded path). Stored
 * on the runtime so resetRuntime() and dispose() can clearTimeout it, mirroring
 * perfCpuInterval. Only one such recheck is ever in flight at a time.
 */
export interface PendingTimerContext {
	pendingDurableTrimTimer: ReturnType<typeof setTimeout> | null;
}

// ---------------------------------------------------------- ensurePerfInterval

/** v0.8.8: (re)start the 5s cpu/mem sampling interval (idempotent). One per
 *  MegaRuntime; cleared in disposePerf(). Samples process.cpuUsage() (user/sys
 *  delta vs the last tick → ms) + process.memoryUsage() (rss/heap → MB) and
 *  records them as perf_samples. unref'd so it never keeps the process alive
 *  on its own. Non-fatal: any failure is swallowed (instrumentation never
 *  blocks the agent). PREVENT-PI-004: local process stats + SQLite only. */
export function ensurePerfIntervalImpl(ctx: PerfContext): void {
	if (ctx.perfCpuInterval) return;
	ctx.perfCpuBaseline = undefined; // first tick sets the baseline (no delta)
	ctx.perfCpuInterval = setInterval(() => {
		try {
			const dir = ctx.currentStateDir;
			const cpu = process.cpuUsage();
			const mem = process.memoryUsage();
			if (ctx.perfCpuBaseline) {
				const du = (cpu.user - ctx.perfCpuBaseline.user) / 1000; // μs → ms
				const ds = (cpu.system - ctx.perfCpuBaseline.sys) / 1000;
				recordPerfSample(dir, "cpu_user_ms", Math.max(0, du));
				recordPerfSample(dir, "cpu_sys_ms", Math.max(0, ds));
			}
			ctx.perfCpuBaseline = { user: cpu.user, sys: cpu.system };
			recordPerfSample(dir, "rss_mb", mem.rss / 1_000_000);
			recordPerfSample(dir, "heap_mb", mem.heapUsed / 1_000_000);
		} catch {
			/* non-fatal */
		}
	}, 5000);
	ctx.perfCpuInterval.unref?.();
}

// ------------------------------------------------------------------ disposePerf

/** Stop the cpu/mem sampling interval on teardown. Re-armed lazily by
 *  ensurePerfInterval() on the next turn_start. */
export function disposePerf(ctx: PerfContext): void {
	if (ctx.perfCpuInterval) {
		clearInterval(ctx.perfCpuInterval);
		ctx.perfCpuInterval = null;
		ctx.perfCpuBaseline = undefined;
	}
}

/** RT2 (audit): cancel the in-flight deferred durable-trim recheck timer on
 *  teardown / session reset. Re-armed lazily by the next race-guarded path that
 *  calls ctx.compact(). Safe to call when none is pending. */
export function disposePendingTimers(ctx: PendingTimerContext): void {
	if (ctx.pendingDurableTrimTimer) {
		clearTimeout(ctx.pendingDurableTrimTimer);
		ctx.pendingDurableTrimTimer = null;
	}
}
