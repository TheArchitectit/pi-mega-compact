/**
 * routes-vector-cortex-heal.test.ts — GET /api/vector-cortex/closure-proof (VC6A).
 *
 * Reader-only closure-optimization diagnostics aggregate. Split from
 * routes-vector-cortex.test.ts so the parent file stays under the 600-line test
 * hard limit; shares the harness below.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withServer } from "./routes-vector-cortex-helpers.js";

describe("/api/vector-cortex/closure-proof (VC6A reader-only)", () => {
  test("GET returns the reader-only closure aggregate when VC6A is ON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vc6a-heal-"));
    process.env.MEGACOMPACT_VC6A = "1";
    try {
      await withServer("9470", dir, async (port) => {
        const res = await fetch(`http://localhost:${port}/api/vector-cortex/closure-proof`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          enabled: boolean;
          mode: "A" | "B" | "C";
          optimizations: number;
          proofRejections: number;
          retainedEdgeTotal: number;
          removedEdgeTotal: number;
          conservativeTraversalTotal: number;
          optimizedTraversalTotal: number;
          lastRejection: string | null;
          updatedAt: string;
        };
        assert.equal(body.enabled, true);
        assert.equal(body.mode, "A");
        // Reader-only: aggregate counts only.
        assert.equal(typeof body.optimizations, "number");
        assert.equal(typeof body.proofRejections, "number");
        assert.equal(typeof body.retainedEdgeTotal, "number");
        assert.equal(typeof body.removedEdgeTotal, "number");
        const json = JSON.stringify(body);
        // Never exposes per-edge proof rows, node ids, or source payloads.
        assert.ok(!json.includes("rows"), "never exposes proof rows");
        assert.ok(!json.includes("selected"), "never exposes the closed selection");
        assert.ok(typeof body.updatedAt === "string", "updatedAt is a string");
      });
    } finally {
      delete process.env.MEGACOMPACT_VC6A;
    }
  });

  test("GET closure-proof reports mode B + disabled when VC6A is OFF", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vc6a-heal-off-"));
    process.env.MEGACOMPACT_VC6A = "0";
    try {
      await withServer("9471", dir, async (port) => {
        const res = await fetch(`http://localhost:${port}/api/vector-cortex/closure-proof`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as { enabled: boolean; mode: "A" | "B" | "C" };
        assert.equal(body.enabled, false);
        assert.equal(body.mode, "B", "flag-off routes to conservative closure (mode B)");
      });
    } finally {
      delete process.env.MEGACOMPACT_VC6A;
    }
  });

  test("GET closure-proof rejects non-GET (reader-only path has no mutation)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vc6a-heal-ro-"));
    await withServer("9472", dir, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/vector-cortex/closure-proof`, {
        method: "POST",
      });
      assert.equal(res.status, 405);
      assert.deepEqual(await res.json(), { error: "method_not_allowed" });
    });
  });
});
