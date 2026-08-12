/**
 * dashboard-server/routes-rag-settings-3wf.test.ts — 3WF-5 Settings round-trip.
 *
 * Spec test 1 (docs/specs/three-way-failback-sprints.md, "3WF-5 Tests"): the two
 * three-way-failback flags round-trip through the REAL GET/POST
 * /api/rag-settings handler — GET surfaces them with their ON defaults, POST
 * writes the opt-out line into a real .mega-compact.env in a temp stateDir, and
 * re-enabling strips it again. Kept in its own file (soft-cap discipline) rather
 * than growing routes-rag-settings.test.ts, and mirroring the VC0A round-trip
 * case there.
 *
 * No mocks/stubs of the unit under test: the real route handler, the real route
 * context, and a real env-file write in an mkdtemp dir.
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

/** The two flags this sprint surfaces. */
const THREE_WAY_KEY = "MEGACOMPACT_THREE_WAY_FAILBACK";
const TAIL_INJECT_KEY = "MEGACOMPACT_RECALL_TAIL_INJECT";

let testDir: string;
let saved: [string, string | undefined][];

function polluteEnv(): void {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("MEGACOMPACT")) delete process.env[key];
	}
}

beforeEach(() => {
	testDir = mkdtempSync(join(tmpdir(), "mega-3wf-settings-"));
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

describe("3WF-5 settings round-trip", () => {
	it("GET surfaces both 3WF flags with ON defaults", () => {
		const all = getSettings();
		for (const key of [THREE_WAY_KEY, TAIL_INJECT_KEY]) {
			const spec = all.find((s) => s.key === key);
			assert.ok(spec, `${key} must be surfaced by GET /api/rag-settings`);
			assert.equal(spec.type, "boolean");
			assert.equal(spec.value, true, `${key} default must resolve ON`);
		}
	});

	it("POST toggling the umbrella OFF writes the plain opt-out, re-enable writes ON", async () => {
		const off = await post({ key: THREE_WAY_KEY, value: "false" });
		assert.equal(off.statusCode, 200);
		assert.match(
			envContent(),
			/export MEGACOMPACT_THREE_WAY_FAILBACK="false"/,
			"opt-out must write the PLAIN key the runtime envBool reads (not the _DISABLED convention)",
		);

		const on = await post({ key: THREE_WAY_KEY, value: "true" });
		assert.equal(on.statusCode, 200);
		assert.match(
			envContent(),
			/export MEGACOMPACT_THREE_WAY_FAILBACK="true"/,
			"re-enabling must write the plain key to ON",
		);
	});

	it("POST toggling tail-inject OFF writes the plain opt-out, re-enable writes ON", async () => {
		const off = await post({ key: TAIL_INJECT_KEY, value: "false" });
		assert.equal(off.statusCode, 200);
		assert.match(
			envContent(),
			/export MEGACOMPACT_RECALL_TAIL_INJECT="false"/,
			"opt-out must write the PLAIN key the runtime envBool reads (not the _DISABLED convention)",
		);

		const on = await post({ key: TAIL_INJECT_KEY, value: "true" });
		assert.equal(on.statusCode, 200);
		assert.match(
			envContent(),
			/export MEGACOMPACT_RECALL_TAIL_INJECT="true"/,
			"re-enabling must write the plain key to ON",
		);
	});

	it("the written plain key is what the RUNTIME loadConfig actually reads (end-to-end)", async () => {
		await post({ key: THREE_WAY_KEY, value: "false" });
		// boolDirect writes MEGACOMPACT_THREE_WAY_FAILBACK="false"; the runtime reads
		// that plain key via envBool. Simulate the runtime's next-boot env (the env
		// file is sourced into process.env) and prove the flag actually turns OFF.
		assert.match(envContent(), /export MEGACOMPACT_THREE_WAY_FAILBACK="false"/);
		process.env.MEGACOMPACT_THREE_WAY_FAILBACK = "false";
		assert.equal(
			loadConfig().threeWayFailback,
			false,
			"runtime must read the plain key off-state — the toggle must actually disable the system",
		);
		process.env.MEGACOMPACT_THREE_WAY_FAILBACK = "true";
		assert.equal(loadConfig().threeWayFailback, true, "runtime reads the plain key on-state");
	});

	it("neither 3WF key is in EXCLUDED_SETTINGS", () => {
		for (const key of [THREE_WAY_KEY, TAIL_INJECT_KEY]) {
			assert.equal(
				EXCLUDED_SETTINGS.includes(key),
				false,
				`${key} must NOT be excluded (all-flags-toggleable rule)`,
			);
		}
	});
});
