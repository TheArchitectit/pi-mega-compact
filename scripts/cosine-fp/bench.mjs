// guardrails-allow PREVENT-PI-004: local-only synthetic FP bench — pure fs read/write + in-memory RNG/embed, no network.
/**
 * scripts/cosine-fp/bench.mjs — L2 cosine false-positive harness (COS-FP-A).
 *
 * Builds a deterministic synthetic corpus (corpus.mjs), embeds every item with
 * the shipped deterministic trigram embedder, scores every unique pair's
 * cosine, and for each candidate threshold in the grid 0.80 → 0.98 step 0.005
 * (exactly 37 points) labels each pair FP (clean/near but cosine >= threshold
 * → deduped) / FN (dup but cosine < threshold → passed), aggregating per
 * content-type FP rate + FN rate + F1. Emits a digest-stable aggregate JSON
 * under scripts/cosine-fp/bench-run/ and the markdown eval report
 * docs/vector-cortex/cosine-threshold-report.md recommending a default.
 *
 * Determinism: same seed + params → identical report digest SHA-256.
 * Synthetic-corpus-only — never reads real session/ledger bytes (EVAL-REDACT-002).
 * No network (PREVENT-PI-004). Flag-off (MEGACOMPACT_COSINE_FP_BENCH=0) makes
 * this script inert: it gates report emission and never writes/rewrites the
 * report — byte-identical predecessor.
 *
 * Usage:
 *   node scripts/cosine-fp/bench.mjs            # full sweep + report emit
 *   node scripts/cosine-fp/bench.mjs --seed 20260806
 *   node scripts/cosine-fp/bench.mjs --empty    # force the no_data early return
 */

import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCorpus, corpusSeed } from "./corpus.mjs";

const FLAG = process.env.MEGACOMPACT_COSINE_FP_BENCH;

// ── Pure helpers (deterministic, mirror src/embedder.ts exactly) ───────────

export function l2Normalize(v) {
  let sumSq = 0;
  for (const x of v) sumSq += x * x;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return v.map(() => 0);
  return v.map((x) => x / norm);
}

export function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic trigram embed — byte-identical to shipped TrigramEmbedder. */
export function trigramEmbed(text, dim = 512, seed = 0x9e3779b9) {
  const vec = new Array(dim).fill(0);
  const norm = text.toLowerCase().replace(/\s+/g, " ");
  if (norm.length === 0) return l2Normalize(vec);
  vec[fnv1a(norm) % dim] += 1;
  for (const word of norm.split(" ")) {
    if (word.length === 0) continue;
    vec[fnv1a(word) % dim] += 1;
    for (let i = 0; i + 3 <= word.length; i++) {
      const gram = word.slice(i, i + 3);
      vec[(fnv1a(gram) ^ seed) % dim] += 1;
    }
  }
  if (norm.length < 3) vec[fnv1a(norm) % dim] += 1;
  return l2Normalize(vec);
}

/**
 * The L2 decision semantics (published contract — the report + fixtures pin
 * it): a pair is `deduped` when its cosine is >= the grid threshold, `passed`
 * otherwise. EXACT `<` vs `>=` (off-by-one): a pair at cosine 0.8995 is
 * `passed` at threshold 0.900 and `deduped` at 0.899 — never both.
 */
export function classifyPair(cosine, threshold) {
  return cosine >= threshold ? "deduped" : "passed";
}

/** Grid 0.80 → 0.98 step 0.005, inclusive both ends → exactly 37 points. */
export function makeGrid(lo = 0.8, hi = 0.98, step = 0.005) {
  const points = [];
  for (let t = lo; t <= hi + 1e-9; t += step) {
    points.push(Math.round(t * 1000) / 1000);
  }
  if (points[points.length - 1] !== Math.round(hi * 1000) / 1000) {
    points.push(Math.round(hi * 1000) / 1000);
  }
  return points;
}

