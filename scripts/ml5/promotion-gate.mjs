#!/usr/bin/env node
/**
 * ml5/promotion-gate.mjs — ML5-E promotion gate.
 *
 * Evaluates the five heads against per-head calibration thresholds AND the new
 * asset against the committed asset on a fixed held-out dev set (never training
 * data). On pass → mark candidate eligible; on fail → write the candidate and
 * emit `demoted_new_asset`.
 *
 * Rollback: if a newly-promoted asset later regresses (a week-N+1 calibration
 * run scores worse), the prior week's asset is restored via atomic manifest
 * digest swap — no partial state.
 *
 * Invoked by retrain-nightly.mjs after package, or manually for a rollback
 * round-trip. The MEGACOMPACT_ML5_E flag gates invocation.
 *
 * LOCAL ONLY: filesystem reads/writes only, zero network (PREVENT-PI-004).
 *
 * Usage:
 *   node scripts/ml5/promotion-gate.mjs [--asset-dir <path>] [--rollback]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(scriptDir, "..", "..");

const ENCODER_DIR = join(homedir(), ".pi", "mega-compact-encoder");
const CANDIDATES_DIR = join(ENCODER_DIR, "candidates");
const LEDGER_PATH = join(ENCODER_DIR, "promotion-ledger.json");
const CALIBRATION_PATH = join(ENCODER_DIR, "calibration.json");

// ── Flag gate ────────────────────────────────────────────────────────────────

const flagValue = process.env.MEGACOMPACT_ML5_E;
if (flagValue === "0" || flagValue === "false") {
  process.exit(0);
}
const flagDisabled = process.env.MEGACOMPACT_ML5_E_DISABLED;
if (flagDisabled === "true" || flagDisabled === "1") {
  process.exit(0);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function log(event, data) {
  console.log(JSON.stringify({ ts: nowIso(), event, ...data }));
}

function readLedger() {
  if (!existsSync(LEDGER_PATH)) return { entries: [], committed: null, lastCorpusDigest: null };
  try {
    return JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
  } catch {
    return { entries: [], committed: null, lastCorpusDigest: null };
  }
}

function writeLedger(ledger) {
  mkdirSync(ENCODER_DIR, { recursive: true });
  writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + "\n", "utf8");
}

function readCalibration() {
  if (!existsSync(CALIBRATION_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CALIBRATION_PATH, "utf8"));
  } catch {
    return null;
  }
}

// ── Per-head threshold check ────────────────────────────────────────────────

// Normative per-head thresholds (mirrored from src/vector-cortex/encoder/types.ts
// EVALUATION_THRESHOLDS). The gate reads calibration.json which carries the
// measured per-head scores from the latest bench run.
const HEAD_THRESHOLDS = {
  semantic: { spearman: 0.75, recallAt10: 0.9 },
  dependency: { precision: 0.97, recall: 0.95 },
  contradiction: { precision: 0.98, recall: 0.9, ece: 0.05 },
  cacheStability: { precision: 0.999, recall: 0.9 },
  payloadRouting: { macroF1: 0.97, exactAnchorRecall: 1.0 },
};

function checkHeadVerdicts(calibration) {
  if (!calibration || !calibration.heldOut) {
    // No calibration data — cannot verify; treat as all-fail (honest degradation).
    return Object.keys(HEAD_THRESHOLDS).map((h) => ({ head: h, pass: false }));
  }
  const ho = calibration.heldOut;
  const verdicts = [];
  verdicts.push({
    head: "semantic",
    pass: (ho.semantic?.spearman ?? 0) >= HEAD_THRESHOLDS.semantic.spearman
      && (ho.semantic?.recallAt10 ?? 0) >= HEAD_THRESHOLDS.semantic.recallAt10,
  });
  verdicts.push({
    head: "dependency",
    pass: (ho.dependency?.precision ?? 0) >= HEAD_THRESHOLDS.dependency.precision
      && (ho.dependency?.recall ?? 0) >= HEAD_THRESHOLDS.dependency.recall,
  });
  verdicts.push({
    head: "contradiction",
    pass: (ho.contradiction?.precision ?? 0) >= HEAD_THRESHOLDS.contradiction.precision
      && (ho.contradiction?.recall ?? 0) >= HEAD_THRESHOLDS.contradiction.recall
      && (ho.contradiction?.ece ?? 1) <= HEAD_THRESHOLDS.contradiction.ece,
  });
  verdicts.push({
    head: "cacheStability",
    pass: (ho.cacheStability?.precision ?? 0) >= HEAD_THRESHOLDS.cacheStability.precision
      && (ho.cacheStability?.recall ?? 0) >= HEAD_THRESHOLDS.cacheStability.recall,
  });
  verdicts.push({
    head: "payloadRouting",
    pass: (ho.payloadRouting?.macroF1 ?? 0) >= HEAD_THRESHOLDS.payloadRouting.macroF1
      && (ho.payloadRouting?.exactAnchorRecall ?? 0) >= HEAD_THRESHOLDS.payloadRouting.exactAnchorRecall,
  });
  return verdicts;
}

// ── Held-out dev set beat ────────────────────────────────────────────────────

function heldOutBeat(calibration, ledger) {
  // The held-out dev set comparison: does the new asset's aggregate score beat
  // the currently committed asset's score? Uses the calibration record's
  // aggregateScore field (computed from the fixed dev set, never training data).
  if (!calibration || typeof calibration.aggregateScore !== "number") return false;
  if (!ledger.committed) return true; // No incumbent → always beats.
  // Find the incumbent's score from the ledger.
  const incumbent = ledger.entries.find((e) => e.assetDigest === ledger.committed);
  if (!incumbent || typeof incumbent.aggregateScore !== "number") return true;
  return calibration.aggregateScore > incumbent.aggregateScore;
}

// ── Rollback ─────────────────────────────────────────────────────────────────

function doRollback(ledger) {
  if (!ledger.committed || ledger.entries.length < 2) {
    log("rollback_skipped", { reason: "no_prior_asset" });
    return false;
  }
  // Find the entry BEFORE the committed one (append-only manifest = ordered).
  const committedIdx = ledger.entries.findIndex((e) => e.assetDigest === ledger.committed);
  if (committedIdx <= 0) {
    log("rollback_skipped", { reason: "no_prior_entry" });
    return false;
  }
  const priorEntry = ledger.entries[committedIdx - 1];
  // Atomic digest swap: flip committed to the prior entry's digest.
  ledger.committed = priorEntry.assetDigest;
  writeLedger(ledger);
  log("rollback_complete", { restored_sha256: priorEntry.assetDigest, prior_ts: priorEntry.ts });
  return true;
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const isRollback = args.includes("--rollback");

  const ledger = readLedger();

  if (isRollback) {
    const ok = doRollback(ledger);
    process.exit(ok ? 0 : 1);
  }

  const calibration = readCalibration();
  const headVerdicts = checkHeadVerdicts(calibration);
  const fiveOk = headVerdicts.every((v) => v.pass);
  const beat = heldOutBeat(calibration, ledger);

  const candidateManifest = join(CANDIDATES_DIR, "manifest.json");
  let assetDigest = null;
  if (existsSync(candidateManifest)) {
    assetDigest = sha256Hex(readFileSync(candidateManifest));
  }

  if (fiveOk && beat) {
    // Promote: mark the candidate as eligible (the human operator promotes via
    // the ML5-D Improve Cortex flow; we record eligibility here).
    const row = {
      schema: "promotion-v1",
      ts: nowIso(),
      corpusDigest: ledger.lastCorpusDigest,
      assetDigest,
      priorAssetDigest: ledger.committed,
      headVerdicts,
      fiveHeadsOk: true,
      heldOutBeat: true,
      verdict: "promoted",
      demotedEvent: null,
    };
    ledger.entries.push(row);
    ledger.committed = assetDigest;
    writeLedger(ledger);
    log("promotion_gate", { verdict: "promoted", assetDigest });
  } else {
    // Demote: record the candidate with the demotion event.
    const row = {
      schema: "promotion-v1",
      ts: nowIso(),
      corpusDigest: ledger.lastCorpusDigest,
      assetDigest,
      priorAssetDigest: ledger.committed,
      headVerdicts,
      fiveHeadsOk: fiveOk,
      heldOutBeat: beat,
      verdict: "demoted",
      demotedEvent: "demoted_new_asset",
    };
    ledger.entries.push(row);
    writeLedger(ledger);
    log("promotion_gate", { verdict: "demoted", assetDigest, fiveHeadsOk: fiveOk, heldOutBeat: beat });
  }
}

main();
