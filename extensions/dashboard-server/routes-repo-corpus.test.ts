/**
 * routes-repo-corpus.test.ts — REPO-A cross-repo corpus status route.
 *
 * Exercises handleRepoCorpus against a synthetic corpus dir (via the
 * MEGACOMPACT_REPO_CORPUS_DIR seam): flag-on 200 with the full RepoCorpusStatusV1
 * contract, flag-off 404 (byte-identical predecessor), non-GET 405, and a
 * missing-stateDir repo degrading to consentedCrossRepo:false (never a crash).
 * Synthetic pseudonymous corpus — no user data, no real remotes, no payload
 * content. No import of script modules (no `any`, distribution seam intact).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes-core.js";
import { handleRepoCorpus } from "./routes-repo-corpus.js";
import type { RepoCorpusStatusV1 } from "./api-contracts/repo-corpus.js";

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

/**
 * Canonical 3-repo manifest with full cross-repo consent + one recorded overlap.
 */
function sampleManifest() {
  return {
    schema: "repo-corpus-manifest-v1",
    ownerPseudonym: "owner-a",
    datasetVersion: "2026-08-07",
    effectiveSeq: 1000,
    totalEvents: 14,
    repos: [
      {
        repoPseudonym: "1111111111111111",
        sessions: 3,
        sessionIds: ["sess-repo-1-a", "sess-repo-1-b", "sess-repo-1-c"],
        events: 5,
        digest: "d1",
      },
      {
        repoPseudonym: "2222222222222222",
        sessions: 2,
        sessionIds: ["sess-repo-2-a", "sess-repo-2-b"],
        events: 4,
        digest: "d2",
      },
      {
        repoPseudonym: "3333333333333333",
        sessions: 3,
        sessionIds: ["sess-repo-3-a", "sess-repo-3-b", "sess-repo-3-c"],
        events: 5,
        digest: "d3",
      },
    ],
    overlaps: [
      {
        repoA: "1111111111111111",
        repoB: "2222222222222222",
        sharedSessions: 1,
        sharedIds: ["sess-repo-1-b"],
      },
    ],
  };
}

function writeSampleCorpus(dir: string): void {
  // Repo "3333333333333333" has NO consent row → its stateDir is gone/missing,
  // so the route degrades it to consentedCrossRepo:false (never a crash).
  const consentState = {
    schema: "repo-corpus-consent-state-v1",
    perRepo: [
      { repoPseudonym: "1111111111111111", consentedCrossRepo: true },
      { repoPseudonym: "2222222222222222", consentedCrossRepo: true, revokedAt: undefined },
    ],
  };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(sampleManifest())}\n`, "utf8");
  writeFileSync(join(dir, "consent-state.json"), `${JSON.stringify(consentState)}\n`, "utf8");
}

describe("routes-repo-corpus", () => {
  let dir: string;

  test("flag-on 200: full RepoCorpusStatusV1 contract + missing-stateDir degrade", () => {
    dir = mkdtempSync(join(tmpdir(), "repocorpus-"));
    writeSampleCorpus(dir);
    process.env.MEGACOMPACT_REPO_CORPUS = "1";
    process.env.MEGACOMPACT_REPO_CORPUS_DIR = dir;
    const { res, capture } = stubRes();
    handleRepoCorpus(makeReq("/api/repo-corpus", "GET"), res, makeCtx());
    assert.equal(capture.status, 200);
    const body = JSON.parse(capture.body) as RepoCorpusStatusV1;
    assert.equal(body.schema, "repo-corpus-status-v1");
    assert.equal(body.status, "live");
    assert.equal(body.totalEvents, 14);
    assert.notEqual(body.corpus, null);
    assert.equal(body.corpus!.schema, "repo-corpus-manifest-v1");
    assert.equal(body.corpus!.repos.length, 3);
    assert.equal(body.corpus!.overlaps.length, 1);
    assert.equal(body.corpus!.overlaps[0]!.sharedSessions, 1);
    // perRepo merges consent state.
    assert.equal(body.perRepo.length, 3);
    const byPseud = new Map(body.perRepo.map((r) => [r.repoPseudonym, r]));
    assert.equal(byPseud.get("1111111111111111")!.consentedCrossRepo, true);
    assert.equal(byPseud.get("2222222222222222")!.consentedCrossRepo, true);
    // Missing-stateDir repo degrades to false, NOT a crash.
    assert.equal(byPseud.get("3333333333333333")!.consentedCrossRepo, false);
    assert.ok(body.status.length > 0);
    rmSync(dir, { recursive: true, force: true });
    delete process.env.MEGACOMPACT_REPO_CORPUS_DIR;
    delete process.env.MEGACOMPACT_REPO_CORPUS;
  });

  test("absent corpus → awaiting_data, never a fabricated zero row", () => {
    dir = mkdtempSync(join(tmpdir(), "repocorpus-"));
    process.env.MEGACOMPACT_REPO_CORPUS = "1";
    process.env.MEGACOMPACT_REPO_CORPUS_DIR = dir;
    const { res, capture } = stubRes();
    handleRepoCorpus(makeReq("/api/repo-corpus", "GET"), res, makeCtx());
    assert.equal(capture.status, 200);
    const body = JSON.parse(capture.body) as RepoCorpusStatusV1;
    assert.equal(body.status, "awaiting_data");
    assert.equal(body.corpus, null);
    assert.equal(body.perRepo.length, 0);
    assert.equal(body.totalEvents, 0);
    rmSync(dir, { recursive: true, force: true });
    delete process.env.MEGACOMPACT_REPO_CORPUS_DIR;
    delete process.env.MEGACOMPACT_REPO_CORPUS;
  });

  test("flag-off 404 — byte-identical predecessor", () => {
    dir = mkdtempSync(join(tmpdir(), "repocorpus-"));
    writeSampleCorpus(dir);
    process.env.MEGACOMPACT_REPO_CORPUS = "0";
    process.env.MEGACOMPACT_REPO_CORPUS_DIR = dir;
    const { res, capture } = stubRes();
    handleRepoCorpus(makeReq("/api/repo-corpus", "GET"), res, makeCtx());
    assert.equal(capture.status, 404);
    const body = JSON.parse(capture.body) as { error: string };
    assert.equal(body.error, "not_found");
    rmSync(dir, { recursive: true, force: true });
    delete process.env.MEGACOMPACT_REPO_CORPUS_DIR;
    delete process.env.MEGACOMPACT_REPO_CORPUS;
  });

  test("non-GET 405", () => {
    dir = mkdtempSync(join(tmpdir(), "repocorpus-"));
    writeSampleCorpus(dir);
    process.env.MEGACOMPACT_REPO_CORPUS = "1";
    process.env.MEGACOMPACT_REPO_CORPUS_DIR = dir;
    const { res, capture } = stubRes();
    handleRepoCorpus(makeReq("/api/repo-corpus", "POST"), res, makeCtx());
    assert.equal(capture.status, 405);
    rmSync(dir, { recursive: true, force: true });
    delete process.env.MEGACOMPACT_REPO_CORPUS_DIR;
    delete process.env.MEGACOMPACT_REPO_CORPUS;
  });
});
