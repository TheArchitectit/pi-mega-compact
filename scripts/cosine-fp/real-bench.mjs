// guardrails-allow PREVENT-PI-004: local-only real-corpus FP bench — pure fs read/write + in-memory embed/RNG, no network.
/**
 * scripts/cosine-fp/real-bench.mjs — L2 cosine false-positive validation on a
 * donated, consent-approved real corpus (COS-FP-R).
 *
 * Executes ONLY when a valid consented corpus exists. The corpus gate returns
 * `no_corpus` when the corpus dir/manifest is absent (the normative pre-donation
 * state — NOT a failure) and `corpus_invalid` when a manifest is present but any
 * session lacks consent metadata or a revoked/non-consented session is included
 * (STOP, write nothing). Only consent-approved sessions are ever scored
 * (SECURITY_PRIVACY §Lifecycle/§Consent); non-consented/revoked sessions are
 * denied and logged, never silently included (EVAL-REDACT-002: this report
 * carries counts, CIs + digests only, never raw snippet text).
 *
 * Full run: reads the manifest, filters to consented sessions, embeds donated
 * snippets via the shipped deterministic trigram embedder (imported from
 * ./bench.mjs — no duplication), scores pairs at the grid 0.80→0.98 step 0.005,
 * labels FP/FN against the session-owner-annotated ground truth, and reports
 * per-threshold FP/FN with Wilson score intervals + session-grouped
 * bootstrap(10000) (EVALUATION §Metrics). Emits a digest-keyed JSON under
 * scripts/cosine-fp/bench-run/ (real-<digest>.json, never overwritten) and
 * appends a real-corpus block to docs/vector-cortex/cosine-threshold-report.md
 * (append-only — the synthetic baseline block is never edited/overwritten).
 *
 * Determinism: same corpus + params → same result digest (embedding is the
 * deterministic trigramEmbed; the session-grouped bootstrap is mulberry32-seeded
 * from the corpus digest). Same input → identical digested output.
 *
 * Flag-off (MEGACOMPACT_COSINE_FP_REAL=0) makes this script inert: it prints a
 * one-line message and writes nothing — byte-identical predecessor.
 *
 * Usage:
 *   node scripts/cosine-fp/real-bench.mjs --check-corpus   # gate-only; prints no_corpus/corpus_invalid/count
 *   node scripts/cosine-fp/real-bench.mjs                  # full run (only when a valid consented corpus exists)
 *   MEGACOMPACT_COSINE_FP_REAL=0 node scripts/cosine-fp/real-bench.mjs   # inert
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mulberry32 } from "./corpus.mjs";
import {
  trigramEmbed,
  cosineSimilarity,
  classifyPair,
  makeGrid,
  canonicalJson,
  sha256Hex,
} from "./bench.mjs";

const FLAG = process.env.MEGACOMPACT_COSINE_FP_REAL;

// ── Corpus location + execution targets (local-only; env-overridable for
//    operator targets + honest structural tests) ─────────────────────────────

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORPUS_DIR = () =>
  process.env.MEGACOMPACT_COSINE_FP_REAL_CORPUS ||
  join(ROOT, "scripts", "cosine-fp", "corpus");
const MANIFEST_PATH = () => join(CORPUS_DIR(), "corpus-manifest.json");
const OUT_DIR = () =>
  process.env.MEGACOMPACT_COSINE_FP_REAL_OUTDIR ||
  join(ROOT, "scripts", "cosine-fp", "bench-run");
const REPORT_PATH = () =>
  process.env.MEGACOMPACT_COSINE_FP_REAL_REPORT ||
  join(ROOT, "docs", "vector-cortex", "cosine-threshold-report.md");

/** Minimum consented-session floor (EVALUATION §Corpus = 100). Env-overridable
 *  only so the write-time structural tests exercise the full run on a tiny
 *  synthetic corpus; the default always enforces the 100-session floor. */
