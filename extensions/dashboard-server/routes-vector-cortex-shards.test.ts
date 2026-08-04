/**
 * routes-vector-cortex-shards.test.ts — GET /api/vector-cortex/shards (VC4A).
 *
 * Reader-only dual-tier shard aggregate. Split from routes-vector-cortex.test.ts
 * so the parent file stays under the 600-line test hard limit; each new sprint's
 * route tests live in their own sibling file sharing the harness below.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withServer } from "./routes-vector-cortex-helpers.js";

describe("/api/vector-cortex/shards (VC4A reader-only)", () => {
  test("GET returns the reader-only dual-tier shard aggregate when VC4A is ON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vc4a-shards-"));
    process.env.MEGACOMPACT_VC4A = "1";
    try {
      await withServer("9430", dir, async (port) => {
        const res = await fetch(
          `http://localhost:${port}/api/vector-cortex/shards`,
        );
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          enabled: boolean;
          semanticCount: number;
          exactCount: number;
          byteTotal: number;
          protectedByteTotal: number;
          updatedAt: string;
        };
        assert.equal(body.enabled, true);
        // Reader-only: counts/bytes only, never shard payloads or verbatim bytes.
        assert.equal(typeof body.semanticCount, "number");
        assert.equal(typeof body.exactCount, "number");
        assert.equal(typeof body.byteTotal, "number");
        assert.equal(typeof body.protectedByteTotal, "number");
        const json = JSON.stringify(body);
        assert.ok(!json.includes("originalBytes"), "never exposes verbatim exact bytes");
        assert.ok(typeof body.updatedAt === "string", "updatedAt is a string");
      });
    } finally {
      delete process.env.MEGACOMPACT_VC4A;
    }
  });

  test("GET shards reports disabled when VC4A is OFF", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vc4a-shards-off-"));
    process.env.MEGACOMPACT_VC4A = "0";
    try {
      await withServer("9431", dir, async (port) => {
        const res = await fetch(
          `http://localhost:${port}/api/vector-cortex/shards`,
        );
        assert.equal(res.status, 200);
        const body = (await res.json()) as { enabled: boolean };
        assert.equal(body.enabled, false);
      });
    } finally {
      delete process.env.MEGACOMPACT_VC4A;
    }
  });

  test("GET shards rejects non-GET (reader-only path has no mutation)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vc4a-shards-ro-"));
    await withServer("9432", dir, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/vector-cortex/shards`, {
        method: "POST",
      });
      assert.equal(res.status, 405);
      assert.deepEqual(await res.json(), { error: "method_not_allowed" });
    });
  });
});
