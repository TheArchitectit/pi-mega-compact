#!/usr/bin/env node
/**
 * encoder/gate-qualify.mjs — ENC-0f real-asset qualification gate.
 *
 * Runs the ML5-B production bench (`scripts/ml5/bench-onnx-prod.mjs`) under
 * `--expose-gc` over the ENC-0d-promoted real trained ONNX (the
 * `assets/vector-cortex/encoder-v1/model.onnx` shipped asset, opset 21), feeds
 * the resulting BenchResultV1 to the pure `qualifyEncodedAsset` function
 * (compiled `dist/vector-cortex/encoder/qualify.js`), and emits a
 * `QualificationV1` record + a monitoring event.
 *
 * - verdict "qualified"   → write `encoder-qualification.json`, emit
 *   `vector_cortex_encoder_qualified`, exit 0.
 * - verdict "failed"      → write `encoder-qualification.json`, emit
 *   `vector_cortex_encoder_qualification_failed` (with `reasons`), exit 1.
 * - infrastructure error  → exit 2 (missing dist, missing --asset, bench spawn
 *   failure). A missing/absent asset is an HONEST demote: emit
 *   `vector_cortex_encoder_qualification_failed` reason `asset_missing`.
 *
 * `MEGACOMPACT_ENC_0F=0` (or `false`) → a single byte-parity log line and exit 0:
 * no bench runs, no QualificationV1 record is written, no events are emitted —
 * byte-identical to the ENC-0d predecessor.
 *
 * LOCAL ONLY: spawns a local bench over a local file path; reads/writes local
 * files only. Zero network (PREVENT-PI-004). Emits aggregate measurements +
 * verdict + digest only, never payload/message content (EVAL-REDACT-002).
 *
 * Usage:
 *   node scripts/encoder/gate-qualify.mjs [--asset <path>] [--tokens 512] [--threads 4]
 */

import {
  writeFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(scriptDir, "..", "..");

// Qualification record + events live under the encoder state dir (developer /
// evidence artifacts per ENC-0f) — MEGACOMPACT_STATE_DIR overrides for tests.
const STATE_DIR = process.env.MEGACOMPACT_STATE_DIR
  || join(homedir(), ".pi", "mega-compact-encoder");
const QUALIFICATION_PATH = join(STATE_DIR, "encoder-qualification.json");
const EVENTS_LOG = join(STATE_DIR, "events.log");

// The ENC-0d-promoted currently-shipped real ONNX (repo asset, opset 21).
const DEFAULT_ASSET = join(ROOT, "assets", "vector-cortex", "encoder-v1", "model.onnx");
const BENCH_SCRIPT = join(ROOT, "scripts", "ml5", "bench-onnx-prod.mjs");

// ENC-0f qualification profile (normative): 512 tokens on 4 threads.
const QUAL_TOKENS = 512;
const QUAL_THREADS = 4;

// ── Flag gates ──────────────────────────────────────────────────────────────

const enc0fOff = ["0", "false"].includes(process.env.MEGACOMPACT_ENC_0F || "");
// Byte-identical predecessor: no bench, no record, no events.
if (enc0fOff) {
  console.log("gate-qualify: MEGACOMPACT_ENC_0F disabled — no qualification gate runs, byte-identical predecessor");
  process.exit(0);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function arg(name, dflt) {
  const argv = process.argv;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === `--${name}`) return argv[i + 1] ?? dflt;
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  return dflt;
}

function digestPrefix(digest) {
  return typeof digest === "string" && digest.length > 0 ? digest.slice(0, 12) : null;
}

/** Append one structured event line to events.log (non-fatal, append-only). */
function appendEvent(fields) {
  const line = JSON.stringify({ ts: Date.now(), ...fields }) + "\n";
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(EVENTS_LOG, line, "utf8");
  } catch {
    /* never break the gate on a log failure */
  }
}

/**
 * Atomic file replace: write `content` to a temp sibling in the SAME directory
 * as `target`, fsync it to disk, then rename over `target`. rename is atomic on
 * POSIX (never an in-place partial). The temp is removed on any failure so no
 * partial state ever lands at `target` — same shape as promotion-gate.mjs.
 */
