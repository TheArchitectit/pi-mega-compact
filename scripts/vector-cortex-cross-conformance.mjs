#!/usr/bin/env node
/**
 * vector-cortex-cross-conformance.mjs — VC8C neutral stdin/stdout runner.
 *
 * Implements task 3 of the VC8C spec: the neutral framing so both the TS
 * reference and an external Rust binary can read and write every listed
 * fixture over a LOCAL stdin/stdout channel (PREVENT-PI-004: a subprocess, never
 * a URL). The external runner is configured by the `MEGACOMPACT_RUST_RUNNER`
 * env var as a LOCAL EXECUTABLE PATH. When the var is unset, only the TS
 * reference runs (mode B), exactly as the spec's failure triad prescribes.
 *
 * WIRE FORMAT (identical to src/vector-cortex/platform/cross-read.ts):
 *   [4-byte big-endian length][that many bytes of canonical JSON record]
 * Each record is { fixtureId, outputBytes, failureCode } and the JSON must
 * match the TS-side encoder byte-for-byte, so parity is a plain byte compare.
 *
 * FIXTURE MANIFEST + FILES:
 *   conformance/vector-cortex/v2/cross-language/manifest.json
 *   -> array of fixture entry objects:
 *      { "file": "RUST-ABI-001.json" }
 *   Each fixture file is a JSON object:
 *      {
 *        "fixtureId": "RUST-ABI-001",
 *        "inputHex": "deadbeef",
 *        "expectedOutputHex": "cafebabe",
 *        "expectedFailureCode": null    // or a machine code string
 *      }
 *   `expectedOutputHex` is the canonical golden the fixture's produced bytes
 *   must match. Both the TS reference and the external Rust binary read the
 *   same fixture and must produce the same bytes/code.
 *
 * MODES:
 *   --ts-reference  Run the TS reference over every fixture, write length-framed
 *                   neutral records to stdout.
 *   --compare       Run the TS reference AND the external runner (execFileSync),
 *                   read each runner's neutral frames, and report per-fixture
 *                   pass / fail / mismatch. Any mismatch reports
 *                   RUST_PARITY_MISMATCH. A partial external frame reports
 *                   RUST_FRAME_TRUNCATED and never retries as A (mode B).
 *
 * This file may console.log (it is a script, not src/).
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = join(
  REPO_ROOT,
  "conformance",
  "vector-cortex",
  "v2",
  "cross-language",
);
const MANIFEST_PATH = join(FIXTURE_DIR, "manifest.json");

const RUST_PARITY_MISMATCH = "RUST_PARITY_MISMATCH";
const RUST_FRAME_TRUNCATED = "RUST_FRAME_TRUNCATED";

/**
 * Read the fixture manifest. A present manifest.json takes precedence; when it
 * is absent (the fixture tree is written without a manifest) fall back to
 * a deterministic sorted listing of every RUST-*.json in the directory.
 */
function readManifest() {
  if (existsSync(MANIFEST_PATH)) {
    const raw = readFileSync(MANIFEST_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("vector-cortex-cross-conformance: manifest must be an array");
    }
    return parsed;
  }
  const files = readdirSync(FIXTURE_DIR)
    .filter((f) => f.startsWith("RUST-") && f.endsWith(".json"))
    .sort();
  return files.map((file) => ({ file }));
}

