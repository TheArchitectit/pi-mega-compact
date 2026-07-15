import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  compressSmart,
  decompressSmart,
  readGzJson,
  writeGzJson,
  normalizeSessionId,
  nextCheckpointId,
} from "./store.js";

const baseTmp = mkdtempSync(join(tmpdir(), "mc-store-"));
let counter = 0;
function tmpDir() {
  return join(baseTmp, `d-${counter++}`);
}

// ---------------------------------------------------------------------------
// compressSmart / decompressSmart
// ---------------------------------------------------------------------------

test("compressSmart: tiny payload (<512B) uses RAW tier", () => {
  const data = Buffer.from(JSON.stringify({ hello: "world" }));
  assert.ok(data.length < 512);
  const compressed = compressSmart(data);
  // Versioned header: 0xEC 0x01 [version=1] [tier=0x00 RAW]; payload after byte 4.
  assert.equal(compressed[0], 0xec, "magic hi");
  assert.equal(compressed[1], 0x01, "magic lo / version marker");
  assert.equal(compressed[2], 0x01, "format version 1");
  assert.equal(compressed[3], 0x00, "tag RAW");
  // Payload after the 4-byte header should be identical to original
  assert.deepEqual(compressed.subarray(4), data);
});

test("compressSmart: medium payload (4KB–32KB) uses GZIP-6 tier", () => {
  // ~8KB of repetitive text
  const data = Buffer.from("the quick brown fox jumps over the lazy dog. ".repeat(180));
  assert.ok(data.length >= 4096 && data.length < 32768);
  const compressed = compressSmart(data);
  // Versioned header + tier tag 0x02 (GZIP-6) at byte 3.
  assert.equal(compressed[0], 0xec);
  assert.equal(compressed[3], 0x02, "tag GZIP-6");
  // Compressed should be smaller
  assert.ok(compressed.length < data.length, "compressed smaller than raw");
});

test("compressSmart: large payload (>32KB) uses BROTLI tier", () => {
  // ~40KB of repetitive text
  const data = Buffer.from("this is a long summary of a coding session. ".repeat(900));
  assert.ok(data.length >= 32768);
  const compressed = compressSmart(data);
  // Versioned header + tier tag 0x05 (BROTLI_4) at byte 3.
  assert.equal(compressed[0], 0xec);
  assert.equal(compressed[3], 0x05, "tag BROTLI_4");
  // Compressed should be smaller
  assert.ok(compressed.length < data.length, "brotli compressed smaller than raw");
});

test("compressSmart: small payload (512B–4KB) uses GZIP-1 tier", () => {
  // ~1.5KB
  const data = Buffer.from("a moderately sized summary with some repetition. ".repeat(30));
  assert.ok(data.length >= 512 && data.length < 4096);
  const compressed = compressSmart(data);
  assert.equal(compressed[0], 0xec);
  assert.equal(compressed[3], 0x01, "tag GZIP-1");
});

test("decompressSmart roundtrips all tiers", () => {
  const sizes = [
    { label: "tiny",   gen: () => Buffer.from("small") },
    { label: "small",  gen: () => Buffer.from("x".repeat(600)) },
    { label: "medium", gen: () => Buffer.from("y".repeat(8000)) },
    { label: "large",  gen: () => Buffer.from("z".repeat(40000)) },
  ];
  for (const { label, gen } of sizes) {
    const original = gen();
    const compressed = compressSmart(original);
    const decompressed = decompressSmart(compressed);
    assert.deepEqual(decompressed, original, `roundtrip failed for ${label} (${original.length}B)`);
  }
});

test("decompressSmart handles legacy untagged gzip files (backward compat)", () => {
  const data = Buffer.from(JSON.stringify({ legacy: true }));
  const legacyGzip = gzipSync(data); // no tag byte, starts with 0x1f
  assert.equal(legacyGzip[0], 0x1f, "gzip magic byte present");
  const result = decompressSmart(legacyGzip);
  assert.deepEqual(JSON.parse(result.toString()), { legacy: true });
});

test("readGzJson / writeGzJson roundtrip with smart compression", () => {
  const dir = tmpDir();
  const path = join(dir, "test.json.gz");
  const data = [{ id: "a", value: 42 }, { id: "b", value: 99 }];
  writeGzJson(path, data);
  const loaded = readGzJson<typeof data>(path, []);
  assert.deepEqual(loaded, data);
});

