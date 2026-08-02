/**
 * cleanup.test.ts — close global PGlite index, remove temp base dir, force-exit leaked watchers.
 * Split from mega-compact-s38.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import { rmSync } from "node:fs";
import { baseTmpDir, closeVectorIndex } from "./_helpers.js";


test("cleanup", async () => {
	// PGlite WASM close can hang; race with a timeout to prevent 40-min hangs.
	try {
		await Promise.race([closeVectorIndex(), new Promise((r) => setTimeout(r, 3000))]);
	} catch { /* ignore */ }
	rmSync(baseTmpDir, { recursive: true, force: true });
	// Force-exit: each harness() creates a MegaRuntime with an fs.watch
	// game-state watcher that is never disposed (no session_shutdown in tests).
	// Those handles keep the event loop alive indefinitely after all tests
	// complete, so `node --test` (without --test-force-exit) would hang.
	// Drain stdout/stderr, then defer the exit: a bare process.exit() discards
	// unflushed pipe buffers — observed 2026-07-30: when piped, the trailing
	// tests' results and the run summary silently vanished from the report.
	await new Promise((r) => process.stdout.write("", r));
	await new Promise((r) => process.stderr.write("", r));
	await new Promise((r) => setTimeout(r, 1500));
	process.exit(0);
});

