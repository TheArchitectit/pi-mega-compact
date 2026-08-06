/**
 * routes-dedup-attribution.test.ts — dedup tier-attribution route (DEDUP-ATTR).
 *
 * Exercises handleDedupTierAttribution against a real temporary events.log +
 * stateDir and a stub ServerResponse: flag-on 200 with the full contract shape,
 * flag-off 404 + no durable cache write, non-GET 405, and malformed lines
 * skipped silently. Real file reads, no mocks of the data source.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { handleDedupTierAttribution } from "./routes-dedup-attribution.js";

const HOUR = 60 * 60 * 1000;

interface Capture {
  status: number;
  body: string;
}

function stubRes(): { res: ServerResponse; capture: Capture } {
  const capture = { status: 0, body: "" };
  const res = {
    writeHead(code: number, _headers?: unknown): ServerResponse {
      capture.status = code;
      return res as unknown as ServerResponse;
    },
    end(body?: unknown): ServerResponse {
      capture.body = String(body ?? "");
      return res as unknown as ServerResponse;
    },
  } as unknown as ServerResponse;
  return { res, capture };
}

function makeReq(url: string, method = "GET"): IncomingMessage {
  return { url, method } as unknown as IncomingMessage;
}

function makeCtx(stateDir: string, eventsPath: string): RouteContext {
  return {
    snapshotPath: "",
    eventsPath,
    stateDir,
    SERVER_VERSION: "",
    serveClientAsset: () => false,
    eventOffsetRef: { value: 0 },
    overlayCurrentRepo: () => {},
    detectCrossRepoDrift: () => [],
  } as unknown as RouteContext;
}

/** Write a synthetic events.log with N dedup_audit lines, newest last. */
function writeAuditEvents(
  eventsPath: string,
  nowMs: number,
  rows: Array<{ offsetMs: number; tier: string; status: string }>,
  extra: string[] = [],
): void {
  const lines = [
    ...extra,
    ...rows.map((r) =>
      JSON.stringify({
        type: "dedup_audit",
        ts: new Date(nowMs + r.offsetMs).toISOString(),
        sessionId: "sess-1",
        tier: r.tier,
        status: r.status,
      }),
    ),
  ];
  writeFileSync(eventsPath, lines.join("\n") + "\n");
}

