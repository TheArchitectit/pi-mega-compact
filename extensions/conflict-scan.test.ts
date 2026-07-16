/**
 * conflict-scan.test.ts — unit tests for the extension-conflict scanner.
 *
 * Fixture trees are written under a temp dir and scanned via
 * MEGACOMPACT_EXT_SCAN_DIR (which makes collectScanRoots() return that
 * single root). This covers the S24 follow-up fix:
 *
 *   1. node_modules-style code extensions (package.json + pi.extensions) are
 *      still detected by source-marker grep (regression).
 *   2. USER-LEVEL extensions installed outside npm (e.g. pi-hermes-memory)
 *      now get scanned too — previously only `node_modules` was walked, so a
 *      data-only memory store (MEMORY.md + sessions.db, no package.json)
 *      was never flagged (the 5000-char file-buffer error slipped through).
 *   3. The data-only memory-store signature is detected even with no source.
 *   4. pi-mega-compact (selfName) is always skipped.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectConflicts, collectScanRoots } from "./conflict-scan.js";

const base = mkdtempSync(join(tmpdir(), "mc-scan-"));
let n = 0;

/** Make a fixture root containing one or more fake extensions, return its path. */
function fixture(build: (root: string) => void): string {
	const root = join(base, `case-${n++}`);
	mkdirSync(root, { recursive: true });
	build(root);
	return root;
}

after(() => {
	rmSync(base, { recursive: true, force: true });
});

test("scans a user-level, data-only memory store (no package.json)", () => {
	const root = fixture((r) => {
		const ext = join(r, "pi-hermes-memory");
		mkdirSync(ext, { recursive: true });
		// No package.json, no source — just pi's memory-store signature.
		writeFileSync(join(ext, "MEMORY.md"), "# memory\n");
		writeFileSync(join(ext, "sessions.db"), "");
	});
	process.env.MEGACOMPACT_EXT_SCAN_DIR = root;
	try {
		const { conflicts } = detectConflicts();
		assert.ok(conflicts.length >= 1, "expected a memory conflict");
		const hit = conflicts.find((c) => c.kind === "memory");
		assert.ok(hit, "expected a memory-kind conflict");
		assert.equal(hit!.severity, "high");
		assert.ok(
			hit!.evidence.includes("MEMORY.md") ||
				hit!.evidence.includes("sessions.db"),
			"evidence should name the on-disk memory signature",
		);
	} finally {
		delete process.env.MEGACOMPACT_EXT_SCAN_DIR;
	}
});

test("still detects a code extension by source marker (regression)", () => {
	const root = fixture((r) => {
		// A code extension is a DIRECT child of the scan root (mirrors the
		// node_modules layout: packages live one level under the root).
		const ext = join(r, "some-memory-ext");
		mkdirSync(ext, { recursive: true });
		writeFileSync(
			join(ext, "package.json"),
			JSON.stringify({ name: "some-memory-ext", pi: { extensions: ["x.ts"] } }),
		);
		writeFileSync(join(ext, "index.ts"), "export const MEMORY_TOOL = true;");
	});
	process.env.MEGACOMPACT_EXT_SCAN_DIR = root;
	try {
		const { conflicts } = detectConflicts();
		const hit = conflicts.find((c) => c.package === "some-memory-ext");
		assert.ok(hit, "expected some-memory-ext to be flagged");
		assert.equal(hit!.kind, "memory");
	} finally {
		delete process.env.MEGACOMPACT_EXT_SCAN_DIR;
	}
});

test("skips pi-mega-compact (selfName) and non-extension dirs", () => {
	const root = fixture((r) => {
		// selfName dir with a memory signature — must be ignored.
		const me = join(r, "node_modules", "pi-mega-compact");
		mkdirSync(me, { recursive: true });
		writeFileSync(join(me, "sessions.db"), "");
		// unrelated dir with no pi.extensions and no memory signature.
		mkdirSync(join(r, "node_modules", "totally-fine"), { recursive: true });
	});
	process.env.MEGACOMPACT_EXT_SCAN_DIR = root;
	try {
		const { scanned, conflicts } = detectConflicts();
		assert.equal(conflicts.length, 0, "no conflicts expected");
		assert.ok(
			!scanned.some((s) => s.includes("pi-mega-compact")),
			"selfName should not appear in scanned",
		);
	} finally {
		delete process.env.MEGACOMPACT_EXT_SCAN_DIR;
	}
});

test("collectScanRoots honors MEGACOMPACT_EXT_SCAN_DIR override", () => {
	const root = fixture(() => {});
	process.env.MEGACOMPACT_EXT_SCAN_DIR = root;
	try {
		const roots = collectScanRoots();
		assert.deepEqual(roots, [root], "override replaces the whole root list");
	} finally {
		delete process.env.MEGACOMPACT_EXT_SCAN_DIR;
	}
});

test("collectScanRoots falls back to node_modules + user dir when no override", () => {
	delete process.env.MEGACOMPACT_EXT_SCAN_DIR;
	delete process.env.MEGACOMPACT_EXT_USER_DIR;
	// No override set and this test file lives under extensions/, so node_modules
	// resolution walks up from here; the user dir (~/.pi/agent) may or may
	// not exist in CI. We only assert the call returns a non-throwing array.
	const roots = collectScanRoots();
	assert.ok(Array.isArray(roots), "collectScanRoots must return an array");
});
