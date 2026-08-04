/**
 * dedup-audit.test-helpers.ts — shared harness for the dedup audit trail tests.
 *
 * Extracted so dedup-audit.test.ts and dedup-audit-gating.test.ts share one
 * temp-dir lifecycle and one events.log reader instead of duplicating them, and
 * so each test file stays under the 300-line src/ soft limit.
 *
 * Hermetic: every store gets its own temp state dir, so no test can observe
 * another's audit lines. No network (PREVENT-PI-004).
 */

import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDedupConfig, type DedupConfigShape } from "./config/dedup.js";
import { defaultEventsPath, type DedupAuditEvent } from "./monitoring.js";

/** Root temp dir shared by both audit test files (each run gets a subdir). */
export const baseTmp = mkdtempSync(join(tmpdir(), "mc-dedup-audit-"));

/** The live config with per-test overrides applied. */
export function cfg(over: Partial<DedupConfigShape> = {}): DedupConfigShape {
	return { ...loadDedupConfig(), ...over };
}

let seq = 0;

/** A never-before-used state dir under `baseTmp`. */
export function freshDir(): string {
	return join(baseTmp, `run-${seq++}-${Math.floor(performance.now() * 1000)}`);
}

/** Read every dedup_audit line from a store's default events.log. */
export function auditLines(stateDir: string): DedupAuditEvent[] {
	const path = defaultEventsPath(stateDir);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as DedupAuditEvent)
		.filter((e) => e.type === "dedup_audit");
}

/** A path whose parent directory can never be created: it sits under a FILE. */
export function unwritablePath(): string {
	const blocker = join(baseTmp, `blocker-${seq++}`);
	writeFileSync(blocker, "not a directory");
	return join(blocker, "sub", "events.log");
}
