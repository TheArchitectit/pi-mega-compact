/**
 * routes-rag-settings-headroom.test.ts — v0.21.9 output-headroom settings.
 *
 * The two new flags (MEGACOMPACT_OVERFLOW_HEADROOM, MEGACOMPACT_OUTPUT_RESERVE_PCT)
 * must be dashboard-toggleable (all-flags rule — never EXCLUDED_SETTINGS) and
 * round-trip through the REAL GET/POST /api/rag-settings handler exactly like
 * the 3WF flags. Mirrors routes-rag-settings-3wf.test.ts; kept in its own file
 * per the soft-cap discipline.
 *
 * No mocks/stubs of the unit under test: real route handler, real route
 * context, real env-file write in an mkdtemp dir.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { buildRouteContext } from "./routes-core.js";
import { handleRagSettings } from "./routes-rag-settings.js";
import { EXCLUDED_SETTINGS } from "./routes-rag-settings-helpers.js";
import { loadConfig } from "../mega-config.js";

const HEADROOM_KEY = "MEGACOMPACT_OVERFLOW_HEADROOM";
const RESERVE_KEY = "MEGACOMPACT_OUTPUT_RESERVE_PCT";

let testDir: string;
let saved: [string, string | undefined][];

function polluteEnv(): void {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("MEGACOMPACT")) delete process.env[key];
	}
}

beforeEach(() => {
	testDir = mkdtempSync(join(tmpdir(), "mega-headroom-settings-"));
	saved = Object.keys(process.env)
		.filter((k) => k.startsWith("MEGACOMPACT"))
		.map((k) => [k, process.env[k]]);
	polluteEnv();
});

afterEach(() => {
	polluteEnv();
	for (const [key, val] of saved) {
		if (val === undefined) delete process.env[key];
		else process.env[key] = val;
	}
	try {
		rmSync(testDir, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
});

function makeRes(): { res: ServerResponse; body: string; statusCode: number } {
	let body = "";
	let statusCode = 0;
	const res = {
		writeHead(code: number) {
			statusCode = code;
		},
		end(chunk?: string) {
			if (chunk) body = chunk;
		},
	} as unknown as ServerResponse;
	return {
		res,
		get body() {
			return body;
		},
		get statusCode() {
			return statusCode;
		},
	};
}

function ctx() {
	return buildRouteContext({
		snapshotPath: join(testDir, "dashboard.json"),
		eventsPath: join(testDir, "events.log"),
		stateDir: testDir,
		SERVER_VERSION: "9.9.9-test",
		serveClientAsset: () => false,
		detectCrossRepoDrift: () => ({
			generatedAt: 0,
			totals: { ok: 0, warn: 0, stale: 0, compactionLag: 0, modelChurn: 0 },
			repos: [],
		}),
	});
}

async function post(body: object): Promise<{ body: string; statusCode: number }> {
	const payload = JSON.stringify(body);
	let dataEmitted = false;
	const req = {
		method: "POST",
		url: "/api/rag-settings",
		headers: {},
		on(event: string, cb: (c?: Buffer) => void): unknown {
			if (event === "data") {
				if (!dataEmitted) {
					dataEmitted = true;
					cb(Buffer.from(payload));
				}
			} else if (event === "end") {
				cb();
			}
			return this;
		},
	} as unknown as IncomingMessage;
	const r = makeRes();
	const handled = handleRagSettings(req, r.res, ctx());
	assert.equal(handled, true, "POST must be handled");
	return { body: r.body, statusCode: r.statusCode };
}

interface GetSetting {
	key: string;
	value: unknown;
	type: string;
}

function getSettings(): GetSetting[] {
	const req = {
		method: "GET",
		url: "/api/rag-settings",
		headers: {},
	} as unknown as IncomingMessage;
	const r = makeRes();
	const handled = handleRagSettings(req, r.res, ctx());
	assert.equal(handled, true, "GET must be handled");
	assert.equal(r.statusCode, 200);
	const parsed = JSON.parse(r.body) as {
		categories: { name: string; settings: GetSetting[] }[];
	};
	return parsed.categories.flatMap((c) => c.settings);
}

function envContent(): string {
	const p = join(testDir, ".mega-compact.env");
	return existsSync(p) ? readFileSync(p, "utf-8") : "";
}

describe("v0.21.9 output-headroom settings round-trip", () => {
	it("GET surfaces both headroom flags with their defaults", () => {
		const all = getSettings();
		const headroom = all.find((s) => s.key === HEADROOM_KEY);
		assert.ok(headroom, `${HEADROOM_KEY} must be surfaced by GET /api/rag-settings`);
		assert.equal(headroom.type, "boolean");
		assert.equal(headroom.value, true, "overflow-headroom gate defaults ON");
		const reserve = all.find((s) => s.key === RESERVE_KEY);
		assert.ok(reserve, `${RESERVE_KEY} must be surfaced by GET /api/rag-settings`);
		assert.equal(reserve.type, "number");
		assert.equal(reserve.value, 0.3, "output reserve fraction defaults to 0.30");
	});

	it("POST toggling the headroom gate OFF writes the plain opt-out, re-enable writes ON", async () => {
		const off = await post({ key: HEADROOM_KEY, value: "false" });
		assert.equal(off.statusCode, 200);
		assert.match(
			envContent(),
			/export MEGACOMPACT_OVERFLOW_HEADROOM="false"/,
			"opt-out must write the PLAIN key the runtime envBool reads",
		);
		const on = await post({ key: HEADROOM_KEY, value: "true" });
		assert.equal(on.statusCode, 200);
		assert.match(envContent(), /export MEGACOMPACT_OVERFLOW_HEADROOM="true"/);
	});

	it("POST writing the reserve fraction round-trips into loadConfig", async () => {
		const r = await post({ key: RESERVE_KEY, value: "0.45" });
		assert.equal(r.statusCode, 200);
		assert.match(envContent(), /export MEGACOMPACT_OUTPUT_RESERVE_PCT="0.45"/);
		process.env.MEGACOMPACT_OUTPUT_RESERVE_PCT = "0.45";
		assert.equal(loadConfig().outputReservePct, 0.45, "runtime reads the written value");
		// The clamp bounds: an out-of-range write is clamped at load, never NaN.
		process.env.MEGACOMPACT_OUTPUT_RESERVE_PCT = "5";
		assert.equal(loadConfig().outputReservePct, 0.95, "clamped to the 0.95 ceiling");
		process.env.MEGACOMPACT_OUTPUT_RESERVE_PCT = "0.01";
		assert.equal(loadConfig().outputReservePct, 0.1, "clamped to the 0.10 floor");
	});

	it("the written plain key is what the RUNTIME loadConfig actually reads (end-to-end)", async () => {
		await post({ key: HEADROOM_KEY, value: "false" });
		assert.match(envContent(), /export MEGACOMPACT_OVERFLOW_HEADROOM="false"/);
		process.env.MEGACOMPACT_OVERFLOW_HEADROOM = "false";
		assert.equal(
			loadConfig().overflowHeadroom,
			false,
			"the toggle must actually disable the headroom gate",
		);
		process.env.MEGACOMPACT_OVERFLOW_HEADROOM = "true";
		assert.equal(loadConfig().overflowHeadroom, true);
	});

	it("neither headroom key is in EXCLUDED_SETTINGS", () => {
		for (const key of [HEADROOM_KEY, RESERVE_KEY]) {
			assert.equal(
				EXCLUDED_SETTINGS.includes(key),
				false,
				`${key} must NOT be excluded (all-flags-toggleable rule)`,
			);
		}
	});
});
