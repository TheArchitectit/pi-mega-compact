/**
 * vector-cortex/repo-corpus/consent.test.ts — REPO-A consent-resolution
 * determinism (real committed consent.mjs via its CLI seam).
 *
 * Exercises the ACTUAL append-only consent helpers: append → resolve → assert
 * grant; append a revoke → resolve asserts revoke subordinates the prior grant
 * from its effectiveSeq onward (instant freeze); a grant with an explicit
 * effectiveSeq resolves deterministically. Also validates consentCoversCrossRepo
 * semantics end-to-end by driving the committed corpus-builder (build.mjs) with
 * a fully-granted 2-repo corpus (covers cross-repo → ok) vs the same corpus with
 * the second repo revoked (→ REPO_CORPUS_CONSENT_REQUIRED). No mocks, no stubs —
 * the committed scripts run unmodified. No import of .mjs modules (PREVENT-011).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
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
const CONSENT = join(ROOT, "scripts", "repo-corpus", "consent.mjs");
const BUILD = join(ROOT, "scripts", "repo-corpus", "build.mjs");

function runNode(script: string, args: string[]): { code: number; stdout: string } {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  return { code: r.status ?? -1, stdout: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** The consent CLI derives the pseudonym from the repo's `git remote get-url
 *  origin` (local, read-only). We drive it through a REAL temp git repo whose
 *  origin remote resolves deterministically, so append and resolve agree on the
 *  same repoPseudonym without any mocked helpers. */
