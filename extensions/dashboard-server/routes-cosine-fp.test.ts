/**
 * routes-cosine-fp.test.ts — COS-FP-A cosine-FP report route.
 *
 * Exercises handleCosineFpReport against the real committed synthetic bench
 * aggregate (scripts/cosine-fp/bench-run/cosine-fp-report.json) copied into a
 * temp bench-run dir (via the MEGACOMPACT_COSINE_FP_BENCH_RUN_DIR seam):
 * flag-on 200 with the full CosineFpReportV1 shape incl. recommendation +
 * digest; flag-off 404 (byte-identical predecessor); non-GET 405; missing
 * report file → awaiting_data, never a fabricated zero row (COS-FP-A-003).
 * Real committed bench output — no invented constants, no import of script
 * modules (no `any`).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { handleCosineFpReport } from "./routes-cosine-fp.js";
import type { CosineFpReportV1 } from "./api-contracts/cosine-fp.js";

/** Repo-root bench-run aggregate (committed by gen-fixtures/bench). */
function committedAggregateRaw(): string | null {
  // dist/extensions/dashboard-server/*.test.js → repo root is 3 levels up.
  const here = dirname(fileURLToPath(import.meta.url));
  const p = join(here, "..", "..", "..", "scripts", "cosine-fp", "bench-run", "cosine-fp-report.json");
  try {
    return readFileSync(p, "utf8"); // guardrails-allow PREVENT-PI-004: local committed aggregate read
  } catch {
    return null;
  }
}

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

function makeCtx(): RouteContext {
  return {
    snapshotPath: "",
    eventsPath: "",
    stateDir: "",
    SERVER_VERSION: "",
    serveClientAsset: () => false,
    eventOffsetRef: { value: 0 },
    overlayCurrentRepo: () => {},
    detectCrossRepoDrift: () => [],
  } as unknown as RouteContext;
}

function freshRun(runDir: string, url: string, method = "GET"): Capture {
  process.env.MEGACOMPACT_COSINE_FP_BENCH = "1";
  process.env.MEGACOMPACT_COSINE_FP_BENCH_RUN_DIR = runDir;
  const { res, capture } = stubRes();
  handleCosineFpReport(makeReq(url, method), res, makeCtx());
  return capture;
}

describe("routes-cosine-fp", () => {
  let dir: string;

  test("flag-on 200: full CosineFpReportV1 shape with recommendation + digest", () => {
    const raw = committedAggregateRaw();
    assert.ok(raw !== null, "committed cosine-fp-report.json must exist");
    const aggregate = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(aggregate.status, "ok", "committed aggregate must be an ok bench");
    dir = mkdtempSync(join(tmpdir(), "cosfp-"));
    writeFileSync(join(dir, "cosine-fp-report.json"), raw, "utf8");

    const capture = freshRun(dir, "/api/cosine-fp-report");
    assert.equal(capture.status, 200);
    const body = JSON.parse(capture.body) as CosineFpReportV1;
    assert.equal(body.status, "live");
    assert.equal(body.benchStatus, "ok");
    assert.equal(typeof body.recommendedDefault, "number");
    assert.equal(typeof body.digest, "string");
    assert.equal(typeof body.shippedDefault, "number");
    assert.equal(body.overrides !== null, true);
    assert.equal(Array.isArray(body.rows), true);
    assert.equal(body.grid?.points, 37);
    assert.equal(body.corpusSummary?.items, 72);
    // Report digest passes through exactly; status is derived non-empty.
    assert.equal(body.digest, aggregate.digest);
    assert.ok(body.status.length > 0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing report file → awaiting_data, never a fabricated zero row", () => {
    dir = mkdtempSync(join(tmpdir(), "cosfp-"));
    const capture = freshRun(dir, "/api/cosine-fp-report");
    assert.equal(capture.status, 200);
    const body = JSON.parse(capture.body) as CosineFpReportV1;
    assert.equal(body.status, "awaiting_data");
    assert.equal(body.benchStatus, "awaiting_data");
    assert.equal(body.rows, null);
    assert.equal(body.recommendedDefault, null);
    assert.equal(body.digest, null);
    assert.equal(body.fpBudget, null);
    rmSync(dir, { recursive: true, force: true });
  });

  test("flag-off 404 — byte-identical predecessor", () => {
    const raw = committedAggregateRaw();
    assert.ok(raw !== null);
    dir = mkdtempSync(join(tmpdir(), "cosfp-"));
    writeFileSync(join(dir, "cosine-fp-report.json"), raw, "utf8");
    process.env.MEGACOMPACT_COSINE_FP_BENCH = "0";
    process.env.MEGACOMPACT_COSINE_FP_BENCH_RUN_DIR = dir;
    const { res, capture } = stubRes();
    handleCosineFpReport(makeReq("/api/cosine-fp-report", "GET"), res, makeCtx());
    assert.equal(capture.status, 404);
    const body = JSON.parse(capture.body) as { error: string };
    assert.equal(body.error, "not_found");
    rmSync(dir, { recursive: true, force: true });
    delete process.env.MEGACOMPACT_COSINE_FP_BENCH;
  });

  test("non-GET 405", () => {
    dir = mkdtempSync(join(tmpdir(), "cosfp-"));
    const capture = freshRun(dir, "/api/cosine-fp-report", "POST");
    assert.equal(capture.status, 405);
    rmSync(dir, { recursive: true, force: true });
  });
});
