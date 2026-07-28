/**
 * facts.ts — format-agnostic fact extractor + weights + metrics.
 *
 * The core honesty guarantee of this benchmark: the SAME extractor parses
 * every compactor's brief (ours, pi-vcc's, the raw-truncate baseline) and the
 * full transcript (ground truth). No compactor gets a parsing advantage —
 * adapted from pi-vcc §3.1's "both sides use the same parser" principle.
 *
 * Facts are normalized keys, not embeddings:
 *  - command family via regex (git, gh pr/issue, search, test/verify, other)
 *  - file path (read vs modified — modified inferred from edit/write tools)
 *  - commit hash (git commit -m / commit subject)
 *  - tool call (edit-class vs read-class)
 *
 * Fully local, zero network (PREVENT-PI-004). Deterministic.
 */

export interface CommandFact {
	exactKey: string;
	semanticKey: string;
	family: "git" | "gh" | "search" | "verify" | "other";
	failed: boolean;
}
export interface ToolFact {
	key: string;
	family: "edit" | "read";
}

// ── Command families + tool classes ──────────────────────────────────────────

const TEST_RE =
	/(?:\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?[\w:-]*(?:test|spec|check|lint|build|typecheck|tsc)\b|\bnode\s+--test\b|\bpytest\b|\bcargo\s+test\b|\bgo\s+test\b|\bmvn\s+test\b|\bgradle\s+test\b|\btsc\b)/i;
const GH_RE = /(?:^|\s)gh\s+(pr|issue)\s+(\w+)\s+(\d+)/i;
const GH_ANY_RE = /(?:^|\s)gh\s+(pr|issue)\s+(\w+)\b/i;
const GIT_RE = /(?:^|\s)git\s+(\w+)/i;
const SEARCH_RE = /^(?:rg|grep|find)\b/i;
const EDIT_TOOL_RE = /^(edit|write|multiedit|quick_edit|target_edit|apply_patch|str_replace|create_file)$/i;
const READ_TOOL_RE = /^(read|glob|grep|ls|find|semantic_query|semantic_grep|semantic_show|view|cat|head|tail)$/i;

const normalizeCommand = (cmd: string): string =>
	cmd.replace(/^\s*cd\s+\S+\s*&&\s*/, "").replace(/\s+/g, " ").trim();

const commandFamily = (cmd: string): CommandFact["family"] => {
	if (GH_ANY_RE.test(cmd)) return "gh";
	if (GIT_RE.test(cmd)) return "git";
	if (SEARCH_RE.test(cmd)) return "search";
	if (TEST_RE.test(cmd)) return "verify";
	return "other";
};

const semanticCommandKey = (cmd: string): string => {
	const n = normalizeCommand(cmd);
	const gh = n.match(GH_RE);
	if (gh) return `gh:${gh[1].toLowerCase()}:${gh[2].toLowerCase()}:${gh[3]}`;
	const ghAny = n.match(GH_ANY_RE);
	if (ghAny) return `gh:${ghAny[1].toLowerCase()}:${ghAny[2].toLowerCase()}`;
	const git = n.match(GIT_RE);
	if (git) {
		const msg = n.match(/\bgit\s+commit\b[^\n]*?-m\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
		if (msg) return `git:commit:${msg[1] ?? msg[2] ?? msg[3]}`;
		return `git:${git[1].toLowerCase()}`;
	}
	if (TEST_RE.test(n)) {
		const runner = n.match(/^\S+/)?.[0] ?? "test";
		const files = [...n.matchAll(/[\w./-]*(?:test|spec)[\w./-]*\.[\w]+|tests\/[\w./-]+/g)]
			.map((m) => m[0])
			.sort();
		return `verify:${runner}:${files.length ? files.join(",") : n.slice(0, 120)}`;
	}
	if (SEARCH_RE.test(n)) {
		const quoted = n.match(/"([^"]+)"|'([^']+)'/)?.slice(1).find(Boolean);
		const bin = n.match(/^\S+/)?.[0] ?? "search";
		return `search:${bin}:${quoted ?? n.slice(0, 120)}`;
	}
	const [bin = "cmd", sub = ""] = n.split(/\s+/, 2);
	return `${bin}:${sub || n.slice(0, 80)}`;
};

export const commandFact = (raw: string, failed = false): CommandFact | null => {
	const n = normalizeCommand(raw);
	if (!n) return null;
	return {
		exactKey: `cmd:${n}`,
		semanticKey: semanticCommandKey(n),
		family: commandFamily(n),
		failed,
	};
};

// ── Facts model ──────────────────────────────────────────────────────────────

export interface Facts {
	filesModified: Set<string>;
	filesRead: Set<string>;
	commits: Set<string>;
	commandsSemantic: Set<string>;
	testCommands: Set<string>;
	failedCommands: Set<string>;
	ghCommands: Set<string>;
	searchCommands: Set<string>;
	editTools: Set<string>;
	readTools: Set<string>;
	commandExactDupes: number;
	toolDupes: number;
}

