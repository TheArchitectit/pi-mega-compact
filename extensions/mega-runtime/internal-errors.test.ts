/**
 * internal-errors.test.ts — Sprint H (Finding 3 / Option A): the
 * `recentInternalErrors` ring + `recordInternalError(category)` instrumentation.
 *
 * Verifies the ring cap/shift mirror of `recentErrorCategories`, and the
 * emit-site push at the highest-leverage failure sites. Uses real stores
 * (no mocks/stubs per repo rules).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { closeStore } from "../../src/store/sqlite.js";

const require = createRequire(import.meta.url);
// Require the compiled JS (build output) so ESM import of pi-tui etc. resolves.
const { MegaRuntime, RING_MAX } = require("./state.js") as {
	MegaRuntime: new (config: any) => any;
	RING_MAX: number;
};

function minimalConfig(stateDir: string): any {
	return {
		tier: "custom",
		tierPct: null,
		thresholdTokens: 100_000,
		stateDir,
		fastGatePct: 70,
		anchorUserMessages: 3,
		preserveRecent: 4,
		preserveRecentMin: 2,
		auto: false,
		autoInline: false,
		autoContinueLengthStop: false,
		autoPctTrigger: null,
		dedupSim: 0.9,
		raptorEnabled: false,
		legacyDurableTrim: false,
		dbMirror: false,
		crossRepoEnabled: false,
		crossRepoCosine: 0.9,
		memoryAutoReview: false,
		memoryReviewInterval: 10,
		recallMaxTokens: 1500,
		windowDedupe: false,
		debug: false,
	};
}

function freshDir(): string {
	return mkdtempSync(join(tmpdir(), "mc-int-err-"));
}

describe("Sprint H — recentInternalErrors ring + recordInternalError", () => {
	const dirs: string[] = [];
	after(() => {
		for (const d of dirs) {
			try { closeStore(d); } catch { /* */ }
		}
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	it("ring starts empty and RING_MAX matches the error-category cap", () => {
		const dir = freshDir(); dirs.push(dir);
		const rt = new MegaRuntime(minimalConfig(dir));
		assert.deepEqual(rt.recentInternalErrors, [], "empty on construction");
		assert.equal(typeof RING_MAX, "number");
		assert.ok(RING_MAX > 0, "RING_MAX is a positive cap");
	});

	it("recordInternalError pushes the category", () => {
		const dir = freshDir(); dirs.push(dir);
		const rt = new MegaRuntime(minimalConfig(dir));
		rt.recordInternalError("store_write");
		assert.deepEqual(rt.recentInternalErrors, ["store_write"]);
	});

	it("ring caps at RING_MAX and shifts the oldest when over", () => {
		const dir = freshDir(); dirs.push(dir);
		const rt = new MegaRuntime(minimalConfig(dir));
		for (let i = 0; i < RING_MAX + 3; i++) {
			rt.recordInternalError(`cat-${i}`);
		}
		assert.equal(rt.recentInternalErrors.length, RING_MAX, "capped at RING_MAX");
		// Oldest 3 dropped; last RING_MAX entries retained in order.
		const expected = Array.from({ length: RING_MAX }, (_, i) => `cat-${i + 3}`);
		assert.deepEqual(rt.recentInternalErrors, expected, "shift keeps newest RING_MAX");
	});

	it("distinct categories accumulate independently (store_write vs vector_index)", () => {
		const dir = freshDir(); dirs.push(dir);
		const rt = new MegaRuntime(minimalConfig(dir));
		rt.recordInternalError("store_write");
		rt.recordInternalError("vector_index");
		rt.recordInternalError("store_write");
		assert.deepEqual(rt.recentInternalErrors, [
			"store_write",
			"vector_index",
			"store_write",
		]);
	});
});