function minSessions() {
  const raw = Number(process.env.MEGACOMPACT_COSINE_FP_REAL_FLOOR);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 100;
}

/** Bootstrap replicates (EVALUATION §Metrics; default 10000). Env-overridable
 *  for fast structural tests; determinism does not depend on the value. */
function bootstrapCount() {
  const raw = Number(process.env.MEGACOMPACT_COSINE_FP_REAL_BOOTSTRAP);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 10000;
}

const FP_BUDGET = 0.05;
const CONTENT_TYPES = ["code", "prose", "mixed"];
// COS-FP-A synthetic baseline thresholds this sprint compares against.
const SYNTHETIC_BASELINE = { default: 0.815, code: 0.915, prose: 0.95, mixed: 0.955 };

function flagEnabled() {
  return !(FLAG === "0" || FLAG === "false");
}

// ── Corpus gate (task 1) ─────────────────────────────────────────────────────

const REQUIRED_METADATA = [
  "sourceDigest",
  "provenance",
  "license",
  "repositoryGroup",
  "language",
  "contentTypeFraction",
  "split",
];

/**
 * Structural corpus gate. Returns:
 *   { status:"no_corpus", reason:"absent" }            — dir/manifest missing
 *   { status:"no_corpus", reason:"insufficient", sessionCount, floor }
 *                                                    — present but < floor consented
 *   { status:"corpus_invalid", reason, detail, count? } — malformed / non-consented
 *   { status:"ok", sessionCount, sessions }             — valid, consented corpus
 */
export function checkCorpus(corpusDir = CORPUS_DIR()) {
  const manifestPath = join(corpusDir, "corpus-manifest.json");
  if (!existsSync(corpusDir) || !existsSync(manifestPath)) {
    return { status: "no_corpus", reason: "absent" };
  }
  let manifest;
  try {
    const raw = readFileSync(manifestPath, "utf8");
    manifest = JSON.parse(raw); // PREVENT-001: guarded below
    if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.sessions)) {
      return {
        status: "corpus_invalid",
        reason: "manifest_malformed",
        detail: "corpus-manifest.json must be an object with a sessions array",
      };
    }
  } catch (err) {
    return {
      status: "corpus_invalid",
      reason: "manifest_unreadable",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const missingConsent = [];
  const revoked = [];
  const missingMeta = [];
  for (const s of manifest.sessions) {
    const consent = s && typeof s === "object" ? s.consent : null;
    const recordId = consent && typeof consent.recordId === "string" ? consent.recordId : "";
    if (!recordId) missingConsent.push(s ? s.sessionId : "(null session)");
    else if (consent.revoked === true) revoked.push(s.sessionId);
    for (const key of REQUIRED_METADATA) {
      if (!(key in s)) missingMeta.push(`${key}:${s ? s.sessionId : "?"}`);
    }
  }
  if (missingConsent.length > 0) {
    return {
      status: "corpus_invalid",
      reason: "missing_consent",
      detail: `${missingConsent.length} session(s) missing a consent record id`,
      count: missingConsent.length,
    };
  }
  if (revoked.length > 0) {
    return {
      status: "corpus_invalid",
      reason: "revoked_consent",
      detail: `${revoked.length} session(s) have revoked consent`,
      count: revoked.length,
    };
  }
  if (missingMeta.length > 0) {
    return {
      status: "corpus_invalid",
      reason: "missing_metadata",
      detail: `${missingMeta.length} missing metadata field(s): ${missingMeta.slice(0, 5).join(", ")}${missingMeta.length > 5 ? "…" : ""}`,
      count: missingMeta.length,
    };
  }
  const floor = minSessions();
  if (manifest.sessions.length < floor) {
    return {
      status: "no_corpus",
      reason: "insufficient",
      sessionCount: manifest.sessions.length,
      floor,
    };
  }
  // Defense-in-depth: never include a session whose consent is revoked, even in
  // an otherwise well-formed manifest (see filterConsented).
  const consented = filterConsented(manifest.sessions);
  return { status: "ok", sessionCount: consented.length, sessions: consented };
}

/**
 * Consent filter (task 2 belt-and-suspenders): excludes any session without a
 * consent record id or with revoked consent, LOGGING each denial. Never silently
 * includes a non-consented/revoked session. In a gate-passing corpus this is a
 * pass-through; it is unit-tested directly so revocation is never scored.
 */
export function filterConsented(sessions) {
  const out = [];
  for (const s of sessions) {
    const consent = s && typeof s === "object" ? s.consent : null;
    const recordId = consent && typeof consent.recordId === "string" ? consent.recordId : "";
    if (!recordId || consent.revoked === true) {
      process.stderr.write(
        `real-bench consent filter: denying ${s ? s.sessionId : "(unknown)"} ` +
          `${recordId ? "(revoked)" : "(no consent record)"} — excluded from scoring\n`,
      );
      continue;
    }
    out.push(s);
  }
  return out;
}

// ── Statistics (task 3) ──────────────────────────────────────────────────────

/**
 * Wilson score interval for a proportion p = k/n at 95% confidence. Returns
 * {lo, hi} clamped to [0,1], or {lo:null, hi:null} when n === 0 (no evidence).
 */
export function wilsonInterval(k, n) {
  if (n === 0) return { lo: null, hi: null };
  const p = k / n;
  const z = 1.96;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - margin), hi: Math.min(1, center + margin) };
}

