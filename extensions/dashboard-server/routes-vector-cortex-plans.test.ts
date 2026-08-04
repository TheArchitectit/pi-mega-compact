/**
 * routes-vector-cortex-plans.test.ts — GET /api/vector-cortex/plans (VC5A).
 *
 * Reader-only plan manifest view. Split from routes-vector-cortex.test.ts so the
 * parent file stays under the 600-line test hard limit; mirrors the VC4B sibling.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withServer } from "./routes-vector-cortex-helpers.js";

describe("/api/vector-cortex/plans (VC5A reader-only)", () => {
  test("GET returns the reader-only plan manifest view when VC5A is ON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vc5a-plans-"));
    process.env.MEGACOMPACT_VC5A = "1";
    try {
      await withServer("9450", dir, async (port) => {
        const res = await fetch(`http://localhost:${port}/api/vector-cortex/plans`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          enabled: boolean;
          dagCount: number;
          plannerCount: number;
          plans: unknown[];
          updatedAt: string;
        };
        assert.equal(body.enabled, true);
        // Registered conformance ID ranges (DAG-001..030, PLN-001..020).
        assert.equal(body.dagCount, 30);
        assert.equal(body.plannerCount, 20);
        // Reader-only: only plan manifests exposed, never payloads/prompt text.
        assert.ok(Array.isArray(body.plans));
        const json = JSON.stringify(body);
        assert.ok(!json.includes("prompt"), "never exposes prompt text");
        assert.ok(!json.includes("sourceBytes"), "never exposes source bytes");
        assert.ok(typeof body.updatedAt === "string", "updatedAt is a string");
      });
    } finally {
      delete process.env.MEGACOMPACT_VC5A;
    }
  });

  test("GET plans reports disabled when VC5A is OFF", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vc5a-plans-off-"));
    process.env.MEGACOMPACT_VC5A = "0";
    try {
      await withServer("9451", dir, async (port) => {
        const res = await fetch(`http://localhost:${port}/api/vector-cortex/plans`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as { enabled: boolean };
        assert.equal(body.enabled, false);
      });
    } finally {
      delete process.env.MEGACOMPACT_VC5A;
    }
  });

  test("GET plans rejects non-GET (reader-only path has no mutation)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vc5a-plans-ro-"));
    await withServer("9452", dir, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/vector-cortex/plans`, {
        method: "POST",
      });
      assert.equal(res.status, 405);
      assert.deepEqual(await res.json(), { error: "method_not_allowed" });
    });
  });
});
