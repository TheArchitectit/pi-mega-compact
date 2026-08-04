#!/usr/bin/env node
/**
 * vector-cortex-scope-check.mjs — hard scope gate for Vector Cortex sprints.
 *
 * Every sprint spec under docs/vector-cortex/sprints/ declares a
 * `Production ownership:` field naming the exact files that sprint may create
 * or modify. Agents have drifted outside that set (unlisted side work, edits to
 * unrelated subsystems). This gate makes the drift non-mergeable: given a sprint
 * id and one or more commit SHAs, it asserts every file each commit touched
 * falls inside (declared ownership ∪ fixed cross-cutting seams).
 *
 * Usage:
 *   node scripts/vector-cortex-scope-check.mjs <SPRINT_ID> <COMMIT_SHA...>
 *
 * Exit 0 = every committed file in scope. Exit 1 = drift (files listed).
 *
 * Pure git read: `git show --name-only` and `git rev-parse` only. No network
 * (PREVENT-PI-004), no writes, no commits, Node builtins only.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPRINT_DIR = join(ROOT, "docs", "vector-cortex", "sprints");

// ---------------------------------------------------------------------------
// Ownership parsing
// ---------------------------------------------------------------------------

/**
 * Locate the spec file for a sprint id (VC0A, VC4B, ...). Specs are named
 * `<ID>-<slug>.md`; match on the id prefix so the slug need not be known.
 * @param {string} sprintId
 * @returns {string} absolute path to the spec
 */
export function resolveSpecPath(sprintId, sprintDir = SPRINT_DIR) {
	const id = sprintId.toUpperCase();
	const matches = readdirSync(sprintDir)
		.filter((f) => f.endsWith(".md"))
		.filter((f) => f.toUpperCase().startsWith(`${id}-`) || f.toUpperCase() === `${id}.MD`);
	if (matches.length === 0) {
		throw new Error(`no sprint spec found for "${sprintId}" in ${sprintDir}`);
	}
	if (matches.length > 1) {
		throw new Error(`ambiguous sprint id "${sprintId}": ${matches.join(", ")}`);
	}
	return join(sprintDir, matches[0]);
}

/**
 * Extract the raw text of the `Production ownership:` field. The field is a
 * sentence inside a prose paragraph, terminated by the next field sentence
 * ("Algorithm:") or end of paragraph.
 * @param {string} specText
 * @returns {string} raw ownership text (may contain backticks/braces/globs)
 */
export function extractOwnershipText(specText) {
	const start = specText.indexOf("Production ownership:");
	if (start === -1) throw new Error("spec has no `Production ownership:` field");
	const after = specText.slice(start + "Production ownership:".length);
	// Terminate at the next known field label or a blank line, whichever is first.
	const stop = after.search(/\n\s*\n|\bAlgorithm:|\bMigration disposition:/);
	return (stop === -1 ? after : after.slice(0, stop)).trim();
}

/**
 * Expand a single brace group: `a/{x,y}.ts` → ["a/x.ts", "a/y.ts"].
 * Applied repeatedly so nested/multiple groups all expand.
 * @param {string} token
 * @returns {string[]}
 */
export function expandBraces(token) {
	const m = token.match(/^(.*?)\{([^{}]*)\}(.*)$/);
	if (!m) return [token];
	const [, head, body, tail] = m;
	return body
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.flatMap((part) => expandBraces(`${head}${part}${tail}`));
}

/**
 * A token is path-shaped if it looks like a repo-relative path. Ownership
 * fields carry trailing prose inside the backticks in a few specs
 * (`src/tieredRouter.ts delegate`, `scripts/deploy.sh asset gate`), so each
 * whitespace-run is examined and non-path words are dropped.
 * @param {string} word
 * @returns {boolean}
 */
