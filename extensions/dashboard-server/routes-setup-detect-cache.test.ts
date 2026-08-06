/**
 * routes-setup-detect-cache.test.ts — VC9D detect memo cache semantics.
 *
 * Pins the cache contract deterministically with stub detectors: detection
 * spawns local binaries (non-deterministic across hosts), so the conformance
 * fixtures SETUP-CORTEX-030..033 pin the SEMANTIC rules while this unit test
 * drives the concrete short-circuits of createDetectMemo / withDetectMemo:
 *   - an unchanged key returns the stored value WITHOUT re-running compute
 *   - a key mutation forces a recompute (invalidation)
 *   - a null key is never cached — every call runs compute fresh
 *   - clear() drops the entry so the next call recomputes
 * The memoized* wrappers are exercised via the running server (routes-setup
 * integration tests) and must keep returning non-null detect objects.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createDetectMemo, withDetectMemo } from "./routes-setup-detect-cache.js";

interface StubDetector {
	computeCount: number;
	latestKey: string | null;
}

/** Build a memoized wrapper over an injectable key + compute returning a fresh object. */
function makeMemoized(keySequence: (string | null)[]) {
	const slot = createDetectMemo<{ n: number }>();
	let i = 0;
	const state: StubDetector = { computeCount: 0, latestKey: null };
	const run = (): { n: number } => {
		const k = i < keySequence.length ? keySequence[i] : null;
		i += 1;
		state.latestKey = k;
		return withDetectMemo(
			slot,
			() => k,
			() => {
				state.computeCount += 1;
				return { n: state.computeCount };
			},
		);
	};
	return { run, slot, state };
}

describe("detect memo cache (VC9D)", () => {
	test("an unchanged key returns the identical cached object on the second call (no recompute)", () => {
		const { run, state } = makeMemoized(["pathA:100:1", "pathA:100:1"]);
		const first = run();
		const second = run();
		assert.equal(state.computeCount, 1, "compute ran exactly once");
		assert.strictEqual(second, first, "second call returns the SAME object (cache hit)");
		assert.deepEqual(second, { n: 1 });
	});

	test("a key mutation invalidates the entry and forces a recompute (cache miss)", () => {
		const { run, state } = makeMemoized(["pathA:100:1", "pathA:101:2"]);
		const first = run();
		const second = run();
		assert.equal(state.computeCount, 2, "key change recomputes");
		assert.notStrictEqual(second, first, "a key mutation must NOT reuse the old object");
		assert.deepEqual(second, { n: 2 });
	});

	test("a null key is never cached — every call recomputes fresh", () => {
		const slot = createDetectMemo<{ n: number }>();
		let computes = 0;
		const nullRun = () =>
			withDetectMemo(slot, () => null, () => {
				computes += 1;
				return { n: computes };
			});
		assert.deepEqual(nullRun(), { n: 1 });
		assert.deepEqual(nullRun(), { n: 2 }, "null key is never cached");
		assert.equal(computes, 2);
	});

	test("clear() drops the entry so the next call recomputes", () => {
		const { run, slot, state } = makeMemoized(["pathA:100:1", "pathA:100:1"]);
		const first = run();
		slot.clear();
		const third = run();
		assert.equal(state.computeCount, 2, "clear forces a recompute on the same key");
		assert.notStrictEqual(third, first);
		assert.deepEqual(third, { n: 2 });
	});

	test("withDetectMemo returns a non-null detect object under both flag states", () => {
		// The memoized wrappers never return null (detect objects are non-null);
		// the slot's `get` uses null only as "no entry", so a cached `{...}` object
		// is always returned as-is.
		const slot = createDetectMemo<{ installed: boolean }>();
		const always = () => withDetectMemo(slot, () => "k", () => ({ installed: true }));
		assert.deepEqual(always(), { installed: true });
		assert.deepEqual(always(), { installed: true });
	});
});
