/**
 * compactors.ts — pluggable compactor adapters for the benchmark suite.
 *
 * Each compactor implements the same interface so the scorer can compare them
 * symmetrically. We never "tune" our compactor to win the benchmark —
 * the honest result is whatever the numbers show.
 *
 * Each adapter converts BenchmarkMessage (our common shape) to the compactor's
 * expected type — using duck-typing / any casts where the type systems diverge.
 */

import type { BenchmarkMessage } from "./corpus.js";

export interface Compactor {
	name: string;
	build(input: { messages: BenchmarkMessage[]; budgetChars?: number }): string;
}

// ── Raw tail-truncation (the "do nothing" baseline) ──────────────────────────
// Keeps the last N chars of the transcript verbatim. It should win on raw recall
// (it keeps everything) but lose badly on size/density — a correctness check
// on the extractor (pi-vcc §4 "do nothing" baseline).

export const rawTruncate: Compactor = {
	name: "raw-truncate",
	build({ messages, budgetChars }) {
		const limit = budgetChars ?? 8000;
		let out = "";
		for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
			const text = messages[i].text;
			if (out.length + text.length > limit) {
				const remaining = limit - out.length;
				out = text.slice(-remaining) + "\n\n---\n\n" + out;
				break;
			}
			out = text + "\n\n---\n\n" + out;
		}
		return out.slice(0, limit);
	},
};

// ── Our summarizer (pi-mega-compact's summarizeMessages) ────────────────────
// This is the extractive, deterministic template — no LLM call at runtime.
// We import from our compiled dist/ so the benchmark tests what we actually ship.
// Our EngineMessage shape: { role, text, toolName?, input?, output? } —
// BenchmarkMessage matches this exactly, so no conversion needed.

let _summarizeMessages: ((messages: any[]) => string) | null = null;

const loadOurs = async () => {
	if (_summarizeMessages) return _summarizeMessages;
	const mod = await import("../../dist/src/compact.js");
	_summarizeMessages = mod.summarizeMessages as (messages: any[]) => string;
	return _summarizeMessages;
};

export const createOurs = async (): Promise<Compactor> => {
	const summarize = await loadOurs();
	return {
		name: "mega-compact",
		build({ messages }) {
			// BenchmarkMessage is structurally compatible with EngineMessage
			return summarize(messages as any);
		},
	};
};

// ── pi-vcc: compile + compileRanked ──────────────────────────────────────────
// pi-vcc is published to npm but its compile/compileRanked are internal modules.
// Per their §8, we clone their repo and import from src/ directly.
// The clone location defaults to $CLAUDE_JOB_DIR/tmp/pi-vcc; override via PI_VCC_DIR env.
//
// pi-vcc's Message type (from @earendil-works/pi-ai) uses { role, content }.
// Our BenchmarkMessage uses { role, text }. The adapter converts:
//   { role, text } → { role, content: text }
// pi-vcc duck-types internally (normalize.ts checks msg.role / msg.content),
// so this is safe at runtime even though the TS types differ.

interface PiVccModule {
	compile: (input: { messages: any[]; previousSummary?: string }) => string;
	compileRanked: (input: { messages: any[]; previousSummary?: string }) => string;
}

let _piVcc: PiVccModule | null = null;

const loadPiVcc = async (): Promise<PiVccModule> => {
	if (_piVcc) return _piVcc;
	const piVccDir = process.env.PI_VCC_DIR ?? "/home/user001/.claude/jobs/5e4c06cd/tmp/pi-vcc";
	const mod = await import(`${piVccDir}/src/core/summarize.ts`);
	_piVcc = { compile: mod.compile, compileRanked: mod.compileRanked };
	return _piVcc;
};

/** Convert BenchmarkMessage → pi-vcc's expected { role, content } shape. */
const toPiVccMessages = (msgs: BenchmarkMessage[]): any[] =>
	msgs.map((m) => ({ role: m.role, content: m.text }));

export const createPiVccBaseline = async (): Promise<Compactor> => {
	const vcc = await loadPiVcc();
	return {
		name: "pi-vcc-baseline",
		build({ messages }) {
			return vcc.compile({ messages: toPiVccMessages(messages) });
		},
	};
};

export const createPiVccRanked = async (): Promise<Compactor> => {
	const vcc = await loadPiVcc();
	return {
		name: "pi-vcc-ranked",
		build({ messages }) {
			return vcc.compileRanked({ messages: toPiVccMessages(messages) });
		},
	};
};

// ── Registry ─────────────────────────────────────────────────────────────────

const COMPACTOR_FACTORIES: Record<string, () => Promise<Compactor>> = {
	"raw-truncate": async () => rawTruncate,
	"mega-compact": createOurs,
	"pi-vcc-baseline": createPiVccBaseline,
	"pi-vcc-ranked": createPiVccRanked,
};

export const AVAILABLE_COMPACTORS = Object.keys(COMPACTOR_FACTORIES);

export const resolveCompactors = async (names?: string[]): Promise<Compactor[]> => {
	const want = names ?? AVAILABLE_COMPACTORS;
	const compactors: Compactor[] = [];
	for (const name of want) {
		const factory = COMPACTOR_FACTORIES[name];
		if (!factory) {
			console.warn(`[compactors] unknown "${name}", skipping — available: ${AVAILABLE_COMPACTORS.join(", ")}`);
			continue;
		}
		try {
			compactors.push(await factory());
		} catch (e: any) {
			console.warn(`[compactors] failed to load "${name}": ${e.message} — skipping`);
		}
	}
	return compactors;
};
