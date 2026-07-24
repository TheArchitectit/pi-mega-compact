#!/usr/bin/env node
/**
 * real-repo-benchmark.ts — measures compact token size over real repos.
 *
 * Walks actual repo file trees, builds realistic agent transcripts (reads,
 * edits, commands), and measures what compact actually produces at scale.
 *
 * Targets ~1M tokens of work per repo. Reports input tokens → compact output
 * tokens, compression ratio, and what survives at various checkpoints.
 *
 * Fully local, zero network. Uses actual file contents — not synthetic data.
 *
 * Usage:
 *   npx tsx scripts/benchmark/real-repo-benchmark.ts
 *   npx tsx scripts/benchmark/real-repo-benchmark.ts --repos=rad-gateway --target-tokens=500000
 *   npx tsx scripts/benchmark/real-repo-benchmark.ts --skip-pivcc
 *
 * Output: prints table + writes scripts/benchmark/out/real-repo-results.json
 */

import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { estimateSessionTokens, estimateBlockTokens } from "../../src/tokens.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface EngineMessage {
	role: "user" | "assistant" | "tool" | "custom";
	text: string;
	toolName?: string;
	input?: string;
	output?: string;
}

interface RepoSpec {
	name: string;
	path: string;
}

interface CheckpointResult {
	inputTokens: number;
	messageCount: number;
	compactTokens: number;
	compactChars: number;
	ratio: number; // compactTokens / inputTokens
}

interface RepoResult {
	repo: string;
	totalFiles: number;
	totalLines: number;
	targetTokens: number;
	actualInputTokens: number;
	messageCount: number;
	checkpoints: CheckpointResult[];
	finalCompact: CheckpointResult;
	piVccBaseline?: CheckpointResult;
	piVccRanked?: CheckpointResult;
}

// ── Config ───────────────────────────────────────────────────────────────────

const IGNORE_DIRS = new Set([
	"node_modules", ".git", "dist", "build", "vendor", ".next", "target",
	"__pycache__", ".cache", "coverage", ".turbo", "out",
]);

const BINARY_EXTS = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".woff", ".woff2",
	".ttf", ".eot", ".mp3", ".mp4", ".wav", ".pdf", ".zip", ".tar",
	".gz", ".bz2", ".7z", ".rar", ".exe", ".dll", ".so", ".dylib",
	".bin", ".dat", ".db", ".sqlite", ".sqlite3", ".wasm", ".pyc",
]);

const CHECKPOINT_INTERVAL = 100_000; // tokens between checkpoints

// ── File walker ──────────────────────────────────────────────────────────────

interface RepoFile {
	path: string; // relative path
	contents: string;
	lines: number;
}

const walkRepo = (repoPath: string): RepoFile[] => {
	const files: RepoFile[] = [];

	const walk = (dir: string) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (IGNORE_DIRS.has(entry.name)) continue;
			if (entry.name.startsWith(".")) continue;

			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath);
			} else if (entry.isFile()) {
				const ext = extname(entry.name).toLowerCase();
				if (BINARY_EXTS.has(ext)) continue;

				try {
					const stat = statSync(fullPath);
					if (stat.size > 500_000) continue; // skip files > 500KB
					const contents = readFileSync(fullPath, "utf-8");
					const relPath = relative(repoPath, fullPath);
					files.push({
						path: relPath,
						contents,
						lines: contents.split("\n").length,
					});
				} catch {
					// skip unreadable files
				}
			}
		}
	};

	walk(repoPath);
	return files;
};

// ── Transcript builder ───────────────────────────────────────────────────────
// Builds realistic agent transcripts from actual file contents.
// Simulates: user asks → assistant reads → assistant edits → tool output.

const USER_PROMPTS = [
	"Read this file and explain what it does",
	"Fix the bug in the error handling",
	"Add a new feature to handle the edge case",
	"Refactor this to be more readable",
	"Write tests for this module",
	"Review the changes and check for issues",
	"Search for all TODOs and fix them",
	"Update the documentation",
	"Optimize the performance of this function",
	"Add proper error handling here",
	"Check if this follows the style guide",
	"Make this function more robust",
	"Split this into smaller functions",
	"Add type annotations",
	"Fix the race condition",
];

const pick = <T>(arr: T[], idx: number): T => arr[idx % arr.length];

