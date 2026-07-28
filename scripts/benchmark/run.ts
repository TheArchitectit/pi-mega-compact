#!/usr/bin/env node
/**
 * run.ts — benchmark runner for pi-mega-compact.
 *
 * Orchestrates: load corpus → extract ground truth → run every compactor →
 * score → aggregate → print table + write out/results.{csv,json}.
 *
 * Fully local, zero network (PREVENT-PI-004). Deterministic PRNG for synthetic.
 *
 * Usage:
 *   node --import tsx scripts/benchmark/run.ts --corpus=synthetic --seed=42 --limit=200
 *   node --import tsx scripts/benchmark/run.ts --corpus=real --limit=50 --sessions=~/.pi/agent/sessions
 *   node --import tsx scripts/benchmark/run.ts --corpus=synthetic,real --compactors=mega-compact,pi-vcc-ranked
 *
 * Flags:
 *   --corpus=synthetic|real|both   Default: synthetic
 *   --seed=N                       Synthetic PRNG seed. Default: 42
 *   --limit=N                      Max sessions per corpus. Default: 200 (synthetic), 50 (real)
 *   --sessions=DIR                 Session directory for real corpus. Default: ~/.pi/agent/sessions
 *   --dup-frac=F                   Synthetic duplication fraction [0,1]. Default: 0.3
 *   --budget=N                     Target brief size in chars. Default: 8000
 *   --compactors=a,b,c             Compactores to run. Default: all available
 *   --out=DIR                      Output directory for results. Default: scripts/benchmark/out
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateSynthetic, loadRealSessions, type CorpusSession } from "./corpus.js";
import { resolveCompactors, AVAILABLE_COMPACTORS } from "./compactors.js";
import { scoreSession, aggregateScores, formatResultsTable, formatDeltasTable } from "./score.js";

// ── CLI parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getFlag = (name: string): string | undefined =>
	args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1]?.trim();
const hasFlag = (name: string) => args.some((a) => a === `--${name}`);

const CORPUS_MODE = getFlag("corpus") ?? "synthetic";
const SEED = Number(getFlag("seed") ?? "42");
const SYNTH_LIMIT = Number(getFlag("limit") ?? (CORPUS_MODE === "real" ? "50" : "200"));
const SESSIONS_DIR = getFlag("sessions") ?? join(process.env.HOME ?? "~", ".pi", "agent", "sessions");
const DUP_FRAC = Number(getFlag("dup-frac") ?? "0.3");
const BUDGET = Number(getFlag("budget") ?? "8000");
const OUT_DIR = getFlag("out") ?? join(import.meta.dirname ?? "scripts/benchmark", "out");

// ── Main ─────────────────────────────────────────────────────────────────────

const main = async () => {
	const startTime = performance.now();

	console.log("╔══════════════════════════════════════════════════════════════╗");
	console.log("║  pi-mega-compact benchmark suite                            ║");
	console.log("╚══════════════════════════════════════════════════════════════╝");
	console.log();

	// 1. Load corpus
	const corpus: CorpusSession[] = [];
	const modes = CORPUS_MODE.split(",");

	if (modes.includes("synthetic") || modes.includes("both")) {
		const synth = generateSynthetic({ seed: SEED, count: SYNTH_LIMIT, dupFraction: DUP_FRAC });
		corpus.push(...synth);
		console.log(`[corpus] loaded ${synth.length} synthetic sessions (seed=${SEED}, dup-frac=${DUP_FRAC})`);
	}
	if (modes.includes("real") || modes.includes("both")) {
		const limitForReal = modes.includes("both") ? Math.min(SYNTH_LIMIT, 50) : SYNTH_LIMIT;
		const real = loadRealSessions({ dir: SESSIONS_DIR, limit: limitForReal });
		corpus.push(...real);
		console.log(`[corpus] loaded ${real.length} real sessions from ${SESSIONS_DIR}`);
	}

	if (corpus.length === 0) {
		console.error("[corpus] no sessions found. Check --corpus, --sessions, --limit.");
		process.exit(1);
	}

	// 2. Resolve compactors
	const compactors = await resolveCompactors(
		getFlag("compactors")?.split(",").map((s) => s.trim()),
	);
	if (compactors.length === 0) {
		console.error("[compactors] none loaded. Check --compactors or dist/src/compact.js.");
		process.exit(1);
	}
	console.log(`[compactors] ${compactors.map((c) => c.name).join(", ")}`);
	console.log(`[config] budget=${BUDGET} sessions=${corpus.length}`);
	console.log();

	// 3. Score each session
	const results = [];
	for (let i = 0; i < corpus.length; i++) {
		const session = corpus[i];
		if ((i + 1) % 50 === 0 || i === 0) {
			process.stdout.write(`\r[scoring] ${i + 1}/${corpus.length}...`);
		}
		try {
			const scores = scoreSession(session.id, session.messages, compactors);
			results.push(scores);
		} catch (e: any) {
			console.warn(`\n[warn] ${session.id}: ${e.message} — skipping`);
		}
	}
	console.log(`\r[scoring] ${results.length}/${corpus.length} complete          `);
	console.log();

	if (results.length === 0) {
		console.error("[error] no sessions scored successfully.");
		process.exit(1);
	}

	// 4. Aggregate + display
	const aggregated = aggregateScores(results);
	const table = formatResultsTable(aggregated);
	const deltas = formatDeltasTable(aggregated);

	console.log(table);
	console.log();
	console.log(deltas);

	// 5. Write out/
	mkdirSync(OUT_DIR, { recursive: true });

	const jsonPath = join(OUT_DIR, "results.json");
	const csvPath = join(OUT_DIR, "results.csv");

	// JSON: full results + aggregated
	writeFileSync(
		jsonPath,
		JSON.stringify(
			{
				timestamp: new Date().toISOString(),
				config: { corpus: CORPUS_MODE, seed: SEED, limit: SYNTH_LIMIT, dupFrac: DUP_FRAC, budget: BUDGET },
				aggregated,
				sessionCount: results.length,
			},
			null,
			2,
		),
	);
	console.log(`[out] ${jsonPath}`);

	// CSV: per-session scores (for external analysis / charting)
	const compNames = Object.keys(results[0]?.compactors ?? {});
	const csvHeader = [
		"session_id",
		"message_count",
		"total_chars",
		...compNames.flatMap((n) => [`${n}_recall`, `${n}_density`, `${n}_precision`, `${n}_size`, `${n}_dupes`, `${n}_latencyMs`]),
	].join(",");
	const csvRows = results.map((r) =>
		[
			r.sessionId,
			r.messageCount,
			r.totalChars,
			...compNames.flatMap((n) => {
				const c = r.compactors[n];
				return c ? [c.recall, c.density, c.precision, c.size, c.duplicateFacts, c.latencyMs].join(",") : "0,0,0,0,0,0";
			}),
		].join(","),
	);
	writeFileSync(csvPath, [csvHeader, ...csvRows].join("\n"));
	console.log(`[out] ${csvPath}`);

	// 6. Timing
	const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
	console.log();
	console.log(`Benchmark complete in ${elapsed}s.`);
};

main().catch((e) => {
	console.error("[fatal]", e);
	process.exit(1);
});
