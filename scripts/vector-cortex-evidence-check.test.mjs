/**
 * Tests for scripts/vector-cortex-evidence-check.mjs.
 *
 * Real end-to-end exercises against SYNTHETIC evidence fixtures written into a
 * temp repo skeleton: one record whose claims match the tree (passes) and one
 * whose claims are wrong in every checkable dimension (fails, with the exact
 * mismatch codes). No mocks — the checker reads real files and reports real
 * `wc -l` values, exactly as it does in the gate.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { checkEvidence, resolveClaimPath, listSprints } from "./vector-cortex-evidence-check.mjs";
import {
  parseLineClaims,
  parseTestClaims,
  parseFixtureClaims,
  parseStatus,
  parseAttestation,
  section,
} from "./vector-cortex-evidence-claims.mjs";

/** Build a throwaway repo skeleton; returns its root. */
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "vc-evidence-"));
  mkdirSync(join(root, "docs", "vector-cortex", "evidence"), { recursive: true });
  mkdirSync(join(root, "conformance", "vector-cortex", "v2"), { recursive: true });
  return root;
}

function writeFile(root, rel, contents) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, contents);
  return p;
}

/** A source file with exactly `n` lines (n-1 newlines + final LF). */
function sourceOfLines(n) {
  return `${Array.from({ length: n }, (_, i) => `// line ${i + 1}`).join("\n")}\n`;
}

function writeEvidence(root, sprint, body) {
  writeFile(root, `docs/vector-cortex/evidence/${sprint}.md`, body);
}

function writeManifest(root, fixtureCount) {
  writeFile(
    root,
    "conformance/vector-cortex/v2/manifest.json",
    JSON.stringify({ fixtures: Array.from({ length: fixtureCount }, (_, i) => ({ id: `F-${i}` })) }),
  );
}

function codes(result) {
  return result.problems.map((p) => p.code);
}

