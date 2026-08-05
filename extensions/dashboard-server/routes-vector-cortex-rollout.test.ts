/**
 * routes-vector-cortex-rollout.test.ts — GET /api/vector-cortex/rollout (VC5C).
 *
 * Reader-only live graduated-rollout aggregate. Split from the parent
 * routes-vector-cortex.test.ts so the family stays under the 600-line test hard
 * limit; shares the `withServer` harness.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withServer } from "./routes-vector-cortex-helpers.js";

describe("/api/vector-cortex/rollout (VC5C reader-only)", () => {
  test("GET returns the reader-only rollout aggregate when VC5C is ON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vc5c-rollout-"));
    process.env.MEGACOMPACT_VC5C = "1";
    try {
      await withServer("9560", dir, async (port) => {
        const res = await fetch(`http://localhost:${port}/api/vector-cortex/rollout`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          enabled: boolean;
          gateIndex: number;
          gatePct: number;
          buckets: number;
          bucketCount: number;
          events: number;
          sessions: number;
          promotionBlocked: boolean;
          updatedAt: string;
        };
        assert.equal(body.enabled, true);
        assert.equal(body.gateIndex, 0);
        assert.equal(body.gatePct, 1);
        assert.equal(body.buckets, 10000);
        assert.equal(body.bucketCount, 100); // 1% of 10000
        assert.equal(body.events, 0);
        assert.equal(body.sessions, 0);
        assert.equal(body.promotionBlocked, false);
        assert.ok(typeof body.updatedAt === "string", "updatedAt is a string");
      });
    } finally {
      delete process.env.MEGACOMPACT_VC5C;
    }
  });

  test("GET rollout reports disabled when VC5C is OFF", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vc5c-rollout-off-"));
    process.env.MEGACOMPACT_VC5C = "0";
    try {
      await withServer("9561", dir, async (port) => {
        const res = await fetch(`http://localhost:${port}/api/vector-cortex/rollout`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          enabled: boolean;
          gatePct: number;
          bucketCount: number;
        };
        assert.equal(body.enabled, false);
        assert.equal(body.gatePct, 0, "gate cleared when disabled");
        assert.equal(body.bucketCount, 0, "buckets zero when disabled");
      });
    } finally {
      delete process.env.MEGACOMPACT_VC5C;
    }
  });

  test("GET rollout rejects non-GET (reader-only path has no mutation)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vc5c-rollout-ro-"));
    await withServer("9562", dir, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/vector-cortex/rollout`, {
        method: "POST",
      });
      assert.equal(res.status, 405);
      assert.deepEqual(await res.json(), { error: "method_not_allowed" });
    });
  });
});