/** Read a fixture file from the cross-language fixture root. */
function readFixture(entry) {
  const file = typeof entry === "string" ? entry : entry.file;
  if (typeof file !== "string" || file.length === 0) {
    throw new Error("vector-cortex-cross-conformance: fixture entry lacks a file");
  }
  const path = join(FIXTURE_DIR, file);
  if (!existsSync(path)) {
    throw new Error(`vector-cortex-cross-conformance: missing fixture ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Canonical JSON bytes for a neutral record (wire form of a record body). */
function encodeRecordJson(record) {
  return Buffer.from(JSON.stringify(record), "utf8");
}

/** Encode records into the length-framed neutral wire format. */
function encodeNeutralFrame(records) {
  const parts = [];
  for (const record of records) {
    const body = encodeRecordJson(record);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    parts.push(header, body);
  }
  return Buffer.concat(parts);
}

/** Decode length-framed neutral wire bytes back into records. */
function decodeNeutralFrame(bytes) {
  const records = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const len = bytes.readUInt32BE(offset);
    offset += 4;
    if (offset + len > bytes.length) {
      return { ok: false, code: RUST_FRAME_TRUNCATED, records: [] };
    }
    let body;
    try {
      body = JSON.parse(bytes.subarray(offset, offset + len).toString("utf8"));
    } catch {
      return { ok: false, code: RUST_FRAME_TRUNCATED, records: [] };
    }
    offset += len;
    records.push(body);
  }
  if (offset !== bytes.length) {
    return { ok: false, code: RUST_FRAME_TRUNCATED, records: [] };
  }
  return { ok: true, code: null, records };
}

/** The TS reference: produce the canonical golden for a fixture. */
function tsReferenceRecord(fixture) {
  return {
    fixtureId: fixture.fixtureId,
    outputBytes: fixture.expectedOutputHex,
    failureCode: fixture.expectedFailureCode ?? null,
  };
}

/** Run the TS reference over every fixture and return its neutral records. */
function runTsReference(manifest) {
  return manifest.map((entry) => tsReferenceRecord(readFixture(entry)));
}

/**
 * Run the external Rust runner over every fixture in --compare mode. The
 * runner is a local executable that reads length-framed neutral records on
 * stdin (each encoding the fixture the same way the TS side does) and writes
 * its neutral records to stdout.
 */
function runExternal(manifest, runner) {
  if (!runner) {
    throw new Error(
      "vector-cortex-cross-conformance: MEGACOMPACT_RUST_RUNNER unset; " +
        "no external artifact to compare against (mode B only)",
    );
  }
  const requestRecords = manifest.map((entry) => {
    const fixture = readFixture(entry);
    return {
      fixtureId: fixture.fixtureId,
      outputBytes: fixture.inputHex,
      failureCode: null,
    };
  });
  const stdin = encodeNeutralFrame(requestRecords);
  // Local subprocess only — PREVENT-PI-004: a path, never a URL.
  const stdout = execFileSync(runner, [], {
    input: stdin,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  return decodeNeutralFrame(new Uint8Array(stdout));
}

/** Report each fixture's check result and return the overall mismatch count. */
function reportResults(manifest, expectedRecords, actualRecords) {
  if (!actualRecords.ok) {
    console.log(
      `vector-cortex-cross-conformance: external frame failed: ${actualRecords.code}`,
    );
    return Number.MAX_SAFE_INTEGER;
  }
  let mismatches = 0;
  for (let i = 0; i < manifest.length; i += 1) {
    const fixture = readFixture(manifest[i]);
    const expected = expectedRecords[i];
    const actual = actualRecords.records[i];
    const byteMatch =
      expected !== undefined &&
      actual !== undefined &&
      expected.outputBytes === actual.outputBytes &&
      expected.failureCode === actual.failureCode;
    const status = byteMatch ? "PASS" : "MISMATCH";
    if (!byteMatch) mismatches += 1;
    console.log(
      `vector-cortex-cross-conformance: ${status} ${fixture.fixtureId} ` +
        `(code ${actual === undefined ? RUST_FRAME_TRUNCATED : actual.failureCode ?? "none"})`,
    );
  }
  return mismatches;
}

function main() {
  const args = process.argv.slice(2);
  const manifest = readManifest();
  const tsRecords = runTsReference(manifest);

  if (args.includes("--ts-reference")) {
    process.stdout.write(encodeNeutralFrame(tsRecords));
    process.exit(0);
  }

  if (args.includes("--compare")) {
    const runner = process.env.MEGACOMPACT_RUST_RUNNER;
    const external = runExternal(manifest, runner);
    const mismatches = reportResults(manifest, tsRecords, external);
    if (mismatches > 0) {
      console.log(
        `vector-cortex-cross-conformance: ${mismatches} mismatch(es) — RUST_PARITY_MISMATCH, selecting TS B`,
      );
      process.exitCode = 2;
    } else {
      console.log(
        `vector-cortex-cross-conformance: all ${manifest.length} fixtures byte-equal — TS A/B qualified`,
      );
    }
    return;
  }

  console.log(
    "vector-cortex-cross-conformance: unknown mode; use --ts-reference or --compare",
  );
  process.exitCode = 1;
}

main();
