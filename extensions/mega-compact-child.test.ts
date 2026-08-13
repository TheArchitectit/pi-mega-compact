/**
 * mega-compact-child.test.ts — integration test for the child extension.
 *
 * Mocks only the pi ExtensionAPI surface (no real pi runtime in tests); uses a
 * REAL bridge + REAL sqlite store in a temp repo dir (repo's no-mocks rule). The
 * child's stateDir is resolved via repoStateDir(process.cwd(), ...) — we make
 * process.cwd() a temp git repo so the child and the test seed the SAME
 * <tmp>/.pi/mega-compact store.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import type { ExtensionAPI, BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import { createMegaBridge } from "../src/bridge.js";
import childExtension from "./mega-compact-child.js";

type Handler = (event: Record<string, unknown>, ctx?: unknown) => unknown;

/** Minimal mock of the pi ExtensionAPI. */
function makeMockPi(): {
	pi: ExtensionAPI;
	handlers: Map<string, Handler>;
	fire: (event: string, payload: Record<string, unknown>, ctx?: unknown) => Promise<unknown>;
} {
	const handlers = new Map<string, Handler>();
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		handlers,
		async fire(event, payload, ctx) {
			const h = handlers.get(event);
			if (!h) return undefined;
			return await h(payload, ctx);
		},
	};
}

/** Build a temp git repo + return its <repo>/.pi/mega-compact state dir. */
function makeTempRepo(): { root: string; stateDir: string } {
	const root = mkdtempSync(join(tmpdir(), "mega-child-test-"));
	execSync("git init -q", { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
	const stateDir = join(root, ".pi", "mega-compact");
	mkdirSync(stateDir, { recursive: true });
	return { root, stateDir };
}

/** A mock ctx whose sessionManager yields SessionMessageEntry-shaped entries.
 *  sessionEntryToContextMessages expects {type:"message", message:{role,content}},
 *  NOT a {messages:[...]} wrapper — the wrong shape returns [] and starves
 *  compaction. Mirrors triggerGuard.test.ts's proven entry mock. */
function mockCtxWithMessages(messages: Array<{ role: string; text: string }>) {
	return {
		sessionManager: {
			getEntries: () =>
				messages.map((m, i) => ({
					type: "message" as const,
					id: `e${i}`,
					parentId: null,
					timestamp: String(i),
					message: { role: m.role, content: m.text },
				})),
		},
	};
}

let savedCwd: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
	savedCwd = process.cwd();
	savedEnv = { ...process.env };
	delete process.env.MEGACOMPACT_ITHACUS_BRIDGE;
	delete process.env.ITHACUS_MEGA_SESSION_ID;
});

afterEach(() => {
	process.chdir(savedCwd);
	process.env = savedEnv;
});

