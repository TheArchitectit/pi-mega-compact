/**
 * routes-setup-cortex-actions-enc0g.test.ts — ENC-0g verify-asset log honesty.
 *
 * The verify-asset action log must carry the qualification record's verdict
 * (record_verdict) so operators can trust it; when no record exists it must say
 * record_verdict=unavailable; when ENC_0G is off the log line stays byte-identical
 * (no suffix). These 3 tests were split out of routes-setup-cortex-actions.test.ts
 * to keep it under the extensions/ 400-line soft cap. Uses the real server
 * spawn-and-fetch harness (withServer) — no mocks, no stubs.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withServer } from "./routes-vector-cortex-helpers.js";

const ACTION_BODY = (action: string, confirm: boolean) =>
  JSON.stringify({ action, confirm });

describe("ENC-0g verify-asset action log honesty", () => {
  test("verify-asset log carries record_verdict when a valid record exists", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "vc9b-enc0g-rec-"));
    const dir = mkdtempSync(join(tmpdir(), "vc9b-enc0g-rec-app-"));
    process.env.MEGACOMPACT_STATE_DIR = stateDir;
    process.env.MEGACOMPACT_ENC_0G = "1";
    process.env.MEGACOMPACT_ENC_0F = "1";
    writeFileSync(
      join(stateDir, "encoder-qualification.json"),
      JSON.stringify({
        schema: "qualification-v1",
        verdict: "failed",
        reasons: ["latency", "rss"],
        platform: "linux-x64",
      }),
      "utf8",
    );
    process.env.MEGACOMPACT_VC9B = "1";
    try {
      await withServer("9731", dir, async (port) => {
        const res = await fetch(`http://localhost:${port}/api/setup-cortex-action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: ACTION_BODY("verify-asset", true),
        });
        assert.equal(res.status, 200);
        const result = (await res.json()) as { logName: string };
        const tail = await fetch(
          `http://localhost:${port}/api/setup-cortex-action-log?name=${result.logName}`,
        );
        const body = (await tail.json()) as { tail: string };
        assert.match(
          body.tail,
          /record_verdict=failed record_reasons=latency,rss/,
          "verify-asset log surfaces the failed record verdict + reasons",
        );
      });
    } finally {
      delete process.env.MEGACOMPACT_STATE_DIR;
      delete process.env.MEGACOMPACT_ENC_0G;
      delete process.env.MEGACOMPACT_ENC_0F;
      delete process.env.MEGACOMPACT_VC9B;
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("verify-asset log reports record_verdict=unavailable when no record + gate on", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "vc9b-enc0g-absent-"));
    const dir = mkdtempSync(join(tmpdir(), "vc9b-enc0g-absent-app-"));
    process.env.MEGACOMPACT_STATE_DIR = stateDir;
    process.env.MEGACOMPACT_ENC_0G = "1";
    process.env.MEGACOMPACT_ENC_0F = "1";
    process.env.MEGACOMPACT_VC9B = "1";
    try {
      await withServer("9732", dir, async (port) => {
        const res = await fetch(`http://localhost:${port}/api/setup-cortex-action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: ACTION_BODY("verify-asset", true),
        });
        assert.equal(res.status, 200);
        const result = (await res.json()) as { logName: string };
        const tail = await fetch(
          `http://localhost:${port}/api/setup-cortex-action-log?name=${result.logName}`,
        );
        const body = (await tail.json()) as { tail: string };
        assert.match(body.tail, /record_verdict=unavailable/, "no-record case is honest");
      });
    } finally {
      delete process.env.MEGACOMPACT_STATE_DIR;
      delete process.env.MEGACOMPACT_ENC_0G;
      delete process.env.MEGACOMPACT_ENC_0F;
      delete process.env.MEGACOMPACT_VC9B;
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("verify-asset log line is byte-identical (no suffix) when ENC_0G is off", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "vc9b-enc0g-off-"));
    const dir = mkdtempSync(join(tmpdir(), "vc9b-enc0g-off-app-"));
    process.env.MEGACOMPACT_STATE_DIR = stateDir;
    process.env.MEGACOMPACT_ENC_0G = "0";
    process.env.MEGACOMPACT_ENC_0F = "1";
    writeFileSync(
      join(stateDir, "encoder-qualification.json"),
      "{\"schema\":\"qualification-v1\",\"verdict\":\"failed\",\"reasons\":[\"latency\"],\"platform\":\"linux-x64\"}",
      "utf8",
    );
    process.env.MEGACOMPACT_VC9B = "1";
    try {
      await withServer("9733", dir, async (port) => {
        const res = await fetch(`http://localhost:${port}/api/setup-cortex-action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: ACTION_BODY("verify-asset", true),
        });
        assert.equal(res.status, 200);
        const result = (await res.json()) as { logName: string };
        const tail = await fetch(
          `http://localhost:${port}/api/setup-cortex-action-log?name=${result.logName}`,
        );
        const body = (await tail.json()) as { tail: string };
        assert.ok(
          !body.tail.includes("record_verdict="),
          "flag-off appends no suffix — byte-identical line",
        );
      });
    } finally {
      delete process.env.MEGACOMPACT_STATE_DIR;
      delete process.env.MEGACOMPACT_ENC_0G;
      delete process.env.MEGACOMPACT_ENC_0F;
      delete process.env.MEGACOMPACT_VC9B;
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