/**
 * Draw `count` whole-session indices in [0, n-1] with replacement from a
 * deterministic mulberry32 RNG seeded by `seed`. A session is never split — each
 * draw is one integer session index (the session-grouped invariant).
 */
export function drawSessionIndices(n, seed, count) {
  const rng = mulberry32(seed >>> 0);
  const idx = [];
  for (let i = 0; i < count; i++) idx.push(Math.floor(rng() * n));
  return idx;
}

/**
 * Session-grouped bootstrap: resample WHOLE sessions (with replacement), compute
 * the mean over the resampled sessions' per-session values, repeat `B` times,
 * and return the 2.5/97.5 percentile CI. Because the unit of resampling is the
 * session, no session ever straddles a fold/resample boundary.
 */
export function bootstrapSessionMeans(perSessionValues, seed, B) {
  const n = perSessionValues.length;
  if (n === 0) return { lo: null, hi: null, means: [] };
  const rng = mulberry32(seed >>> 0);
  const means = new Array(B);
  for (let b = 0; b < B; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += perSessionValues[Math.floor(rng() * n)];
    }
    means[b] = sum / n;
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(0.025 * (B - 1))];
  const hi = means[Math.floor(0.975 * (B - 1))];
  return { lo: round(lo), hi: round(hi), means };
}

function round(x) {
  return Math.round(x * 1e4) / 1e4;
}

// ── Scoring + report (tasks 2–4) ─────────────────────────────────────────────

/** Embed all snippets and score every ground-truth pair once. */
function scorePairs(sessions) {
  const emb = new Map();
  for (const s of sessions) {
    for (const sn of s.snippets || []) {
      emb.set(`${s.sessionId}::${sn.id}`, trigramEmbed(sn.text));
    }
  }
  const pairs = [];
  for (const s of sessions) {
    for (const gt of s.groundTruth || []) {
      const aKey = `${s.sessionId}::${gt.a}`;
      const bKey = `${s.sessionId}::${gt.b}`;
      const va = emb.get(aKey);
      const vb = emb.get(bKey);
      if (!va || !vb) continue;
      const cos = cosineSimilarity(va, vb);
      pairs.push({ sessionId: s.sessionId, truth: gt.truth, contentType: gt.contentType, cos });
    }
  }
  return pairs;
}

/**
 * Run the full grid sweep over a consented corpus and return the report object
 * (pure + deterministic: same sessions + grid → same digest). `sessions` is the
 * consent-filtered session list (type attribution by pair contentType).
 */
