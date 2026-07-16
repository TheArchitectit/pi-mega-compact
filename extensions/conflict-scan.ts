/**
 * conflict-scan.ts — detect other installed pi extensions that overlap with
 * pi-mega-compact's two owned responsibilities:
 *
 *   1. Conversation auto-compaction (we hook session_before_compact).
 *   2. Durable "save to memory" (we now keep a `memories` table in our SQLite).
 *
 * This is a DETECT-AND-WARN scanner only. pi has no pre-load / veto hook — one
 * extension cannot block another from loading — so we inspect the installed
 * package set at startup and on demand, then report overlaps. No config is
 * mutated. (See memory `pi-memory-mcp-review` for the original conflict pattern.)
 *
 * Pi-agnostic: reads package.json + greps source. No pi runtime types, so it is
 * unit-testable against a fixture node_modules tree.
 *
 * SCAN-SCOPE FIX (S24 follow-up): the original scanner only walked the npm
 * `node_modules` tree, so user-level extensions installed outside npm (e.g.
 * `pi-hermes-memory`, a data-only `MEMORY.md` + `sessions.db` memory store)
 * were never inspected — that gap let the 5000-char file-buffer error slip
 * through undetected. We now also scan the user-level extension dir and detect
 * memory stores that ship with no package.json / source to grep.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

export type ConflictKind = "compaction" | "memory" | "tool-output";
export type ConflictSeverity = "high" | "info";

export interface ConflictHit {
	package: string;
	severity: ConflictSeverity;
	kind: ConflictKind;
	evidence: string[];
	/** One-line recommended action for the user. */
	recommendation: string;
}

export interface ConflictReport {
	scanned: string[];
	conflicts: ConflictHit[];
}

// Marker sets. A package is flagged when its source matches a marker in a
// category. File-grep (not AST) keeps this dependency-free and fast.
const MARKERS = {
	// Directly competes with our conversation compaction.
	compaction: [
		"session_before_compact",
		"session_compact",
		"compactSession",
		"autoCompact",
		"auto_compact",
	],
	// Saves durable memory to its own store — the takeover target.
	memory: [
		"MEMORY_TOOL",
		"learn-memory",
		"saveMemory",
		"memoryPolicy",
		"wal_checkpoint",
		"store/db.ts",
		"memoryTool",
	],
	// Tool-output shaping (compact/summarize tool results) — overlap, not a rival.
	toolOutput: ["tool_result", "ToolResult"],
} as const;

/** Resolve the node_modules dir that contains this package (or env override). */
export function resolveExtensionRoot(
	selfDir: string = dirname(fileURLToPath(import.meta.url)),
): string | null {
	const override = process.env.MEGACOMPACT_EXT_SCAN_DIR;
	if (override && override.trim() !== "") return override;
	// selfDir is <root>/extensions or <root>/dist/extensions. Walk up to the
	// node_modules that holds pi-mega-compact.
	let dir = selfDir;
	for (let i = 0; i < 6; i++) {
		const candidate = join(dir, "node_modules");
		if (existsSync(candidate) && existsSync(join(candidate, "pi-mega-compact")))
			return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/**
 * Resolve every directory that may hold pi extensions to scan.
 *
 * - `MEGACOMPACT_EXT_SCAN_DIR` (if set) replaces the whole list — a single
 *   fixture/override root for tests or custom layouts.
 * - Otherwise: the node_modules that holds this package (classic npm layout) AND
 *   the user-level extension dir (`~/.pi/agent`), which is where extensions
 *   installed outside npm actually live. The original scanner only walked
 *   node_modules, so user-level memory extensions were never flagged — that is
 *   the gap that let the 5000-char `MEMORY.md` buffer error slip through.
 */
export function collectScanRoots(): string[] {
	const override = process.env.MEGACOMPACT_EXT_SCAN_DIR;
	if (override && override.trim() !== "") return [override];
	const roots: string[] = [];
	const nm = resolveExtensionRoot();
	if (nm && existsSync(nm)) roots.push(nm);
	const userDir =
		process.env.MEGACOMPACT_EXT_USER_DIR?.trim() ||
		join(homedir(), ".pi", "agent");
	if (existsSync(userDir)) roots.push(userDir);
	return roots;
}

/**
 * True when a directory is a pi memory-store container rather than a normal code
 * extension. `pi-hermes-memory` ships as exactly this: no package.json, no
 * source — just `MEMORY.md` + `sessions.db`. The marker-grep path misses it,
 * so we also detect the on-disk memory signature.
 */
function isMemoryStoreDir(pkgDir: string): boolean {
	return (
		existsSync(join(pkgDir, "sessions.db")) ||
		existsSync(join(pkgDir, "MEMORY.md"))
	);
}

/** Recursively collect source-ish files under a package, capped to avoid scans. */
function collectFiles(root: string, max = 400): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		if (out.length >= max) return;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const e of entries) {
			if (out.length >= max) return;
			const full = join(dir, e);
			let st;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				if (e === "node_modules" || e === ".git") continue;
				walk(full);
			} else if (/\.(ts|js|mjs|cjs|json|md)$/.test(e)) {
				out.push(full);
			}
		}
	};
	walk(root);
	return out;
}

