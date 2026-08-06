#!/usr/bin/env node
/**
 * ml5/retrain-nightly.mjs — ML5-E nightly retraining orchestrator.
 *
 * Invoked by the system cron (see crontab.example), never auto-spawned by the
 * extension runtime. The MEGACOMPACT_ML5_E flag gates invocation — the script
 * checks it and exits 0 when disabled.
 *
 * Pipeline:
 *   1. Corpus refresh: re-export the corpus snapshot (new redacted-tagged
 *      sessions since the last run).
 *   2. Corpus-digest check: compare against the last-run ledger. If no new
 *      rows → exit 0 (no re-training, no event noise).
 *   3. Training: call the ML5-A train step.
 *   4. Bench: call the ML5-B bench step.
 *   5. Package: call the ML5-C package step.
 *   6. Record: append a PromotionV1 ledger row to the append-only manifest.
 *
 * Candidates are written to ~/.pi/mega-compact-encoder/candidates/. The cron
 * NEVER commits or pushes; the human operator reviews the dashboard and
 * promotes via the ML5-D "Improve Cortex" flow.
 *
 * LOCAL ONLY: filesystem reads/writes only, zero network (PREVENT-PI-004).
 *
 * Usage:
 *   session: scheduled via crontab -e — see crontab.example
 *   manual:  node scripts/ml5/retrain-nightly.mjs [--state-dir <path>]
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(scriptDir, "..", "..");

// ── Configuration ────────────────────────────────────────────────────────────

const STATE_DIR = process.env.MEGACOMPACT_STATE_DIR
  || join(homedir(), ".pi", "agent", "extensions", "pi-mega-compact");
const ENCODER_DIR = join(homedir(), ".pi", "mega-compact-encoder");
const CANDIDATES_DIR = join(ENCODER_DIR, "candidates");
const LEDGER_PATH = join(ENCODER_DIR, "promotion-ledger.json");

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

function log(event, data) {
  const line = JSON.stringify({ ts: nowIso(), event, ...data });
  console.log(line);
}

// ── Step 1: Corpus refresh ──────────────────────────────────────────────────

function exportCorpusSnapshot() {
  // Reads the corpus from the state dir's redacted-tagged sessions and produces
  // a deterministic digest. This is the local corpus export — no network.
  const corpusPath = join(STATE_DIR, "corpus-snapshot.json");
  if (!existsSync(corpusPath)) {
    return { digest: null, rows: 0 };
  }
  try {
    const raw = readFileSync(corpusPath, "utf8");
    const corpus = JSON.parse(raw);
    const rows = Array.isArray(corpus.sessions) ? corpus.sessions.length : 0;
    const digest = sha256Hex(Buffer.from(raw, "utf8"));
    return { digest, rows };
  } catch {
    return { digest: null, rows: 0 };
  }
}

// ── Step 2: Corpus-digest check (no-op exit 0 on unchanged) ─────────────────

function corpusDigestUnchanged(ledger, currentDigest) {
  if (!currentDigest) return true;
  return ledger.lastCorpusDigest === currentDigest;
}

// ── Step 3–5: Train, bench, package ─────────────────────────────────────────

function runStep(label, cmd, args) {
  log("retrain_step_start", { step: label });
  try {
    execFileSync(cmd, args, { cwd: ROOT, stdio: "pipe", timeout: 600_000 });
    log("retrain_step_done", { step: label, exit: 0 });
    return true;
  } catch (err) {
    const code = err?.status ?? 1;
    log("retrain_step_fail", { step: label, exit: code });
    return false;
  }
}

function trainHeads() {
  return runStep("train", "python3", [
    join(ROOT, "training", "vector-cortex", "train.py"),
    "--state-dir", STATE_DIR,
    "--output-dir", CANDIDATES_DIR,
  ]);
}

function benchHeads() {
  return runStep("bench", "node", [
    join(ROOT, "scripts", "vc2-model-prep", "bench-onnx.mjs"),
    "--asset-dir", CANDIDATES_DIR,
  ]);
}

function packageAsset() {
  return runStep("package", "node", [
    join(ROOT, "scripts", "ml5", "package-assets.mjs"),
    "--asset-dir", CANDIDATES_DIR,
  ]);
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  mkdirSync(CANDIDATES_DIR, { recursive: true });
  mkdirSync(ENCODER_DIR, { recursive: true });

  const ledger = readLedger();
  const corpus = exportCorpusSnapshot();

  if (corpusDigestUnchanged(ledger, corpus.digest)) {
    log("retrain_noop", { reason: "corpus_digest_unchanged", corpusDigest: corpus.digest });
    process.exit(0);
  }

  log("retrain_start", { corpusDigest: corpus.digest, corpusRows: corpus.rows });

  if (!trainHeads()) {
    log("retrain_failed", { step: "train" });
    process.exit(1);
  }
  if (!benchHeads()) {
    log("retrain_failed", { step: "bench" });
    process.exit(1);
  }
  if (!packageAsset()) {
    log("retrain_failed", { step: "package" });
    process.exit(1);
  }

  // Run the promotion gate (evaluates five-head thresholds + held-out beat;
  // appends its own promoted/demoted row to the ledger).
  if (!runStep("gate", "node", [join(ROOT, "scripts", "ml5", "promotion-gate.mjs")])) {
    log("retrain_failed", { step: "gate" });
    process.exit(1);
  }

  // Read the gate's ledger row (the gate wrote it). The orchestrator only logs
  // the outcome — the gate is the single writer of PromotionV1 rows.
  const updated = readLedger();
  const gateRow = updated.entries[updated.entries.length - 1];
  log("retrain_complete", {
    verdict: gateRow?.verdict ?? "unknown",
    assetDigest: gateRow?.assetDigest ?? null,
    ledgerEntries: updated.entries.length,
  });
}

main();