function isPathShaped(word) {
	if (!word) return false;
	if (!/^[A-Za-z0-9_.@{-]/.test(word)) return false;
	// Build output is never authored scope; the compiled-command code blocks
	// mention dist/ paths, so drop them rather than treating them as owned.
	if (word.startsWith("dist/")) return false;
	// Must contain a path separator or a file extension to count as a path.
	return word.includes("/") || /\.[A-Za-z0-9]+$/.test(word);
}

/**
 * Parse the ownership text into a normalized list of owned path patterns.
 * Handles: separate backtick spans, `;`/space separation inside one span,
 * brace expansion, `X/*` globs, and trailing prose words.
 * @param {string} ownershipText
 * @returns {string[]} owned patterns (paths and `X/*` globs)
 */
export function parseOwnership(ownershipText) {
	// Prefer backtick-quoted spans; if the field has none, fall back to the
	// whole text so a malformed spec still yields something to check.
	const spans = [...ownershipText.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
	const source = spans.length > 0 ? spans : [ownershipText];

	/** @type {string[]} */
	const owned = [];
	for (const span of source) {
		// Split on `;`/whitespace only — commas inside `{a,b}` are brace members,
		// so brace groups must survive splitting and be expanded afterwards.
		for (const chunk of span.split(/[;\s]+/)) {
			const word = chunk.trim().replace(/[.;,]+$/, "");
			if (!isPathShaped(word)) continue; // drop prose like "delegate", "gate"
			for (const expanded of expandBraces(word)) {
				// Post-expansion a stray comma-list (no braces) may remain; split it.
				for (const piece of expanded.split(",")) {
					const p = piece.trim().replace(/[.;,]+$/, "");
					if (isPathShaped(p)) owned.push(p);
				}
			}
		}
	}
	return [...new Set(owned)];
}

/**
 * Harvest the test files the spec names (exact test sources + the sprint
 * acceptance aggregator). These are mandatory per sprint, so they are in scope
 * even though they are not listed under Production ownership.
 * @param {string} specText
 * @returns {string[]}
 */
export function parseNamedTests(specText) {
	/** @type {string[]} */
	const out = [];
	for (const label of ["Exact test sources:", "acceptance aggregator"]) {
		let idx = specText.indexOf(label);
		while (idx !== -1) {
			const after = specText.slice(idx, idx + 1200);
			for (const m of after.matchAll(/`([^`]+)`/g)) {
				// Braces first (`{calibrate,select,fallback}.test.ts`), then commas.
				for (const chunk of m[1].split(/[;\s]+/)) {
					const word = chunk.trim().replace(/[.;,]+$/, "");
					if (!isPathShaped(word)) continue;
					for (const expanded of expandBraces(word)) {
						for (const piece of expanded.split(",")) {
							const p = piece.trim().replace(/[.;,]+$/, "");
							if (isPathShaped(p) && p.includes(".test.")) out.push(p);
						}
					}
				}
			}
			idx = specText.indexOf(label, idx + label.length);
		}
	}
	return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Cross-cutting exceptions
// ---------------------------------------------------------------------------

/**
 * Files ANY sprint may touch: every sprint wires a flag, adds conformance
 * fixtures, writes its evidence record, and may carry dashboard wiring.
 * @param {string} sprintId
 * @returns {{exact: Set<string>, prefixes: string[], patterns: RegExp[]}}
 */
export function crossCuttingExceptions(sprintId) {
	const id = sprintId.toUpperCase();
	const exact = new Set([
		// Flag definition + root re-export (mandated for every sprint).
		"src/config/vector-cortex.ts",
		"src/config.ts",
		// Dashboard wiring set — allowed unconditionally; sprints without
		// dashboard work simply never touch these.
		"extensions/dashboard-server/api-contracts/vector-cortex.ts",
		"extensions/dashboard-server/routes-vector-cortex.ts",
		"extensions/dashboard-server/routes.ts",
		"extensions/dashboard-server/server.ts",
		"extensions/dashboard-client/src/api/vector-cortex.ts",
		"extensions/dashboard-client/src/types/vector-cortex.ts",
		"extensions/dashboard-client/src/tabs/VectorCortexTab.tsx",
		// Publish acceptance gate.
		"scripts/vector-cortex-publish-acceptance.mjs",
		// Mandatory per-sprint fixture generation entry point (companion to the
		// scripts/gen-fixtures/ modules below).
		"scripts/vector-cortex-gen-fixtures.mjs",
		// This gate itself + its test, so the gate can be re-run on its own commit.
		"scripts/vector-cortex-scope-check.mjs",
		"scripts/vector-cortex-scope-check.test.mjs",
		// Evidence record for THIS sprint only.
		`docs/vector-cortex/evidence/${id}.md`,
	]);
	const prefixes = [
		// Fixtures are mandatory per sprint.
		"conformance/vector-cortex/",
		// Fixture generation is mandatory per sprint.
		"scripts/gen-fixtures/",
		// Committed dashboard build output. Regenerated wholesale by the mandated
		// `cd extensions/dashboard-client && npm run build` gate, so the hashed
		// asset churn is a mechanical byproduct rather than authored scope.
		"extensions/dashboard-client/dist/",
	];
	const patterns = [
		// routes-rag-settings*.ts (SETTINGS flag registration) and its tests.
		/^extensions\/dashboard-server\/routes-rag-settings[\w.-]*\.ts$/,
		// routes-vector-cortex*.ts handlers and their tests. Sprints split the
		// handler per domain (routes-vector-cortex-shards.ts, -query.ts, ...) to
		// stay under the 500-line hard limit, so the whole family is a seam.
		/^extensions\/dashboard-server\/routes-vector-cortex[\w.-]*\.(ts|tsx)$/,
		// The sprint's own spec file. A sprint may amend its Production ownership
		// line (contract-first deviations, helper additions surfaced by THIS gate);
		// the amendment is a per-sprint artifact the controller ratifies, the same
		// standing as the evidence record. Match ONLY this sprint's spec, no other.
		new RegExp(`^docs/vector-cortex/sprints/${id}-[^/]+\\.md$`),
	];
	return { exact, prefixes, patterns };
}

/**
 * Decide whether one committed file is in scope.
 * @param {string} file repo-relative path
 * @param {string[]} owned owned patterns from the spec
 * @param {ReturnType<typeof crossCuttingExceptions>} exc
 * @returns {boolean}
 */
export function isInScope(file, owned, exc) {
	if (exc.exact.has(file)) return true;
	if (exc.prefixes.some((p) => file.startsWith(p))) return true;
	if (exc.patterns.some((re) => re.test(file))) return true;

	for (const pattern of owned) {
		if (pattern.endsWith("/*")) {
			// Directory glob: anything under X/ is owned (recursively).
			if (file.startsWith(pattern.slice(0, -1))) return true;
			continue;
		}
		if (pattern.endsWith("/**")) {
			if (file.startsWith(pattern.slice(0, -2))) return true;
			continue;
		}
		if (file === pattern) return true;
		// An owned `.ts` source implicitly owns its colocated unit test.
		const tsMatch = pattern.match(/^(.*)\.(ts|tsx|mjs)$/);
		if (tsMatch && file === `${tsMatch[1]}.test.${tsMatch[2]}`) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

/**
 * List the files a commit touched. Pure read.
 * @param {string} sha
 * @returns {string[]} repo-relative paths
 */
export function filesInCommit(sha, cwd = ROOT) {
	const out = execFileSync("git", ["show", "--name-only", "--format=%n", sha], {
		cwd,
		encoding: "utf-8",
		maxBuffer: 32 * 1024 * 1024,
	});
	return out
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Run the scope check.
 * @param {string} sprintId
 * @param {string[]} shas
 * @param {{sprintDir?: string, cwd?: string, listFiles?: (sha: string) => string[]}} [opts]
 * @returns {{ok: boolean, checked: number, violations: Array<{sha: string, file: string}>, owned: string[]}}
 */
export function runScopeCheck(sprintId, shas, opts = {}) {
	const specPath = resolveSpecPath(sprintId, opts.sprintDir ?? SPRINT_DIR);
	const specText = readFileSync(specPath, "utf-8");
	const owned = [
		...parseOwnership(extractOwnershipText(specText)),
		...parseNamedTests(specText),
	];
	const exc = crossCuttingExceptions(sprintId);
	const listFiles = opts.listFiles ?? ((sha) => filesInCommit(sha, opts.cwd ?? ROOT));

	/** @type {Array<{sha: string, file: string}>} */
	const violations = [];
	let checked = 0;
	for (const sha of shas) {
		for (const file of listFiles(sha)) {
			checked++;
			if (!isInScope(file, owned, exc)) violations.push({ sha, file });
		}
	}
	return { ok: violations.length === 0, checked, violations, owned };
}

function main(argv) {
	const [sprintId, ...shas] = argv;
	if (!sprintId || shas.length === 0) {
		console.error("usage: node scripts/vector-cortex-scope-check.mjs <SPRINT_ID> <COMMIT_SHA...>");
		return 2;
	}
	/** @type {ReturnType<typeof runScopeCheck>} */
	let result;
	try {
		result = runScopeCheck(sprintId, shas);
	} catch (err) {
		console.error(`SCOPE CHECK ERROR: ${err instanceof Error ? err.message : String(err)}`);
		return 2;
	}

	const sprint = sprintId.toUpperCase();
	if (!result.ok) {
		console.error(`\n✗ SCOPE VIOLATION — sprint ${sprint}`);
		console.error(`\nDeclared Production ownership (${result.owned.length} pattern(s)):`);
		for (const p of result.owned) console.error(`    ${p}`);
		console.error(`\nFile(s) OUTSIDE ${sprint}'s Production ownership:`);
		for (const v of result.violations) {
			console.error(`    ${v.file}    (commit ${v.sha.slice(0, 12)})`);
		}
		console.error(
			`\nFAILED: ${result.violations.length} file(s) outside ${sprint}'s Production ownership\n`,
		);
		return 1;
	}
	console.log(
		`✓ SCOPE: ${sprint} — all ${result.checked} committed file(s) inside Production ownership + allowed cross-cutting seams`,
	);
	return 0;
}

// Only run when invoked directly (importable by the test file).
if (process.argv[1] && process.argv[1].endsWith("vector-cortex-scope-check.mjs")) {
	process.exit(main(process.argv.slice(2)));
}