const buildTranscript = (files: RepoFile[], targetTokens: number): EngineMessage[] => {
	const messages: EngineMessage[] = [];
	let currentTokens = 0;
	let fileIdx = 0;
	let promptIdx = 0;

	while (currentTokens < targetTokens) {
		const file = files[fileIdx % files.length];

		// User request
		const userText = pick(USER_PROMPTS, promptIdx) + ` in ${file.path}`;
		const userMsg: EngineMessage = { role: "user", text: userText };
		messages.push(userMsg);
		currentTokens += estimateSessionTokens([userMsg]);
		promptIdx++;

		// Assistant reads the file (full content)
		const readMsg: EngineMessage = {
			role: "tool",
			text: file.contents,
			toolName: "read",
		};
		messages.push(readMsg);
		currentTokens += estimateSessionTokens([readMsg]);

		// If we've hit the target, stop
		if (currentTokens >= targetTokens) break;

		// Assistant response with analysis
		const assistantText = [
			`I've read ${file.path} (${file.lines} lines).`,
			`This file implements the ${file.path.split("/").pop()?.replace(/\.\w+$/, "") ?? "module"} functionality.`,
			"I can see a few things that need attention.",
			"",
			"Let me make the changes:",
		].join("\n");
		const assistantMsg: EngineMessage = { role: "assistant", text: assistantText };
		messages.push(assistantMsg);
		currentTokens += estimateSessionTokens([assistantMsg]);

		// Edit: take first N lines of the file as the "edited" version
		const editLines = file.contents.split("\n");
		const editSlice = editLines.slice(0, Math.min(editLines.length, 50)).join("\n");
		const editMsg: EngineMessage = {
			role: "tool",
			text: `Updated ${file.path}`,
			toolName: "edit",
			input: JSON.stringify({ file: file.path, oldText: editSlice.slice(0, 200), newText: editSlice }),
			output: `Successfully edited ${file.path}`,
		};
		messages.push(editMsg);
		currentTokens += estimateSessionTokens([editMsg]);

		// Every 5th iteration, run a command
		if (fileIdx % 5 === 0) {
			const cmdText = "npm run test 2>&1";
			const cmdOutput = [
				"> test",
				"> jest --passWithNoTests",
				"",
				"PASS  tests/app.test.ts",
				"  ✓ should handle basic case (12 ms)",
				"  ✓ should handle edge case (3 ms)",
				"",
				"Test Suites: 1 passed, 1 total",
				"Tests:       2 passed, 2 total",
				"Snapshots:   0 total",
				"Time:        1.234 s",
			].join("\n");
			const cmdMsg: EngineMessage = {
				role: "assistant",
				text: `Running: ${cmdText}`,
			};
			const cmdResult: EngineMessage = {
				role: "tool",
				text: cmdOutput,
				toolName: "bash",
			};
			messages.push(cmdMsg, cmdResult);
			currentTokens += estimateSessionTokens([cmdMsg, cmdResult]);
		}

		// Every 10th iteration, do a grep/search
		if (fileIdx % 10 === 0) {
			const searchPattern = file.path.split("/").pop()?.replace(/\.\w+$/, "") ?? "function";
			const searchMsg: EngineMessage = {
				role: "assistant",
				text: `Searching for "${searchPattern}" in the codebase...`,
			};
			const searchResult: EngineMessage = {
				role: "tool",
				text: `${file.path}:1: ${file.contents.split("\n")[0] ?? ""}`,
				toolName: "grep",
			};
			messages.push(searchMsg, searchResult);
			currentTokens += estimateSessionTokens([searchMsg, searchResult]);
		}

		fileIdx++;
	}

	return messages;
};

// ── Compact runners ──────────────────────────────────────────────────────────

const loadSummarizeMessages = async (): Promise<(msgs: EngineMessage[]) => string> => {
	const mod = await import("../../dist/src/compact.js");
	return mod.summarizeMessages as (msgs: EngineMessage[]) => string;
};

const loadPiVcc = async (): Promise<{
	compile: (input: { messages: any[]; previousSummary?: string }) => string;
	compileRanked: (input: { messages: any[]; previousSummary?: string }) => string;
} | null> => {
	try {
		const piVccDir = process.env.PI_VCC_DIR ?? "/home/user001/.claude/jobs/5e4c06cd/tmp/pi-vcc";
		const mod = await import(`${piVccDir}/src/core/summarize.ts`);
		return { compile: mod.compile, compileRanked: mod.compileRanked };
	} catch (e: any) {
		console.warn(`[pi-vcc] not available: ${e.message}`);
		return null;
	}
};

// ── Checkpoint scoring ───────────────────────────────────────────────────────

const scoreCheckpoint = (
	inputTokens: number,
	messageCount: number,
	compactText: string,
): CheckpointResult => {
	const compactChars = compactText.length;
	const compactTokens = estimateBlockTokens(compactText);
	return {
		inputTokens,
		messageCount,
		compactTokens,
		compactChars,
		ratio: compactTokens / inputTokens,
	};
};

// ── Runner ───────────────────────────────────────────────────────────────────

