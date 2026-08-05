/**
 * routes-vector-cortex-render.test.ts — GET /api/vector-cortex/render (VC5B).
 *
 * Reader-only render + provider-profile aggregate. Split from the parent
 * routes-vector-cortex.test.ts so the family stays under the 600-line test hard
 * limit; shares the `withServer` harness.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withServer } from "./routes-vector-cortex-helpers.js";

describe("/api/vector-cortex/render (VC5B reader-only)", () => {
  test("GET returns the reader-only render aggregate when VC5B is ON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vc5b-render-"));
    process.env.MEGACOMPACT_VC5B = "1";
    try {
      await withServer("9550", dir, async (port) => {
        const res = await fetch(`http://localhost:${port}/api/vector-cortex/render`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
          enabled: boolean;
          renderCount: number;
          providerCount: number;
          knownProfiles: string[];
          updatedAt: string;
        };
        assert.equal(body.enabled, true);
        assert.equal(body.renderCount, 20); // REN-001..020
        assert.equal(body.providerCount, 15); // PRO-001..015
        assert.ok(Array.isArray(body.knownProfiles));
        assert.ok(body.knownProfiles.length >= 1, "at least one known base profile");
        // Reader-only: never exposes rendered bytes, prompt text, or the request.
        const json = JSON.stringify(body);
        assert.ok(!json.includes("systemPrompt"), "never exposes the prepend");
        assert.ok(!json.includes("requestDigest"), "never exposes the request digest");
        assert.ok(typeof body.updatedAt === "string", "updatedAt is a string");
      });
    } finally {
      delete process.env.MEGACOMPACT_VC5B;
    }
  });

  test("GET render reports disabled when VC5B is OFF", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vc5b-render-off-"));
    process.env.MEGACOMPACT_VC5B = "0";
    try {
      await withServer("9551", dir, async (port) => {
        const res = await fetch(`http://localhost:${port}/api/vector-cortex/render`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as { enabled: boolean; renderCount: number };
        assert.equal(body.enabled, false);
        assert.equal(body.renderCount, 0, "counts zero when disabled");
      });
    } finally {
      delete process.env.MEGACOMPACT_VC5B;
    }
  });

  test("GET render rejects non-GET (reader-only path has no mutation)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vc5b-render-ro-"));
    await withServer("9552", dir, async (port) => {
      const res = await fetch(`http://localhost:${port}/api/vector-cortex/render`, {
        method: "POST",
      });
      assert.equal(res.status, 405);
      assert.deepEqual(await res.json(), { error: "method_not_allowed" });
    });
  });
});
