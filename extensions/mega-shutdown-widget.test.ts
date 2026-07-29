/**
 * mega-shutdown-widget.test.ts — regression cover for two host-integration
 * fixes that the rest of the suite cannot see, because both are about what
 * happens at the boundary with pi rather than inside the compaction engine:
 *
 *  1. session_shutdown must close the PGlite indexes. They are lazily-opened
 *     module singletons whose handles keep node's event loop alive, so leaving
 *     them open made `pi -p` produce its answer and then hang instead of
 *     exiting. closeVectorIndex()/closeMemoryIndex() existed but had no
 *     non-test callers.
 *
 *  2. The above-editor widget must be suppressible. It is a persistent,
 *     animated, full-width panel that repaints on its own cadence, which fights
 *     terminals where the user drives scrollback (pi inside a Neovim
 *     `:terminal`). MEGACOMPACT_TUI_WIDGET=0 turns it off without touching
 *     compaction.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	closeVectorIndex,
	initVectorIndex,
	isVectorIndexDisabled,
} from "../src/store/vectorIndex.js";
import { closeMemoryIndex } from "../src/store/memoryIndex.js";
import { loadConfig } from "./mega-config.js";
import { MegaRuntime } from "./mega-runtime.js";

const baseTmp = mkdtempSync(join(tmpdir(), "mc-shutdown-"));
process.env.MEGACOMPACT_INDEX_DIR = join(baseTmp, "index");
let counter = 0;

/** Fresh per-test state dir so concurrent runs never collide on disk. */
function isolate(): void {
	process.env.MEGACOMPACT_STATE_DIR = join(baseTmp, `run-${counter++}`);
}

/** Minimal ExtensionContext slice: renderWidget only reaches ctx.ui.setWidget. */
function widgetCtx(calls: string[]): any {
	return {
		ui: {
			setWidget: (key: string) => calls.push(key),
		},
	};
}

test.after(async () => {
	// This file is itself a demonstration of the bug under test: without these
	// closes the PGlite handles opened above keep the event loop alive and the
	// test process never exits.
	await Promise.all([closeVectorIndex(), closeMemoryIndex()]);
	rmSync(baseTmp, { recursive: true, force: true });
});

test("MEGACOMPACT_TUI_WIDGET defaults on and is disabled by 0", () => {
	isolate();
	delete process.env.MEGACOMPACT_TUI_WIDGET;
	assert.equal(loadConfig().tuiWidget, true, "widget should default to on");

	process.env.MEGACOMPACT_TUI_WIDGET = "0";
	assert.equal(loadConfig().tuiWidget, false);

	process.env.MEGACOMPACT_TUI_WIDGET = "1";
	assert.equal(loadConfig().tuiWidget, true);

	delete process.env.MEGACOMPACT_TUI_WIDGET;
});

test("renderWidget registers the panel when tuiWidget is on", () => {
	isolate();
	delete process.env.MEGACOMPACT_TUI_WIDGET;
	const runtime = new MegaRuntime(loadConfig());
	try {
		const calls: string[] = [];
		runtime.renderWidget(widgetCtx(calls));
		assert.equal(calls.length, 1, "expected one setWidget registration");
	} finally {
		runtime.dispose();
	}
});

test("renderWidget registers nothing when tuiWidget is off", () => {
	isolate();
	process.env.MEGACOMPACT_TUI_WIDGET = "0";
	const runtime = new MegaRuntime(loadConfig());
	try {
		const calls: string[] = [];
		// Repeated calls, because the panel is re-registered on every snapshot
		// and every game-state change — one guarded path is not enough.
		runtime.renderWidget(widgetCtx(calls));
		runtime.renderWidget(widgetCtx(calls));
		assert.deepEqual(calls, [], "widget must never be registered when disabled");
	} finally {
		runtime.dispose();
		delete process.env.MEGACOMPACT_TUI_WIDGET;
	}
});

test("the extension's session_shutdown handler awaits index teardown", async () => {
	isolate();
	const handlers: Record<string, Function[]> = {};
	const pi: any = {
		on(event: string, handler: Function) {
			(handlers[event] ??= []).push(handler);
		},
		registerCommand() {},
		registerProvider() {},
	};

	const { default: extension } = await import("./mega-compact.js");
	extension(pi);

	const shutdown = handlers["session_shutdown"] ?? [];
	assert.ok(shutdown.length, "extension must register a session_shutdown handler");

	const event = { type: "session_shutdown" } as any;
	const ctx = {
		ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {} },
		cwd: process.env.MEGACOMPACT_STATE_DIR,
	} as any;

	// Assert the close by identity rather than by "some handler returned a
	// promise": several modules register on session_shutdown and at least one
	// other is already async, so a promise proves nothing about teardown. The
	// index is a module singleton, so if shutdown really closed it, re-init
	// hands back a *different* instance.
	const before = await initVectorIndex();
	if (isVectorIndexDisabled() || !before) return; // PGlite unavailable — nothing to close

	await Promise.all(shutdown.map((handler) => handler(event, ctx)));

	const after = await initVectorIndex();
	assert.notEqual(after, before, "session_shutdown must close the PGlite vector index");

	// Idempotent: a second shutdown (reload, double-fire) must not throw.
	await Promise.all(shutdown.map((handler) => handler(event, ctx)));
});
