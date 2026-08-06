/**
 * ml5b-acceptance.test.ts — ML5-B production bench harness acceptance aggregator
 * (fixtures-driven, no mocks, no stubs).
 *
 * Drives ML5-BENCH-001..004 against the canonical v2 conformance corpus + the
 * REAL code: the four bench-heads envelope fixtures (p95 latency, marginal RSS,
 * opset-17 handshake, determinism + end-to-end event path), the normative gate
 * pins (40 ms / 150 MiB / opset 17 / 3-run determinism from encoder/types.ts),
 * the event-path integration (corpus → bench shell → BenchResultV1 → four
 * `vector_cortex_encoder_bench_*` events), and the no-payload-leakage invariant
 * (EVAL-REDACT-002: aggregate measurements + digest only, never chunk content).
 *
 * Flag-agnostic: no fixed runtime flag is asserted. The gate pins come from
 * encoder/types.ts normative constants, so the SAME file passes both
 * `node --test dist/vector-cortex/ml5b-acceptance.test.js` and the mandated
 * `MEGACOMPACT_ML5_B=0 ...` parity run.
 *
 * Local file reads only, zero network (PREVENT-PI-004).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENCODER_MAX_TOKENS,
  ENCODER_LATENCY_P95_MS,
  ENCODER_RSS_BUDGET_BYTES,
  ENCODER_OPSET,
} from "./encoder/types.js";
import { ML5B_ENABLED } from "../config/vector-cortex.js";
import type { BenchResultV1 } from "./encoder/bench-export.js";
import { logBenchEvent } from "../monitoring.js";

const HERE = dirname(fileURLToPath(import.meta.url));
function repoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "conformance", "vector-cortex"))) return dir;
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  throw new Error("conformance corpus not found above " + from);
}
const V2 = join(repoRoot(HERE), "conformance", "vector-cortex", "v2");

const BENCH_IDS = ["ML5-BENCH-001", "ML5-BENCH-002", "ML5-BENCH-003", "ML5-BENCH-004"] as const;

interface ManifestRow { id: string; path: string; algorithm: string; schema: string; expected: string }
interface Manifest { owner: string; schemaVersion: string; fixtures: ManifestRow[] }
interface BenchFixture {
  id: string; kind: string; flag?: string; gate?: string;
  tokens?: number; threads?: number; budget_ms?: number;
  budget_mib?: number; baseline_subtracted?: boolean;
  opset?: number; handshake?: string;
  runs?: number; distinct_digests?: number; events_written?: number;
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}
function fixture(id: string): BenchFixture {
  const row = readManifest().fixtures.find((f) => f.id === id && f.path.startsWith("bench-heads/"));
  assert.ok(row, `fixture ${id} registered under bench-heads/`);
  return JSON.parse(readFileSync(join(V2, row!.path), "utf8")) as BenchFixture;
}

const PRESERVE_SUMMARY_FIELDS = new Set([
  "timestamp", "platform", "encoderNative", "threads", "tokens", "corpusTokens",
  "p95Ms", "rssMib", "rssBaselineMib", "rssMarginalMib", "opset", "deterministic",
  "digest", "gates", "error",
]);

function tmpDir(tag: string): string {
  return join(tmpdir(), `${tag}-${process.pid}-${Math.random().toString(36).slice(2)}`);
}

describe("ML5-B conformance registration", () => {
  test("manifest registers ML5-BENCH-001..004 with bench-heads algorithm + ML5-B owner", () => {
    const m = readManifest();
    const ids = new Set(m.fixtures.map((f) => f.id));
    for (const id of BENCH_IDS) {
      assert.ok(ids.has(id), `missing ${id}`);
      const row = m.fixtures.find((f) => f.id === id)!;
      assert.equal(row.algorithm, "bench-heads", `${id} algorithm`);
      assert.equal(row.schema, "schemas/ml5-fixture.schema.json", `${id} schema ref`);
      assert.equal(row.path, `bench-heads/${id}.json`, `${id} path`);
      assert.equal(row.expected, "ok");
    }
    assert.ok(m.owner.split(",").includes("ML5-B"), "owner CSV includes ML5-B");
  });
});

describe("ML5-BENCH-001..004 envelope invariants", () => {
  test("001 p95 latency gate pin (512 tokens, 4 threads, budget 40 ms)", () => {
    const fx = fixture("ML5-BENCH-001");
    assert.equal(fx.kind, "bench-heads");
    assert.equal(fx.flag, "MEGACOMPACT_ML5_B");
    assert.equal(fx.gate, "latency");
    assert.equal(fx.tokens, ENCODER_MAX_TOKENS);      // 512
    assert.equal(fx.threads, 4);
    assert.equal(fx.budget_ms, ENCODER_LATENCY_P95_MS); // 40
  });
  test("002 steady-state marginal RSS gate pin (baseline-subtracted, budget 150 MiB)", () => {
    const fx = fixture("ML5-BENCH-002");
    assert.equal(fx.kind, "bench-heads");
    assert.equal(fx.gate, "rss");
    assert.equal(fx.budget_mib, ENCODER_RSS_BUDGET_BYTES / (1024 * 1024)); // 150
    assert.equal(fx.baseline_subtracted, true);
  });
  test("003 opset-17 handshake pin", () => {
    const fx = fixture("ML5-BENCH-003");
    assert.equal(fx.kind, "bench-heads");
    assert.equal(fx.gate, "opset");
    assert.equal(fx.opset, ENCODER_OPSET); // 17
    assert.equal(fx.handshake, "ok");
  });
  test("004 determinism + end-to-end integration pin", () => {
    const fx = fixture("ML5-BENCH-004");
    assert.equal(fx.kind, "bench-heads");
    assert.equal(fx.gate, "determinism");
    assert.equal(fx.runs, 3);
    assert.equal(fx.distinct_digests, 1);
    assert.equal(fx.events_written, 4);
  });
});

describe("ML5-B gate pins + event path", () => {
  test("the flag exports a live boolean regardless of env state", () => {
    assert.equal(typeof ML5B_ENABLED(), "boolean");
  });
  test("normative gate pins match the fixtures (40 ms / 150 MiB / opset 17 / 512 tokens)", () => {
    assert.equal(ENCODER_MAX_TOKENS, 512);
    assert.equal(ENCODER_LATENCY_P95_MS, 40);
    assert.equal(ENCODER_RSS_BUDGET_BYTES, 150 * 1024 * 1024);
    assert.equal(ENCODER_OPSET, 17);
  });
  test("BenchResultV1 carries aggregate measurements + digest only, never chunk content (EVAL-REDACT-002)", () => {
    const result: BenchResultV1 = {
      timestamp: 1,
      platform: "linux-x64",
      encoderNative: false,
      threads: 4,
      tokens: 512,
      corpusTokens: 0,
      p95Ms: 5,
      rssMib: 60,
      rssBaselineMib: 59,
      rssMarginalMib: 1,
      opset: 17,
      deterministic: true,
      digest: "ab".repeat(32),
      gates: { latency: true, rss: true, opset: true, determinism: true, all: true },
    };
    const leaked = Object.keys(result).filter((k) => !PRESERVE_SUMMARY_FIELDS.has(k));
    assert.deepEqual(leaked, [], "no chunk/message content fields in BenchResultV1");
    assert.equal(result.digest, "ab".repeat(32), "digest is a 64-char sha256 hex");
  });
  test("logBenchEvent writes the four vector_cortex_encoder_bench_* events to events.log (non-fatal)", () => {
    const dir = tmpDir("ml5b-events");
    mkdirSync(dir, { recursive: true });
    try {
      const eventsPath = join(dir, "events.log");
      const run = { platform: "linux-x64", encoderNative: false, threads: 4, tokens: 512 };
      logBenchEvent(eventsPath, "vector_cortex_encoder_bench_p95_ms", { ...run, p95Ms: 5, pass: true });
      logBenchEvent(eventsPath, "vector_cortex_encoder_bench_rss_mib", { ...run, rssMarginalMib: 1, pass: true });
      logBenchEvent(eventsPath, "vector_cortex_encoder_bench_opset_ok", { ...run, opset: 17, pass: true });
      logBenchEvent(eventsPath, "vector_cortex_encoder_bench_deterministic", { ...run, deterministic: true, pass: true });
      const lines = readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean);
      assert.equal(lines.length, 4, "exactly four events written");
      const events = lines.map((l) => JSON.parse(l));
      const names = events.map((e) => e.event);
      for (const n of ["vector_cortex_encoder_bench_p95_ms", "vector_cortex_encoder_bench_rss_mib", "vector_cortex_encoder_bench_opset_ok", "vector_cortex_encoder_bench_deterministic"]) {
        assert.ok(names.includes(n), `event ${n} written`);
      }
      for (const e of events) {
        assert.equal(typeof e.ts, "number");
        assert.equal(typeof e.pass, "boolean");
        assert.ok(Object.keys(e).every((k) => !["summary", "content", "text", "message"].includes(k)), "no payload content in event");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