export function computeReport(sessions, grid = makeGrid()) {
  const pairs = scorePairs(sessions);
  const thresholdRows = grid.map((threshold) => {
    const perType = {};
    for (const ct of CONTENT_TYPES) {
      const tp = pairs.filter((p) => p.contentType === ct);
      const clean = tp.filter((p) => p.truth === "clean");
      const dup = tp.filter((p) => p.truth === "duplicate");
      const fp = clean.filter((p) => classifyPair(p.cos, threshold) === "deduped").length;
      const fn = dup.filter((p) => classifyPair(p.cos, threshold) === "passed").length;
      perType[ct] = {
        fp,
        cleanTotal: clean.length,
        fpRate: clean.length === 0 ? null : round(fp / clean.length),
        fpCi: wilsonInterval(fp, clean.length),
        fn,
        dupTotal: dup.length,
        fnRate: dup.length === 0 ? null : round(fn / dup.length),
      };
    }
    return { threshold, perType };
  });

  // Overall (all types) per-threshold row for the CI-backed recommendation.
  const overall = thresholdRows.map((row) => {
    let fp = 0, cleanTotal = 0, fn = 0, dupTotal = 0;
    for (const ct of CONTENT_TYPES) {
      fp += row.perType[ct].fp;
      cleanTotal += row.perType[ct].cleanTotal;
      fn += row.perType[ct].fn;
      dupTotal += row.perType[ct].dupTotal;
    }
    return {
      threshold: row.threshold,
      fp,
      cleanTotal,
      fpRate: cleanTotal === 0 ? null : round(fp / cleanTotal),
      fpCi: wilsonInterval(fp, cleanTotal),
      fn,
      dupTotal,
      fnRate: dupTotal === 0 ? null : round(fn / dupTotal),
    };
  });

  const recommendations = buildRecommendations({ thresholdRows, overall });
  const sessionCount = sessions.length;
  const corpusDigest = corpusDigestOf(sessions);

  const report = {
    status: "ok",
    mode: "real",
    grid: { lo: grid[0], hi: grid[grid.length - 1], step: grid.length > 1 ? round(grid[1] - grid[0]) : 0, points: grid.length },
    sessionCount,
    pairCount: pairs.length,
    corpusDigest,
    syntheticBaseline: SYNTHETIC_BASELINE,
    fpBudget: FP_BUDGET,
    rows: thresholdRows,
    overall,
    recommendations,
    digest: null,
  };
  report.digest = sha256Hex(
    Buffer.from(canonicalJson(stripDigest(report)) + "\n", "utf8"),
  );
  return report;
}

function bestQualifying(row, budget) {
  const ci = row.fpCi;
  if (ci.hi === null) return { ok: false };
  // Non-overlapping-with-failure: the whole CI must be at/below the FP budget.
  if (ci.hi > budget) return { ok: false };
  return { ok: true, fpCi: ci, fpRate: row.fpRate };
}

/** Per-type + overall recommendation array: emitted only where the real CI is
 *  non-overlapping-with-failure (hi <= FP budget). Never emits for a type with
 *  insufficient clean-pair evidence (ci null). */