test("readGzJson reads legacy gzip files written by old code", () => {
  const dir = tmpDir();
  const path = join(dir, "legacy.json.gz");
  const data = { old: true };
  // Simulate old writeGzJson (plain gzip, no tag)
  mkdirSync(join(path, ".."), { recursive: true });
  const buf = gzipSync(Buffer.from(JSON.stringify(data), "utf-8"));
  writeFileSync(path, buf);

  const loaded = readGzJson<typeof data>(path, { old: false });
  assert.deepEqual(loaded, { old: true });
});

test("compression tier: GZIP-1 and GZIP-6 tiers produce valid, smaller output", () => {
  // GZIP-1 tier (~600B input, 512B–4KB band)
  const small = compressSmart(Buffer.from("compress me ".repeat(200)));
  assert.equal(small[0], 0xec, "versioned magic");
  assert.equal(small[3], 0x01, "GZIP-1 tag for small input");
  assert.ok(small.length < 600, "GZIP-1 output smaller than input");
  assert.deepEqual(decompressSmart(small), Buffer.from("compress me ".repeat(200)));

  // GZIP-6 tier (~8KB input, 4KB–32KB band)
  const big = compressSmart(Buffer.from("compress me ".repeat(1800)));
  assert.equal(big[0], 0xec, "versioned magic");
  assert.equal(big[3], 0x02, "GZIP-6 tag for medium input");
  assert.ok(big.length < Buffer.from("compress me ".repeat(1800)).length, "GZIP-6 output smaller than input");
  assert.deepEqual(decompressSmart(big), Buffer.from("compress me ".repeat(1800)));
});

test("Fix E: pressure escalates gzip tier strength (sync, no zstd)", () => {
  const small = Buffer.from("compress me ".repeat(200)); // 512B–4KB band
  const medium = Buffer.from("compress me ".repeat(1800)); // 4KB–32KB band

  // Low pressure → cheap levels (gzip-1 / gzip-6).
  const lowSmall = compressSmart(small, 0);
  const lowMedium = compressSmart(medium, 0);
  assert.equal(lowSmall[3], 0x01, "small tier tag");
  assert.equal(lowMedium[3], 0x02, "medium tier tag");
  assert.ok(decompressSmart(lowSmall).equals(small), "low-pressure small roundtrips");
  assert.ok(decompressSmart(lowMedium).equals(medium), "low-pressure medium roundtrips");

  // High pressure → stronger levels (gzip-9 / gzip-9); tag unchanged, output
  // must still decode to the exact original (versioned header preserved).
  const highSmall = compressSmart(small, 1);
  const highMedium = compressSmart(medium, 1);
  assert.equal(highSmall[3], 0x01, "tag unchanged under pressure");
  assert.equal(highMedium[3], 0x02, "tag unchanged under pressure");
  assert.ok(decompressSmart(highSmall).equals(small), "high-pressure small roundtrips");
  assert.ok(decompressSmart(highMedium).equals(medium), "high-pressure medium roundtrips");
});

// ---------------------------------------------------------------------------
// normalizeSessionId
// ---------------------------------------------------------------------------

test("normalizeSessionId adds sess_ prefix when missing", () => {
  assert.equal(normalizeSessionId("abc"), "sess_abc");
  assert.equal(normalizeSessionId("sess_abc"), "sess_abc");
});

// ---------------------------------------------------------------------------
// nextCheckpointId
// ---------------------------------------------------------------------------

test("nextCheckpointId returns chkpt_001 for new session", () => {
  const dir = tmpDir();
  assert.equal(nextCheckpointId("sess_nci1", dir), "chkpt_001");
});

test("nextCheckpointId increments highest existing id", () => {
  const dir = tmpDir();
  const sid = "sess_nci2";
  // Write a checkpoints file with two entries to simulate existing state
  const fakeCheckpoints = [
    { checkpointId: "chkpt_001", sessionId: "sess_nci2", summary: "a", keyDecisions: [], nextSteps: [], filesModified: [], tokenEstimate: 100, regionHash: "h1", embedding: [], timestamp: 1 },
    { checkpointId: "chkpt_003", sessionId: "sess_nci2", summary: "b", keyDecisions: [], nextSteps: [], filesModified: [], tokenEstimate: 100, regionHash: "h2", embedding: [], timestamp: 2 },
  ];
  writeGzJson(join(dir, "sess_nci2.checkpoints.json.gz"), fakeCheckpoints);
  assert.equal(nextCheckpointId(sid, dir), "chkpt_004");
});

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------

test("cleanup", () => {
  rmSync(baseTmp, { recursive: true, force: true });
});
