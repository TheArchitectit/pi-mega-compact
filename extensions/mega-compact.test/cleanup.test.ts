/**
 * cleanup.test.ts — close global PGlite index + remove temp base dir.
 * Split from mega-compact.test.ts; test bodies are unchanged.
 */
import { test } from "node:test";
import { rmSync } from "node:fs";
import { baseTmpDir, closeVectorIndex } from "./_helpers.js";

test("cleanup", async () => {
	// Terminate the global PGlite cross-repo index (WASM worker thread) so the
	// test process can exit. Without this, node --test never returns even though
	// every test passed — the leaked worker keeps the event loop alive.
	// Race with a timeout to prevent 40-min hangs if PGlite WASM close stalls.
	try {
		await Promise.race([
			closeVectorIndex(),
			new Promise((r) => setTimeout(r, 3000)),
		]);
	} catch { /* ignore */ }
	rmSync(baseTmpDir, { recursive: true, force: true });
});