export function buildRecommendations({ thresholdRows, overall }) {
  const out = [];
  for (const ct of CONTENT_TYPES) {
    const qualified = thresholdRows
      .map((r) => ({ row: r, q: bestQualifying(r.perType[ct], FP_BUDGET) }))
      .filter((x) => x.q.ok);
    if (qualified.length === 0) continue;
    // Prefer the qualified threshold with the lowest FN rate (best recall), else
    // the smallest FP rate.
    const best = [...qualified].sort(
      (a, b) =>
        (a.row.perType[ct].fnRate ?? 1) - (b.row.perType[ct].fnRate ?? 1) ||
        (a.row.perType[ct].fpRate ?? 1) - (b.row.perType[ct].fpRate ?? 1),
    )[0];
    out.push({
      contentType: ct,
      threshold: best.row.threshold,
      fpRate: best.q.fpRate,
      ci: best.q.fpCi,
      fnRate: best.row.perType[ct].fnRate,
      syntheticBaseline: SYNTHETIC_BASELINE[ct],
    });
  }
  const oq = overall.map((r) => ({ row: r, q: bestQualifying(r, FP_BUDGET) })).filter((x) => x.q.ok);
  if (oq.length > 0) {
    const best = [...oq].sort(
      (a, b) => (a.row.fnRate ?? 1) - (b.row.fnRate ?? 1) || (a.row.fpRate ?? 1) - (b.row.fpRate ?? 1),
    )[0];
    out.unshift({
      contentType: "overall",
      threshold: best.row.threshold,
      fpRate: best.q.fpRate,
      ci: best.q.fpCi,
      fnRate: best.row.fnRate,
      syntheticBaseline: SYNTHETIC_BASELINE.default,
    });
  }
  return out;
}

function corpusDigestOf(sessions) {
  const lines = [];
  for (const s of sessions) {
    lines.push(
      `${s.sessionId}|${s.sourceDigest || ""}|${
        (s.snippets || []).map((x) => x.id).sort().join(",")
      }|${
        (s.groundTruth || [])
          .map((g) => `${g.a}~${g.b}~${g.truth}`)
          .sort()
          .join(",")
      }`,
    );
  }
  return sha256Hex(Buffer.from(lines.sort().join("\n") + "\n", "utf8"));
}

function stripDigest(report) {
  const copy = { ...report };
  copy.digest = null;
  copy.bootstrap = { ...copy.bootstrap, means: [] }; // bootstrap means excluded from digest
  return copy;
}

// ── I/O + report append (task 5) ─────────────────────────────────────────────

/**
 * Persist the digest-keyed execution JSON under OUT_DIR as real-<digest>.json.
 * Never overwrites an existing run: if the file already exists (same corpus
 * re-run), it is left untouched and reported as `existing`.
 */
export function writeRunJson(report) {
  mkdirSync(OUT_DIR(), { recursive: true });
  const file = join(OUT_DIR(), `real-${report.digest}.json`);
  const exists = existsSync(file);
  if (!exists) writeFileSync(file, canonicalJson(report) + "\n", "utf8");
  return { file, existing: exists };
}

/** Append the real-corpus block to the threshold report (append-only). The
 *  synthetic baseline block is never edited or overwritten. */
export function appendReportBlock(report) {
  const lines = [];
  lines.push("");
  lines.push("## Real-corpus validation (COS-FP-R)");
  lines.push("");
  lines.push(
    `**Session count:** ${report.sessionCount} · **Pairs:** ${report.pairCount} · **Corpus digest:** ${report.corpusDigest} · **Run digest:** ${report.digest}`,
  );
  lines.push(
    `**Overall FP budget:** ${report.fpBudget} · **Synthetic baseline (COS-FP-A):** default ${report.syntheticBaseline.default} / CODE ${report.syntheticBaseline.code} / PROSE ${report.syntheticBaseline.prose} / MIXED ${report.syntheticBaseline.mixed}`,
  );
  lines.push("");
  lines.push("| scope | threshold | FP-rate (CI) | FN-rate | synthetic baseline |");
  lines.push("| --- | --- | --- | --- | --- |");
  if (report.recommendations.length === 0) {
    lines.push("| overall | — | — | — | — |*(no threshold meets the FP budget with non-overlapping CI)*|");
  } else {
    for (const r of report.recommendations) {
      const fmt = (x) => (x === null || x === undefined ? "—" : String(x));
      const ci =
        r.ci.lo === null ? "—" : `[${fmt(r.ci.lo)}, ${fmt(r.ci.hi)}]`;
      lines.push(
        `| ${r.contentType} | ${r.threshold} | ${fmt(r.fpRate)} (${ci}) | ${fmt(r.fnRate)} | ${r.syntheticBaseline} |`,
      );
    }
  }
  lines.push("");
  lines.push(
    `> Real-corpus-only (EVAL-REDACT-002): this block carries counts, CIs and digests only — never raw snippet text. Donated consent-approved sessions only (SECURITY_PRIVACY §Consent).`,
  );
  lines.push("");
  appendText(REPORT_PATH(), lines.join("\n"));
}

