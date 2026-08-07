/**
 * routes-setup-env-upsert.ts — upsert-style write of the per-repo
 * `.mega-compact.env` for the primary embedder selection.
 *
 * Extracted from routes-setup.ts so the route stays under the 300-line soft
 * cap. The writer preserves every unrelated line (ENC-1a's endpoint/key,
 * ENC-1b's dim/headers, operator comments) and replaces only the three keys
 * this primary write owns — MEGACOMPACT_EMBEDDING_URL,
 * MEGACOMPACT_ALLOW_REMOTE_EMBEDDER, MEGACOMPACT_MINILM. URLs already persisted
 * by enc1a/enc1b helpers are NOT clobbered across a later native-opt-in POST
 * (the ENC-1b defect class caught in live review).
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Line-prefix recognizer for an owned key (covers active, commented, and prose forms). */
function ownsKey(line: string, key: string): boolean {
	return (
		line.startsWith(`export ${key}=`) ||
		line.startsWith(`# export ${key}=`) ||
		line.startsWith(`# ${key} `)
	);
}

const OWNED_PREFIXES = [
	"MEGACOMPACT_EMBEDDING_URL",
	"MEGACOMPACT_ALLOW_REMOTE_EMBEDDER",
	"MEGACOMPACT_MINILM",
];

const SCAFFOLD_COMMENTS = new Set([
	"# Mega-Compact Embedder Configuration",
	"# trigram: built-in embedder, no URL needed",
	"# unset MEGACOMPACT_EMBEDDING_URL (commented to override any shell-set value)",
	"# MEGACOMPACT_ALLOW_REMOTE_EMBEDDER not set (loopback-only)",
]);

function isScaffoldComment(line: string): boolean {
	return (
		SCAFFOLD_COMMENTS.has(line) ||
		line.startsWith("# Configured via dashboard Setup tab at ")
	);
}

/**
 * Write the embedder selection upsert-style into `<stateDir>/.mega-compact.env`.
 * `resolvedUrl === null` selects the trigram (built-in) path — the emitted
 * lines carry only the scaffold comments for that case (the URL/remote lines
 * are intentionally absent, matching the pre-refactor byte shape).
 */
export function writeEmbedderEnv(
	stateDir: string,
	resolvedUrl: string | null,
	allowRemote: boolean,
): string {
	const envPath = join(stateDir, ".mega-compact.env");
	const existingLines: string[] = (() => {
		try {
			return existsSync(envPath) ? readFileSync(envPath, "utf-8").split("\n") : [];
		} catch {
			return [];
		}
	})();
	const preserved: string[] = existingLines.filter(
		(l) =>
			l.trim().length > 0 &&
			!isScaffoldComment(l) &&
			!OWNED_PREFIXES.some((p) => ownsKey(l, p)),
	);
	const next: string[] = [
		"# Mega-Compact Embedder Configuration",
		`# Configured via dashboard Setup tab at ${new Date().toISOString()}`,
		...preserved,
	];
	if (resolvedUrl !== null) {
		next.push(`export MEGACOMPACT_EMBEDDING_URL="${resolvedUrl}"`);
		if (allowRemote) {
			next.push(`export MEGACOMPACT_ALLOW_REMOTE_EMBEDDER="1"`);
		} else {
			next.push(`# MEGACOMPACT_ALLOW_REMOTE_EMBEDDER not set (loopback-only)`);
		}
	} else {
		next.push("# trigram: built-in embedder, no URL needed");
		next.push("# unset MEGACOMPACT_EMBEDDING_URL (commented to override any shell-set value)");
		next.push("# export MEGACOMPACT_EMBEDDING_URL=");
		next.push("# export MEGACOMPACT_ALLOW_REMOTE_EMBEDDER=");
	}
	next.push("");
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(envPath, next.join("\n"), "utf-8");
	return envPath;
}
