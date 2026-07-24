/**
 * corpus.ts — session corpus loaders for the benchmark suite.
 *
 * Two modes (pi-vcc's in-sample / out-of-sample split):
 *   synthetic({ seed, count, dupFraction }) — deterministic seeded generator,
 *     fully reproducible, zero external deps. Controlled fact density + duplication.
 *   real({ dir, limit }) — reads ~/.pi/agent/sessions/*.jsonl. Privacy:
 *     only aggregate metrics + session IDs written to out/, never transcript text.
 *
 * Both return CorpusSession with BenchmarkMessage[] — a common shape that every
 * compactor adapter converts to its own expected type. Fully local, zero network.
 */

// ── Common message type (matches our EngineMessage shape) ────────────────────

export interface BenchmarkMessage {
	role: "user" | "assistant" | "tool" | "custom";
	text: string;
	toolName?: string;
	input?: string;
	output?: string;
}

export interface CorpusSession {
	id: string;
	messages: BenchmarkMessage[];
	/** Human-readable description of where this session came from. */
	source: string;
}

// ── Deterministic PRNG (mulberry32, same as dedup-benchmark.mjs) ─────────────

function mulberry32(seed: number) {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ── Synthetic session generator ──────────────────────────────────────────────

const SYNTH_FILES = [
	"src/engine.ts", "src/compact.ts", "src/types.ts", "src/vectorstore.ts",
	"extensions/mega-events/event-tracker.ts", "extensions/mega-events/error-classifier.ts",
	"scripts/benchmark/run.ts", "tests/engine.test.ts", "package.json", "tsconfig.json",
	"README.md", "docs/CHANGELOG.md", "src/hooks/before-compact.ts", "src/commands/pidock.ts",
	"extensions/dashboard-client/src/App.tsx", "extensions/dashboard-client/src/index.css",
];

const SYNTH_COMMANDS = [
	"npm run build", "npm run test", "npm run lint", "git add .", 'git commit -m "fix(engine): null guard"',
	"git push origin feature-branch", "gh pr create --title 'fix: crash' --body 'fixes null guard'",
	"gh pr merge --squash", "rg 'pattern'", "find . -name '*.ts'", "bun test --timeout=30000",
	"tsc --noEmit", "node scripts/deploy.sh", "git stash", "git stash pop",
	"gh issue view 123", "grep -rn 'TODO' src/", "cat package.json",
];

const SYNTH_TOOLS = [
	"edit", "write", "read", "grep", "glob", "ls", "view",
];

const SYNTH_USER_PROMPTS = [
	"Fix the null pointer error in the compact function",
	"Add error handling to the before-compact hook",
	"Write tests for the new error classifier",
	"Refactor the vector store to use a connection pool",
	"Deploy to staging and verify the dashboard loads",
	"Review the PR diff and check for regressions",
	"Search for all TODOs in src/ and list them",
	"Explain how the dedup tiers work",
	"The build is failing on CI, figure out why",
	"Update the README for the new version",
];

const generateMessage = (
	rng: () => number,
	role: "user" | "assistant" | "tool",
): BenchmarkMessage => {
	if (role === "user") {
		const idx = Math.floor(rng() * SYNTH_USER_PROMPTS.length);
		return { role: "user", text: SYNTH_USER_PROMPTS[idx] };
	}
	if (role === "tool") {
		const toolName = SYNTH_TOOLS[Math.floor(rng() * SYNTH_TOOLS.length)];
		const filePath = SYNTH_FILES[Math.floor(rng() * SYNTH_FILES.length)];
		return {
			role: "tool",
			text: `${filePath} content here (tool output)`,
			toolName,
		};
	}
	// assistant
	const commands: string[] = [];
	const n = Math.floor(rng() * 3) + 1;
	for (let i = 0; i < n; i++) {
		commands.push(SYNTH_COMMANDS[Math.floor(rng() * SYNTH_COMMANDS.length)]);
	}
	const edited = SYNTH_FILES[Math.floor(rng() * SYNTH_FILES.length)];
	return {
		role: "assistant",
		text: [
			"I'll fix this now.",
			`Running: ${commands[0]}`,
			`Edited: ${edited}`,
			commands.length > 1 ? `Then: ${commands.slice(1).join(", ")}` : "",
			"Done.",
		]
			.filter(Boolean)
			.join("\n"),
	};
};

export interface SyntheticOptions {
	seed: number;
	count: number;
	/** Probability each message duplicates a previous fact [0,1]. Default 0.3. */
	dupFraction?: number;
	/** Mean messages per session. Default 60. */
	sessionSize?: number;
}

export const generateSynthetic = (opts: SyntheticOptions): CorpusSession[] => {
	const rng = mulberry32(opts.seed);
	const dupFrac = opts.dupFraction ?? 0.3;
	const meanSize = opts.sessionSize ?? 60;

	const sessions: CorpusSession[] = [];
	for (let i = 0; i < opts.count; i++) {
		const len = Math.max(8, Math.floor(meanSize * (0.4 + rng() * 1.2)));
		const messages: BenchmarkMessage[] = [];
		for (let j = 0; j < len; j++) {
			const roll = rng();
			let role: "user" | "assistant" | "tool";
			if (j === 0) role = "user";
			else if (roll < 0.35) role = "user";
			else if (roll < 0.7) role = "assistant";
			else role = "tool";

			// Duplicate an earlier message with dupFrac probability (introduces noise for dedup testing)
			if (dupFrac > 0 && rng() < dupFrac && j > 3) {
				const dupIdx = Math.floor(rng() * (j - 1));
				const dup = messages[dupIdx];
				if (dup.role === role) {
					messages.push({ ...dup });
					continue;
				}
			}
			messages.push(generateMessage(rng, role));
		}
		sessions.push({
			id: `synthetic-${opts.seed}-${i}`,
			messages,
			source: `synthetic(seed=${opts.seed}, len=${len})`,
		});
	}
	return sessions;
};

// ── Real sessions (from ~/.pi/agent/sessions/*.jsonl) ─────────────────────────
// Mirrors pi-vcc §8: only aggregate metrics + session IDs are exported, never text.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface RealOptions {
	dir?: string;
	limit?: number;
}

