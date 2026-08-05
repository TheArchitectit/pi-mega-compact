/**
 * routes-vector-cortex-residual.test.ts — GET /api/vector-cortex/residual (VC4B).
 *
 * Reader-only residual-basis-parity aggregate. Split from routes-vector-cortex.test.ts
 * so the parent file stays under the 600-line test hard limit; each new sprint's
 * route tests live in their own sibling file sharing the harness below.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withServer } from "./routes-vector-cortex-helpers.js";

describe("/api/vector-cortex/residual (VC4B reader-only)", () => {
  test("GET returns the reader-only residual aggregate when VC4B is ON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vc4b-resid-"));
    process.env.MEGACOMPACT_VC4B = "1";
    try {
      await withServer("9440", dir, async (port) => {
        const res = await fetch(`http://localhost:${port}/api/vector-cortex/residual`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          enabled: boolean;
          encodeAttempts: number;
          admittedCount: number;
          rejectedCount: number;
          recoveryFailures: number;
          encodedByteTotal: number;
          exactByteTotal: number;
          updatedAt: string;
        };
        assert.equal(body.enabled, true);
        // Reader-only: counts/bytes only, never residual payloads or shard bytes.
        assert.equal(typeof body.encodeAttempts, "number");
        assert.equal(typeof body.admittedCount, "number");
        assert.equal(typeof body.rejectedCount, "number");
        assert.equal(typeof body.recoveryFailures, "number");
        assert.equal(typeof body.encodedByteTotal, "number");
        assert.equal(typeof body.exactByteTotal, "number");
        const json = JSON.stringify(body);
        assert.ok(!json.includes("originalBytes"), "never exposes verbatim source bytes");
        assert.ok(!json.includes("corrections"), "never exposes correction streams");
        assert.ok(typeof body.updatedAt === "string", "updatedAt is a string");
      });
    } finally {
      delete process.env.MEGACOMPACT_VC4B;
    }
  });

  test("GET residual reports disabled when VC4B is OFF", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vc4b-resid-off-"));
    process.env.MEGACOMPACT_VC4B = "0";
    try {
      await withServer("9441", dir, async (port) => {
        const res = await fetch(`http://localhost:${port}/api/vector-cortex/residual`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as { enabled: boolean };
        assert.equal(body.enabled, false);
      });
    } finally {
      delete process.env.MEGACOMPACT_VC4B;
    }
  });

  test("GET residual rejects non-GET (reader-only path has no mutation)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vc4b-resid-ro-"));
    await withServer("9442", dir, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/vector-cortex/residual`, {
        method: "POST",
      });
      assert.equal(res.status, 405);
      assert.deepEqual(await res.json(), { error: "method_not_allowed" });
    });
  });
});
