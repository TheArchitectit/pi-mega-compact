/**
 * snapshot.test.ts — C.4 computeMegaSnapshot tests for providerCachePct
 * and megaCacheFlare fields.
 *
 * Uses MEGACOMPACT_STATE_DIR + mkdtemp (G7). No pi runtime.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { computeMegaSnapshot, type SnapshotInput } from "./snapshot.js";

function baseInput(overrides: Partial<SnapshotInput> = {}): SnapshotInput {
	return {
		rtTokensSaved: 1000,
		lastCtxPercent: null,
		lastCtxTokens: 0,
		lastCtxWindow: 0,
		activeAgents: 0,
		currentTurn: 0,
		statusKey: undefined,
		ready: false,
		armed: false,
		st: {
			totalTokenEstimate: 800,
			originalTokens: 1200,
			storageDedupRate: 0.12,
			checkpointCount: 3,
			lastCheckpointId: undefined,
			lastSummary: undefined,
			injectedCount: 0,
			dedupHitRate: 0.05,
			tokensSaved: 200,
			dedupAttempts: 40,
			dedupCollapsed: 5,
		},
		repo: {
			tokensSaved: 5000,
			totalTokenEstimate: 4000,
			checkpointCount: 9,
			sessionCount: 2,
			originalTokens: 6000,
			dedupAttempts: 100,
			dedupCollapsed: 30,
			storageDedupRate: 0.3,
		},
		pressureBand: "low",
		configTier: "default",
		modelSnap: undefined,
		lastCompactAt: null,
		embedderName: () => "Trigram",
		driftStatus: () => "ok" as const,
		getCachedGameState: () => ({
			game_mode_on: false,
			theme: "transparent",
			tui_display_mode: "full",
		}),
		getTurnLevel: () => 1,
		providerCachePct: 56.2,
		megaCacheFlare: false,
		megaCacheFlarePct: 0,
		levelUpFlare: false,
		achievementFlare: false,
		achievementFlareTitles: [],
		activeEffect: null,
		lastActivityAt: Date.now(),
		ticker: [],
		lastWhy: undefined,
		tierTrace: undefined,
		pulsing: false,
		...overrides,
	};
}

describe("computeMegaSnapshot (C.4)", () => {
	let dir: string;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "mc-snap-"));
		process.env.MEGACOMPACT_STATE_DIR = dir;
	});
	after(() => {
		delete process.env.MEGACOMPACT_STATE_DIR;
		rmSync(dir, { recursive: true, force: true });
	});

	// ── C.1: providerCachePct flows into cachePct ─────────────────────────
	it("cachePct equals providerCachePct (not dedup hit rate)", () => {
		const res = computeMegaSnapshot(baseInput({ providerCachePct: 56.2 }));
		assert.equal(res.widgetData.cachePct, 56.2, "cachePct is providerCachePct");
	});

	it("cachePct is 0 when providerCachePct is 0", () => {
		const res = computeMegaSnapshot(baseInput({ providerCachePct: 0 }));
		assert.equal(res.widgetData.cachePct, 0, "cachePct is 0");
	});

	it("cachePct is independent of dedup hit rate", () => {
		const res = computeMegaSnapshot(
			baseInput({
				providerCachePct: 12.5,
				st: {
					totalTokenEstimate: 99999,
					originalTokens: 99999,
					storageDedupRate: 0.99,
					checkpointCount: 1,
					lastCheckpointId: undefined,
					lastSummary: undefined,
					injectedCount: 0,
					dedupHitRate: 0.05,
					tokensSaved: 200,
					dedupAttempts: 40,
					dedupCollapsed: 5,
				},
			}),
		);
		assert.equal(res.widgetData.cachePct, 12.5, "cachePct ignores dedup");
	});

	// ── megaCacheFlare fields pass through ────────────────────────────────
	it("megaCacheFlare + megaCacheFlarePct pass through to widgetData", () => {
		const res = computeMegaSnapshot(
			baseInput({ megaCacheFlare: true, megaCacheFlarePct: 287 }),
		);
		assert.equal(res.widgetData.megaCacheFlare, true);
		assert.equal(res.widgetData.megaCacheFlarePct, 287);
	});

	it("megaCacheFlare is false by default", () => {
		const res = computeMegaSnapshot(baseInput());
		assert.equal(res.widgetData.megaCacheFlare, false);
	});

	// ── level pass-through ────────────────────────────────────────────────
	it("level flows from getTurnLevel", () => {
		const res = computeMegaSnapshot(baseInput({ getTurnLevel: () => 42 }));
		assert.equal(res.curLevel, 42);
	});
});
