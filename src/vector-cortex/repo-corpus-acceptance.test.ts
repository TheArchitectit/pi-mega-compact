/** REPO-A acceptance aggregator (fixture registration + contract scan, no mocks).
 *
 *  Asserts the cross-repo corpus fixtures REPO-A-001..003 are registered in the
 *  v2 manifest with the repo-corpus algorithm/schema, that their envelopes carry
 *  the expected reader-route posture (live / off), that REPO-A-003 (flag-off)
 *  omits the manifest key entirely, and that the flag surface stays boolean and
 *  flag-agnostic (passes with MEGACOMPACT_REPO_CORPUS ON or OFF).
 *
 *  Local file reads only, zero network. All imports stay within src/ so the
 *  legacy mirrored dist publishes it (ENC-0g lesson).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { REPO_CORPUS_ENABLED } from "../config/vector-cortex.js";

const HERE = dirname(fileURLToPath(import.meta.url));
function repoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "conformance", "vector-cortex"))) return dir;
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  throw new Error("conformance corpus not found above " + from);
}
const ROOT = repoRoot(HERE);
const V2 = join(ROOT, "conformance", "vector-cortex", "v2");

const REPO_A_IDS = ["REPO-A-001", "REPO-A-002", "REPO-A-003"] as const;

interface ManifestRow {
  id: string;
  path: string;
  algorithm: string;
  schema?: string;
  expected: string;
}
interface Manifest { owner: string; domain: string; fixtures: ManifestRow[] }
interface RepoCorpusFixture {
  id: string;
  producer: string;
  assertion: string;
  kind: string;
  flag_off: boolean;
  schema?: string;
  manifest?: {
    schema: string;
    totalEvents: number;
    repos: { repoPseudonym: string }[];
    overlaps: { sharedSessions: number }[];
  };
  expected: { manifest_written: boolean; overlap_count?: number; route_status: string };
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(V2, "manifest.json"), "utf8")) as Manifest;
}
function fixture(id: string): RepoCorpusFixture {
  const row = readManifest().fixtures.find(
    (f) => f.id === id && f.path.startsWith("repo-corpus/"),
  );
  if (!row) throw new Error(`fixture ${id} not registered in manifest`);
  const path = join(V2, row.path);
  return JSON.parse(readFileSync(path, "utf8")) as RepoCorpusFixture;
}

describe("REPO-A fixture registration + kind-closure", () => {
  test("manifest registers REPO-A-001..003 with algorithm repo-corpus + the schema", () => {
    const m = readManifest();
    const expectedById: Record<string, string> = {
      "REPO-A-001": "ok",
      "REPO-A-002": "ok",
      "REPO-A-003": "flag-off",
    };
    for (const id of REPO_A_IDS) {
      const row = m.fixtures.find((f) => f.id === id && f.path.startsWith("repo-corpus/"));
      assert.ok(row, `${id} registered in manifest`);
      assert.equal(row!.algorithm, "repo-corpus", `${id} algorithm`);
      assert.equal(row!.path, `repo-corpus/${id}.json`, `${id} path`);
      assert.equal(
        row!.schema,
        "schemas/repo-corpus-manifest.schema.json",
        `${id} schema`,
      );
      assert.equal(row!.expected, expectedById[id]!, `${id} expected`);
    }
  });

  test("REPO-A-NEG-001 negative-consent fixture is registered with expected negative", () => {
    const row = readManifest().fixtures.find(
      (f) => f.id === "REPO-A-NEG-001" && f.path.startsWith("repo-corpus/test-consent/"),
    );
    assert.ok(row, "REPO-A-NEG-001 registered in manifest");
    assert.equal(row!.algorithm, "repo-corpus", "NEG algorithm");
    assert.equal(row!.expected, "negative", "NEG expected");
  });

  test("owner REPO-A is registered in the manifest owner CSV", () => {
    const owners = readManifest().owner.split(",").map((s) => s.trim());
    assert.ok(owners.includes("REPO-A"), "owner REPO-A present");
  });

  test("domain repo-corpus is registered in the manifest domain CSV", () => {
    const domains = readManifest().domain.split(/[;,]/).map((s) => s.trim());
    assert.ok(domains.includes("repo-corpus"), "domain repo-corpus present");
  });
});

describe("REPO-A fixture envelope posture", () => {
  test("REPO-A-001 + REPO-A-002 are live corpora with a manifest and expected route live", () => {
    for (const id of ["REPO-A-001", "REPO-A-002"] as const) {
      const fx = fixture(id);
      assert.equal(fx.kind, "repo-corpus", `${id} kind`);
      assert.equal(fx.flag_off, false, `${id} not flag-off`);
      assert.equal(fx.expected.route_status, "live", `${id} route status`);
      assert.equal(fx.expected.manifest_written, true, `${id} manifest written`);
      assert.equal(fx.manifest?.schema, "repo-corpus-manifest-v1", `${id} manifest schema`);
      assert.ok((fx.manifest?.repos.length ?? 0) > 0, `${id} has repos`);
      assert.equal(typeof fx.expected.overlap_count, "number", `${id} overlap count`);
    }
  });

  test("REPO-A-001 claims a real cross-repo overlap; REPO-A-002 claims none", () => {
    const a1 = fixture("REPO-A-001");
    const a2 = fixture("REPO-A-002");
    assert.equal(a1.manifest!.overlaps.length, 1, "REPO-A-001 has one overlap");
    assert.equal(a1.expected.overlap_count, 1, "REPO-A-001 overlap count ff");
    assert.ok(
      (a1.manifest!.overlaps[0]?.sharedSessions ?? 0) > 0,
      "REPO-A-001 shared sessions present",
    );
    assert.equal(a2.manifest!.overlaps.length, 0, "REPO-A-002 no overlaps");
    assert.equal(a2.expected.overlap_count, 0, "REPO-A-002 overlap count 0");
  });

  test("REPO-A-003 (flag-off) is a valid fixture with route off and NO manifest key", () => {
    const fx = fixture("REPO-A-003");
    assert.equal(fx.kind, "repo-corpus", "REPO-A-003 kind");
    assert.equal(fx.flag_off, true, "REPO-A-003 flag-off");
    assert.equal(fx.expected.route_status, "off", "REPO-A-003 route off");
    assert.equal(fx.expected.manifest_written, false, "REPO-A-003 no manifest written");
    assert.equal("manifest" in fx, false, "REPO-A-003 omits the manifest key entirely");
  });
});

describe("REPO-A flag invariants (flag-agnostic)", () => {
  test("flag state is a live boolean regardless of env", () => {
    const saved = process.env.MEGACOMPACT_REPO_CORPUS;
    try {
      delete process.env.MEGACOMPACT_REPO_CORPUS;
      assert.equal(typeof REPO_CORPUS_ENABLED(), "boolean");
      process.env.MEGACOMPACT_REPO_CORPUS = "0";
      assert.equal(REPO_CORPUS_ENABLED(), false);
      process.env.MEGACOMPACT_REPO_CORPUS = "1";
      assert.equal(REPO_CORPUS_ENABLED(), true);
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_REPO_CORPUS;
      else process.env.MEGACOMPACT_REPO_CORPUS = saved;
    }
  });
});

describe("REPO-A settings toggle registration", () => {
  test("the flag is registered as a VECTOR_CORTEX_SETTINGS boolDirect toggle (never excluded)", () => {
    const src = readFileSync(
      join(ROOT, "extensions", "dashboard-server", "routes-rag-settings-vector-cortex.ts"),
      "utf8",
    );
    assert.match(src, /"MEGACOMPACT_REPO_CORPUS"/, "flag registered in VECTOR_CORTEX_SETTINGS");
    const excluded = src.match(/EXCLUDED_SETTINGS[^;]*;/s);
    if (excluded) {
      assert.doesNotMatch(excluded[0], /MEGACOMPACT_REPO_CORPUS/, "flag NOT in EXCLUDED_SETTINGS");
    }
  });
});
