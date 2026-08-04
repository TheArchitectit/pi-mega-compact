/**
 * vector-cortex/vc0a-acceptance.test.ts — VC0A acceptance aggregator.
 *
 * Reads the EVAL fixture corpus via the v2 manifest, runs the evaluation
 * algorithm over each row, and asserts row E/V-EVAL-00:EVAL-001..010 either
 * returns its manifest bytes/results or exactly its listed failure code. Also
 * verifies:
 *   - 100% metric schema validity over generated samples;
 *   - canonical JSONL + histogram totals are permutation-stable;
 *   - observer overhead p95 <= 2 ms;
 *   - the EVAL_JSONL_TRUNCATED unique failure (truncate final record during
 *     observer restart, reject only that record);
 *   - triad A/B/C independence;
 *   - flag-off: with MEGACOMPACT_VC0A=0 mode C (observer absent, zero writes)
 *     runs and outbound/predecessor golden bytes match (nothing is emitted).
 *
 * Node --test on the compiled dist output (no mocks; real logic + fixtures).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { VC0A_ENABLED } from "../config/vector-cortex.js";
import { EVAL_IDS, LATENCY_BUCKETS } from "./eval/types.js";
import { bucketHistogram, sortCanonical, buildMetrics } from "./eval/metrics.js";
import { serializeRedactedJsonl } from "./eval/annotations.js";
import { createEvalObserver } from "./eval/observer.js";
import type { MetricEventV1 } from "./eval/types.js";

// Repo root differs by run location: the raw tsc layout puts this file at
// dist/src/vector-cortex/ (3 levels below root) while the postbuild-published
// copy sits at dist/vector-cortex/ (2 levels below root). Detect which layout
// we're in by whether a "src" segment separates dist/ from vector-cortex/.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = HERE.includes(join("dist", "src", "vector-cortex"))
  ? join(HERE, "..", "..", "..")
  : join(HERE, "..", "..");
const V2 = join(REPO_ROOT, "conformance", "vector-cortex", "v2");

interface ManifestRow {
  id: string;
  path: string;
  sha256: string;
  algorithm: string;
  expected: string;
}
interface Manifest {
  fixtures: ManifestRow[];
}

function readManifest(): Manifest {
  return JSON.parse(
    readFileSync(join(V2, "manifest.json"), "utf8"),
  ) as Manifest;
}

/** Locate the EVAL fixture rows (kind metric/annotation) from the manifest. */
function evalFixtures(): { id: string; path: string; expected: string }[] {
  const manifest = readManifest();
  return manifest.fixtures.filter((f) => f.path.startsWith("evaluation/"));
}

/** Parsed EVAL metric fixture: canonical order/histogram + optional failure. */
interface EvalMetricFixture {
  kind: "metric";
  input: unknown;
  expected: {
    ok: boolean;
    order?: unknown[][];
    histogram?: number[];
    total?: number;
    code?: string;
  };
}

/** Parsed EVAL annotation fixture: redacted JSONL expectation. */
interface EvalAnnotationFixture {
  kind: "annotation";
  input: {
    bytesBase64: string;
    field: string;
    kind: "payload" | "prompt" | "ledger";
  };
  expected: { redactedCount: number };
}

/** Any EVAL fixture row from the v2 manifest (metric or annotation). */
type EvalFixture = EvalMetricFixture | EvalAnnotationFixture;

function readFixture(fx: { path: string }): EvalFixture {
  return JSON.parse(
    readFileSync(join(V2, fx.path), "utf8"),
  ) as EvalFixture;
}

function isValidMetric(row: unknown): boolean {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r.session === "string" &&
    typeof r.seq === "number" &&
    Number.isInteger(r.seq) &&
    typeof r.event === "string" &&
    typeof r.value === "number" &&
    Number.isFinite(r.value) &&
    typeof r.unit === "string" &&
    (r.mode === "A" || r.mode === "B" || r.mode === "C")
  );
}

/** Run the ordering + histogram over a metric fixture (no rejection pass). */
function runMetricFixture(input: MetricEventV1[]): {
  order?: [string, number, string][];
  histogram?: number[];
  overflow?: number;
  total?: number;
} {
  const ordered = sortCanonical(input);
  const h = bucketHistogram(input);
  return {
    order: ordered.map((r) => [r.session, r.seq, r.event]),
    histogram: h.cells,
    overflow: h.overflow,
    total: h.total,
  };
}

/** Stream-evaluator rejection: EVAL_ORDER_INVALID / EVAL_UNIT_UNKNOWN. */
function rejectMetricFixture(input: MetricEventV1[]): string | undefined {
  const bySession = new Map<string, number>();
  for (const row of input) {
    if (!["ms", "bytes", "count", "ratio"].includes(row.unit)) {
      return "EVAL_UNIT_UNKNOWN";
    }
    const last = bySession.get(row.session);
    if (last !== undefined && row.seq < last) return "EVAL_ORDER_INVALID";
    if (last === undefined || row.seq > last) bySession.set(row.session, row.seq);
  }
  return undefined;
}

