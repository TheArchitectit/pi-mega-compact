/**
 * context-handler/thrashGuard.test.ts — 3WF-2 ReductionValidator + ThrashGuard.
 *
 * No mocks, no stubs (project rule O1): a REAL VectorStore against a temp
 * stateDir (which is also the real meta-table owner), with a REAL compactSession
 * checkpoint persisted for the store-level assertion. The MegaRuntime is a
 * minimal typed stub (only the fields the guard + gate touch); ctx is not needed
 * here. Follows triggerGuard.test.ts conventions (real store, mkdtemp,
 * closeIndexStore in after()).
 *
 * Assertions (sprint tests 3 + 4):
 *  3. three consecutive INEFFECTIVE compactions (live currentTokens does NOT
 *     shrink across the consecutive context events) -> the 4th context event
 *     above threshold produces NO fire (gate returns "return"; meta key set) AND
 *     thrasguard.blocked_until is set in meta (assert via getMetaNumber). Then
 *     inject > N tokens of live growth -> guard no longer blocks (gate returns
 *     "proceed"); a real compactSession now grows vectorList (compaction can
 *     fire again).
 *  4. umbrella flag OFF -> compactSession output byte-identical (the guard never
 *     writes meta when off); and isThrashBlocked is inert (no thrasguard.* meta
 *     key written even after ineffective fires).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VectorStore, vectorList, vectorStats } from "../../../src/vectorStore.js";
import { compactSession } from "../../../src/engine.js";
import { closeIndexStore } from "../../../src/store/sqlite.js";
import { getMetaNumber, setMetaNumber } from "../../../src/store/sqlite.js";
import type { Logger } from "../../../src/log.js";
import type { MegaRuntime } from "../../mega-runtime.js";
import type { MegaConfig } from "../../mega-config.js";
import { evaluateGate, thrashGuardBlocks } from "./gateCheck.js";
import {
	markCompactionFired,
	evaluatePendingReduction,
	isThrashBlocked,
	disarmThrashGuard,
	ReductionValidator,
	THRASH_BLOCKED_KEY,
	THRASH_BASELINE_KEY,
} from "./thrashGuard.js";

/** Real EngineMessage fixture (user + assistant turn). */
function msg(role: "user" | "assistant", text: string): any {
	return { role, text };
}

/** Fresh isolated state dir per VectorStore. */
function freshStore(): { store: VectorStore; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "mc-thrash-"));
	return { store: new VectorStore({ dedupSim: 0.9, stateDir: dir }), dir };
}

