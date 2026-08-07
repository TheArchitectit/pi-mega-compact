/**
 * vector-cortex/repo-corpus/negative.test.ts — REPO-A missing-consent refusal.
 *
 * Drives the committed corpus-builder (scripts/repo-corpus/build.mjs) against a
 * synthetic repo set (from the committed test-consent fixture REPO-A-NEG-001)
 * where ONE repo has revoked cross-repo consent. Asserts the builder returns
 * REPO_CORPUS_CONSENT_REQUIRED, ZERO bytes are written (--corpus-out/manifest.json
 * does NOT exist), and a `repo_corpus_consent_refused` line is appended WITHOUT
 * payload content (repoPseudonym + effectiveSeq + refusalCode only — never
 * matched text / checkpoint / events paths). No mocks, no stubs — the committed
 * build.mjs runs unmodified.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function repoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "scripts", "repo-corpus"))) return dir;
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  throw new Error("scripts/repo-corpus not found above " + from);
}

const ROOT = repoRoot(HERE);
const BUILD = join(ROOT, "scripts", "repo-corpus", "build.mjs");
const V2 = join(ROOT, "conformance", "vector-cortex", "v2");
const NEG_FIXTURE = join(V2, "repo-corpus", "test-consent", "REPO-A-NEG-001.json");

interface NegFixture {
  id: string;
  grantedRepoPseudonyms: string[];
  revokedRepoPseudonym: string;
  eventsPerRepo: number;
  refusal: string;
  zeroBytesWritten: boolean;
  logsRefusalEvent: boolean;
}

function readNegFixture(): NegFixture {
  return JSON.parse(readFileSync(NEG_FIXTURE, "utf8")) as NegFixture;
}

function runBuild(
  dir: string,
  request: unknown,
): { code: number; stdout: string; audit: string } {
  const reqPath = join(dir, "request.json");
  writeFileSync(reqPath, JSON.stringify(request), "utf8");
  const audit = join(dir, "audit.log");
  const out = join(dir, "corpus-out");
  const r = spawnSync(
    process.execPath,
    [BUILD, "--manifest", reqPath, "--corpus-out", out, "--audit", audit],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
  );
  return {
    code: r.status ?? -1,
    stdout: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    audit,
  };
}

describe("REPO-A negative consent (committed build.mjs)", () => {
  test("one revoked repo refuses the whole build: REPO_CORPUS_CONSENT_REQUIRED + zero bytes + pseudonymous refusal log", () => {
    const fx = readNegFixture();
    const dir = mkdtempSync(join(tmpdir(), "repo-neg-"));
    const owner = "owner-a";

    const stateA = join(dir, "repoA");
    const stateB = join(dir, "repoB");
    mkdirSync(stateA, { recursive: true });
    mkdirSync(stateB, { recursive: true });

    // Synthetic events.log slices — IDs/counts only, never payload content.
    const sess = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ event: "c", session: `${prefix}-${i}` }));
    writeFileSync(join(stateA, "events.log"), sess("sess-a", fx.eventsPerRepo).map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    writeFileSync(join(stateB, "events.log"), sess("sess-b", fx.eventsPerRepo).map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    const mkRec = (pseud: string, id: string, action: string, seq: number) => ({
      consentId: id,
      ownerPseudonym: owner,
      repoPseudonym: pseud,
      scope: "cross-repo",
      purpose: "corpus",
      datasetVersion: "2026-08-07",
      ts: seq,
      policyVersion: "1",
      action,
      sourceEventId: id,
      effectiveSeq: seq,
    });

    // Repo A: full cross-repo grant.
    const pA = fx.grantedRepoPseudonyms[0]!;
    const logA = join(dir, "consentA.jsonl");
    writeFileSync(logA, JSON.stringify(mkRec(pA, "g-a", "grant", 1000)) + "\n", "utf8");

    // Repo B: granted then REVOKED → cross-repo consent must be absent/revoked.
    const pB = fx.revokedRepoPseudonym;
    const logB = join(dir, "consentB.jsonl");
    writeFileSync(
      logB,
      JSON.stringify(mkRec(pB, "g-b", "grant", 1000)) + "\n" +
        JSON.stringify(mkRec(pB, "r-b", "revoke", 9000)) + "\n",
      "utf8",
    );

    const request = {
      schema: "repo-corpus-request-v1",
      ownerPseudonym: owner,
      datasetVersion: "2026-08-07",
      repos: [
        { stateDir: stateA, repoPseudonym: pA, consentLog: logA, ownerAttestation: owner },
        { stateDir: stateB, repoPseudonym: pB, consentLog: logB, ownerAttestation: owner },
      ],
    };

    const { code, stdout, audit } = runBuild(dir, request);

    // 1. Refusal code.
    assert.equal(
      code,
      3,
      `builder must refuse with exit 3 (consent required), got ${code}: ${stdout}`,
    );
    assert.match(stdout, new RegExp(fx.refusal), `refusal names ${fx.refusal}`);

    // 2. Zero bytes written — the corpus manifest must NOT exist.
    assert.equal(
      existsSync(join(dir, "corpus-out", "manifest.json")),
      false,
      "no manifest.json may be written on consent refusal (zero bytes)",
    );

    // 3. Pseudonymous refusal audit — no payload content.
    assert.equal(fx.logsRefusalEvent, true);
    const auditLines = readFileSync(audit, "utf8").trim().split("\n").filter(Boolean);
    const refused = auditLines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.event === "repo_corpus_consent_refused");
    assert.ok(refused, "a repo_corpus_consent_refused line must be appended");
    assert.equal(refused["repoPseudonym"], pB);
    assert.equal(typeof refused["effectiveSeq"], "number");
    assert.equal(refused["refusalCode"], fx.refusal);
    const keys = Object.keys(refused).sort();
    // Only ts/event/pseudonym/seq/refusalCode — NEVER matched text or paths.
    assert.deepEqual(keys, ["effectiveSeq", "event", "refusalCode", "repoPseudonym", "ts"]);

    rmSync(dir, { recursive: true, force: true });
  });
});