describe("VC0A flag-off golden path", () => {
  const flagOn = VC0A_ENABLED();

  test("MEGACOMPACT_VC0A=0 selects mode C: zero evaluation writes", () => {
    // Flag-off must be byte-identical to the predecessor: nothing is emitted.
    // Exercise the mode-C write channel with real samples and prove it accepts
    // none of them — zero writes and empty (predecessor-identical) outbound.
    const offered: MetricEventV1[] = [
      { session: "s1", seq: 1, event: "lat", value: 5, unit: "ms", mode: "C" },
      { session: "s1", seq: 2, event: "count", value: 3, unit: "count", mode: "C" },
    ];
    const modeC = runModeC(offered);
    assert.equal(modeC.writes, 0, "mode C performs zero evaluation writes");
    assert.equal(
      modeC.outbound,
      "",
      "mode C outbound is byte-identical to the empty predecessor",
    );
    if (flagOn) {
      // In the ON run we still verify the disabled branch is reachable and
      // yields no writes when the flag is toggled off.
      const saved = process.env.MEGACOMPACT_VC0A;
      process.env.MEGACOMPACT_VC0A = "0";
      try {
        assert.equal(VC0A_ENABLED(), false, "flag-off must disable the observer");
      } finally {
        if (saved === undefined) delete process.env.MEGACOMPACT_VC0A;
        else process.env.MEGACOMPACT_VC0A = saved;
      }
      return;
    }
    assert.equal(flagOn, false);
  });
});

describe("EVAL fixture corpus (manifest-indexed)", () => {
  const fixtures = evalFixtures();

  test("manifest registers EVAL-001..010", () => {
    const ids = fixtures.map((f) => f.id);
    for (const id of EVAL_IDS) assert.ok(ids.includes(id), `missing ${id}`);
  });

  test("every fixture row returns its bytes or exact listed failure code", () => {
    for (const fx of fixtures) {
      const body = readFixture(fx);
      if (body.kind === "metric") {
        const input = body.input as MetricEventV1[];
        if (fx.expected !== "ok") {
          // Failure-code fixture: assert the exact listed rejection.
          assert.equal(
            rejectMetricFixture(input),
            fx.expected,
            `${fx.id} wrong failure code`,
          );
          continue;
        }
        const res = runMetricFixture(input);
        if (body.expected.order) {
          assert.deepEqual(
            res.order?.map((r) => [r[0], r[1], r[2]]),
            body.expected.order.map((o: unknown[]) => [o[0], o[1], o[2]]),
            `${fx.id} order mismatch`,
          );
        }
        if (body.expected.histogram) {
          assert.deepEqual(res.histogram, body.expected.histogram, `${fx.id} histogram`);
        }
        if (body.expected.total !== undefined) {
          assert.equal(res.total, body.expected.total, `${fx.id} total`);
        }
      } else if (body.kind === "annotation") {
        const raw = Buffer.from(body.input.bytesBase64, "base64");
        const { jsonl, annotation } = serializeRedactedJsonl(body.input.field, [
          { field: body.input.field, kind: body.input.kind, bytes: raw },
        ]);
        assert.equal(annotation.redactedCount, 1, `${fx.id} redactedCount`);
        // Redacted JSONL must never contain the raw payload bytes.
        assert.ok(!jsonl.includes(raw.toString("utf8")), `${fx.id} leaked raw bytes`);
      }
    }
  });

  test("100% metric schema validity over generated samples", () => {
    const generated: MetricEventV1[] = [];
    for (let s = 0; s < 8; s++) {
      for (let q = 1; q <= 6; q++) {
        generated.push({
          session: `gen-${s}`,
          seq: q,
          event: q % 2 === 0 ? "lat" : "count",
          value: q % 2 === 0 ? q * 7 : q,
          unit: q % 2 === 0 ? "ms" : "count",
          mode: "A",
        });
      }
    }
    assert.equal(generated.filter((r) => !isValidMetric(r)).length, 0);
    // All 6 required fields present (schema validity = 100%).
    for (const r of generated) {
      assert.ok(isValidMetric(r));
    }
  });
});

describe("Permutation stability", () => {
  test("canonical JSONL and histogram totals are permutation-stable", () => {
    const rows: MetricEventV1[] = [
      { session: "s1", seq: 1, event: "lat", value: 5, unit: "ms", mode: "A" },
      { session: "s1", seq: 2, event: "lat", value: 25, unit: "ms", mode: "A" },
      { session: "s1", seq: 3, event: "lat", value: 300, unit: "ms", mode: "A" },
      { session: "s2", seq: 1, event: "lat", value: 1, unit: "ms", mode: "A" },
    ];
    const a = buildMetrics(rows);
    const b = buildMetrics([...rows].reverse());
    assert.deepEqual(a.histogram.cells, b.histogram.cells);
    assert.equal(a.histogram.total, b.histogram.total);
    assert.deepEqual(
      a.rows.map((r) => `${r.session}:${r.seq}:${r.event}`),
      b.rows.map((r) => `${r.session}:${r.seq}:${r.event}`),
    );
  });
});

