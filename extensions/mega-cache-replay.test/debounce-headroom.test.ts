/**
 * debounce-headroom.test.ts — C2 (v0.21.10): the 2s debounce is EXEMPT for
 * headroom-triggered fires, mirroring the existing thrash-guard exemption.
 *
 * pi's own overflow recovery is "400 → compact → immediate retry", so it re-fires
 * a context event well inside our 2s debounce window. Pre-C2 that fire took the
 * debounce return path and handed pi the RAW untrimmed view — input + the model's
 * output reserve still exceeded the window → another 400 → "Context overflow
 * recovery failed after one compact-and-retry attempt." An overflowed session is
 * unrecoverable; a wasted re-fire is merely wasteful.
 *
 * Scale note: no window-size constants are asserted. The trip is produced by the
 * existing percent-based gate (reserve = a FRACTION of the reported window), and
 * the second case proves the same fractions behave identically at a 1M window.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./_helpers.js";

/**
 * Put the runtime in a headroom-tripping state at ANY window size: report a
 * window, declare a maxTokens that is a large fraction of it (via the real
 * model_select → captureModel path), and sit at an input fraction that alone is
 * far below every percent fire point. The gate's own math
 * (input + reserve + margin >= window) then trips.
 */
async function armHeadroom(
	h: ReturnType<typeof harness>,
	window: number,
): Promise<void> {
	h.usage.contextWindow = window;
	h.usage.percent = 40; // 40% input — below every tier fire point
	h.usage.tokens = Math.round(window * 0.4);
	// 40% input + 62% reserve + margin > 100% of the window → headroom trip.
	await h.fire(
		"model_select",
		{ type: "model_select", model: "headroom-test" },
		h.ctx({
			model: {
				id: "headroom-test",
				provider: "plexus",
				contextWindow: window,
				maxTokens: Math.round(window * 0.62),
				reasoning: false,
			},
		}),
	);
}

test("C2: a headroomExceeded fire BYPASSES the armed 2s debounce", async () => {
	const h = harness();
	const session = h.buildSession("A", 14);
	const rt = h.runtime;

	await armHeadroom(h, 32000);
	const ctx = h.ctx();
	// Arm the debounce exactly as pi's overflow-recovery re-fire would find it: a
	// fire happened <2s ago. Also drop the trim cache so the D.2 replay branch
	// (above the debounce, already exempt) cannot mask the debounce path.
	rt.debounceUntil = Date.now() + 2000;
	rt.trimCache = undefined;

	const dbgBefore = rt.diagCtxDebounce;
	const firesBefore = rt.diagLiveTrimFires;
	const tripsBefore = rt.diagCtxHeadroomTrip;

	await h.fire("context", { type: "context", messages: session }, ctx);

	assert.ok(
		rt.diagCtxHeadroomTrip > tripsBefore,
		`the gate tripped on headroom (${tripsBefore} → ${rt.diagCtxHeadroomTrip})`,
	);
	assert.equal(
		rt.diagCtxDebounce,
		dbgBefore,
		`debounce NOT taken on the headroom fire (${rt.diagCtxDebounce} === ${dbgBefore})`,
	);
	assert.ok(
		rt.diagLiveTrimFires > firesBefore,
		`the pipeline ran and returned a trimmed view (fires ${firesBefore} → ${rt.diagLiveTrimFires})`,
	);
	// The bypass must still RE-ARM the debounce so a following non-headroom fire
	// is debounced as normal (no stale window left behind).
	assert.ok(
		rt.debounceUntil > Date.now(),
		"the bypassing fire re-armed the debounce",
	);
});

test("C2: the headroom bypass is scale-free — same fractions bypass at a 1M window", async () => {
	const h = harness();
	const session = h.buildSession("A", 14);
	const rt = h.runtime;

	await armHeadroom(h, 1_000_000);
	const ctx = h.ctx();
	rt.debounceUntil = Date.now() + 2000;
	rt.trimCache = undefined;

	const dbgBefore = rt.diagCtxDebounce;
	const tripsBefore = rt.diagCtxHeadroomTrip;
	await h.fire("context", { type: "context", messages: session }, ctx);

	assert.ok(rt.diagCtxHeadroomTrip > tripsBefore, "headroom tripped at 1M too");
	assert.equal(rt.diagCtxDebounce, dbgBefore, "debounce bypassed at 1M too");
});

test("C2: WITHOUT headroom the debounce is unchanged — the second rapid fire is debounced", async () => {
	const h = harness();
	const session = h.buildSession("A", 14);
	const rt = h.runtime;

	// Healthy headroom: a tiny declared output budget AND a modest input fraction
	// (30% of the window), so input + reserve + margin stays well under 100% and
	// the gate's headroom check cannot trip. percent=null routes us to the token
	// gate, which the harness's THRESHOLD_TOKENS=50 passes, so we reach the
	// debounce — the path under test.
	h.usage.contextWindow = 200000;
	h.usage.percent = null;
	h.usage.tokens = Math.round(200000 * 0.3);
	await h.fire(
		"model_select",
		{ type: "model_select", model: "roomy-test" },
		h.ctx({
			model: {
				id: "roomy-test",
				provider: "plexus",
				contextWindow: 200000,
				maxTokens: 1000,
				reasoning: false,
			},
		}),
	);
	const ctx = h.ctx();

	h.clearDebounce();
	await h.fire("context", { type: "context", messages: session }, ctx);
	assert.equal(rt.diagCtxHeadroomTrip, 0, "no headroom trip on a roomy model");
	assert.ok(rt.diagLiveTrimFires >= 1, "the first fire produced a trim");

	// Invalidate the replay cache so the debounce (not D.2 replay) is the path
	// under test, but leave the debounce armed by the fire above.
	rt.trimCache = undefined;
	const dbgBefore = rt.diagCtxDebounce;
	assert.ok(rt.debounceUntil > Date.now(), "the first fire armed the debounce");

	await h.fire("context", { type: "context", messages: session }, ctx);

	assert.equal(
		rt.diagCtxDebounce,
		dbgBefore + 1,
		`the non-headroom rapid re-fire was debounced (${dbgBefore} → ${rt.diagCtxDebounce})`,
	);
	assert.equal(rt.diagCtxHeadroomTrip, 0, "still no headroom trip");
});