describe("mega-compact-child", () => {
	it("flag ON + data: before_agent_start injects a recall block", async () => {
		const { root, stateDir } = makeTempRepo();
		// Seed a checkpoint in the SAME store the child will read.
		const seed = createMegaBridge({ stateDir });
		seed.compact({
			sessionId: "sess_child_1",
			messages: [
				{ role: "user", text: "deploy the dashboard" },
				{ role: "assistant", text: "deployed via deploy.sh" },
			],
		});
		seed.close();

		process.chdir(root);
		process.env.ITHACUS_MEGA_SESSION_ID = "sess_child_1";
		const { pi, handlers, fire } = makeMockPi();
		childExtension(pi);

		const event: Partial<BeforeAgentStartEvent> = {
			type: "before_agent_start",
			prompt: "deploy the dashboard",
			systemPrompt: "BASE SYSTEM PROMPT",
		};
		const result = (await fire("before_agent_start", event as Record<string, unknown>)) as
			| { systemPrompt: string }
			| undefined;

		assert.ok(result, "expected an injection result");
		assert.match(result!.systemPrompt, /BASE SYSTEM PROMPT/);
		assert.match(result!.systemPrompt, /deploy/);
		assert.ok(handlers.has("session_shutdown"), "should register session_shutdown");
		rmSync(root, { recursive: true, force: true });
	});

	it("flag OFF: before_agent_start returns undefined and builds no bridge", async () => {
		const { root } = makeTempRepo();
		process.chdir(root);
		process.env.MEGACOMPACT_ITHACUS_BRIDGE = "false";
		process.env.ITHACUS_MEGA_SESSION_ID = "sess_child_2";
		const { pi, handlers, fire } = makeMockPi();
		childExtension(pi);

		assert.equal(handlers.size, 0, "no handlers registered when flag OFF");
		const result = await fire("before_agent_start", {
			type: "before_agent_start",
			prompt: "anything",
			systemPrompt: "BASE",
		});
		assert.equal(result, undefined);
		rmSync(root, { recursive: true, force: true });
	});

	it("ITHACUS_MEGA_SESSION_ID unset: stability guard returns undefined", async () => {
		const { root, stateDir } = makeTempRepo();
		const seed = createMegaBridge({ stateDir });
		seed.compact({
			sessionId: "sess_child_3",
			messages: [{ role: "user", text: "recallable task" }, { role: "assistant", text: "done" }],
		});
		seed.close();

		process.chdir(root);
		delete process.env.ITHACUS_MEGA_SESSION_ID;
		const { pi, fire } = makeMockPi();
		childExtension(pi);

		const result = await fire("before_agent_start", {
			type: "before_agent_start",
			prompt: "recallable task",
			systemPrompt: "BASE",
		});
		assert.equal(result, undefined);
		rmSync(root, { recursive: true, force: true });
	});

	it("bridge throws: before_agent_start returns undefined (non-fatal)", async () => {
		const { root } = makeTempRepo();
		process.chdir(root);
		// Point at a non-git cwd fallback by using a stateDir path that the bridge
		// cannot open (read-only parent). We instead force a throw by setting an
		// unreachable stateDir via chdir to a non-existent path's sibling.
		process.env.ITHACUS_MEGA_SESSION_ID = "sess_child_4";
		const { pi, fire } = makeMockPi();
		childExtension(pi);

		// A real store won't throw for a valid dir; emulate the failure by passing a
		// query that yields throws is hard, so verify non-fatal by corrupting the
		// store path: cd to a dir whose .pi/mega-compact is a file, not a dir.
		const badState = join(root, ".pi", "mega-compact");
		rmSync(badState, { recursive: true, force: true });
		// Make it a plain file so sqlite open (a file-as-dir path) fails.
		mkdirSync(join(root, ".pi"), { recursive: true });
		writeFileSync(badState, "not a dir");

		const result = await fire("before_agent_start", {
			type: "before_agent_start",
			prompt: "anything",
			systemPrompt: "BASE",
		});
		assert.equal(result, undefined, "non-fatal: errors must not crash the loop");
		rmSync(root, { recursive: true, force: true });
	});

	it("registers NO tools", async () => {
		const { root } = makeTempRepo();
		process.chdir(root);
		const calls: string[] = [];
		const spyPi = {
			on: () => undefined,
			registerTool: () => {
				calls.push("registerTool");
			},
		} as unknown as ExtensionAPI;
		childExtension(spyPi);
		assert.equal(calls.length, 0, "child must register zero tools");
		rmSync(root, { recursive: true, force: true });
	});

	it("produces NO console output", async () => {
		const { root, stateDir } = makeTempRepo();
		const seed = createMegaBridge({ stateDir });
		seed.compact({
			sessionId: "sess_child_6",
			messages: [{ role: "user", text: "quiet task" }, { role: "assistant", text: "done" }],
		});
		seed.close();

		process.chdir(root);
		process.env.ITHACUS_MEGA_SESSION_ID = "sess_child_6";
		const { pi, fire } = makeMockPi();
		childExtension(pi);

		const logs: string[] = [];
		const origLog = console.log;
		const origErr = console.error;
		const origWarn = console.warn;
		console.log = (...a: unknown[]) => logs.push(String(a[0]));
		console.error = (...a: unknown[]) => logs.push(String(a[0]));
		console.warn = (...a: unknown[]) => logs.push(String(a[0]));
		try {
			await fire("before_agent_start", {
				type: "before_agent_start",
				prompt: "quiet task",
				systemPrompt: "BASE",
			});
			await fire("session_shutdown", { type: "session_shutdown" }, mockCtxWithMessages([
				{ role: "user", text: "quiet task" },
				{ role: "assistant", text: "done" },
			]));
		} finally {
			console.log = origLog;
			console.error = origErr;
			console.warn = origWarn;
		}
		assert.equal(logs.length, 0, `expected silence, got: ${logs.join("|")}`);
		rmSync(root, { recursive: true, force: true });
	});

	it("session_shutdown compacts when messages present", async () => {
		const { root, stateDir } = makeTempRepo();
		process.chdir(root);
		process.env.ITHACUS_MEGA_SESSION_ID = "sess_child_7";
		const { pi, fire } = makeMockPi();
		childExtension(pi);

		await fire("session_shutdown", { type: "session_shutdown" }, mockCtxWithMessages([
			{ role: "user", text: "compact me" },
			{ role: "assistant", text: "compacted" },
		]));

		// Verify a checkpoint landed in the real store.
		const verify = createMegaBridge({ stateDir });
		const r = verify.recallCheckpoints({ sessionId: "sess_child_7", query: "compact me", limit: 3 });
		verify.close();
		assert.ok(!r.empty, "shutdown should have persisted a checkpoint");
		rmSync(root, { recursive: true, force: true });
	});
});