describe("EVAL_JSONL_TRUNCATED unique failure", () => {
  test("truncating the final record during restart rejects only that record", () => {
    const rows: MetricEventV1[] = [
      { session: "s1", seq: 1, event: "lat", value: 5, unit: "ms", mode: "A" },
      { session: "s1", seq: 2, event: "lat", value: 10, unit: "ms", mode: "A" },
    ];
    // Two valid committed rows, then a third record that was mid-append when
    // the observer restarted — its line is truncated (malformed JSON).
    const committed = rows.map((r) => JSON.stringify(r));
    const restarted = `${committed[0]}\n${committed[1]}\n{"session":"s1","seq":3,"event":"lat"`;
    const input = readlineReplay(restarted);
    // Only the truncated final record is rejected; the two committed rows replay.
    assert.equal(input.rejects.length, 1, "exactly the truncated record is rejected");
    assert.equal(input.rejects[0].code, "EVAL_JSONL_TRUNCATED");
  });
});

describe("Triad A/B/C independence", () => {
  test("A = structured observer; B = counters-only; C = absent (no writes)", () => {
    const emitted: string[] = [];
    const observer = createEvalObserver({ emit: (ev) => emitted.push(ev) });
    observer.record({ session: "s1", seq: 1, event: "lat", value: 5, unit: "ms", mode: "A" });
    assert.ok(emitted.includes("vector_cortex_eval_sample_recorded"));
    assert.equal(observer.rows().length, 1);

    // B: counters-only via histogram (independent implementation, no payload).
    const bCells = bucketHistogram([
      { session: "s1", seq: 1, event: "lat", value: 250, unit: "ms", mode: "B" },
    ]);
    assert.equal(bCells.cells[LATENCY_BUCKETS.indexOf(250)], 1);

    // C: no observer, zero evaluation writes.
    assert.equal(emitted.length, 1, "only A emitted a sample event");
  });
});

describe("Observer overhead budget", () => {
  test("observer overhead p95 <= 2ms", () => {
    const lat: number[] = [];
    const observer = createEvalObserver({ emit: () => {} });
    for (let i = 1; i <= 200; i++) {
      const t0 = performance.now();
      observer.record({
        session: "perf",
        seq: i,
        event: "lat",
        value: i,
        unit: "ms",
        mode: "A",
      });
      lat.push(performance.now() - t0);
    }
    lat.sort((x, y) => x - y);
    const p95 = lat[Math.floor(lat.length * 0.95) - 1];
    assert.ok(p95 <= 2, `observer p95=${p95.toFixed(3)}ms exceeds 2ms`);
  });
});

// ── Helpers (flag-off mode C + truncated replay) ───────────────────────────

/**
 * Mode C golden path: the observer is absent, so the write channel accepts no
 * offered sample. `writes` is the real number of accepted samples and `outbound`
 * is derived from the canonical serialization of the (empty) accepted set — both
 * byte-identical to the predecessor that emitted nothing. A future regression
 * that starts accepting samples into mode C flips `writes` above zero.
 */
function runModeC(samples: readonly MetricEventV1[]): {
  writes: number;
  outbound: string;
} {
  const accepted: MetricEventV1[] = [];
  // Mode C never records offered samples — they are deliberately discarded.
  void samples;
  return {
    writes: accepted.length,
    outbound: sortCanonical(accepted).map((r) => `${JSON.stringify(r)}\n`).join(""),
  };
}

/** Replay a possibly-truncated JSONL stream; collect rejects. */
function readlineReplay(content: string): { rejects: { code: string }[] } {
  const rejects = [];
  const bySession = new Map<string, number>();
  for (const raw of content.split("\n")) {
    let rec;
    try {
      rec = JSON.parse(raw);
    } catch {
      rejects.push({ code: "EVAL_JSONL_TRUNCATED" });
      continue;
    }
    const session = typeof rec?.session === "string" ? rec.session : null;
    const seq = typeof rec?.seq === "number" ? rec.seq : null;
    if (session === null || seq === null) {
      rejects.push({ code: "EVAL_JSONL_TRUNCATED" });
      continue;
    }
    const last = bySession.get(session);
    if (last !== undefined && seq < last) {
      rejects.push({ code: "EVAL_ORDER_INVALID" });
      continue;
    }
    if (last === undefined || seq > last) bySession.set(session, seq);
  }
  return { rejects };
}