function atomicWrite(target, content) {
  const dir = dirname(target);
  const tmp = join(dir, `.${target.split("/").pop()}.tmp-${process.pid}-${Date.now().toString(36)}`);
  let fd = null;
  try {
    fd = openSync(tmp, "w");
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, target);
  } catch (err) {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

// ── Qualification record write ──────────────────────────────────────────────

function writeQualification(q) {
  mkdirSync(STATE_DIR, { recursive: true });
  atomicWrite(QUALIFICATION_PATH, JSON.stringify(q, null, 2) + "\n");
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const asset = arg("asset", DEFAULT_ASSET);
  const tokens = Number(arg("tokens", QUAL_TOKENS)) || QUAL_TOKENS;
  const threads = Number(arg("threads", QUAL_THREADS)) || QUAL_THREADS;

  // Qualification runs only when a real trained asset is present. Missing asset
  // → honest demote (no fabricated pass), emit failure then exit 1.
  if (!existsSync(asset)) {
    appendEvent({
      event: "vector_cortex_encoder_qualification_failed",
      reasons: ["asset_missing"],
      platform: `${process.platform}-${process.arch}`,
    });
    console.error(`gate-qualify: asset not found: ${asset}`);
    process.exit(1);
  }

  // Bench must run under --expose-gc for an honest post-GC marginal-RSS figure.
  const bench = spawnSync(
    process.execPath,
    ["--expose-gc", BENCH_SCRIPT, `--asset=${asset}`, `--tokens=${tokens}`, `--threads=${threads}`],
    { stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 },
  );

  if (bench.error) {
    appendEvent({
      event: "vector_cortex_encoder_qualification_failed",
      reasons: ["bench_spawn_failed"],
      detail: String(bench.error && bench.error.message || bench.error),
      platform: `${process.platform}-${process.arch}`,
    });
    console.error(`gate-qualify: bench spawn failed: ${bench.error.message}`);
    process.exit(2);
  }

  // Parse BenchResultV1 from the bench's stdout JSON.
  let benchResult;
  try {
    benchResult = JSON.parse(bench.stdout.toString("utf8"));
  } catch (err) {
    appendEvent({
      event: "vector_cortex_encoder_qualification_failed",
      reasons: ["bench_json_unparsable"],
      detail: String(err && err.message || err),
      platform: `${process.platform}-${process.arch}`,
    });
    console.error(`gate-qualify: could not parse bench stdout JSON: ${err.message}`);
    process.exit(2);
  }

  // Dynamic-import the compiled pure qualify fn. The gate runs post-build; if
  // dist is missing, exit 2 with an instructive message.
  let qualify;
  try {
    qualify = await import("../../dist/vector-cortex/encoder/qualify.js");
  } catch (err) {
    console.error(
      "gate-qualify: dist/vector-cortex/encoder/qualify.js is missing — run `npm run build` first.\n" +
        String(err && err.stack || err),
    );
    process.exit(2);
  }

  const q = qualify.qualifyEncodedAsset(benchResult, benchResult.platform ?? `${process.platform}-${process.arch}`);

  // Persist the QualificationV1 record + emit the matching event.
  writeQualification(q);

  if (q.verdict === "qualified") {
    appendEvent({
      event: "vector_cortex_encoder_qualified",
      p95Ms: q.p95Ms,
      rssMib: q.rssMib,
      opset: q.opset,
      platform: q.platform,
      digestPrefix: digestPrefix(q.digest),
    });
    console.log(`gate-qualify: QUALIFIED p95=${q.p95Ms}ms rss=${q.rssMib}MiB opset=${q.opset}`);
    process.exit(0);
  }

  appendEvent({
    event: "vector_cortex_encoder_qualification_failed",
    reasons: q.reasons,
    p95Ms: q.p95Ms,
    rssMib: q.rssMib,
    opset: q.opset,
    platform: q.platform,
    digestPrefix: digestPrefix(q.digest),
  });
  console.log(`gate-qualify: FAILED(${q.reasons.join(",")}) p95=${q.p95Ms}ms rss=${q.rssMib}MiB opset=${q.opset}`);
  process.exit(1);
}

main().catch((e) => {
  console.error("gate-qualify: " + ((e && e.message) || e));
  process.exit(2);
});
