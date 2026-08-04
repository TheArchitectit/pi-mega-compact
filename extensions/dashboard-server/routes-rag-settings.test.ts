/**
 * dashboard-server/routes-rag-settings.test.ts — comprehensive settings tests.
 *
 * Handler-level tests for GET/POST /api/rag-settings: category grouping,
 * env-default resolution, env overrides, env-file writes, validation.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildRouteContext } from "./routes-core.js";
import { handleRagSettings } from "./routes-rag-settings.js";
import { SETTINGS } from "./routes-rag-settings-helpers.js";
import { VC0A_ENABLED, VC0B_ENABLED, VC1A_ENABLED, VC0C_ENABLED, VC1B_ENABLED, VC1C_ENABLED, VC3A_ENABLED } from "../../src/config/vector-cortex.js";

let testDir: string;
let savedMegacompact: [string, string | undefined][];

function polluteEnv(): void {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("MEGACOMPACT")) delete process.env[key];
	}
}

beforeEach(() => {
	testDir = mkdtempSync(join(tmpdir(), "mega-settings-route-test-"));
	// Capture and clear all MEGACOMPACT_* so each test starts from defaults.
	savedMegacompact = Object.keys(process.env)
		.filter((k) => k.startsWith("MEGACOMPACT"))
		.map((k) => [k, process.env[k]]);
	polluteEnv();
});

afterEach(() => {
	polluteEnv();
	for (const [key, val] of savedMegacompact) {
		if (val === undefined) delete process.env[key];
		else process.env[key] = val;
	}
	try {
		rmSync(testDir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

function makeReq(method: string, url = "/api/rag-settings"): IncomingMessage {
	return { method, url, headers: {} } as unknown as IncomingMessage;
}

function makeRes(): { res: ServerResponse; body: string; statusCode: number } {
	let body = "";
	let statusCode = 0;
	const res = {
		writeHead(code: number, _headers?: Record<string, string>) {
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
		detectCrossRepoDrift: () => {
			return {
				generatedAt: 0,
				totals: { ok: 0, warn: 0, stale: 0, compactionLag: 0, modelChurn: 0 },
				repos: [],
			};
		},
	});
}

async function post(body: object): Promise<{ body: string; statusCode: number }> {
	const payload = JSON.stringify(body);
	let dataEmitted = false;
	const req = {
		method: "POST",
		url: "/api/rag-settings",
		headers: {},
		// Minimal EventEmitter stand-in: emit data then end synchronously.
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
	// 'end' fires synchronously via our stub, so the response is already written.
	return { body: r.body, statusCode: r.statusCode };
}

function get(): { body: string; statusCode: number } {
	const req = makeReq("GET");
	const r = makeRes();
	const handled = handleRagSettings(req, r.res, ctx());
	assert.equal(handled, true, "GET must be handled");
	return { body: r.body, statusCode: r.statusCode };
}

describe("handleRagSettings — comprehensive settings", () => {
	it("GET returns all 7 categories", () => {
		const { body, statusCode } = get();
		assert.equal(statusCode, 200);
		const parsed = JSON.parse(body) as {
			categories: { name: string; settings: unknown[] }[];
			llmActive: boolean;
		};
		const names = parsed.categories.map((c) => c.name);
		for (const cat of SETTINGS) {
			assert.ok(names.includes(cat.name), `missing category ${cat.name}`);
		}
		assert.equal(names.length, SETTINGS.length);
		// Every declared setting appears under its category.
		for (const cat of SETTINGS) {
			const got = parsed.categories.find((c) => c.name === cat.name);
			assert.ok(got, `missing category ${cat.name}`);
			assert.equal(got.settings.length, cat.settings.length);
		}
		assert.equal(typeof parsed.llmActive, "boolean");
	});

	it("GET returns correct defaults when env vars unset", () => {
		const { body } = get();
		const parsed = JSON.parse(body) as {
			categories: { name: string; settings: { key: string; value: unknown; default: unknown }[] }[];
		};
		for (const cat of SETTINGS) {
			const got = parsed.categories.find((c) => c.name === cat.name)!;
			for (const spec of cat.settings) {
				const state = got.settings.find((s) => s.key === spec.key);
				assert.ok(state, `missing ${spec.key}`);
				assert.deepEqual(state.value, spec.default, `${spec.key} default`);
			}
		}
	});

	it("GET returns current override values from process.env", () => {
		process.env.MEGACOMPACT_HYDE_MODEL = "my-model";
		process.env.MEGACOMPACT_L2_THRESHOLD = "0.9";
		process.env.MEGACOMPACT_AUTO_WIKI = "false";
		process.env.MEGACOMPACT_HYDE_DISABLED = "true";
		const { body } = get();
		const parsed = JSON.parse(body) as {
			categories: { settings: { key: string; value: unknown; type: string }[] }[];
		};
		const all = parsed.categories.flatMap((c) => c.settings);
		const byKey = new Map(all.map((s) => [s.key, s]));
		assert.equal(byKey.get("MEGACOMPACT_HYDE_MODEL")!.value, "my-model");
		assert.equal(byKey.get("MEGACOMPACT_L2_THRESHOLD")!.value, 0.9);
		assert.equal(byKey.get("MEGACOMPACT_AUTO_WIKI")!.value, false);
		assert.equal(byKey.get("MEGACOMPACT_HYDE")!.value, false);
	});

	it("POST writes _DISABLED for boolean-opt-out settings", async () => {
		const r = await post({ key: "MEGACOMPACT_HYDE", value: "false" });
		assert.equal(r.statusCode, 200);
		const envPath = join(testDir, ".mega-compact.env");
		const content = readFileSync(envPath, "utf-8");
		assert.match(content, /export MEGACOMPACT_HYDE_DISABLED="true"/);
	});

	it("POST writes direct KEY=\"value\" for direct settings", async () => {
		const r = await post({ key: "MEGACOMPACT_AUTO_WIKI", value: "false" });
		assert.equal(r.statusCode, 200);
		const envPath = join(testDir, ".mega-compact.env");
		const content = readFileSync(envPath, "utf-8");
		assert.match(content, /export MEGACOMPACT_AUTO_WIKI="false"/);
	});

	it("VC0A flag round-trips through settings (boolDirect, not EXCLUDED)", async () => {
		// Surface: default ON, type boolean.
		const getBody = JSON.parse(get().body) as {
			categories: { name: string; settings: { key: string; value: unknown; type: string }[] }[];
		};
		const vc = getBody.categories
			.flatMap((c) => c.settings)
			.find((s) => s.key === "MEGACOMPACT_VC0A");
		assert.ok(vc, "MEGACOMPACT_VC0A must be a dashboard setting");
		assert.equal(vc.type, "boolean");
		assert.equal(vc.value, true);

		// Toggle OFF: settings handler writes the direct "false" line.
		const off = await post({ key: "MEGACOMPACT_VC0A", value: "false" });
		assert.equal(off.statusCode, 200);
		const envOff = readFileSync(join(testDir, ".mega-compact.env"), "utf-8");
		assert.match(envOff, /export MEGACOMPACT_VC0A="false"/);
		// Env line drives VC0A_ENABLED() off.
		process.env.MEGACOMPACT_VC0A = "false";
		assert.equal(VC0A_ENABLED(), false);

		// Toggle ON: settings handler writes the direct "true" line.
		const on = await post({ key: "MEGACOMPACT_VC0A", value: "true" });
		assert.equal(on.statusCode, 200);
		const envOn = readFileSync(join(testDir, ".mega-compact.env"), "utf-8");
		assert.match(envOn, /export MEGACOMPACT_VC0A="true"/);
		process.env.MEGACOMPACT_VC0A = "true";
		assert.equal(VC0A_ENABLED(), true);
	});

	it("VC0B flag round-trips through settings (boolDirect, not EXCLUDED)", async () => {
		// Surface: default ON, type boolean.
		const getBody = JSON.parse(get().body) as {
			categories: { name: string; settings: { key: string; value: unknown; type: string }[] }[];
		};
		const vc = getBody.categories
			.flatMap((c) => c.settings)
			.find((s) => s.key === "MEGACOMPACT_VC0B");
		assert.ok(vc, "MEGACOMPACT_VC0B must be a dashboard setting");
		assert.equal(vc.type, "boolean");
		assert.equal(vc.value, true);

		// Toggle OFF: settings handler writes the direct "false" line.
		const off = await post({ key: "MEGACOMPACT_VC0B", value: "false" });
		assert.equal(off.statusCode, 200);
		const envOff = readFileSync(join(testDir, ".mega-compact.env"), "utf-8");
		assert.match(envOff, /export MEGACOMPACT_VC0B="false"/);
		process.env.MEGACOMPACT_VC0B = "false";
		assert.equal(VC0B_ENABLED(), false);

		// Toggle ON: settings handler writes the direct "true" line.
		const on = await post({ key: "MEGACOMPACT_VC0B", value: "true" });
		assert.equal(on.statusCode, 200);
		const envOn = readFileSync(join(testDir, ".mega-compact.env"), "utf-8");
		assert.match(envOn, /export MEGACOMPACT_VC0B="true"/);
		process.env.MEGACOMPACT_VC0B = "true";
		assert.equal(VC0B_ENABLED(), true);
	});

	it("VC1A flag round-trips through settings (boolDirect, not EXCLUDED)", async () => {
		// Surface: default ON, type boolean.
		const getBody = JSON.parse(get().body) as {
			categories: { name: string; settings: { key: string; value: unknown; type: string }[] }[];
		};
		const vc = getBody.categories
			.flatMap((c) => c.settings)
			.find((s) => s.key === "MEGACOMPACT_VC1A");
		assert.ok(vc, "MEGACOMPACT_VC1A must be a dashboard setting");
		assert.equal(vc.type, "boolean");
		assert.equal(vc.value, true);

		// Toggle OFF: settings handler writes the direct "false" line.
		const off = await post({ key: "MEGACOMPACT_VC1A", value: "false" });
		assert.equal(off.statusCode, 200);
		const envOff = readFileSync(join(testDir, ".mega-compact.env"), "utf-8");
		assert.match(envOff, /export MEGACOMPACT_VC1A="false"/);
		process.env.MEGACOMPACT_VC1A = "false";
		assert.equal(VC1A_ENABLED(), false);

		// Toggle ON: settings handler writes the direct "true" line.
		const on = await post({ key: "MEGACOMPACT_VC1A", value: "true" });
		assert.equal(on.statusCode, 200);
		const envOn = readFileSync(join(testDir, ".mega-compact.env"), "utf-8");
		assert.match(envOn, /export MEGACOMPACT_VC1A="true"/);
		process.env.MEGACOMPACT_VC1A = "true";
		assert.equal(VC1A_ENABLED(), true);
	});

	it("VC0C flag round-trips through settings (boolDirect, not EXCLUDED)", async () => {
		// Surface: default ON, type boolean.
		const getBody = JSON.parse(get().body) as {
			categories: { name: string; settings: { key: string; value: unknown; type: string }[] }[];
		};
		const vc = getBody.categories
			.flatMap((c) => c.settings)
			.find((s) => s.key === "MEGACOMPACT_VC0C");
		assert.ok(vc, "MEGACOMPACT_VC0C must be a dashboard setting");
		assert.equal(vc.type, "boolean");
		assert.equal(vc.value, true);

		// Toggle OFF: settings handler writes the direct "false" line.
		const off = await post({ key: "MEGACOMPACT_VC0C", value: "false" });
		assert.equal(off.statusCode, 200);
		const envOff = readFileSync(join(testDir, ".mega-compact.env"), "utf-8");
		assert.match(envOff, /export MEGACOMPACT_VC0C="false"/);
		process.env.MEGACOMPACT_VC0C = "false";
		assert.equal(VC0C_ENABLED(), false);

		// Toggle ON: settings handler writes the direct "true" line.
		const on = await post({ key: "MEGACOMPACT_VC0C", value: "true" });
		assert.equal(on.statusCode, 200);
		const envOn = readFileSync(join(testDir, ".mega-compact.env"), "utf-8");
		assert.match(envOn, /export MEGACOMPACT_VC0C="true"/);
		process.env.MEGACOMPACT_VC0C = "true";
		assert.equal(VC0C_ENABLED(), true);
	});

	it("VC1B flag round-trips through settings (boolDirect, not EXCLUDED)", async () => {
		// Surface: default ON, type boolean.
		const getBody = JSON.parse(get().body) as {
			categories: { name: string; settings: { key: string; value: unknown; type: string }[] }[];
		};
		const vc = getBody.categories
			.flatMap((c) => c.settings)
			.find((s) => s.key === "MEGACOMPACT_VC1B");
		assert.ok(vc, "MEGACOMPACT_VC1B must be a dashboard setting");
		assert.equal(vc.type, "boolean");
		assert.equal(vc.value, true);

		// Toggle OFF: settings handler writes the direct "false" line.
		const off = await post({ key: "MEGACOMPACT_VC1B", value: "false" });
		assert.equal(off.statusCode, 200);
		const envOff = readFileSync(join(testDir, ".mega-compact.env"), "utf-8");
		assert.match(envOff, /export MEGACOMPACT_VC1B="false"/);
		process.env.MEGACOMPACT_VC1B = "false";
		assert.equal(VC1B_ENABLED(), false);

		// Toggle ON: settings handler writes the direct "true" line.
		const on = await post({ key: "MEGACOMPACT_VC1B", value: "true" });
		assert.equal(on.statusCode, 200);
		const envOn = readFileSync(join(testDir, ".mega-compact.env"), "utf-8");
		assert.match(envOn, /export MEGACOMPACT_VC1B="true"/);
		process.env.MEGACOMPACT_VC1B = "true";
		assert.equal(VC1B_ENABLED(), true);
	});

	it("VC1C flag round-trips through settings (boolDirect, not EXCLUDED)", async () => {
		// Surface: default ON, type boolean.
		const getBody = JSON.parse(get().body) as {
			categories: { name: string; settings: { key: string; value: unknown; type: string }[] }[];
		};
		const vc = getBody.categories
			.flatMap((c) => c.settings)
			.find((s) => s.key === "MEGACOMPACT_VC1C");
		assert.ok(vc, "MEGACOMPACT_VC1C must be a dashboard setting");
		assert.equal(vc.type, "boolean");
		assert.equal(vc.value, true);

		// Toggle OFF: settings handler writes the direct "false" line.
		const off = await post({ key: "MEGACOMPACT_VC1C", value: "false" });
		assert.equal(off.statusCode, 200);
		const envOff = readFileSync(join(testDir, ".mega-compact.env"), "utf-8");
		assert.match(envOff, /export MEGACOMPACT_VC1C="false"/);
		process.env.MEGACOMPACT_VC1C = "false";
		assert.equal(VC1C_ENABLED(), false);

		// Toggle ON: settings handler writes the direct "true" line.
		const on = await post({ key: "MEGACOMPACT_VC1C", value: "true" });
		assert.equal(on.statusCode, 200);
		const envOn = readFileSync(join(testDir, ".mega-compact.env"), "utf-8");
		assert.match(envOn, /export MEGACOMPACT_VC1C="true"/);
		process.env.MEGACOMPACT_VC1C = "true";
		assert.equal(VC1C_ENABLED(), true);
	});

	it("VC3A flag round-trips through settings (boolDirect, not EXCLUDED)", async () => {
		// Surface: default ON, type boolean.
		const getBody = JSON.parse(get().body) as {
			categories: { name: string; settings: { key: string; value: unknown; type: string }[] }[];
		};
		const vc = getBody.categories
			.flatMap((c) => c.settings)
			.find((s) => s.key === "MEGACOMPACT_VC3A");
		assert.ok(vc, "MEGACOMPACT_VC3A must be a dashboard setting");
		assert.equal(vc.type, "boolean");
		assert.equal(vc.value, true);

		// Toggle OFF: settings handler writes the direct "false" line.
		const off = await post({ key: "MEGACOMPACT_VC3A", value: "false" });
		assert.equal(off.statusCode, 200);
		const envOff = readFileSync(join(testDir, ".mega-compact.env"), "utf-8");
		assert.match(envOff, /export MEGACOMPACT_VC3A="false"/);
		process.env.MEGACOMPACT_VC3A = "false";
		assert.equal(VC3A_ENABLED(), false);

		// Toggle ON: settings handler writes the direct "true" line.
		const on = await post({ key: "MEGACOMPACT_VC3A", value: "true" });
		assert.equal(on.statusCode, 200);
		const envOn = readFileSync(join(testDir, ".mega-compact.env"), "utf-8");
		assert.match(envOn, /export MEGACOMPACT_VC3A="true"/);
		process.env.MEGACOMPACT_VC3A = "true";
		assert.equal(VC3A_ENABLED(), true);
	});

	it("POST re-enabling a _DISABLED flag strips the opt-out line", async () => {
		await post({ key: "MEGACOMPACT_HYDE", value: "false" });
		const afterDisable = readFileSync(join(testDir, ".mega-compact.env"), "utf-8");
		assert.match(afterDisable, /MEGACOMPACT_HYDE_DISABLED/);
		await post({ key: "MEGACOMPACT_HYDE", value: "true" });
		const afterEnable = readFileSync(join(testDir, ".mega-compact.env"), "utf-8");
		assert.doesNotMatch(afterEnable, /MEGACOMPACT_HYDE/);
	});

	it("POST rejects unknown keys", async () => {
		const r = await post({ key: "MEGACOMPACT_NOT_A_REAL_KEY", value: "true" });
		assert.equal(r.statusCode, 400);
		const parsed = JSON.parse(r.body) as { error: string };
		assert.match(parsed.error, /unknown_setting/);
	});

	it("POST rejects out-of-range numeric values", async () => {
		const over = await post({ key: "MEGACOMPACT_L2_THRESHOLD", value: "2" });
		assert.equal(over.statusCode, 400);
		const under = await post({ key: "MEGACOMPACT_L2_THRESHOLD", value: "-1" });
		assert.equal(under.statusCode, 400);
		const parsed = JSON.parse(over.body) as { error: string };
		assert.match(parsed.error, /above_max|below_min/);
	});

	it("POST writes a valid in-range numeric value", async () => {
		const r = await post({ key: "MEGACOMPACT_L2_THRESHOLD", value: "0.9" });
		assert.equal(r.statusCode, 200);
		const content = readFileSync(join(testDir, ".mega-compact.env"), "utf-8");
		assert.match(content, /export MEGACOMPACT_L2_THRESHOLD="0.9"/);
	});

	it("non-GET/POST returns 405", () => {
		const req = makeReq("DELETE");
		const r = makeRes();
		const handled = handleRagSettings(req, r.res, ctx());
		assert.equal(handled, true);
		assert.equal(r.statusCode, 405);
	});

	it("wrong path falls through (returns false)", () => {
		const req = makeReq("GET", "/api/other");
		const r = makeRes();
		const handled = handleRagSettings(req, r.res, ctx());
		assert.equal(handled, false);
	});
});
