/**
 * prefix-telemetry.test.ts — S54 cache prefix-break detection (pure).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	diffPrefixChain,
	hashPrefixMessage,
	isPrefixTelemetryEnabled,
} from "./prefix-telemetry.js";

const noTool = () => false;

describe("prefix-telemetry (S54)", () => {
	it("first sample is the baseline — never a break", () => {
		const r = diffPrefixChain(null, ["a", "b"], {
			epochChanged: false,
			recallInjected: false,
			isToolMessage: noTool,
		});
		assert.equal(r.broke, false);
		assert.equal(r.cause, null);
	});

	it("append-only growth is not a break", () => {
		const r = diffPrefixChain(["a", "b"], ["a", "b", "c"], {
			epochChanged: false,
			recallInjected: false,
			isToolMessage: noTool,
		});
		assert.equal(r.broke, false);
	});

	it("pure tail truncation keeps the head intact — not a break", () => {
		const r = diffPrefixChain(["a", "b", "c"], ["a", "b"], {
			epochChanged: false,
			recallInjected: false,
			isToolMessage: noTool,
		});
		assert.equal(r.broke, false);
	});

	it("mid-array divergence breaks at the first differing index", () => {
		const r = diffPrefixChain(["a", "b", "c"], ["a", "x", "c"], {
			epochChanged: false,
			recallInjected: false,
			isToolMessage: noTool,
		});
		assert.equal(r.broke, true);
		assert.equal(r.breakIndex, 1);
		assert.equal(r.cause, "other");
	});

	it("epoch change outranks tool position", () => {
		const r = diffPrefixChain(["a", "b"], ["A", "b"], {
			epochChanged: true,
			recallInjected: false,
			isToolMessage: () => true, // everything looks tool-ish — epoch still wins
		});
		assert.equal(r.cause, "epoch-change");
	});

	it("recall injection outranks tool-insertion but not epoch-change", () => {
		const r = diffPrefixChain(["a", "b"], ["a", "B"], {
			epochChanged: false,
			recallInjected: true,
			isToolMessage: () => true,
		});
		assert.equal(r.cause, "recall-injection");
	});

	it("tool-ish message at the break point classifies tool-insertion", () => {
		const r = diffPrefixChain(["a", "b", "c"], ["a", "x", "c"], {
			epochChanged: false,
			recallInjected: false,
			isToolMessage: (i) => i === 1,
		});
		assert.equal(r.cause, "tool-insertion");
	});

	it("hashPrefixMessage is deterministic + role-sensitive", () => {
		const h1 = hashPrefixMessage("user", "hello");
		const h2 = hashPrefixMessage("user", "hello");
		const h3 = hashPrefixMessage("assistant", "hello");
		assert.equal(h1, h2);
		assert.notEqual(h1, h3);
		assert.match(h1, /^[0-9a-f]{8}$/);
	});

	it("flag default ON; MEGACOMPACT_PREFIX_TELEMETRY=0 disables", () => {
		delete process.env.MEGACOMPACT_PREFIX_TELEMETRY;
		assert.equal(isPrefixTelemetryEnabled(), true);
		process.env.MEGACOMPACT_PREFIX_TELEMETRY = "0";
		assert.equal(isPrefixTelemetryEnabled(), false);
		delete process.env.MEGACOMPACT_PREFIX_TELEMETRY;
	});
});