function appendText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { flag: "a", encoding: "utf8" });
}

// ── CLI (task: gate check + full run) ────────────────────────────────────────

export function main(argv) {
  if (!flagEnabled()) {
    process.stdout.write(
      `MEGACOMPACT_COSINE_FP_REAL=0 — script inert (nothing executes, no writes).\n`,
    );
    return { status: "off", written: false };
  }
  const gate = checkCorpus();
  if (argv.includes("--check-corpus")) {
    printGate(gate);
    return gate;
  }
  if (gate.status !== "ok") {
    printGate(gate);
    return gate;
  }
  const report = computeReport(gate.sessions);
  const bootstrapSeed = Number.parseInt(report.corpusDigest.slice(0, 8), 16);
  const perSessionClean = perSessionCleanFp(gate.sessions, report);
  const boot = bootstrapSessionMeans(
    perSessionClean,
    bootstrapSeed,
    bootstrapCount(),
  );
  report.bootstrap = { lo: boot.lo, hi: boot.hi, means: boot.means };
  const { file, existing } = writeRunJson(report);
  appendReportBlock(report);
  process.stdout.write(
    `COSINE_FP_REAL ok sessions=${report.sessionCount} pairs=${report.pairCount} ` +
      `overallCI=[${boot.lo ?? "—"}, ${boot.hi ?? "—"}] digest=${report.digest} ` +
      `${existing ? "(existing run, not overwritten)" : file}\n`,
  );
  return report;
}

function perSessionCleanFp(sessions, report) {
  const emb = new Map();
  const pairs = [];
  for (const s of sessions) {
    for (const sn of s.snippets || []) emb.set(`${s.sessionId}::${sn.id}`, trigramEmbed(sn.text));
    for (const gt of s.groundTruth || []) {
      if (gt.truth !== "clean") continue;
      const va = emb.get(`${s.sessionId}::${gt.a}`);
      const vb = emb.get(`${s.sessionId}::${gt.b}`);
      if (!va || !vb) continue;
      pairs.push({ sessionId: s.sessionId, cos: cosineSimilarity(va, vb) });
    }
  }
  const overall = report.recommendations.find((r) => r.contentType === "overall");
  const t = overall ? overall.threshold : report.overall[0]?.threshold ?? report.grid.lo;
  const bySession = new Map();
  for (const p of pairs) {
    const arr = bySession.get(p.sessionId) || [];
    arr.push(p);
    bySession.set(p.sessionId, arr);
  }
  return [...bySession.values()].map((sp) => {
    const n = sp.length;
    if (n === 0) return 0;
    const f = sp.filter((p) => classifyPair(p.cos, t) === "deduped").length;
    return f / n;
  });
}

function printGate(gate) {
  switch (gate.status) {
    case "no_corpus":
      if (gate.reason === "insufficient") {
        process.stdout.write(
          `real-corpus gate: no_corpus (insufficient) — ${gate.sessionCount}/${gate.floor} consented sessions\n`,
        );
      } else {
        process.stdout.write(
          `real-corpus gate: no_corpus — corpus dir/manifest absent (normative pre-donation state, nothing written)\n`,
        );
      }
      return;
    case "corpus_invalid":
      process.stdout.write(
        `real-corpus gate: corpus_invalid (${gate.reason}) — ${gate.detail} — STOP, nothing written\n`,
      );
      return;
    case "ok":
      process.stdout.write(
        `real-corpus gate: ok — ${gate.sessionCount} consented sessions\n`,
      );
      return;
    default:
      process.stdout.write(`real-corpus gate: ${gate.status}\n`);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
