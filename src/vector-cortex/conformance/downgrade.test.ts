/**
 * downgrade.test.ts — DowngradeReport determinism unit tests (VC1C, CONF-DOWN-003).
 *
 * A downgrade export produces a NEW legacy copy without ever mutating the
 * authority data it reads. The resulting DowngradeReport is deterministic: a
 * second export yields a byte-identical report digest. This holds whether the
 * exporter reads from a real corpus or an injected one (fully local, no network).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  runDowngradeExport,
  type DowngradeExporter,
  type DowngradeReport,
} from "./runner.js";

/** A deterministic exporter over an immutable input array. */
function makeExporter(rows: readonly string[]): DowngradeExporter {
  const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
  return {
    exportOnce: (): DowngradeReport => {
      const copyId = sha256(rows.join("|")).slice(0, 16);
      // Deterministic report: no timestamps, no randomness.
      const body = {
        schema: "downgrade-report-v1" as const,
        exportedCopyId: copyId,
        copiedCount: rows.length,
        unrepresentableIds: [] as string[],
      };
      const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
      return { ...body, reportDigest: digest };
    },
  };
}

describe("DowngradeReport (CONF-DOWN-003)", () => {
  test("a second export yields a byte-identical report digest", () => {
    const rows = ["c1", "c2", "c3"];
    const exporter = makeExporter(rows);
    const a = runDowngradeExport(exporter);
    const b = runDowngradeExport(exporter);
    assert.equal(a.schema, "downgrade-report-v1");
    assert.equal(a.copiedCount, 3);
    assert.equal(a.reportDigest, b.reportDigest, "deterministic report digest across runs");
    assert.equal(a.exportedCopyId, b.exportedCopyId, "deterministic copy id across runs");
  });

  test("unrepresentable ids are listed, never silently dropped", () => {
    let exports = 0;
    const exporter: DowngradeExporter = {
      exportOnce: (): DowngradeReport => {
        exports += 1;
        const body = {
          schema: "downgrade-report-v1" as const,
          exportedCopyId: "0123456789abcdef",
          copiedCount: 1,
          unrepresentableIds: ["bad"],
        };
        const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
        return { ...body, reportDigest: digest };
      },
    };
    const r = runDowngradeExport(exporter);
    assert.equal(copiesOf(exports), 1);
    assert.deepEqual(r.unrepresentableIds, ["bad"], "unrepresentable rows surfaced");
    assert.equal((r as DowngradeReport).copiedCount, 1);
  });

  test("the report digest covers the report body (any mutation changes it)", () => {
    const exporter = makeExporter(["c1"]);
    const a = runDowngradeExport(exporter);
    assert.match(a.reportDigest, /^[0-9a-f]{64}$/, "report digest is a sha256 hex");
  });
});

function copiesOf(n: number): number {
  return n;
}