describe("handleDedupTierAttribution", () => {
  test("non-matching URL returns false (falls through)", () => {
    const dir = mkdtempSync(join(tmpdir(), "dedupattr-"));
    try {
      const ctx = makeCtx(dir, join(dir, "events.log"));
      const { res, capture } = stubRes();
      const claimed = handleDedupTierAttribution(makeReq("/api/snapshot"), res, ctx);
      assert.equal(claimed, false);
      assert.equal(capture.status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("non-GET returns 405", () => {
    const dir = mkdtempSync(join(tmpdir(), "dedupattr-"));
    try {
      writeAuditEvents(join(dir, "events.log"), Date.now(), []);
      const ctx = makeCtx(dir, join(dir, "events.log"));
      const { res, capture } = stubRes();
      const claimed = handleDedupTierAttribution(
        makeReq("/api/dedup-tier-attribution", "POST"),
        res,
        ctx,
      );
      assert.equal(claimed, true);
      assert.equal(capture.status, 405);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("flag-off (MEGACOMPACT_DEDUP_ATTR=0) returns 404 and writes no cache file", () => {
    const dir = mkdtempSync(join(tmpdir(), "dedupattr-"));
    try {
      const prev = process.env.MEGACOMPACT_DEDUP_ATTR;
      process.env.MEGACOMPACT_DEDUP_ATTR = "0";
      try {
        writeAuditEvents(join(dir, "events.log"), Date.now(), [
          { offsetMs: -1 * HOUR, tier: "L0", status: "deduped" },
        ]);
        const ctx = makeCtx(dir, join(dir, "events.log"));
        const { res, capture } = stubRes();
        const claimed = handleDedupTierAttribution(
          makeReq("/api/dedup-tier-attribution?windowMs=86400000"),
          res,
          ctx,
        );
        assert.equal(claimed, true);
        assert.equal(capture.status, 404);
        assert.equal(existsSync(join(dir, "dedup-tier-attribution.json")), false);
      } finally {
        if (prev === undefined) delete process.env.MEGACOMPACT_DEDUP_ATTR;
        else process.env.MEGACOMPACT_DEDUP_ATTR = prev;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("flag-on returns 200 with the full contract shape + durable cache write", () => {
    const dir = mkdtempSync(join(tmpdir(), "dedupattr-"));
    try {
      const now = Date.now();
      writeAuditEvents(join(dir, "events.log"), now, [
        { offsetMs: -1 * HOUR, tier: "L0", status: "deduped" },
        { offsetMs: -2 * HOUR, tier: "L1", status: "passed" },
        { offsetMs: -3 * HOUR, tier: "L2", status: "deduped" },
        { offsetMs: -4 * HOUR, tier: "new", status: "stored" },
      ]);
      const ctx = makeCtx(dir, join(dir, "events.log"));
      const { res, capture } = stubRes();
      const claimed = handleDedupTierAttribution(
        makeReq("/api/dedup-tier-attribution?windowMs=86400000"),
        res,
        ctx,
      );
      assert.equal(claimed, true);
      assert.equal(capture.status, 200);
      const body = JSON.parse(capture.body) as {
        schema: string;
        windowStart: string;
        windowEnd: string;
        totalDecisions: number;
        byTier: {
          l0: { deduped: number; passed: number };
          l1: { deduped: number; passed: number };
          l2: { deduped: number; passed: number };
          new: number;
        };
        l0Share: number;
        l1Share: number;
        l2Share: number;
        status: string;
      };
      assert.equal(body.schema, "dedup-tier-rollup-v1");
      assert.equal(body.totalDecisions, 4);
      assert.deepEqual(body.byTier.l0, { deduped: 1, passed: 0 });
      assert.deepEqual(body.byTier.l1, { deduped: 0, passed: 1 });
      assert.deepEqual(body.byTier.l2, { deduped: 1, passed: 0 });
      assert.equal(body.byTier.new, 1);
      assert.equal(body.l0Share, 0.25);
      assert.equal(body.l1Share, 0.25);
      assert.equal(body.l2Share, 0.25);
      assert.equal(body.status, "live");
      assert.ok(typeof body.windowStart === "string");
      assert.ok(typeof body.windowEnd === "string");
      // Durable snapshot written beside the state dir.
      assert.equal(existsSync(join(dir, "dedup-tier-attribution.json")), true);
      const snap = JSON.parse(
        readFileSync(join(dir, "dedup-tier-attribution.json"), "utf8"),
      ) as { totalDecisions: number };
      assert.equal(snap.totalDecisions, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("empty window returns totalDecisions 0 + shares 0 + awaiting_data", () => {
    const dir = mkdtempSync(join(tmpdir(), "dedupattr-"));
    try {
      writeAuditEvents(join(dir, "events.log"), Date.now(), []);
      const ctx = makeCtx(dir, join(dir, "events.log"));
      const { res, capture } = stubRes();
      handleDedupTierAttribution(
        makeReq("/api/dedup-tier-attribution?windowMs=86400000"),
        res,
        ctx,
      );
      const body = JSON.parse(capture.body) as {
        totalDecisions: number;
        l0Share: number;
        l1Share: number;
        l2Share: number;
        status: string;
      };
      assert.equal(body.totalDecisions, 0);
      assert.equal(body.l0Share, 0);
      assert.equal(body.l1Share, 0);
      assert.equal(body.l2Share, 0);
      assert.equal(body.status, "awaiting_data");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed events.log lines are skipped silently (no throw, no crash)", () => {
    const dir = mkdtempSync(join(tmpdir(), "dedupattr-"));
    try {
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      writeAuditEvents(
        join(dir, "events.log"),
        now,
        [{ offsetMs: -1 * HOUR, tier: "L1", status: "deduped" }],
        [
          "{ not valid json", // malformed
          JSON.stringify({ ts: nowIso }), // no type
          JSON.stringify({ type: "decision", ts: nowIso }), // non-audit
          JSON.stringify({ type: "dedup_audit", ts: "garbage", tier: "L0", status: "deduped" }), // bad ts
        ],
      );
      const ctx = makeCtx(dir, join(dir, "events.log"));
      const { res, capture } = stubRes();
      const claimed = handleDedupTierAttribution(
        makeReq("/api/dedup-tier-attribution?windowMs=86400000"),
        res,
        ctx,
      );
      assert.equal(claimed, true);
      assert.equal(capture.status, 200);
      const body = JSON.parse(capture.body) as { totalDecisions: number; status: string };
      assert.equal(body.totalDecisions, 1); // only the well-formed in-window L1 row counted
      assert.equal(body.status, "live");
      const l1 = (JSON.parse(capture.body) as { byTier: { l1: { deduped: number } } }).byTier;
      assert.equal(l1.l1.deduped, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("windowMs is capped at 30 days and defaulted to 24h when invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "dedupattr-"));
    try {
      const now = Date.now();
      // 31 days old — outside even the 30-day cap, but inside 24h default excludes it.
      writeAuditEvents(join(dir, "events.log"), now, [
        { offsetMs: -31 * 24 * HOUR, tier: "L0", status: "deduped" },
      ]);
      const ctx = makeCtx(dir, join(dir, "events.log"));
      const { res: res1, capture: c1 } = stubRes();
      // default (24h) window excludes the 31-day-old event.
      handleDedupTierAttribution(makeReq("/api/dedup-tier-attribution"), res1, ctx);
      assert.equal(c1.status, 200);
      assert.equal(
        (JSON.parse(c1.body) as { totalDecisions: number }).totalDecisions,
        0,
      );
      // an invalid windowMs (>30d cap -> clamped to 30d) also excludes it.
      const { res: res2, capture: c2 } = stubRes();
      handleDedupTierAttribution(
        makeReq("/api/dedup-tier-attribution?windowMs=999999999999"),
        res2,
        ctx,
      );
      assert.equal(c2.status, 200);
      assert.equal((JSON.parse(c2.body) as { totalDecisions: number }).totalDecisions, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