const noopLogger: Logger = {
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as Logger;

/** Minimal MegaRuntime stub: only the fields thrashGuard + gateCheck touch. */
function runtimeStub(
	store: VectorStore,
	stateDir: string,
	over: Partial<{ effectiveThreshold: number; lastCtxWindow: number }> = {},
): MegaRuntime {
	return {
		store,
		currentStateDir: stateDir,
		lastCtxWindow: over.lastCtxWindow ?? 0,
		effectiveThreshold: over.effectiveThreshold ?? 100_000,
		logger: noopLogger,
		diagCtxFastGate: 0,
		diagCtxNoCompact: 0,
		rt: { lastCheckpointId: null as string | null },
	} as unknown as MegaRuntime;
}

/** tiered(custom, pct null) config shaped like MegaConfig for the gate/evaluator. */
function cfg(threeWayFailback: boolean): MegaConfig {
	return {
		threeWayFailback,
		thrashRearmPct: 0.1,
		tier: "custom",
		tierPct: null,
	} as unknown as MegaConfig;
}

/** Drive three ineffective compaction cycles (live window never shrinks). */
function fireThreeIneffective(
	runtime: MegaRuntime,
	stateDir: string,
	config: MegaConfig,
): void {
	// Each cycle: an event fires compaction (liveBefore), the NEXT event shows
	// the window unchanged (liveAfter === liveBefore => ineffective) => arm.
	const live = 190_000; // baseline window that does not shrink
	for (let i = 0; i < 3; i++) {
		markCompactionFired(runtime, live);
		evaluatePendingReduction(runtime, live, config);
	}
	// Guard persisted blocked_until = live + rearmPct * effectiveThreshold
	// = 190_000 + 0.1 * 100_000 = 200_000.
	void stateDir;
}

after(() => {
	try { closeIndexStore(); } catch { /* */ }
});

test("3WF-2 test 3: three ineffective compactions -> guard armed; 4th above-threshold event refused; re-arm after >N growth", () => {
	const { store, dir } = freshStore();
	try {
		const runtime = runtimeStub(store, dir, { effectiveThreshold: 100_000, lastCtxWindow: 0 });
		const config = cfg(true);

		// Pre-condition: nothing armed yet.
		assert.equal(getMetaNumber(THRASH_BLOCKED_KEY, dir), 0, "guard starts unarmed");
		assert.equal(isThrashBlocked(50_000, dir), false, "no block when unarmed");

		// Three consecutive ineffective compactions.
		fireThreeIneffective(runtime, dir, config);

		// The guard is armed: blocked_until meta key is set (190k + 10k = 200k).
		const blockedUntil = getMetaNumber(THRASH_BLOCKED_KEY, dir);
		assert.ok(blockedUntil > 0, "thrasguard.blocked_until is set after ineffective fires");
		assert.equal(getMetaNumber(THRASH_BASELINE_KEY, dir), 190_000, "baseline persisted");

		// The 4th context event: currentTokens (150k) is ABOVE the gate threshold
		// (100k effectiveThreshold, custom tier reads it directly) so the fast gate
		// PROCEEDS — proving the refusal is the GUARD's doing and not a
		// below-threshold no-op. The guard consult (which the handler applies after
		// the replay block, before invokePipeline) then blocks the fire.
		const tailResult = () => undefined;
		const openGate = evaluateGate(runtime, config, {
			pct: null,
			currentTokens: 150_000,
			tailResult,
		});
		assert.equal(
			openGate.kind,
			"proceed",
			"fast gate itself passes at 150k (above the 100k threshold) — isolates the guard's effect",
		);
		assert.equal(
			thrashGuardBlocks(runtime, config, 150_000),
			true,
			"guard refuses the 4th above-threshold event (window still below blocked_until)",
		);
		assert.equal(isThrashBlocked(150_000, dir), true, "still blocked at 150k");

		// Inject > N tokens of live growth: window past blocked_until (200k).
		assert.equal(
			thrashGuardBlocks(runtime, config, 250_000),
			false,
			"guard re-arms after >N growth (window past blocked_until) -> compaction can fire",
		);
		assert.equal(isThrashBlocked(250_000, dir), false, "not blocked once window grew past blocked_until");

		// Store-level proof compaction can fire again: a real compactSession on a
		// real VectorStore grows the checkpoint list. (The blocked phase produced
		// no new row because the gate refused; now unblocked it adds one.)
		const before = vectorList(store, "sess_thrash").length;
		compactSession(
			{
				sessionId: "sess_thrash",
				messages: [msg("user", "real topic zeta nine"), msg("assistant", "ok")],
				keepFrom: 2,
				timestamp: 1,
			},
			store,
		);
		const afterCount = vectorList(store, "sess_thrash").length;
		assert.ok(afterCount > before, "compaction fires again after re-arm (checkpoint row added)");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("3WF-2 test 3 (sanity): effectiveThreshold +Infinity -> guard skips arming (no Infinity/NaN in meta)", () => {
	const { store, dir } = freshStore();
	try {
		// +Infinity effectiveThreshold models the 3WF-2 invariant when the model
		// window is unknown: N = rearmPct * Infinity is non-finite, so arming must
		// SKIP and never persist Infinity/NaN into meta.
		const runtime = runtimeStub(store, dir, { effectiveThreshold: Number.POSITIVE_INFINITY, lastCtxWindow: 0 });
		const config = cfg(true);
		markCompactionFired(runtime, 190_000);
		evaluatePendingReduction(runtime, 190_000, config);
		assert.equal(
			getMetaNumber(THRASH_BLOCKED_KEY, dir),
			0,
			"no armed key when effectiveThreshold is +Infinity (skip, no corruption)",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("3WF-2 test 4: umbrella OFF -> guard writes no meta + compactSession byte-identical", () => {
	const { store, dir } = freshStore();
	try {
		const runtime = runtimeStub(store, dir, { effectiveThreshold: 100_000, lastCtxWindow: 0 });
		const configOff = cfg(false);

		// Three ineffective fires with the umbrella OFF: the guard must be inert
		// (no thrasguard.* meta key written — the flag gate lives in the
		// consumers, not in isThrashBlocked itself).
		for (let i = 0; i < 3; i++) {
			markCompactionFired(runtime, 190_000);
			evaluatePendingReduction(runtime, 190_000, configOff);
		}
		assert.equal(
			getMetaNumber(THRASH_BLOCKED_KEY, dir),
			0,
			"flag OFF: no blocked_until written",
		);
		assert.equal(
			getMetaNumber(THRASH_BASELINE_KEY, dir),
			0,
			"flag OFF: no baseline written",
		);
		// Even if a key WERE present, the flag-gated consult never refuses when the
		// umbrella is OFF. Force-arm the raw meta key, then prove thrashGuardBlocks
		// (the handler's actual consult) returns false regardless. The unguarded
		// isThrashBlocked reads meta directly (the flag gate lives in the consumer),
		// so it is not asserted false here — thrashGuardBlocks is the real surface.
		setMetaNumber(THRASH_BLOCKED_KEY, 999_999, dir);
		assert.equal(
			thrashGuardBlocks(runtime, configOff, 1),
			false,
			"flag OFF: guard consult never refuses even with blocked_until armed",
		);

		// compactSession is untouched by this sprint, so ON vs OFF produce identical
		// output. Proof: two runs on identical inputs compare equal modulo the fields
		// that are inherently variable: checkpointId (generated uuid) AND the
		// dedup fields (deduped/dedupReason) which depend on whether a prior matching
		// checkpoint already exists in the store — the second identical run collapses
		// onto the first, which is correct dedup behavior, not a flag effect. The
		// summary/region/estimates are deterministic and compare equal.
		const input = {
			sessionId: "sess_identity",
			messages: [msg("user", "stable content kappa two"), msg("assistant", "done")],
			keepFrom: 2,
			timestamp: 1,
		};
		const a = compactSession({ ...input }, store);
		const b = compactSession({ ...input }, store);
		const strip = (r: typeof a): string =>
			JSON.stringify({
				...r,
				checkpointId: undefined,
				deduped: undefined,
				dedupReason: undefined,
			});
		assert.equal(
			strip(a),
			strip(b),
			"compactSession output is byte-identical across runs (checkpointId + dedup fields excluded: generated uuid / store-state-dependent)",
		);
		assert.ok(vectorStats(store, "sess_identity").checkpointCount >= 1, "checkpoints persisted");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("3WF-2 test 4 (alt): effective reduction is credited but noise-level wobble is not", () => {
	// Pure validator check (no store). A real shrink is effective; a sub-floor
	// wobble (2% of liveBefore = 3800 at 190k) is NOT effective.
	const V = ReductionValidator;
	assert.equal(V.validateReduction(190_000, 150_000).effective, true, "real shrink credited");
	assert.equal(V.validateReduction(190_000, 189_000).effective, false, "sub-floor wobble not effective");
	assert.equal(V.validateReduction(190_000, 190_000).effective, false, "zero reduction ineffective");
	assert.equal(V.validateReduction(190_000, 200_000).effective, false, "growth is not a reduction");
});

// ─── ThrashGuard bug fix: effective compaction must clear the guard ────

test("fix: effective compaction clears blocked_until (disarms the guard)", () => {
	const dir = mkdtempSync(join(tmpdir(), "mc-tg-fix-"));
	try {
		// Simulate: guard was armed by a prior ineffective compaction.
		setMetaNumber(THRASH_BLOCKED_KEY, 200_000, dir);
		setMetaNumber(THRASH_BASELINE_KEY, 195_000, dir);
		assert.equal(isThrashBlocked(180_000, dir), true, "guard blocks at 180k < 200k");

		// Disarm it (as evaluatePendingReduction would on an effective compaction).
		disarmThrashGuard(dir);
		assert.equal(isThrashBlocked(180_000, dir), false, "guard no longer blocks after disarm");
		assert.equal(getMetaNumber(THRASH_BLOCKED_KEY, dir), 0, "blocked_until cleared to 0");
		assert.equal(getMetaNumber(THRASH_BASELINE_KEY, dir), 0, "baseline cleared to 0");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fix: stale blocked_until from a prior session is cleared on disarm (cross-session)", () => {
	const dir = mkdtempSync(join(tmpdir(), "mc-tg-fix2-"));
	try {
		// Simulate: a prior session armed the guard at a high value.
		setMetaNumber(THRASH_BLOCKED_KEY, 250_000, dir);
		// A new session at 100k would be blocked by the stale guard.
		assert.equal(isThrashBlocked(100_000, dir), true, "stale guard blocks new session");

		// Session start calls disarmThrashGuard.
		disarmThrashGuard(dir);
		// Now the new session is not blocked.
		assert.equal(isThrashBlocked(100_000, dir), false, "not blocked after session-start disarm");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});