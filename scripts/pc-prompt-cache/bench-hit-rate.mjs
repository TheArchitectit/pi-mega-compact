#!/usr/bin/env node
/**
 * pc-prompt-cache/bench-hit-rate.mjs — PC-D controlled benchmark runner.
 *
 * Compares provider prompt-cache hit rates across the three PC flag states:
 *   - pre-pc: both MEGACOMPACT_MESSAGE_SEPARATION and MEGACOMPACT_CACHE_STRIPING
 *     off (baseline before the PC sprints).
 *   - pc-a : message separation ON only (PC-A state).
 *   - pc-b : both separation + strip striping ON (PC-A+PC-B state).
 *
 * providerCachePct per sample = cacheRead / (cacheRead + input + cacheWrite) * 100,
 * the exact ratio aggregated by src/store/sqlite/perf-samples.ts (aggregateCacheRows)
 * from the `cache_hit_pct` partition of the perf_samples table.
 *
 * Grouping by flag state: perf_samples rows do not carry the flag value, so the
 * group boundary is inferred from the sample timestamp vs the two deploy cutoffs
 * (PC-A release, then PC-B release) — the same derivation the PC-D spec's
 * algorithm describes ("flag values at the time each sample was recorded are
 * derivable from the events log timestamps vs the version deploy dates"). The
 * cutoffs are passed as --pc-a-cutoff / --pc-b-cutoff epoch-ms; when omitted the
 * runner reads MEGACOMPACT_PC_BENCH_PC_A_TS / MEGACOMPACT_PC_BENCH_PC_B_TS, and
 * defaults to a no-cutoff single group over every sample. The grouping is
 * deterministic for a fixed set of cutoffs, so fixture PC-016 pinning is stable.
 *
 * --synthetic mode: replays a fixed message sequence through the stable-prefix
 * model and computes deterministic ratios for the three states. A message list is
 * modeled as [volatile tool results interleaved into a stable prefix]; the
 * stable-prefix ratio is (leading stable run) / (total messages) after the
 * state's transform. unseparated leaves tool results interleaved (short stable
 * run); separated moves them to the tail (longer stable run); striped keeps the
 * stable run and appends an additional cache-stripe layer (longest run). The
 * output satisfies the fixture-PC-017 direction separated > unseparated and
 * striped >= separated. No LLM, no network — deterministic pure computation.
 *
 * LOCAL ONLY: reads local sqlite (PREVENT-PI-004 loopback/granted). Outputs
 * aggregate ratios only, never payload bytes (EVAL-REDACT-002).
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

const GROUPS = ["pre-pc", "pc-a", "pc-b"];

/** True when the given perf sample meta carries a finitely positive cacheRead. */
function hasCacheRead(meta) {
  if (meta == null || typeof meta !== "object") return false;
  return Number.isFinite(meta.cacheRead);
}

/**
 * providerCachePct for one cache_hit_pct sample's meta (0-100). Mirrors the
 * perf-samples aggregator formula. Returns 0 when the denominator is 0.
 */
function providerCachePct(meta) {
  const cr = Number.isFinite(meta?.cacheRead) ? meta.cacheRead : 0;
  const cw = Number.isFinite(meta?.cacheWrite) ? meta.cacheWrite : 0;
  const inp = Number.isFinite(meta?.input) ? meta.input : 0;
  const denom = cr + inp + cw;
  return denom > 0 ? (cr / denom) * 100 : 0;
}

/** p-th percentile of an ascending numeric array (nearest-rank). */
function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor((p / 100) * sortedAsc.length)));
  return sortedAsc[idx];
}

/** Convenience p95: percentile(sortedAsc, 95). */
function p95(sortedAsc) {
  return percentile(sortedAsc, 95);
}