test("passing fixture: accurate claims validate clean", () => {
  const root = makeRepo();
  try {
    writeFile(root, "src/widget/alpha.ts", sourceOfLines(120));
    writeFile(root, "src/widget/beta.ts", sourceOfLines(87));
    writeManifest(root, 42);
    writeEvidence(
      root,
      "VCTEST",
      [
        "# VCTEST Evidence",
        "",
        "Status: implementer-complete",
        "",
        "## File sizes and baseline exceptions",
        "",
        "All new files within limits: `src/widget/alpha.ts` (120), src/widget/beta.ts 87.",
        "",
        "## Fixtures and corpus digests",
        "",
        "`node scripts/vector-cortex-conformance.mjs --check` -> 42 fixtures canonical (42 files).",
        "",
        "## Reviewer attestation",
        "",
        "Reviewed by R. Eviewer, 2026-08-03, reviewer-accepted.",
        "",
      ].join("\n"),
    );

    const res = checkEvidence("VCTEST", { root, run: false, latestSprint: "VCTEST" });
    assert.deepEqual(res.problems, [], `expected no problems, got ${JSON.stringify(res.problems)}`);
    assert.equal(res.warnings.length, 0, "attested record must not warn");
    assert.ok(res.checked >= 3, `expected >=3 validated claims, got ${res.checked}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failing fixture: wrong line counts and fixture count are caught with real values", () => {
  const root = makeRepo();
  try {
    writeFile(root, "src/widget/alpha.ts", sourceOfLines(120));
    writeManifest(root, 42);
    writeEvidence(
      root,
      "VCBAD",
      [
        "# VCBAD Evidence",
        "",
        "Status: implementer-complete",
        "",
        "## File sizes and baseline exceptions",
        "",
        "All new files within limits: `src/widget/alpha.ts` (99).",
        "",
        "## Fixtures and corpus digests",
        "",
        "-> 7 fixtures canonical (7 files).",
        "",
        "## Reviewer attestation",
        "",
        "Not yet attested - pending independent reviewer.",
        "",
      ].join("\n"),
    );

    const res = checkEvidence("VCBAD", { root, run: false, latestSprint: "VCBAD" });
    assert.ok(
      codes(res).includes("EVIDENCE_LINE_COUNT_MISMATCH"),
      `expected line-count mismatch, got ${JSON.stringify(codes(res))}`,
    );
    assert.ok(
      codes(res).includes("EVIDENCE_FIXTURE_COUNT_MISMATCH"),
      `expected fixture-count mismatch, got ${JSON.stringify(codes(res))}`,
    );
    // The report must print the REAL value so the controller can correct it.
    const lineProblem = res.problems.find((p) => p.code === "EVIDENCE_LINE_COUNT_MISMATCH");
    assert.match(lineProblem.detail, /actual 120/);
    assert.match(lineProblem.detail, /claims 99/);
    const fixtureProblem = res.problems.find((p) => p.code === "EVIDENCE_FIXTURE_COUNT_MISMATCH");
    assert.match(fixtureProblem.detail, /manifest has 42/);
    // implementer-complete + "Not yet attested" is a WARNING, never a failure.
    assert.deepEqual(
      res.warnings.map((w) => w.code),
      ["EVIDENCE_REVIEWER_ATTESTATION_MISSING"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("test-count and flag-parity claims run the real suite", () => {
  const root = makeRepo();
  try {
    // A genuine 2-test node:test file, executed for real by the checker.
    writeFile(
      root,
      "dist/vc/demo-acceptance.test.js",
      [
        'import { test } from "node:test";',
        'import assert from "node:assert/strict";',
        'test("a", () => assert.ok(true));',
        'test("b", () => assert.ok(true));',
        "",
      ].join("\n"),
    );
    writeFile(root, "package.json", JSON.stringify({ type: "module" }));

    writeEvidence(
      root,
      "VCRUN",
      [
        "# VCRUN Evidence",
        "",
        "Status: draft",
        "",
        "## Commands and verbatim summaries",
        "",
        "```bash",
        "node --test dist/vc/demo-acceptance.test.js",
        "# -> tests 2, pass 2",
        "MEGACOMPACT_VCRUN=0 node --test dist/vc/demo-acceptance.test.js",
        "# -> tests 2, pass 2",
        "```",
        "",
      ].join("\n"),
    );
    const ok = checkEvidence("VCRUN", { root, run: true, latestSprint: "VCRUN" });
    assert.deepEqual(ok.problems, [], `truthful counts must pass: ${JSON.stringify(ok.problems)}`);
    assert.ok(ok.checked >= 2, "both the flag-on and flag-off runs must be validated");

    // Same suite, but the record overstates the count in both flag states.
    writeEvidence(
      root,
      "VCRUNBAD",
      [
        "# VCRUNBAD Evidence",
        "",
        "Status: draft",
        "",
        "## Commands and verbatim summaries",
        "",
        "```bash",
        "node --test dist/vc/demo-acceptance.test.js",
        "# -> tests 25, pass 25",
        "MEGACOMPACT_VCRUNBAD=0 node --test dist/vc/demo-acceptance.test.js",
        "# -> tests 25, pass 25",
        "```",
        "",
      ].join("\n"),
    );
    const bad = checkEvidence("VCRUNBAD", { root, run: true, latestSprint: "VCRUNBAD" });
    assert.ok(codes(bad).includes("EVIDENCE_TEST_COUNT_MISMATCH"), JSON.stringify(codes(bad)));
    assert.ok(codes(bad).includes("EVIDENCE_FLAG_PARITY_MISMATCH"), JSON.stringify(codes(bad)));
    assert.match(
      bad.problems.find((p) => p.code === "EVIDENCE_TEST_COUNT_MISMATCH").detail,
      /actual tests 2 \/ pass 2/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a genuinely red suite fails even when the claimed count matches", () => {
  const root = makeRepo();
  try {
    writeFile(
      root,
      "dist/vc/red-acceptance.test.js",
      [
        'import { test } from "node:test";',
        'import assert from "node:assert/strict";',
        'test("a", () => assert.ok(true));',
        'test("b", () => assert.equal(1, 2));',
        "",
      ].join("\n"),
    );
    writeFile(root, "package.json", JSON.stringify({ type: "module" }));
    writeEvidence(
      root,
      "VCRED",
      [
        "# VCRED Evidence",
        "",
        "Status: draft",
        "",
        "## Commands",
        "",
        "```bash",
        "node --test dist/vc/red-acceptance.test.js",
        "# -> tests 2, pass 2",
        "```",
        "",
      ].join("\n"),
    );
    const res = checkEvidence("VCRED", { root, run: true, latestSprint: "VCRED" });
    assert.ok(
      codes(res).includes("EVIDENCE_TEST_COUNT_MISMATCH"),
      `a red suite claimed green must fail: ${JSON.stringify(res.problems)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("free-prose evidence with no concrete claims passes with a note", () => {
  const root = makeRepo();
  try {
    writeEvidence(
      root,
      "VCPROSE",
      ["# VCPROSE Evidence", "", "Status: draft", "", "Pure sprint - no migration.", ""].join("\n"),
    );
    const res = checkEvidence("VCPROSE", { root, run: false, latestSprint: "VCPROSE" });
    assert.deepEqual(res.problems, []);
    assert.equal(res.checked, 0);
    assert.ok(res.notes.some((n) => n.includes("no concrete claims")), JSON.stringify(res.notes));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing evidence record is itself a failure", () => {
  const root = makeRepo();
  try {
    const res = checkEvidence("VCNOPE", { root, run: false });
    assert.deepEqual(codes(res), ["EVIDENCE_MISSING"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("older records' fixture counts are historical, not failures", () => {
  const root = makeRepo();
  try {
    writeManifest(root, 270);
    const body = [
      "# VCOLD Evidence",
      "",
      "Status: draft",
      "",
      "## Fixtures and corpus digests",
      "",
      "-> 129 fixtures canonical (129 files).",
      "",
    ].join("\n");
    writeEvidence(root, "VCOLD", body);
    // Not the latest sprint -> historical note, no failure.
    const old = checkEvidence("VCOLD", { root, run: false, latestSprint: "VCNEW" });
    assert.deepEqual(old.problems, []);
    assert.ok(old.notes.some((n) => n.includes("historical")), JSON.stringify(old.notes));
    // The latest sprint IS held to HEAD.
    const latest = checkEvidence("VCOLD", { root, run: false, latestSprint: "VCOLD" });
    assert.deepEqual(codes(latest), ["EVIDENCE_FIXTURE_COUNT_MISMATCH"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ambiguous and missing paths are skipped with a note, never guessed", () => {
  const root = makeRepo();
  try {
    writeFile(root, "src/a/emit.ts", sourceOfLines(10));
    writeFile(root, "src/b/emit.ts", sourceOfLines(20));
    writeEvidence(
      root,
      "VCAMB",
      [
        "# VCAMB Evidence",
        "",
        "Status: draft",
        "",
        "## File sizes and baseline exceptions",
        "",
        "All new files within limits: emit.ts 10, src/ghost/nope.ts 44.",
        "",
      ].join("\n"),
    );
    const res = checkEvidence("VCAMB", { root, run: false, latestSprint: "VCAMB" });
    // Guessing one of the two emit.ts files would be a false verdict either way.
    assert.deepEqual(res.problems, []);
    assert.ok(res.notes.some((n) => n.includes("ambiguous path")), JSON.stringify(res.notes));
    assert.ok(res.notes.some((n) => n.includes("unresolved path")), JSON.stringify(res.notes));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveClaimPath resolves direct, suffix, ambiguous and missing", () => {
  const root = makeRepo();
  try {
    writeFile(root, "src/one/only.ts", sourceOfLines(3));
    writeFile(root, "src/x/dup.ts", sourceOfLines(3));
    writeFile(root, "src/y/dup.ts", sourceOfLines(3));
    assert.equal(resolveClaimPath(root, "src/one/only.ts").status, "resolved");
    assert.equal(resolveClaimPath(root, "only.ts").status, "resolved");
    assert.equal(resolveClaimPath(root, "one/only.ts").status, "resolved");
    assert.equal(resolveClaimPath(root, "dup.ts").status, "ambiguous");
    assert.equal(resolveClaimPath(root, "src/x/dup.ts").status, "resolved");
    assert.equal(resolveClaimPath(root, "absent.ts").status, "missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listSprints enumerates evidence records in order", () => {
  const root = makeRepo();
  try {
    writeEvidence(root, "VC1A", "Status: draft\n");
    writeEvidence(root, "VC0A", "Status: draft\n");
    assert.deepEqual(listSprints(root), ["VC0A", "VC1A"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- parser units

test("line claims are scoped to the File sizes section", () => {
  // A bare `(12)` after a test file in the Evaluation section is a TEST count,
  // not a line count; parsing it as lines would be a false positive.
  const md = [
    "## Evaluation",
    "",
    "Cortex unit suites: `sqlite.test.js` (12) + `contract.test.js` (13).",
    "",
    "## File sizes and baseline exceptions",
    "",
    "All new files within limits: `src/ledger/store.ts` (380), types.ts 141.",
    "",
  ].join("\n");
  const claims = parseLineClaims(md);
  assert.deepEqual(
    claims.map((c) => `${c.path}:${c.lines}`).sort(),
    ["src/ledger/store.ts:380", "types.ts:141"],
  );
});

test("line claims accept the '(N lines)' spelling", () => {
  const md = ["## File sizes", "", "`src/vc/triadB-reader.ts` (110 lines).", ""].join("\n");
  assert.deepEqual(parseLineClaims(md), [
    { path: "src/vc/triadB-reader.ts", lines: 110, raw: "`src/vc/triadB-reader.ts` (110 lines)" },
  ]);
});

test("an unrelated whole-suite TOTAL is not attributed to a unit test", () => {
  // Regression: a greedy window read "TOTAL: 1701 passed" as heads.test.js's count.
  const md =
    "- Unit: `node --test dist/src/vc/heads.test.js` -> 11 pass / 0 fail. " +
    "Full `npm test` gate: `TOTAL: 1701 passed, 0 failed across 207 files`.";
  const claims = parseTestClaims(md);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].pass, 11, `expected the unit count, got ${claims[0].pass}`);
});

test("test claims capture flag-off parity invocations", () => {
  const md = [
    "```bash",
    "node --test dist/vector-cortex/vc1b-acceptance.test.js",
    "# -> tests 25, pass 25",
    "MEGACOMPACT_VC1B=0 node --test dist/vector-cortex/vc1b-acceptance.test.js",
    "# -> tests 25, pass 25",
    "```",
  ].join("\n");
  const claims = parseTestClaims(md);
  const off = claims.find((c) => c.flagOff);
  assert.ok(off, "flag-off invocation must be captured");
  assert.equal(off.flagVar, "MEGACOMPACT_VC1B");
  assert.equal(off.tests, 25);
  assert.ok(claims.some((c) => !c.flagOff), "flag-on invocation must be captured too");
});

test("fixture, status, attestation and section parsing", () => {
  assert.deepEqual(
    parseFixtureClaims("-> 270 fixtures canonical (270 files).").map((c) => c.count),
    [270],
  );
  assert.deepEqual(parseFixtureClaims("manifest: 88 rows").map((c) => c.count), [88]);
  assert.equal(parseStatus("Status: implementer-complete\n"), "implementer-complete");
  assert.equal(parseAttestation("## Reviewer attestation\n\nNot yet attested.\n").present, false);
  assert.equal(parseAttestation("## Reviewer attestation\n\nAcme, 2026-01-01, accepted.\n").present, true);
  assert.equal(parseAttestation("# no section").present, false);
  assert.equal(section("## A\n\nbody\n\n## B\n\nother", "A").trim(), "body");
  assert.equal(section("# none", "A"), "");
});
