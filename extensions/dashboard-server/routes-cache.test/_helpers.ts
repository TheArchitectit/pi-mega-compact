/**
 * Shared harness + types for the routes-cache split files.
 * Extracted from routes-cache.test.ts: spawn-and-fetch server harness + DTOs.
 */
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const SERVER_ENTRY = new URL("../server.js", import.meta.url).pathname;

export function waitFor(
	cond: () => boolean | Promise<boolean>,
	timeoutMs = 6000,
): Promise<void> {
	const start = Date.now();
	return new Promise((resolve, reject) => {
		const tick = async () => {
			if (await cond()) return resolve();
			if (Date.now() - start > timeoutMs) return reject(new Error("timeout"));
			setTimeout(tick, 50);
		};
		tick();
	});
}

export function freshDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

export async function withServer<T>(
	port: string,
	dir: string,
	fn: (port: number) => Promise<T>,
): Promise<T> {
	process.env.MEGACOMPACT_DASHBOARD_PORT = port;
	const child = spawn(process.execPath, [SERVER_ENTRY, dir], { stdio: "ignore" });
	try {
		await waitFor(async () => {
			try {
				const raw = JSON.parse(readFileSync(join(dir, "port.pid"), "utf-8"));
				const res = await fetch(`http://localhost:${raw.port}/api/version`);
				return res.ok;
			} catch {
				return false;
			}
		});
		const raw = JSON.parse(readFileSync(join(dir, "port.pid"), "utf-8"));
		return await fn(raw.port);
	} finally {
		child.kill("SIGTERM");
		delete process.env.MEGACOMPACT_DASHBOARD_PORT;
		rmSync(dir, { recursive: true, force: true });
	}
}

export interface ProviderCacheByModel {
	model: string;
	hitPct: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	sampleCount: number;
}

export interface ProviderCacheResponse {
	cache: {
		avgHitPct: number;
		turnCount: number;
		totalCacheRead: number;
		totalCacheWrite: number;
		totalInput: number;
		firstTurnAt: string | null;
		latestTurnAt: string | null;
		byModel: ProviderCacheByModel[];
	};
	savings: {
		cacheReadSaved: number;
		cacheWriteCost: number;
		netSaved: number;
		model: string;
		inputRate: number;
	} | null;
	updatedAt: string;
	windowMinutes?: number | null;
	prefixBreaks: Array<{
		id: number;
		ts: number;
		cause: string;
		confidence: number;
		prevHitPct: number;
		currHitPct: number;
		breakAt: number;
	}>;
}