/** Grep a package's source for any marker in `keys`; return matched markers. */
function matchMarkers(pkgDir: string, keys: readonly string[]): string[] {
	const found = new Set<string>();
	let files: string[];
	try {
		files = collectFiles(pkgDir);
	} catch {
		return [];
	}
	for (const f of files) {
		let text: string;
		try {
			text = readFileSync(f, "utf-8");
		} catch {
			continue;
		}
		for (const m of keys) {
			if (text.includes(m)) found.add(m);
		}
		if (found.size === keys.length) break;
	}
	return [...found];
}

/**
 * Scan installed extensions for overlaps with pi-mega-compact.
 * @param selfName package name to skip (defaults to this package's name).
 */
export function detectConflicts(selfName = "pi-mega-compact"): ConflictReport {
	const roots = collectScanRoots();
	const scanned: string[] = [];
	const conflicts: ConflictHit[] = [];

	for (const root of roots) {
		if (!existsSync(root)) continue;
		let entries: string[];
		try {
			entries = readdirSync(root);
		} catch {
			continue;
		}

		for (const name of entries) {
			const pkgDir = join(root, name);
			let st;
			try {
				st = statSync(pkgDir);
			} catch {
				continue;
			}
			if (!st.isDirectory()) continue;

			// A candidate is either a real code extension (declares pi.extensions) or a
			// data-only memory store (MEMORY.md / sessions.db at its root).
			const pkgJson = join(pkgDir, "package.json");
			let pkg: { name?: string; pi?: { extensions?: string[] } } | null = null;
			if (existsSync(pkgJson)) {
				try {
					pkg = JSON.parse(readFileSync(pkgJson, "utf-8"));
				} catch {
					pkg = null;
				}
			}
			const isCodeExt =
				!!pkg &&
				!!pkg.pi &&
				Array.isArray(pkg.pi.extensions) &&
				pkg.pi.extensions.length > 0;
			const isMemoryStore = isMemoryStoreDir(pkgDir);
			if (!isCodeExt && !isMemoryStore) continue;

			const pkgName = pkg?.name ?? name;
			if (pkgName === selfName) continue;
			scanned.push(`${pkgName} (${name})`);

			if (isCodeExt) {
				const memHits = matchMarkers(pkgDir, MARKERS.memory);
				const compHits = matchMarkers(pkgDir, MARKERS.compaction);
				const toolHits = matchMarkers(pkgDir, MARKERS.toolOutput);

				if (compHits.length > 0) {
					conflicts.push({
						package: pkgName,
						severity: "high",
						kind: "compaction",
						evidence: compHits,
						recommendation:
							"Disabling recommended — competes with pi-mega-compact's conversation compaction.",
					});
					continue; // compaction is the dominant conflict; don't double-flag.
				}
				if (memHits.length > 0) {
					conflicts.push({
						package: pkgName,
						severity: "high",
						kind: "memory",
						evidence: memHits,
						recommendation:
							"pi-mega-compact now owns save-to-memory (/mega-memory, its own SQLite). Disable this to avoid duplicate memory stores.",
					});
					continue;
				}
				if (toolHits.length > 0) {
					conflicts.push({
						package: pkgName,
						severity: "info",
						kind: "tool-output",
						evidence: toolHits,
						recommendation:
							"Shapes tool output (summarize/compact tool results). Generally compatible; no action needed.",
					});
				}
			}

			// Data-only memory store: no source to grep, but the on-disk signature
			// (sessions.db / MEMORY.md) is a conflict with our SQLite memory store.
			if (isMemoryStore) {
				const evidence: string[] = [];
				if (existsSync(join(pkgDir, "sessions.db")))
					evidence.push("sessions.db");
				if (existsSync(join(pkgDir, "MEMORY.md"))) evidence.push("MEMORY.md");
				conflicts.push({
					package: pkgName,
					severity: "high",
					kind: "memory",
					evidence,
					recommendation:
						"pi-mega-compact now owns save-to-memory (its own SQLite). This data-only memory store competes with it — disable to avoid a duplicate / capped memory buffer.",
				});
			}
		}
	}

	return { scanned, conflicts };
}