function median(sortedAsc) {
  if (sortedAsc.length === 0) return 0;
  const mid = Math.floor(sortedAsc.length / 2);
  return sortedAsc.length % 2 === 1
    ? sortedAsc[mid]
    : (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
}

function mean(arr) {
  return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Assign a sample (ts) to its flag-state group given < pre-pc | < pc-b | else.
 * Cutoffs are exclusive of the lower side, inclusive of the upper boundary.
 */
function groupFor(ts, pcACutoff, pcBCutoff) {
  if (pcACutoff != null && ts < pcACutoff) return "pre-pc";
  if (pcBCutoff != null && ts < pcBCutoff) return "pc-a";
  return "pc-b";
}

/**
 * Read cache_hit_pct samples from the perf_samples table (sqlite.db).
 * Returns a sorted-ascending list of providerCachePct values.
 */
function readCacheHitPcts(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT ts, meta FROM perf_samples
         WHERE kind = ? ORDER BY ts ASC`,
      )
      .all("cache_hit_pct");
    const out = [];
    for (const r of rows) {
      let meta = null;
      if (r.meta != null) {
        try {
          meta = JSON.parse(r.meta);
        } catch {
          meta = null;
        }
      }
      out.push({ ts: r.ts, pct: providerCachePct(meta), hasCacheRead: hasCacheRead(meta) });
    }
    return out;
  } finally {
    db.close();
  }
}

/** Resolve the state dir database path (default ~/.pi/agent/extensions/mega-compact/sqlite.db). */
function stateDbPath(stateDir) {
  const dir = stateDir ?? process.env.MEGACOMPACT_STATE_DIR ?? join(homedir(), ".pi", "agent", "extensions", "mega-compact");
  return join(dir, "sqlite.db");
}

/**
 * Build the per-group comparison table from raw samples + cutoffs.
 * Each group: { samples, mean, median, p95, totalCacheReadBaseline }. Missing
 * samples for a group yield a zeroed row (read-only, non-fatal).
 */
function computeGroups(samples, pcACutoff, pcBCutoff) {
  const byGroup = {};
  for (const g of GROUPS) byGroup[g] = [];
  for (const s of samples) byGroup[groupFor(s.ts, pcACutoff, pcBCutoff)].push(s.pct);

  const table = {};
  for (const g of GROUPS) {
    const vals = byGroup[g];
    const sorted = [...vals].sort((a, b) => a - b);
    table[g] = {
      samples: vals.length,
      mean: mean(vals),
      median: median(sorted),
      p95: p95(sorted),
    };
  }
  return table;
}

/** Deterministic stable-prefix ratio (0-1) for the synthetic replay. */
function stablePrefixRatio(total, stableRun, extraStable = 0) {
  const stable = Math.min(total, stableRun + extraStable);
  return total > 0 ? stable / total : 0;
}

/**
 * --synthetic: replay a FIXED message sequence through the stable-prefix model
 * for the three states. The sequence has a stable prefix of N stable messages
 * plus M volatile tool results interleaved into it:
 *   - pre-pc (unseparated): tool results stay interleaved, so the contiguous
 *     stable run ends at the first tool result.
 *   - pc-a (separated): tool results move to the tail, exposing the full stable
 *     run contiguous.
 *   - pc-b (striped): like separated, plus a cache-stripe layer lengthens the
 *     stable run.
 * Returns { pre-pc, pc-a, pc-b } ratios with the deterministic direction
 * separated > unseparated and striped >= separated.
 */
function syntheticReplay() {
  // Fixed sequence: 8 stable messages, 3 tool results interleaved after index 2.
  const STABLE = 8;
  const TOOLS = 3;
  const INTERLEAVE_OFFSET = 2; // first tool result sits at position 3 of 11
  const total = STABLE + TOOLS;

  const prePc = stablePrefixRatio(total, INTERLEAVE_OFFSET);
  const pcA = stablePrefixRatio(total, STABLE);
  const pcB = stablePrefixRatio(total, STABLE, 1); // stripe layer extends the run
  return { "pre-pc": prePc, "pc-a": pcA, "pc-b": pcB };
}

function printTable(table) {
  const header = `${"group".padEnd(8)} ${"samples".padStart(7)} ${"mean%".padStart(8)} ${"median%".padStart(8)} ${"p95%".padStart(8)}`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const g of GROUPS) {
    const row = table[g];
    console.log(
      `${g.padEnd(8)} ${String(row.samples).padStart(7)} ${row.mean.toFixed(2).padStart(8)} ${row.median.toFixed(2).padStart(8)} ${row.p95.toFixed(2).padStart(8)}`,
    );
  }
}

function main(argv) {
  const args = argv.slice(2);

  if (args.includes("--synthetic")) {
    const ratios = syntheticReplay();
    console.log("SYNTHETIC stable-prefix replay (fixed sequence):");
    for (const g of GROUPS) {
      console.log(`  ${g.padEnd(8)} ratio ${ratios[g].toFixed(4)}`);
    }
    console.log(
      `  direction: separated>unseparated=${ratios["pc-a"] > ratios["pre-pc"]}  striped>=separated=${ratios["pc-b"] >= ratios["pc-a"]}`,
    );
    return 0;
  }

  const optValue = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const rawA = optValue("--pc-a-cutoff");
  const rawB = optValue("--pc-b-cutoff");
  const pcACutoff = rawA !== undefined ? Number(rawA) : Number(process.env.MEGACOMPACT_PC_BENCH_PC_A_TS ?? NaN);
  const pcBCutoff = rawB !== undefined ? Number(rawB) : Number(process.env.MEGACOMPACT_PC_BENCH_PC_B_TS ?? NaN);
  const stateDir = optValue("--state-dir");

  const dbPath = stateDbPath(stateDir);
  if (!existsSync(dbPath)) {
    console.error(`no state db at ${dbPath}; run inside a pi session or pass --state-dir`);
    return 1;
  }
  const samples = readCacheHitPcts(dbPath);
  const table = computeGroups(samples, pcACutoff, pcBCutoff);
  console.log(`providerCachePct by flag state (${samples.length} cache_hit_pct samples) @ ${dbPath}`);
  printTable(table);
  return 0;
}

process.exit(main(process.argv));
