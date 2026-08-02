/**
 * mega-runtime/env-loader.ts — load `.mega-compact.env` from the state dir.
 *
 * The /mega-setup wizard and the dashboard Setup tab write a `.mega-compact.env`
 * file with the user's chosen embedder configuration. Without a loader, that
 * file is write-only dead weight — config is read from process.env at startup
 * (mega-config.ts:loadConfig), so the file was never applied.
 *
 * This loader runs BEFORE loadConfig in the extension entry. It parses the
 * file (KEY=VALUE lines, # comments, quoted values) and applies each key to
 * process.env ONLY if it is not already set — so shell profile / inline env
 * vars always win over the file (the user can override without editing it).
 *
 * Non-fatal: a missing or malformed file never breaks the extension.
 *
 * PREVENT-PI-004: reads a local file only — no network.
 * PREVENT-001: no JSON here; line parser is null/empty-safe.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Load `.mega-compact.env` from `stateDir` into `process.env`.
 * Keys already set in the environment win (file does not override shell).
 */
export function loadMegaEnv(stateDir: string): void {
	const envPath = join(stateDir, ".mega-compact.env");
	if (!existsSync(envPath)) return;
	let content: string;
	try {
		content = readFileSync(envPath, "utf-8");
	} catch {
		return; // unreadable — non-fatal
	}
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq < 0) continue;
		let key = trimmed.slice(0, eq).trim();
		// The setup wizard + Setup tab write shell-sourceable syntax
		// (`export KEY="VALUE"`). Strip the leading `export ` so the key is
		// `KEY`, not `export KEY` — otherwise process.env gets a useless entry
		// with a space in the name and the real var is never set.
		key = key.replace(/^export\s+/, "");
		if (!key) continue;
		let val = trimmed.slice(eq + 1).trim();
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1);
		}
		// Shell / inline env vars win over the file.
		if (process.env[key] === undefined) {
			process.env[key] = val;
		}
	}
}
