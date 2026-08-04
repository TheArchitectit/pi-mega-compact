/**
 * manifest.test.ts — FixtureManifestV2 canonical manifest unit tests (VC1C).
 *
 * Validates the manifest reader/validator against TEMP conformance roots so the
 * committed corpus stays canonical: canonical manifests (shuffled key order)
 * converge to one digest; injected extra / missing / digest-drift mutations are
 * rejected with the frozen codes; and the real committed corpus itself passes.
 *
 * Pure FS + pure predicates — no network, no side effects on authority data.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONF_FAIL,
  readFixtureManifestV2,
  validateCanonicalV2,
  canonicalManifestsConverge,
  domainOf,
  type FixtureManifestEntry,
  type ManifestValidateResult,
} from "./manifest.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Walk up from the test location until the conformance corpus is found. */
function repoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "conformance", "vector-cortex"))) return dir;
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  throw new Error("vc1c conformance corpus not found above " + from);
}
const REPO_ROOT = repoRoot(HERE);
const V2 = join(REPO_ROOT, "conformance", "vector-cortex", "v2");

/** Build a temp conformance root with a small canonical corpus. */
function tempRoot(opts?: {
  extra?: string; // extra file path to inject
  mutate?: { path: string; content: string }; // overwrite a committed fixture
  entryContent?: string; // an unlisted-but-manifest-listed file content override
  manifestOverride?: string;
}): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "vc1c-manifest-"));
  mkdirSync(join(root, "events"));
  // Fixture bytes written in canonical key order (id, kind) so the file's
  // canonical digest equals the digest stored in the manifest.
  const fixtureCanonical = '{"id":"EVT-001","kind":"event-v2"}\n';
  writeFileSync(join(root, "events", "EVT-001.json"), fixtureCanonical);
  const digest = createHash("sha256").update(fixtureCanonical).digest("hex");
  // Manifest written with keys sorted by UTF-8 bytes (fixtures < owner < version)
  // and each fixture entry in canonical order (algorithm, expected, id, path,
  // sha256) so validateCanonicalV2 accepts it as canonical.
  const manifest =
    '{"fixtures":[{"algorithm":"event-v2","expected":"ok","id":"EVT-001","path":"events/EVT-001.json","sha256":"' +
    digest +
    '"}],"owner":"vc1c","version":"2"}\n';
  writeFileSync(join(root, "manifest.json"), manifest);

  if (opts?.extra) {
    writeFileSync(join(root, opts.extra), JSON.stringify({ x: 1 }) + "\n");
  }
  if (opts?.mutate) {
    writeFileSync(join(root, opts.mutate.path), opts.mutate.content);
  }
  if (opts?.manifestOverride) {
    writeFileSync(join(root, "manifest.json"), opts.manifestOverride);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("canonical manifests converge", () => {
  test("validateCanonicalV2 passes on a canonical corpus", () => {
    const { root, cleanup } = tempRoot();
    try {
      const v = validateCanonicalV2(root) as { ok: true; entryCount: number };
      assert.equal(v.ok, true);
      assert.equal(v.entryCount, 1);
      assert.equal(canonicalManifestsConverge(root), true);
    } finally {
      cleanup();
    }
  });

  test("shuffled manifest key order still validates and yields the same entry", () => {
    const { root, cleanup } = tempRoot();
    try {
      // Re-write the manifest with keys in a deliberately NON-sorted insertion
      // order (owner before fixtures, expected before algorithm). The canonical
      // reader normalizes keys by UTF-8 bytes, so entries parse identically
      // regardless of insertion order (validateCanonicalV2 separately enforces
      // the strict canonical form).
      const fixtureRaw = readFileSync(join(root, "events", "EVT-001.json"), "utf8");
      const digest = createHash("sha256")
        .update(fixtureRaw).digest("hex");
      const shuffled = {
        owner: "vc1c",
        fixtures: [
          { expected: "ok", algorithm: "event-v2", id: "EVT-001", path: "events/EVT-001.json", sha256: digest },
        ],
        version: "2",
      };
      writeFileSync(join(root, "manifest.json"), JSON.stringify(shuffled) + "\n");
      const manifest = readFixtureManifestV2(root);
      const entry = manifest.byId.get("EVT-001") as FixtureManifestEntry;
      assert.equal(entry.domain, "events");
      assert.deepEqual(entry.algorithmTuple, ["event-v2"]);
      assert.equal(manifest.owner.join(","), "vc1c");
      assert.equal(manifest.fixtureEntries.length, 1);
    } finally {
      cleanup();
    }
  });

  test("the real committed v2 corpus converges to one digest", () => {
    const v = validateCanonicalV2(V2) as ManifestValidateResult;
    if (!v.ok) {
      assert.fail(`committed corpus must be canonical, got ${(v as { codes: readonly string[] }).codes.join(",")}`);
    }
    assert.equal((v as { entryCount: number }).entryCount > 0, true);
  });
});

describe("manifest rejections (frozen codes)", () => {
  test("an extra unlisted file fails with CONF_EXTRA_FIXTURE", () => {
    const { root, cleanup } = tempRoot({ extra: "events/EVT-UNLISTED.json" });
    try {
      const v = validateCanonicalV2(root) as { ok: false; codes: readonly string[] };
      assert.equal(v.ok, false);
      assert.ok(v.codes.includes(CONF_FAIL.EXTRA_FIXTURE), `got ${v.codes.join(",")}`);
    } finally {
      cleanup();
    }
  });

  test("a listed fixture with no file fails with CONF_MISSING_FIXTURE", () => {
    // Manifest lists EVT-001 but the file is absent.
    const { root, cleanup } = tempRoot();
    try {
      rmSync(join(root, "events", "EVT-001.json"));
      const v = validateCanonicalV2(root) as { ok: false; codes: readonly string[] };
      assert.equal(v.ok, false);
      assert.ok(v.codes.includes(CONF_FAIL.MISSING_FIXTURE), `got ${v.codes.join(",")}`);
    } finally {
      cleanup();
    }
  });

  test("a drifted on-disk fixture fails with CONF_DIGEST_DRIFT", () => {
    const { root, cleanup } = tempRoot({ mutate: { path: "events/EVT-001.json", content: '{"id":"EVT-001","kind":"event-v2","mutated":true}' + "\n" } });
    try {
      const v = validateCanonicalV2(root) as { ok: false; codes: readonly string[] };
      assert.equal(v.ok, false);
      assert.ok(v.codes.includes(CONF_FAIL.DIGEST_DRIFT), `got ${v.codes.join(",")}`);
    } finally {
      cleanup();
    }
  });

  test("a noncanonical manifest (unsorted keys) fails with CONF_NONCANONICAL", () => {
    const fixtureRaw = JSON.stringify({ id: "EVT-001", kind: "event-v2" }) + "\n";
    const digest = createHash("sha256").update(fixtureRaw).digest("hex");
    // Keys in non-sorted order at the top level -> noncanonical.
    const noncanon = JSON.stringify({
      owner: "vc1c",
      fixtures: [
        { expected: "ok", algorithm: "event-v2", id: "EVT-001", path: "events/EVT-001.json", sha256: digest },
      ],
      version: "2",
    });
    const { root, cleanup } = tempRoot({ manifestOverride: noncanon + "\n" });
    try {
      const v = validateCanonicalV2(root) as { ok: false; codes: readonly string[] };
      assert.equal(v.ok, false);
      assert.ok(v.codes.includes(CONF_FAIL.NONCANONICAL), `got ${v.codes.join(",")}`);
    } finally {
      cleanup();
    }
  });
});

describe("domain derivation", () => {
  test("domainOf returns the first path segment", () => {
    assert.equal(domainOf("events/EVT-001.json"), "events");
    assert.equal(domainOf("minhash/M4-HIGHBIT-001.json"), "minhash");
    assert.equal(domainOf("migrations/M4-001.json"), "migrations");
    assert.equal(domainOf(""), "");
  });
});
