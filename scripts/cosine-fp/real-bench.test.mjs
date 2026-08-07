// guardrails-allow PREVENT-PI-004: local-only structural tests of the real-bench gates — temp-dir fs + in-memory, no network.
/**
 * scripts/cosine-fp/real-bench.test.mjs — write-time validation tests for the
 * real-corpus FP harness (COS-FP-R).
 *
 * These build tiny SYNTHETIC manifest fixtures in temp dirs to exercise the
 * script's gates and statistics structurally. They are NOT the donated real
 * corpus — they exist only to prove the corpus gate, consent filter, Wilson
 * interval, session-grouped bootstrap, and digest determinism behave per spec,
 * and they must pass TODAY (before any corpus is donated).
 *
 * Run: node --test scripts/cosine-fp/real-bench.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkCorpus,
  filterConsented,
  wilsonInterval,
  drawSessionIndices,
  bootstrapSessionMeans,
  computeReport,
  main,
} from "./real-bench.mjs";

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeSession(id, extra = {}) {
  return {
    sessionId: id,
    sourceDigest: `digest-${id}`,
    provenance: `donated by owner ${id}`,
    license: "MIT",
    consent: { recordId: `consent-${id}`, revoked: false },
    repositoryGroup: "grp",
    language: "ts",
    contentTypeFraction: { code: 0.5, prose: 0.25, mixed: 0.25 },
    split: "train",
    snippets: [
      { id: "s0", contentType: "code", text: `function f${id}(x) { return x * ${id}; }\n// gate ${id} slice` },
      { id: "s1", contentType: "code", text: `function g${id}(y) { return y + ${id}; }\n// trim ${id} lane` },
      { id: "s2", contentType: "code", text: `function f${id}(x) { return x * ${id}; }\n// gate ${id} slice` },
    ],
    groundTruth: [
      { a: "s0", b: "s1", truth: "clean", contentType: "code" },
      { a: "s0", b: "s2", truth: "duplicate", contentType: "code" },
    ],
    ...extra,
  };
}

function writeManifest(dir, sessions) {
  writeFileSync(
    join(dir, "corpus-manifest.json"),
    JSON.stringify({ schemaVersion: 1, sessions }),
    "utf8",
  );
}

// ── (a) corpus gate ──────────────────────────────────────────────────────────

test("checkCorpus returns no_corpus when the corpus dir is absent", () => {
  const empty = makeTempDir("cosfpr-empty-");
  const gate = checkCorpus(empty);
  assert.equal(gate.status, "no_corpus");
  assert.equal(gate.reason, "absent");
});

test("checkCorpus returns no_corpus on an empty dir (no manifest)", () => {
  const dir = makeTempDir("cosfpr-nomanifest-");
  mkdirSync(dir, { recursive: true });
  const gate = checkCorpus(dir);
  assert.equal(gate.status, "no_corpus");
  assert.equal(gate.reason, "absent");
});

test("checkCorpus returns corpus_invalid on a manifest with a non-consented session", () => {
  const dir = makeTempDir("cosfpr-invalid-");
  writeManifest(dir, [
    makeSession("ok"),
    { ...makeSession("non-consented"), consent: {} },
  ]);
  const gate = checkCorpus(dir);
  assert.equal(gate.status, "corpus_invalid");
  assert.equal(gate.reason, "missing_consent");
});

test("checkCorpus returns corpus_invalid when a session is revoked or lacks metadata", () => {
  const revoked = makeTempDir("cosfpr-revoked-");
  writeManifest(revoked, [
    { ...makeSession("a"), consent: { recordId: "consent-a", revoked: true } },
  ]);
  assert.equal(checkCorpus(revoked).status, "corpus_invalid");

  const noMeta = makeTempDir("cosfpr-nometa-");
  const s = makeSession("b");
  delete s.license;
  writeManifest(noMeta, [s]);
  assert.equal(checkCorpus(noMeta).status, "corpus_invalid");
});

test("checkCorpus returns no_corpus (insufficient) when below the session floor", () => {
  const original = process.env.MEGACOMPACT_COSINE_FP_REAL_FLOOR;
  process.env.MEGACOMPACT_COSINE_FP_REAL_FLOOR = "10";
  try {
    const dir = makeTempDir("cosfpr-floor-");
    writeManifest(dir, [makeSession("a"), makeSession("b")]);
    const gate = checkCorpus(dir);
    assert.equal(gate.status, "no_corpus");
    assert.equal(gate.reason, "insufficient");
    assert.equal(gate.sessionCount, 2);
  } finally {
    if (original === undefined) delete process.env.MEGACOMPACT_COSINE_FP_REAL_FLOOR;
    else process.env.MEGACOMPACT_COSINE_FP_REAL_FLOOR = original;
  }
});

test("checkCorpus returns ok only when every session is consented + metadata complete", () => {
  const original = process.env.MEGACOMPACT_COSINE_FP_REAL_FLOOR;
  process.env.MEGACOMPACT_COSINE_FP_REAL_FLOOR = "2";
  try {
    const dir = makeTempDir("cosfpr-ok-");
    writeManifest(dir, [makeSession("a"), makeSession("b")]);
    const gate = checkCorpus(dir);
    assert.equal(gate.status, "ok");
    assert.equal(gate.sessionCount, 2);
  } finally {
    if (original === undefined) delete process.env.MEGACOMPACT_COSINE_FP_REAL_FLOOR;
    else process.env.MEGACOMPACT_COSINE_FP_REAL_FLOOR = original;
  }
});

// ── (b) consent filter ───────────────────────────────────────────────────────

test("filterConsented excludes non-consented/revoked sessions and logs the denial", () => {
  const sessions = [
    makeSession("consented"),
    { ...makeSession("revoked"), consent: { recordId: "r", revoked: true } },
    { ...makeSession("none"), consent: {} },
  ];
  const written = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  let allowed;
  try {
    allowed = filterConsented(sessions);
  } finally {
    process.stderr.write = origWrite;
  }
  assert.equal(allowed.length, 1);
  assert.equal(allowed[0].sessionId, "consented");
  // The denials are logged (never silently included).
  assert.equal(written.filter((l) => l.includes("denying")).length, 2);
});

// ── (c) Wilson interval + session-grouped bootstrap ──────────────────────────

test("Wilson interval bounds are in [0,1] with lo <= hi, and n=0 yields null", () => {
  for (const [k, n] of [[0, 1], [5, 100], [100, 100], [0, 0], [1, 10]]) {
    const { lo, hi } = wilsonInterval(k, n);
    if (n === 0) {
      assert.equal(lo, null);
      assert.equal(hi, null);
      continue;
    }
    assert.ok(lo >= 0 && lo <= 1, `lo=${lo} in [0,1]`);
    assert.ok(hi >= 0 && hi <= 1, `hi=${hi} in [0,1]`);
    assert.ok(lo <= hi, `lo<=hi for k=${k}, n=${n}`);
  }
});

test("session-grouped drawSessionIndices yields whole sessions only (never splits one)", () => {
  const n = 7;
  const idx = drawSessionIndices(n, 0x1234, 500);
  assert.equal(idx.length, 500);
  for (const i of idx) {
    assert.ok(Number.isInteger(i), `index ${i} is a whole session (integer)`);
    assert.ok(i >= 0 && i < n, `index ${i} within [0,${n - 1}]`);
  }
});

test("bootstrapSessionMeans resamples whole sessions; CI in [0,1] and deterministic", () => {
  const values = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 1];
  const a = bootstrapSessionMeans(values, 42, 200);
  const b = bootstrapSessionMeans(values, 42, 200);
  assert.deepEqual(a, b, "deterministic for a fixed seed + values");
  assert.ok(a.lo >= 0 && a.lo <= 1);
  assert.ok(a.hi >= 0 && a.hi <= 1);
  assert.ok(a.lo <= a.hi);
  assert.equal(a.means.length, 200);
});

// ── (d) determinism — same corpus → same digest ──────────────────────────────

test("computeReport is deterministic: same corpus + params → same digest", () => {
  const sessions = [makeSession("a"), makeSession("b"), makeSession("c")];
  const r1 = computeReport(sessions);
  const r2 = computeReport(sessions);
  assert.equal(r1.digest, r2.digest);
  assert.ok(/^[0-9a-f]{64}$/.test(r1.digest), "digest is a 64-hex SHA-256");
});

test("main full-run determinism + never-overwrite on a temp corpus", () => {
  const original = {
    floor: process.env.MEGACOMPACT_COSINE_FP_REAL_FLOOR,
    corpus: process.env.MEGACOMPACT_COSINE_FP_REAL_CORPUS,
    out: process.env.MEGACOMPACT_COSINE_FP_REAL_OUTDIR,
    report: process.env.MEGACOMPACT_COSINE_FP_REAL_REPORT,
    boot: process.env.MEGACOMPACT_COSINE_FP_REAL_BOOTSTRAP,
  };
  const dir = makeTempDir("cosfpr-main-");
  writeManifest(dir, [makeSession("a"), makeSession("b")]);
  const outDir = join(dir, "out");
  mkdirSync(outDir, { recursive: true });
  try {
    process.env.MEGACOMPACT_COSINE_FP_REAL_FLOOR = "2";
    process.env.MEGACOMPACT_COSINE_FP_REAL_CORPUS = dir;
    process.env.MEGACOMPACT_COSINE_FP_REAL_OUTDIR = outDir;
    process.env.MEGACOMPACT_COSINE_FP_REAL_REPORT = join(dir, "report.md");
    process.env.MEGACOMPACT_COSINE_FP_REAL_BOOTSTRAP = "100";
    const r1 = main([]);
    const r2 = main([]);
    assert.equal(r1.status, "ok");
    assert.equal(r1.digest, r2.digest, "same corpus → same digest across runs");
    // Digest-keyed output is never overwritten: exactly one real-*.json exists.
    const jsons = readdirSync(outDir).filter((f) => f.startsWith("real-") && f.endsWith(".json"));
    assert.equal(jsons.length, 1);
    assert.equal(jsons[0], `real-${r1.digest}.json`);
  } finally {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[{
        floor: "MEGACOMPACT_COSINE_FP_REAL_FLOOR",
        corpus: "MEGACOMPACT_COSINE_FP_REAL_CORPUS",
        out: "MEGACOMPACT_COSINE_FP_REAL_OUTDIR",
        report: "MEGACOMPACT_COSINE_FP_REAL_REPORT",
        boot: "MEGACOMPACT_COSINE_FP_REAL_BOOTSTRAP",
      }[k]];
      else process.env[k === "floor" ? "MEGACOMPACT_COSINE_FP_REAL_FLOOR" : k === "corpus" ? "MEGACOMPACT_COSINE_FP_REAL_CORPUS" : k === "out" ? "MEGACOMPACT_COSINE_FP_REAL_OUTDIR" : k === "report" ? "MEGACOMPACT_COSINE_FP_REAL_REPORT" : "MEGACOMPACT_COSINE_FP_REAL_BOOTSTRAP"] = v;
    }
  }
});