export function canonicalJson(value) {
  const keys = Object.keys(value).map((k) => k.normalize("NFC")).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalValue(value[k])}`);
  return `{${parts.join(",")}}`;
}

function canonicalValue(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return "null";
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalValue).join(",")}]`;
  }
  const keys = Object.keys(value).map((k) => k.normalize("NFC")).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalValue(value[k])}`);
  return `{${parts.join(",")}}`;
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// ── Report shaping ──────────────────────────────────────────────────────────

/**
 * The no-fabrication fallback (COS-FP-A-003): when the corpus collapses to zero
 * scorable pairs (no clean items, empty canon, embedding failure), the bench
 * reports an explicit `status:"no_data"` outcome — it never fabricates a
 * threshold or fakes FP=0, never writes a report block, and serves a 404 /
 * `awaiting_data` to the endpoint.
 */
export function noDataOutcome(reason) {
  return {
    status: "no_data",
    reason,
    fabricatedThreshold: false,
    fabricatedFp: false,
    grid: { lo: 0.8, hi: 0.98, step: 0.005, points: makeGrid().length },
    rowCount: 0,
    pairCount: 0,
  };
}

/** Run the full grid sweep over a scored corpus and return the report object. */
export function evaluate(corpus, grid) {
  const items = corpus.items;
  const emb = new Map(items.map((it) => [it.id, trigramEmbed(it.text)]));
  const pairs = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      const cos = cosineSimilarity(emb.get(a.id), emb.get(b.id));
      pairs.push({ a, b, cos });
    }
  }
  if (pairs.length === 0) {
    return noDataOutcome("corpus collapsed to zero scorable pairs");
  }
  const cleanCount = items.filter((x) => x.label === "clean").length;
  if (cleanCount === 0) {
    return noDataOutcome("corpus has no clean items");
  }

  const types = ["code", "prose", "mixed"];
  const rows = grid.map((threshold) => {
    const perType = {};
    for (const ct of types) {
      const typePairs = pairs.filter((p) => p.a.contentType === ct && p.b.contentType === ct);
      const dupN = typePairs.filter(
        (p) => (p.a.label === "dup" || p.b.label === "dup") && classifyPair(p.cos, threshold) === "passed",
      ).length;
      const dupTotal = typePairs.filter((p) => p.a.label === "dup" || p.b.label === "dup").length;
      const cleanNear = typePairs.filter(
        (p) => p.a.label !== "dup" && p.b.label !== "dup" && classifyPair(p.cos, threshold) === "deduped",
      ).length;
      const cleanNearTotal = typePairs.filter((p) => p.a.label !== "dup" && p.b.label !== "dup").length;
      const fnRate = dupTotal === 0 ? null : dupN / dupTotal;
      const fpRate = cleanNearTotal === 0 ? null : cleanNear / cleanNearTotal;
      perType[ct] = { fp: cleanNear, fpRate: ratio(fpRate), fn: dupN, fnRate: ratio(fnRate) };
    }
    const allFp = pairs.filter(
      (p) => p.a.label !== "dup" && p.b.label !== "dup" && classifyPair(p.cos, threshold) === "deduped",
    ).length;
    const allCleanNear = pairs.filter((p) => p.a.label !== "dup" && p.b.label !== "dup").length;
    const allFn = pairs.filter(
      (p) => (p.a.label === "dup" || p.b.label === "dup") && classifyPair(p.cos, threshold) === "passed",
    ).length;
    const allDup = pairs.filter((p) => p.a.label === "dup" || p.b.label === "dup").length;
    const overallFpRate = allCleanNear === 0 ? null : allFp / allCleanNear;
    const overallFnRate = allDup === 0 ? null : allFn / allDup;
    return {
      threshold,
      overallFpRate: ratio(overallFpRate),
      overallFnRate: ratio(overallFnRate),
      overallF1: f1(overallFpRate, overallFnRate),
      perType,
    };
  });

  // Recommendation: threshold minimizing overall F1-loss subject to an FP-rate
  // budget (default 0.05). Prefer the point with the best (lowest-loss, then
  // lowest-FP) tradeoff; fall back to the shipped 0.85 when none qualifies.
  const FP_BUDGET = 0.05;
  const qualified = rows.filter((r) => (r.overallFpRate ?? 1) <= FP_BUDGET);
  const best =
    [...qualified].sort(
      (a, b) => loss(a) - loss(b) || (a.overallFpRate ?? 1) - (b.overallFpRate ?? 1),
    )[0] ?? null;
  const recommendedDefault =
    best === null || best.overallF1 == null ? 0.85 : best.threshold;

  // Per-content-type recommended overrides: the best-F1 threshold per type
  // within the FP budget, else null (no recommendation for that type).
  const overrides = { code: null, prose: null, mixed: null };
  for (const ct of types) {
    const q = rows.filter((r) => (r.perType[ct].fpRate ?? 1) <= FP_BUDGET);
    const r = [...q].sort(
      (a, b) =>
        lossType(a, ct) - lossType(b, ct) ||
        (a.perType[ct].fpRate ?? 1) - (b.perType[ct].fpRate ?? 1),
    )[0];
    if (r && r.perType[ct].fnRate != null) overrides[ct] = r.threshold;
  }

  const report = {
    status: "ok",
    seed: corpus.seed,
    grid: { lo: 0.8, hi: 0.98, step: 0.005, points: grid.length },
    corpusSummary: {
      items: items.length,
      pairs: pairs.length,
      types,
      perType: corpus.counts,
      digest: null,
    },
    rows,
    recommendedDefault,
    shippedDefault: 0.85,
    overrides,
    fpBudget: FP_BUDGET,
    digest: null,
  };
  report.corpusSummary.digest = corpusDigest(items);
  report.digest = sha256Hex(Buffer.from(canonicalJson(stripDigest(report)) + "\n", "utf8"));
  return report;
}

function ratio(x) {
  if (x === null || x === undefined) return null;
  return Math.round(x * 1e4) / 1e4;
}

function f1(fp, fn) {
  if (fp == null || fn == null) return null;
  // Precision/recall derived from FP/FN rates over clean/near and dup pairs.
  const precision = 1 - fp; // 1 - false-positive rate among non-dup
  const recall = 1 - fn; // 1 - false-negative rate among dups
  if (precision + recall === 0) return null;
  return Math.round((2 * precision * recall) / (precision + recall) * 1e4) / 1e4;
}

function loss(row) {
  return (1 - (row.overallF1 ?? 0)) + (row.overallFpRate ?? 1);
}

function lossType(row, ct) {
  return (1 - (f1(row.perType[ct].fpRate, row.perType[ct].fnRate) ?? 0)) + (row.perType[ct].fpRate ?? 1);
}

function corpusDigest(items) {
  const text = items.map((it) => `${it.id}:${it.contentType}:${it.label}`).sort().join("\n");
  return sha256Hex(Buffer.from(text + "\n", "utf8"));
}

function stripDigest(report) {
  const copy = { ...report };
  copy.corpusSummary = { ...copy.corpusSummary, digest: null };
  copy.digest = null;
  return copy;
}

// ── I/O ─────────────────────────────────────────────────────────────────────

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BENCH_RUN_DIR = join(ROOT, "scripts", "cosine-fp", "bench-run");
const AGGREGATE_PATH = join(BENCH_RUN_DIR, "cosine-fp-report.json");
const REPORT_PATH = join(ROOT, "docs", "vector-cortex", "cosine-threshold-report.md");
// The bundled copy that ships in the npm tarball so GET /api/cosine-fp-report
// serves the recommendation on an installed package (PREVENT-DIST-001). Write it
// alongside the bench-run copy so the two stay in lock-step on regeneration.
const BUNDLED_PATH = join(
  ROOT,
  "extensions",
  "dashboard-server",
  "assets",
  "cosine-fp-report.json",
);

function flagEnabled() {
  return !(FLAG === "0" || FLAG === "false");
}

/** Persist the aggregate JSON (canonical) + the markdown eval report. Writes the
 *  bundled asset copy too so the dashboard endpoint serves it on installed
 *  packages (the scripts/bench-run copy is a git-checkout-only dev artifact). */
export function writeReport(report) {
  mkdirSync(BENCH_RUN_DIR, { recursive: true });
  const aggregate = canonicalJson(report) + "\n";
  writeFileSync(AGGREGATE_PATH, aggregate, "utf8");
  mkdirSync(dirname(BUNDLED_PATH), { recursive: true });
  writeFileSync(BUNDLED_PATH, aggregate, "utf8");
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, renderMarkdown(report), "utf8");
}

export function renderMarkdown(report) {
  const lines = [];
  lines.push("# L2 Cosine Threshold Calibration — Synthetic FP harness");
  lines.push("");
  lines.push(`**Status:** ${report.status}`);
  lines.push(`**Corpus seed:** ${report.seed} · **Items:** ${report.corpusSummary.items} · **Pairs:** ${report.corpusSummary.pairs}`);
  lines.push(`**Grid:** ${report.grid.lo} → ${report.grid.hi} step ${report.grid.step} (${report.grid.points} points)`);
  lines.push(`**Shipped default (unchanged this sprint):** ${report.shippedDefault}`);
  lines.push(`**Recommended default:** ${report.recommendedDefault}`);
  lines.push(`**Per-content-type recommended overrides:** CODE ${report.overrides.code ?? "—"} · PROSE ${report.overrides.prose ?? "—"} · MIXED ${report.overrides.mixed ?? "—"}`);
  lines.push(`**Recommendation digest (SHA-256):** ${report.digest}`);
  lines.push(`**Corpus manifest digest (SHA-256):** ${report.corpusSummary.digest}`);
  lines.push("");
  lines.push(`> Synthetic-corpus-only (EVAL-REDACT-002): report carries aggregate counts + fractions + digests only, never any template text.`);
  lines.push("");
  lines.push("## Grid sweep (mean FP across non-dup pairs · FN across dup pairs)");
  lines.push("");
  lines.push("| threshold | FP | FN | F1 | code-FP | prose-FP | mixed-FP | code-FN | prose-FN | mixed-FN |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of report.rows) {
    const fmt = (x) => (x === null ? "—" : String(x));
    lines.push(
      `| ${r.threshold} | ${fmt(r.overallFpRate)} | ${fmt(r.overallFnRate)} | ${fmt(r.overallF1)} | ` +
        `${fmt(r.perType.code.fpRate)} | ${fmt(r.perType.prose.fpRate)} | ${fmt(r.perType.mixed.fpRate)} | ` +
        `${fmt(r.perType.code.fnRate)} | ${fmt(r.perType.prose.fnRate)} | ${fmt(r.perType.mixed.fnRate)} |`,
    );
  }
  lines.push("");
  lines.push("## Recommendation");
  lines.push("");
  lines.push(
    `Default **${report.recommendedDefault}** is the grid point minimizing overall F1-loss subject to an FP-rate budget of ${report.fpBudget}, alongside the shipped ${report.shippedDefault}. Per-content-type overrides (CODE/PROSE/MIXED) are the best-F1 threshold per type within the same FP budget; they remain **unset (default-OFF) landing slots** this sprint — adopting any override is a separate, report-gated decision.`,
  );
  lines.push("");
  return lines.join("\n") + "\n";
}

export function diagnostics(size) {
  return { size };
}

export function main(argv) {
  if (!flagEnabled()) {
    process.stdout.write(
      `COSINE_FP_BENCH=0 — harness inert (no report emission, no endpoint). ${AGGREGATE_PATH} untouched.\n`,
    );
    return { status: "off", written: false };
  }
  const seed = corpusSeed();
  const empty = argv.includes("--empty");
  const corpus = empty
    ? { seed, manifest: [], items: [], counts: {} }
    : buildCorpus(seed);
  if (empty || corpus.items.length === 0) {
    process.stdout.write(`COSINE_FP_BENCH no_data: ${JSON.stringify(noDataOutcome("empty corpus"))}\n`);
    return noDataOutcome("empty corpus");
  }
  const grid = makeGrid();
  const report = evaluate(corpus, grid);
  if (report.status === "no_data") {
    process.stdout.write(`COSINE_FP_BENCH no_data: ${report.reason}\n`);
    return report;
  }
  writeReport(report);
  process.stdout.write(
    `COSINE_FP_BENCH ok seed=${report.seed} pairs=${report.corpusSummary.pairs} ` +
      `recommended=${report.recommendedDefault} digest=${report.digest}\n`,
  );
  return report;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
