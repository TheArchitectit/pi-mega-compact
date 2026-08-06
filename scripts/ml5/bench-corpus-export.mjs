#!/usr/bin/env node
/**
 * ml5/bench-corpus-export.mjs — export real redacted-tagged context_chunks from
 * the local node:sqlite store into a JSONL corpus for the ML5-B bench harness.
 *
 * The bench (bench-onnx-prod.mjs) measures p95/RSS/opset/determinism against
 * PRODUCTION-shaped data, not synthetic vectors. This exporter pulls the
 * extension's own session chunks — redacted-tagged (dedup-processed, summarized)
 * rows only — from the SAME synchronous SQLite store the extension uses
 * (read-only), and writes them as one JSON object per line.
 *
 * Privacy (EVAL-REDACT-002): only rows that carry a non-empty `summary` (the
 * redacted-safe summarized representation produced by the dedup pipeline) and a
 * `content_hash` (a row that passed the dedup/safety gate) are eligible. Raw
 * message content is never exported; the exporter emits the redacted summary
 * plus aggregate fields (digests, token estimates) only.
 *
 * LOCAL ONLY: reads `<state-dir>/sqlite.db` on the local filesystem. Zero
 * network. No writes to the store (read-only SELECT). PREVENT-PI-004.
 *
 * State dir resolution mirrors the extension exactly:
 *   1. MEGACOMPACT_STATE_DIR env override (highest precedence), else
 *   2. per-repo dir <git-root>/.pi/mega-compact (repoStateDir), else
 *   3. the global default ~/.pi/agent/extensions/pi-mega-compact.
 *
 * Usage:
 *   node scripts/ml5/bench-corpus-export.mjs \
 *     [--state-dir=<dir>] [--out=<corpus.jsonl>] [--tokens=<target>]
 *
 * Exits 0 on success. Emits a JSON summary line with the corpus path, row count
 * and token count so the bench + evidence can consume it.
 */

import { openSync, closeSync, writeSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { homedir } from "node:os";

const DEFAULT_TARGET_TOKENS = 1_000_000;
const GLOBAL_STATE_DEFAULT = join(homedir(), ".pi", "agent", "extensions", "pi-mega-compact");

function arg(name, dflt) {
  const idx = process.argv.findIndex((a) => a.startsWith(`--${name}=`));
  return idx === -1 ? dflt : process.argv[idx].slice(name.length + 3);
}

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** git root of a cwd, mirroring extensions/mega-config.ts resolveRepoRoot. */
function resolveRepoRoot(cwd) {
  try {
    const out = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function resolveStateDir() {
  // 1. explicit env override (highest precedence) — also honors --state-dir.
  const override = process.env.MEGACOMPACT_STATE_DIR ?? arg("state-dir", null);
  if (override) return override;
  // 2. per-repo dir (<git-root>/.pi/mega-compact) — repoStateDir(cwd, fallback).
  const root = resolveRepoRoot(process.cwd());
  if (root) {
    const perRepo = join(root, ".pi", "mega-compact");
    if (existsSync(join(perRepo, "sqlite.db"))) return perRepo;
  }
  // (per-repo fallback with no store fails through to the global default)
  // 3. global default.
  return GLOBAL_STATE_DEFAULT;
}

async function main() {
  const stateDir = resolveStateDir();
  const dbPath = join(stateDir, "sqlite.db");
  if (!existsSync(dbPath)) {
    console.error(
      JSON.stringify({
        ts: Date.now(),
        event: "vector_cortex_bench_corpus_export_failed",
        stateDir,
        error: `no store at ${dbPath}; run the extension once to populate context_chunks`,
      }),
    );
    process.exit(2);
  }

  const targetTokens = Math.max(1, Number(arg("tokens", DEFAULT_TARGET_TOKENS)) || DEFAULT_TARGET_TOKENS);
  // Runtime corpus artifact lives beside the store, never in the git tree.
  const outPath = arg("out", join(stateDir, "bench-corpus.jsonl"));

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // Redacted-tagged rows only: non-empty summary (redacted-safe summarized
    // representation) AND a content_hash (the row passed the dedup/safety gate).
    // Read-only; exercises the same context_chunks path the real backfill scans.
    const rows = db
      .prepare(
        `SELECT id, session_id, content_hash, summary, token_estimate
         FROM context_chunks
         WHERE summary IS NOT NULL AND length(summary) > 0
           AND content_hash IS NOT NULL
         ORDER BY session_id ASC, id ASC`,
      )
      .all();

    let corpusTokens = 0;
    let emitted = 0;
    const digest = createHash("sha256");

    const fd = openSync(outPath, "w");
    try {
      for (const row of rows) {
        const estimate = row.token_estimate ?? Math.ceil((row.summary || "").length / 4);
        if (corpusTokens + estimate > targetTokens && emitted > 0) break;
        corpusTokens += estimate;
        const rec = {
          id: row.id,
          session_id: row.session_id,
          content_hash: row.content_hash,
          redacted: true,
          tokens: estimate,
          summary: row.summary, // redacted-safe summarized representation
        };
        const buf = Buffer.from(JSON.stringify(rec) + "\n", "utf8");
        digest.update(buf);
        writeSync(fd, buf);
        emitted++;
      }
    } finally {
      closeSync(fd);
    }

    const corpusSha256 = digest.digest("hex");
    const report = {
      ts: Date.now(),
      event: "vector_cortex_bench_corpus_export",
      stateDir,
      out: outPath,
      rows: emitted,
      tokens: emitted > 0 ? corpusTokens : 0,
      corpusSha256,
    };
    console.log(JSON.stringify(report));
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error(
    JSON.stringify({ ts: Date.now(), event: "vector_cortex_bench_corpus_export_failed", error: String((e && e.message) || e) }),
  );
  process.exit(1);
});
