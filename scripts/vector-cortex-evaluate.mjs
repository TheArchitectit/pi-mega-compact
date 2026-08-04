#!/usr/bin/env node
/**
 * vector-cortex-evaluate.mjs — stream canonical evaluation JSONL (VC0A).
 *
 * Reads MetricEventV1 JSONL from a file (or stdin), validates each record, and
 * writes the canonical `(session, seq, event)`-ordered JSONL to stdout (or a
 * --out file). Produces a JSON summary line on stderr.
 *
 * Validation (per VC0A spec):
 *   - unknown units            -> EVAL_UNIT_UNKNOWN (record rejected)
 *   - non-monotonic seq        -> EVAL_ORDER_INVALID (record rejected)
 *   - final record truncated   -> EVAL_JSONL_TRUNCATED (only that record)
 *
 * LOCAL ONLY: reads/writes the filesystem or stdin/stdout; zero network
 * (PREVENT-PI-004).
 *
 * Usage:
 *   node scripts/vector-cortex-evaluate.mjs --in evals.jsonl [--out canon.jsonl]
 *   cat evals.jsonl | node scripts/vector-cortex-evaluate.mjs
 */

import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

const KNOWN_UNITS = new Set(["ms", "bytes", "count", "ratio"]);

function usage() {
  console.error(
    "Usage: node scripts/vector-cortex-evaluate.mjs --in <file> [--out <file>]",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = { in: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in") args.in = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "-h" || a === "--help") usage();
    else {
      console.error(`Unknown argument: ${a}`);
      usage();
    }
  }
  return args;
}

/**
 * Parse one JSONL line into a metric record. Returns a MarkerTag object or an
 * error record. Unknown units / non-monotonic seq are tagged with their code.
 */
function parseRecord(line, lastSeqBySession) {
  if (line === "" || line === "\n") return { skip: true };
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return { reject: { code: "EVAL_JSONL_TRUNCATED" } };
  }
  const session = typeof rec?.session === "string" ? rec.session : null;
  const seq = typeof rec?.seq === "number" ? rec.seq : null;
  const event = typeof rec?.event === "string" ? rec.event : null;
  const value = typeof rec?.value === "number" ? rec.value : null;
  const unit = typeof rec?.unit === "string" ? rec.unit : null;
  const mode = rec?.mode;

  if (session === null || seq === null || event === null || value === null || unit === null) {
    return { reject: { code: "EVAL_JSONL_TRUNCATED" } };
  }
  if (!KNOWN_UNITS.has(unit)) {
    return { reject: { code: "EVAL_UNIT_UNKNOWN", unit } };
  }
  const last = lastSeqBySession.get(session);
  if (last !== undefined && seq < last) {
    return { reject: { code: "EVAL_ORDER_INVALID", seq, session } };
  }
  if (last === undefined || seq > last) lastSeqBySession.set(session, seq);
  const m = mode === "A" || mode === "B" || mode === "C" ? mode : "A";
  return { record: { session, seq, event, value, unit, mode: m } };
}

function canonicalOrder(rows) {
  const out = [...rows];
  out.sort((a, b) => {
    if (a.session !== b.session) return a.session < b.session ? -1 : 1;
    if (a.seq !== b.seq) return a.seq - b.seq;
    if (a.event !== b.event) return a.event < b.event ? -1 : 1;
    return 0;
  });
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.in ? createReadStream(args.in, "utf8") : stdin;
  const outStream = args.out ? createWriteStream(args.out, "utf8") : stdout;

  const lastSeqBySession = new Map();
  const rejects = [];
  const rows = [];
  let lineNo = 0;

  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    lineNo++;
    const r = parseRecord(line, lastSeqBySession);
    if (r.skip) continue;
    if (r.reject) {
      rejects.push({ ...r.reject, line: lineNo });
      continue;
    }
    rows.push(r.record);
  }
  const ordered = canonicalOrder(rows);
  for (const rec of ordered) outStream.write(`${JSON.stringify(rec)}\n`);
  if (args.out) outStream.end();

  // Summary goes to stderr so stdout stays pure JSONL.
  console.error(
    JSON.stringify({
      event: "vector_cortex_eval_streamed",
      records: ordered.length,
      rejects,
    }),
  );
}

main().catch((e) => {
  console.error("vector-cortex-evaluate error:", e.message);
  process.exit(1);
});