/** Fact weights (pi-vcc §3.2). EDIT to reflect what matters to your workflow. */
export const WEIGHTS = [
	{ ref: "failedCommands" as const, got: "commandsSemantic" as const, weight: 6 },
	{ ref: "commits" as const, got: "commits" as const, weight: 5 },
	{ ref: "filesModified" as const, got: "filesModified" as const, weight: 4 },
	{ ref: "testCommands" as const, got: "testCommands" as const, weight: 4 },
	{ ref: "editTools" as const, got: "editTools" as const, weight: 4 },
	{ ref: "ghCommands" as const, got: "ghCommands" as const, weight: 2 },
	{ ref: "filesRead" as const, got: "filesRead" as const, weight: 1 },
	{ ref: "searchCommands" as const, got: "searchCommands" as const, weight: 1 },
	{ ref: "readTools" as const, got: "readTools" as const, weight: 1 },
	{ ref: "commandsSemantic" as const, got: "commandsSemantic" as const, weight: 0.5 },
] as const satisfies readonly { ref: keyof Facts; got: keyof Facts; weight: number }[];

const asSet = (f: Facts, k: keyof Facts): Set<string> =>
	f[k] instanceof Set ? (f[k] as Set<string>) : new Set();
const countDupes = (items: string[]): number => items.length - new Set(items).size;

export const buildFacts = (parts: {
	filesModified: Set<string>;
	filesRead: Set<string>;
	commits: Set<string>;
	commandFacts: CommandFact[];
	toolFacts: ToolFact[];
}): Facts => ({
	filesModified: parts.filesModified,
	filesRead: parts.filesRead,
	commits: parts.commits,
	commandsSemantic: new Set(parts.commandFacts.map((c) => c.semanticKey)),
	testCommands: new Set(
		parts.commandFacts.filter((c) => c.family === "verify").map((c) => c.semanticKey),
	),
	failedCommands: new Set(
		parts.commandFacts.filter((c) => c.failed).map((c) => c.semanticKey),
	),
	ghCommands: new Set(
		parts.commandFacts.filter((c) => c.family === "gh").map((c) => c.semanticKey),
	),
	searchCommands: new Set(
		parts.commandFacts.filter((c) => c.family === "search").map((c) => c.semanticKey),
	),
	editTools: new Set(parts.toolFacts.filter((t) => t.family === "edit").map((t) => t.key)),
	readTools: new Set(parts.toolFacts.filter((t) => t.family === "read").map((t) => t.key)),
	commandExactDupes: countDupes(parts.commandFacts.map((c) => c.exactKey)),
	toolDupes: countDupes(parts.toolFacts.map((t) => t.key)),
});

// ── Metrics (pi-vcc §3.3) ────────────────────────────────────────────────────

const weightedTotal = (ref: Facts): number =>
	WEIGHTS.reduce((t, w) => t + asSet(ref, w.ref).size * w.weight, 0);

const weightedHit = (ref: Facts, got: Facts): number => {
	let hit = 0;
	for (const w of WEIGHTS) {
		const g = asSet(got, w.got);
		for (const k of asSet(ref, w.ref)) if (g.has(k)) hit += w.weight;
	}
	return hit;
};

/** weightedRecall — fraction of *value* kept (empty session → 1). */
export const weightedRecall = (ref: Facts, got: Facts): number => {
	const total = weightedTotal(ref);
	return total === 0 ? 1 : weightedHit(ref, got) / total;
};

/** weightedFactDensity — value kept per 1k chars (size-normalized). */
export const weightedFactDensity = (ref: Facts, got: Facts, chars: number): number =>
	chars > 0 ? weightedHit(ref, got) / (chars / 1000) : 0;

/** precision — mean fact-weight of the brief's own facts. */
export const precision = (got: Facts): number => {
	const readOnly = new Set([...got.filesRead].filter((p) => !got.filesModified.has(p)));
	let rest = new Set(got.commandsSemantic);
	const inter = (a: Set<string>) => new Set([...rest].filter((k) => a.has(k)));
	const minus = (a: Set<string>) => new Set([...rest].filter((k) => !a.has(k)));
	const verify = inter(got.testCommands);
	rest = minus(got.testCommands);
	const gh = inter(got.ghCommands);
	rest = minus(got.ghCommands);
	const search = inter(got.searchCommands);
	rest = minus(got.searchCommands);
	const cats = [
		{ c: got.commits.size, w: 5 },
		{ c: got.filesModified.size, w: 4 },
		{ c: readOnly.size, w: 1 },
		{ c: verify.size, w: 4 },
		{ c: gh.size, w: 2 },
		{ c: search.size, w: 1 },
		{ c: rest.size, w: 0.5 },
		{ c: got.editTools.size, w: 4 },
		{ c: got.readTools.size, w: 1 },
	];
	const denom = cats.reduce((s, x) => s + x.c, 0);
	return denom === 0 ? 0 : cats.reduce((s, x) => s + x.c * x.w, 0) / denom;
};
