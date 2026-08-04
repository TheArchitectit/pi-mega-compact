/**
 * routes-vector-cortex-reconstruct.test.ts — GET /api/vector-cortex/reconstruct (VC4C).
 *
 * Reader-only reconstruction-fidelity aggregate. Split from routes-vector-cortex.test.ts
 * so the parent file stays under the 600-line test hard limit; each new sprint's
 * route tests live in their own sibling file sharing the harness below.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withServer } from "./routes-vector-cortex-helpers.js";

describe("/api/vector-cortex/reconstruct (VC4C reader-only)", () => {
  test("GET returns the reader-only reconstruction aggregate when VC4C is ON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vc4c-recon-"));
    process.env.MEGACOMPACT_VC4C = "1";
    try {
      await withServer("9450", dir, async (port) => {
        const res = await fetch(`http://localhost:${port}/api/vector-cortex/reconstruct`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          enabled: boolean;
          closureAttempts: number;
          closureRejections: number;
          validatedCount: number;
          invalidatedCount: number;
          spanTotal: number;
          byteTotal: number;
          updatedAt: string;
        };
        assert.equal(body.enabled, true);
        // Reader-only: counts/bytes only, never reconstructed spans or prompt text.
        assert.equal(typeof body.closureAttempts, "number");
        assert.equal(typeof body.closureRejections, "number");
        assert.equal(typeof body.validatedCount, "number");
        assert.equal(typeof body.invalidatedCount, "number");
        assert.equal(typeof body.spanTotal, "number");
        assert.equal(typeof body.byteTotal, "number");
        const json = JSON.stringify(body);
        assert.ok(!json.includes("spans"), "never exposes reconstructed spans");
        assert.ok(!json.includes("prompt"), "never exposes prompt text");
        assert.ok(typeof body.updatedAt === "string", "updatedAt is a string");
      });
    } finally {
      delete process.env.MEGACOMPACT_VC4C;
    }
  });

  test("GET reconstruct reports disabled when VC4C is OFF", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vc4c-recon-off-"));
    process.env.MEGACOMPACT_VC4C = "0";
    try {
      await withServer("9451", dir, async (port) => {
        const res = await fetch(`http://localhost:${port}/api/vector-cortex/reconstruct`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as { enabled: boolean };
        assert.equal(body.enabled, false);
      });
    } finally {
      delete process.env.MEGACOMPACT_VC4C;
    }
  });

  test("GET reconstruct rejects non-GET (reader-only path has no mutation)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vc4c-recon-ro-"));
    await withServer("9452", dir, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/vector-cortex/reconstruct`, {
        method: "POST",
      });
      assert.equal(res.status, 405);
      assert.deepEqual(await res.json(), { error: "method_not_allowed" });
    });
  });
});