function initGitRoot(dir: string): string {
  const root = join(dir, "gitroot");
  mkdirSync(root, { recursive: true });
  const init = spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
  // SSH-style remote (no http(s) token) so the local-only guardrail does not
  // trip on a literal URL; git resolves the pseudonym purely from the string.
  const remote = spawnSync(
    "git",
    ["remote", "add", "origin", "git@example.invalid:owner/synthetic-corpus.git"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(remote.status, 0, `git remote add failed: ${remote.stderr}`);
  return root;
}

function appendConsent(
  log: string,
  owner: string,
  scope: string,
  action: string,
  seq: number,
  root: string,
): void {
  // consent.mjs takes --repo-git-root (for pseudonym derive) + --audit.
  const r = runNode(CONSENT, [
    "append",
    "--repo-git-root",
    root,
    "--owner",
    owner,
    "--scope",
    scope,
    "--purpose",
    "corpus",
    "--dataset-version",
    "2026-08-07",
    "--action",
    action,
    "--effective-seq",
    String(seq),
    "--audit",
    log,
    "--source-event-id",
    `evt-${seq}`,
  ]);
  assert.equal(r.code, 0, `consent append failed: ${r.stdout}`);
}

describe("REPO-A consent resolution (real consent.mjs)", () => {
  let dir: string;
  let log: string;

  test("append grant → resolve cross-repo = granted (deterministic)", () => {
    dir = mkdtempSync(join(tmpdir(), "repo-consent-"));
    log = join(dir, "consent.jsonl");
    const root = initGitRoot(dir);
    appendConsent(log, "owner-a", "cross-repo", "grant", 1000, root);
    const r = runNode(CONSENT, ["resolve", "--repo-git-root", root, "--seq", "1500", "--audit", log]);
    assert.equal(r.code, 0, r.stdout);
    const out = JSON.parse(r.stdout.trim()) as { action: string };
    assert.equal(out.action, "grant");
    rmSync(dir, { recursive: true, force: true });
  });

  test("revoke subordinates a prior grant from effectiveSeq onward (instant freeze)", () => {
    dir = mkdtempSync(join(tmpdir(), "repo-consent-"));
    log = join(dir, "consent.jsonl");
    const root = initGitRoot(dir);
    appendConsent(log, "owner-a", "cross-repo", "grant", 1000, root);
    appendConsent(log, "owner-a", "cross-repo", "revoke", 5000, root);
    // Before the revoke's effectiveSeq the grant stands.
    const before = runNode(CONSENT, ["resolve", "--repo-git-root", root, "--seq", "3000", "--audit", log]);
    assert.equal(JSON.parse(before.stdout.trim()).action, "grant");
    // At/after the revoke's effectiveSeq the scope is frozen revoked.
    const after = runNode(CONSENT, ["resolve", "--repo-git-root", root, "--seq", "5000", "--audit", log]);
    const afterOut = JSON.parse(after.stdout.trim()) as { action: string; revokedAtSeq: number | null };
    assert.equal(afterOut.action, "revoke");
    assert.equal(afterOut.revokedAtSeq, 5000);
    const later = runNode(CONSENT, ["resolve", "--repo-git-root", root, "--seq", "9000", "--audit", log]);
    assert.equal(JSON.parse(later.stdout.trim()).action, "revoke");
    rmSync(dir, { recursive: true, force: true });
  });

  test("consentCoversCrossRepo via builder: full 2-repo grant builds; one revoked refuses", () => {
    dir = mkdtempSync(join(tmpdir(), "repo-consent-"));
    const stateA = join(dir, "repoA");
    const stateB = join(dir, "repoB");
    mkdirSync(stateA, { recursive: true });
    mkdirSync(stateB, { recursive: true });
    // Synthetic events.log slices (IDs/counts only — never payload content).
    writeFileSync(join(stateA, "events.log"), '{"event":"c","session":"sess-1"}\n{"event":"c","session":"sess-2"}\n', "utf8");
    writeFileSync(join(stateB, "events.log"), '{"event":"c","session":"sess-3"}\n', "utf8");
    const logA = join(stateA, ".consent.jsonl");
    const logB = join(stateB, ".consent.jsonl");
    // The builder's reader derives cross-repo consent from each repo's consent
    // log. Seed the manifest with explicit repoPseudonyms so the builder does
    // not need a real git remote.
    const owner = "owner-a";
    const pA = "aaaaaaaaaaaaaaaa";
    const pB = "bbbbbbbbbbbbbbbb";
    // Full grant for both → build succeeds.
    const grantA = { consentId: "g-a", ownerPseudonym: owner, repoPseudonym: pA, scope: "cross-repo", purpose: "corpus", datasetVersion: "2026-08-07", ts: 1000, policyVersion: "1", action: "grant", sourceEventId: "g-a", effectiveSeq: 1000 };
    writeFileSync(logA, JSON.stringify(grantA) + "\n", "utf8");
    const grantB = { ...grantA, consentId: "g-b", repoPseudonym: pB, sourceEventId: "g-b" };
    writeFileSync(logB, JSON.stringify(grantB) + "\n", "utf8");

    let out = join(dir, "out1");
    let req = {
      schema: "repo-corpus-request-v1",
      ownerPseudonym: owner,
      datasetVersion: "2026-08-07",
      repos: [
        { stateDir: stateA, repoPseudonym: pA, consentLog: logA, ownerAttestation: owner },
        { stateDir: stateB, repoPseudonym: pB, consentLog: logB, ownerAttestation: owner },
      ],
    };
    let reqPath = join(dir, "req1.json");
    writeFileSync(reqPath, JSON.stringify(req), "utf8");
    let r1 = runNode(BUILD, ["--manifest", reqPath, "--corpus-out", out, "--audit", join(dir, "audit1.log")]);
    assert.equal(r1.code, 0, `full-grant build should succeed: ${r1.stdout}`);
    assert.ok(existsSync(join(out, "manifest.json")), "manifest written on full grant");
    // The builder also emits the consent-state the reader route projects.
    const csPath = join(out, "consent-state.json");
    assert.ok(existsSync(csPath), "consent-state written on full grant");
    const cs = JSON.parse(readFileSync(csPath, "utf8")) as {
      schema: string;
      perRepo: { repoPseudonym: string; consentedCrossRepo: boolean }[];
    };
    assert.equal(cs.schema, "repo-corpus-consent-state-v1");
    assert.equal(cs.perRepo.length, 2);
    const csByPseud = new Map(cs.perRepo.map((r) => [r.repoPseudonym, r]));
    assert.equal(csByPseud.get(pA)!.consentedCrossRepo, true);
    assert.equal(csByPseud.get(pB)!.consentedCrossRepo, true);

    // Revoke repo B → whole build refuses, zero bytes written.
    const revokeB = { ...grantB, consentId: "r-b", action: "revoke", sourceEventId: "r-b", effectiveSeq: 9000, ts: 9000 };
    writeFileSync(logB, JSON.stringify(revokeB) + "\n", "utf8");
    let out2 = join(dir, "out2");
    let r2 = runNode(BUILD, ["--manifest", reqPath, "--corpus-out", out2, "--audit", join(dir, "audit2.log")]);
    assert.equal(r2.code, 3, `revoked build must refuse with exit 3, got: ${r2.stdout}`);
    assert.ok(
      /REPO_CORPUS_CONSENT_REQUIRED/.test(r2.stdout),
      `refusal must name REPO_CORPUS_CONSENT_REQUIRED: ${r2.stdout}`,
    );
    assert.ok(!existsSync(join(out2, "manifest.json")), "zero bytes written on refusal");
    rmSync(dir, { recursive: true, force: true });
  });
});