const toBenchmarkMessage = (line: string): BenchmarkMessage | null => {
	try {
		const obj = JSON.parse(line);
		if (!obj.role) return null;
		const text = obj.content ?? obj.text ?? "";
		if (typeof text === "string") {
			return {
				role: obj.role,
				text,
				...(obj.toolName ? { toolName: obj.toolName } : {}),
				...(obj.input ? { input: obj.input } : {}),
				...(obj.output ? { output: obj.output } : {}),
			};
		}
		// Handle content array (Claude SDK format)
		if (Array.isArray(text)) {
			const joined = text.map((b: any) => (b.type === "text" ? b.text : "")).join("\n");
			return {
				role: obj.role,
				text: joined,
				...(obj.toolName ? { toolName: obj.toolName } : {}),
			};
		}
		return null;
	} catch {
		return null;
	}
};

export const loadRealSessions = (opts: RealOptions = {}): CorpusSession[] => {
	const dir = opts.dir ?? join(process.env.HOME ?? "~", ".pi", "agent", "sessions");
	let files: string[];
	try {
		files = readdirSync(dir)
			.filter((f) => f.endsWith(".jsonl"))
			.sort();
	} catch (e: any) {
		console.warn(`[corpus] could not read ${dir}: ${e.message}`);
		return [];
	}

	const limit = opts.limit ?? files.length;
	const sessions: CorpusSession[] = [];

	for (const file of files.slice(0, limit)) {
		const path = join(dir, file);
		try {
			const stat = statSync(path);
			if (stat.size === 0) continue;

			const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
			const messages: BenchmarkMessage[] = [];
			for (const line of lines) {
				const msg = toBenchmarkMessage(line);
				if (msg) messages.push(msg);
			}
			if (messages.length > 0) {
				sessions.push({
					id: file.replace(/\.jsonl$/, ""),
					messages,
					source: `real:${file}(${stat.size}B)`,
				});
			}
		} catch {
			// skip unreadable files
		}
	}

	return sessions;
};