const REPOS: RepoSpec[] = [
	{ name: "pi-ithacus-agent-framework", path: "/mnt/data/git/pi-ithacus-agent-framework" },
	{ name: "rad-gateway", path: "/mnt/data/git/rad-gateway" },
	{ name: "game04", path: "/mnt/data/git/game04" },
];

const formatTokens = (n: number): string =>
	n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` :
	n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` :
	n.toFixed(0);

const formatPct = (n: number): string => `${(n * 100).toFixed(1)}%`;

const main = async () => {
	const args = process.argv.slice(2);
	const reposArg = args.find((a) => a.startsWith("--repos="))?.split("=")[1];
	const targetArg = args.find((a) => a.startsWith("--target-tokens="))?.split("=")[1];
	const skipPiVcc = args.includes("--skip-pivcc");

	const targetTokens = parseInt(targetArg ?? "1000000", 10);
	const repoFilter = reposArg?.split(",").map((s) => s.trim());
	const repos = repoFilter
		? REPOS.filter((r) => repoFilter.includes(r.name))
		: REPOS;

	console.log("╔══════════════════════════════════════════════════════════════╗");
	console.log("║  Real-repo compact benchmark                                ║");
	console.log("╚══════════════════════════════════════════════════════════════╝");
	console.log(`\nTarget: ${formatTokens(targetTokens)} tokens per repo`);
	console.log(`Repos: ${repos.map((r) => r.name).join(", ")}`);
	console.log("");

	const summarizeMessages = await loadSummarizeMessages();
	const piVcc = skipPiVcc ? null : await loadPiVcc();

	const allResults: RepoResult[] = [];

	for (const repo of repos) {
		console.log(`\n${"═".repeat(60)}`);
		console.log(`  ${repo.name}`);
		console.log(`${"═".repeat(60)}`);

		// Walk repo
		console.log(`\n[walk] scanning ${repo.path}...`);
		const files = walkRepo(repo.path);
		const totalLines = files.reduce((s, f) => s + f.lines, 0);
		console.log(`[walk] ${files.length} files, ${totalLines.toLocaleString()} lines`);

		if (files.length === 0) {
			console.warn(`[walk] no readable files in ${repo.path}, skipping`);
			continue;
		}

		// Build transcript
		console.log(`[build] generating ~${formatTokens(targetTokens)} tokens of transcript...`);
		const messages = buildTranscript(files, targetTokens);
		const inputTokens = estimateSessionTokens(messages);
		console.log(`[build] ${messages.length} messages, ${formatTokens(inputTokens)} tokens`);

		// Run compact at checkpoints
		console.log(`[compact] running summarizeMessages at ${formatTokens(CHECKPOINT_INTERVAL)}-token intervals...`);
		const checkpoints: CheckpointResult[] = [];
		let accumulated: EngineMessage[] = [];
		let tokensSinceCheckpoint = 0;

		for (const msg of messages) {
			accumulated.push(msg);
			tokensSinceCheckpoint += estimateSessionTokens([msg]);

			if (tokensSinceCheckpoint >= CHECKPOINT_INTERVAL) {
				const totalTokens = estimateSessionTokens(accumulated);
				const compact = summarizeMessages(accumulated);
				const cp = scoreCheckpoint(totalTokens, accumulated.length, compact);
				checkpoints.push(cp);
				process.stdout.write(
					`  ${formatTokens(totalTokens)} msgs=${accumulated.length} → ${formatTokens(cp.compactTokens)} compact (${formatPct(cp.ratio)})\n`
				);
				tokensSinceCheckpoint = 0;
			}
		}

		// Final compact (full transcript)
		console.log(`[compact] final compact on full ${formatTokens(inputTokens)}-token transcript...`);
		const finalCompact = summarizeMessages(messages);
		const finalResult = scoreCheckpoint(inputTokens, messages.length, finalCompact);
		console.log(
			`  FINAL: ${formatTokens(inputTokens)} → ${formatTokens(finalResult.compactTokens)} tokens (${formatPct(finalResult.ratio)}), ${finalResult.compactChars.toLocaleString()} chars`
		);

		// pi-vcc comparison
		let piVccBaseline: RepoResult["piVccBaseline"];
		let piVccRanked: RepoResult["piVccRanked"];
		if (piVcc) {
			console.log(`[pi-vcc] running baseline...`);
			const piVccMsgs = messages.map((m) => ({ role: m.role, content: m.text }));
			const baseline = piVcc.compile({ messages: piVccMsgs });
			piVccBaseline = scoreCheckpoint(inputTokens, messages.length, baseline);
			console.log(
				`  baseline: ${formatTokens(inputTokens)} → ${formatTokens(piVccBaseline.compactTokens)} tokens (${formatPct(piVccBaseline.ratio)}), ${piVccBaseline.compactChars.toLocaleString()} chars`
			);

			console.log(`[pi-vcc] running ranked...`);
			const ranked = piVcc.compileRanked({ messages: piVccMsgs });
			piVccRanked = scoreCheckpoint(inputTokens, messages.length, ranked);
			console.log(
				`  ranked: ${formatTokens(inputTokens)} → ${formatTokens(piVccRanked.compactTokens)} tokens (${formatPct(piVccRanked.ratio)}), ${piVccRanked.compactChars.toLocaleString()} chars`
			);
		}

		allResults.push({
			repo: repo.name,
			totalFiles: files.length,
			totalLines,
			targetTokens,
			actualInputTokens: inputTokens,
			messageCount: messages.length,
			checkpoints,
			finalCompact: finalResult,
			piVccBaseline,
			piVccRanked,
		});
	}

	// ── Summary table ─────────────────────────────────────────────────────

	console.log(`\n${"═".repeat(80)}`);
	console.log("  SUMMARY");
	console.log(`${"═".repeat(80)}\n`);

	const hasPiVcc = allResults.some((r) => r.piVccBaseline);

	// Input stats
	console.log("### Input stats\n");
	console.log(`| Repo | Files | Lines | Messages | Input tokens |`);
	console.log(`|------|-------|-------|----------|-------------|`);
	for (const r of allResults) {
		console.log(`| ${r.repo} | ${r.totalFiles} | ${r.totalLines.toLocaleString()} | ${r.messageCount} | ${formatTokens(r.actualInputTokens)} |`);
	}

	// Compact output
	console.log("\n### Compact output (tokens)\n");
	if (hasPiVcc) {
		console.log(`| Repo | **mega-compact** | **pi-vcc-baseline** | **pi-vcc-ranked** |`);
		console.log(`|------|-----------------|--------------------|--------------------|`);
		for (const r of allResults) {
			const mc = formatTokens(r.finalCompact.compactTokens);
			const pb = r.piVccBaseline ? formatTokens(r.piVccBaseline.compactTokens) : "—";
			const pr = r.piVccRanked ? formatTokens(r.piVccRanked.compactTokens) : "—";
			console.log(`| ${r.repo} | ${mc} | ${pb} | ${pr} |`);
		}
	} else {
		console.log(`| Repo | Compact tokens | Compact chars | Ratio |`);
		console.log(`|------|---------------|--------------|-------|`);
		for (const r of allResults) {
			console.log(`| ${r.repo} | ${formatTokens(r.finalCompact.compactTokens)} | ${r.finalCompact.compactChars.toLocaleString()} | ${formatPct(r.finalCompact.ratio)} |`);
		}
	}

	// Compression ratios
	console.log("\n### Compression ratio (compact / input)\n");
	if (hasPiVcc) {
		console.log(`| Repo | **mega-compact** | **pi-vcc-baseline** | **pi-vcc-ranked** |`);
		console.log(`|------|-----------------|--------------------|--------------------|`);
		for (const r of allResults) {
			const mc = formatPct(r.finalCompact.ratio);
			const pb = r.piVccBaseline ? formatPct(r.piVccBaseline.ratio) : "—";
			const pr = r.piVccRanked ? formatPct(r.piVccRanked.ratio) : "—";
			console.log(`| ${r.repo} | ${mc} | ${pb} | ${pr} |`);
		}
	} else {
		console.log(`| Repo | Ratio |`);
		console.log(`|------|-------|`);
		for (const r of allResults) {
			console.log(`| ${r.repo} | ${formatPct(r.finalCompact.ratio)} |`);
		}
	}

	// Checkpoint progression
	console.log("\n### Checkpoint progression (mega-compact)\n");
	for (const r of allResults) {
		console.log(`**${r.repo}:**`);
		console.log(`| Input tokens | Messages | Compact tokens | Ratio |`);
		console.log(`|-------------|----------|---------------|-------|`);
		for (const cp of r.checkpoints) {
			console.log(`| ${formatTokens(cp.inputTokens)} | ${cp.messageCount} | ${formatTokens(cp.compactTokens)} | ${formatPct(cp.ratio)} |`);
		}
		console.log(`| **${formatTokens(r.finalCompact.inputTokens)}** | **${r.messageCount}** | **${formatTokens(r.finalCompact.compactTokens)}** | **${formatPct(r.finalCompact.ratio)}** |`);
		console.log("");
	}

	// Write JSON results
	const outDir = join(import.meta.dirname, "out");
	mkdirSync(outDir, { recursive: true });
	const outPath = join(outDir, "real-repo-results.json");
	writeFileSync(outPath, JSON.stringify(allResults, null, 2));
	console.log(`\n[output] written to ${outPath}`);
};

main().catch((e) => {
	console.error("FATAL:", e);
	process.exit(1);
});
