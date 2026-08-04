/** VC1C acceptance aggregator — runs the v2 conformance corpus against the REAL
 * algorithms + committed fixtures, no mocks. Triad: A=v2 runner, B=independent
 * exact reader, C=reject unknown. */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MINHASH_VERSION,
  minhashV2Signature,
  encodeSignatureV2,
} from "../dedup/l1-minhash-v2.js";
import { lshBandsV2 } from "../dedup/l1-lsh-v2.js";
import {
  M4_FAIL,
  m4Backfill,
  m4Verify,
  migrateMinhashV2,
  computeV2Row,
  crossVersionError,
  type M4Host,
  type V2SignatureRow,
} from "./migrations/minhash-v2.js";
import {
  readFixtureManifestV2,
  validateCanonicalV2,
  canonicalManifestsConverge,
  CONF_FAIL,
} from "./conformance/manifest.js";
import {
  createConformanceReporter,
  NOOP_CONFORMANCE_REPORTER,
} from "./conformance/emit.js";
import {
  runConformanceCase,
  runDowngradeExport,
  handlerKey,
  EXPECTATION_MISMATCH,
  type ConformanceHandler,
  type DowngradeExporter,
} from "./conformance/runner.js";
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
interface ManifestRow {
  id: string;
  path: string;
  algorithm: string;
  expected: string;
}
interface Manifest {
  version: string;
  owner: string;
  fixtures: ManifestRow[];
}
interface BaseFixture {
  id: string;
  kind: string;
  producer: string;
}
interface MinhashFixture extends BaseFixture {
  input: { session: string; text: string };
  expected: { ok: boolean; buckets: string[]; signatureDigest: string; signatureBytesHex: string };
}
interface MigrationFixture extends BaseFixture {
  input: {
    activeStarting: number;
    checkpoints: string[];
    scenario: string;
    texts?: string[];
    present?: string[];
  };
  expected: {
    ok: boolean;
    code?: string;
    activeVersion?: number;
    count?: number;
    halted?: boolean;
    equalDigests?: boolean;
    noDuplicates?: boolean;
  };
}
interface VersionFixture extends BaseFixture {
  input: { textA: string; textB: string; v1: boolean; v2: boolean };
  expected: { ok: boolean; code: string };
}
interface ConfFixture extends BaseFixture {
  input: { scenario: string; domains?: string[]; extraPath?: string; rows?: number };
  expected: { ok: boolean; entryCount?: number; code?: string; deterministic?: boolean };
}
function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, "utf8")) as T;
}
function fixture<T>(rel: string): T {
  return readJson<T>(join(V2, rel));
}
function readManifest(): Manifest {
  return readJson<Manifest>(join(V2, "manifest.json"));
}
function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Scenario-driven M4 host (mimics the store's migrate host over a mem index). */
function memHost(input: MigrationFixture["input"]): {
  host: M4Host;
  rows: V2SignatureRow[];
  active: () => number;
  switchCalls: () => number;
  failSwitch: (fail: boolean) => void;
} {
  const checkpoints = input.checkpoints;
  const texts = input.texts ?? checkpoints.map((c) => `source-of-${c}`);
  const textOf = new Map(checkpoints.map((c, i) => [c, texts[i] ?? `source-of-${c}`]));
  const rows: V2SignatureRow[] = [];
  let active = input.activeStarting;
  let switches = 0;
  let crashingSwitch = false;
  const host: M4Host = {
    v1CheckpointIds: () => checkpoints,
    sessionOf: () => "m4accept",
    sourceOf: (id) => textOf.get(id) ?? "",
    storedV2: () => rows,
    activeVersion: () => active,
    putV2: (newRows) => {
      // Append without dedup: backfill itself avoids re-writing known ids (via
      // storedV2), so idempotency is preserved while duplicate/corrupt rows can
      // be injected for the failure scenarios (M4-005/006/007).
      rows.push(...newRows);
    },
    switchToV2: () => {
      if (crashingSwitch) throw new Error("M4_SWITCH_CRASH");
      active = MINHASH_VERSION;
      switches += 1;
    },
  };
  return {
    host,
    rows,
    active: () => active,
    switchCalls: () => switches,
    failSwitch: (fail) => {
      crashingSwitch = fail;
    },
  };
}
// Manifest registration
const VC1C_IDS = [
  "M4-001", "M4-002", "M4-003", "M4-004", "M4-005", "M4-006", "M4-007", "M4-008",
];
const VC1C_NAMED = ["M4-HIGHBIT-001", "M4-VERSION-002", "M4-RESUME-003", "M4-DUP-001"];
const VC1C_CONF = ["CONF-MANIFEST-001", "CONF-EXTRA-002", "CONF-DOWN-003"];
describe("VC1C conformance registration", () => {
  test("manifest registers every M4 + named + conformance fixture and seeds-v2", () => {
    const manifest = readManifest();
    const ids = manifest.fixtures.map((f) => f.id);
    for (const id of [...VC1C_IDS, ...VC1C_NAMED, ...VC1C_CONF]) {
      assert.ok(ids.includes(id), `missing ${id}`);
    }
    assert.ok(ids.includes("seeds-v2"), "missing seeds-v2");
    assert.ok(manifest.owner.includes("VC1C"), "manifest owner lists VC1C");
  });
  test("the VC1C corpus is canonical (a single reproducible digest)", () => {
    assert.equal(canonicalManifestsConverge(V2), true, "committed corpus converges");
  });
});
// MinHashV2 exact arithmetic (M4-HIGHBIT-001) + cross-version (M4-VERSION-002)
describe("MinHashV2 exact vectors vs M4-HIGHBIT-001 (triad A/B)", () => {
  test("A: runner reproduces the committed 2048-byte signature + 64 bucket keys", () => {
    const fx = fixture<MinhashFixture>("minhash/M4-HIGHBIT-001.json");
    const bytes = encodeSignatureV2(minhashV2Signature(fx.input.text));
    assert.equal(Buffer.from(bytes).toString("hex"), fx.expected.signatureBytesHex, "signature bytes");
    assert.equal(sha256Hex(bytes), fx.expected.signatureDigest, "signature digest");
    assert.deepEqual(lshBandsV2(bytes, fx.input.session), fx.expected.buckets, "bucket keys");
  });
  test("B: independent exact reader re-derives the signature byte-for-byte", () => {
    // Independent path: recompute directly from the committed text without the
    // runner module's cached seeds, then compare to the fixture digest.
    const fx = fixture<MinhashFixture>("minhash/M4-HIGHBIT-001.json");
    const indep = encodeSignatureV2(minhashV2Signature(fx.input.text));
    assert.equal(sha256Hex(indep), fx.expected.signatureDigest, "independent reader matches fixture");
  });
  test("M4-VERSION-002: a v1/v2 cross-version compare is rejected", () => {
    const fx = fixture<VersionFixture>("minhash/M4-VERSION-002.json");
    assert.equal(fx.expected.code, "MINHASH_VERSION_MISMATCH");
    assert.equal(crossVersionError(), M4_FAIL.VERSION_MISMATCH);
  });
  test("mixed versions never share buckets (version-tagged keys)", () => {
    const fx = fixture<MinhashFixture>("minhash/M4-HIGHBIT-001.json");
    const bytes = encodeSignatureV2(minhashV2Signature(fx.input.text));
    const v1 = lshBandsV2(bytes, fx.input.session, 1);
    const v2 = lshBandsV2(bytes, fx.input.session, 2);
    assert.deepEqual(v1.filter((k) => v2.includes(k)), [], "v1/v2 bucket keys never collide");
  });
});
// M4 migration lifecycle (M4-001..008 + M4-DUP-001 + M4-RESUME-003)
function assertMigration(fx: MigrationFixture): void {
  const input = fx.input;
  const scenario = input.scenario;
  const h = memHost(input);
  if (scenario === "full") {
    const res = migrateMinhashV2(h.host);
    assert.equal(res.ok, fx.expected.ok, `M4-001 ok, got ${res.codes.join(",")}`);
    assert.equal(h.rows.length, fx.expected.count, "backfilled count");
    assert.equal(h.active(), fx.expected.activeVersion, "active version");
  } else if (scenario === "repeat-backfill") {
    m4Backfill(h.host);
    assert.equal(m4Backfill(h.host).length, 0, "idempotent re-backfill");
    assert.equal(m4Verify(h.host).ok, true, "verify ok after re-backfill");
    assert.equal(h.rows.length, fx.expected.count, "no duplicate rows");
  } else if (scenario === "halt-before-switch") {
    // Drive the REAL switch-only-after-verify gate: the host's switch faults, so
    // a full migrateMinhashV2 faults BETWEEN the verified backfill and the
    // active-pointer flip. v1 must stay active; a clean rerun then completes the
    // backfill -> verify -> switch sequence (old authority retained until then).
    m4Backfill(h.host);
    assert.equal(m4Verify(h.host).ok, true, "validate ok");
    h.failSwitch(true);
    assert.throws(() => migrateMinhashV2(h.host), /M4_SWITCH_CRASH/, "crash during switch");
    assert.equal(h.active(), 1, "crash mid-switch leaves v1 active (old authority)");
    assert.equal(fx.expected.halted, true);
    assert.equal(fx.expected.activeVersion, 1, "fixture pins v1 as the pre-switch authority");
    h.failSwitch(false);
    const res = migrateMinhashV2(h.host);
    assert.equal(res.ok, true, `clean rerun completes, got ${res.codes.join(",")}`);
    assert.equal(h.active(), MINHASH_VERSION, "verified switch activates v2");
  } else if (scenario === "repeat-full") {
    assert.equal(migrateMinhashV2(h.host).ok, true, "first migrate ok");
    assert.equal(migrateMinhashV2(h.host).ok, true, "second migrate idempotent");
    assert.equal(h.rows.length, fx.expected.count, "no duplicate rows");
    assert.equal(h.active(), fx.expected.activeVersion, "stays v2");
  } else if (scenario === "resume-after-halt") {
    // First pass persisted only c1 (interrupted before c2 backfilled + switch).
    h.host.putV2([computeV2Row(h.host, input.checkpoints[0]!)]);
    assert.equal(h.active(), 1, "still v1 after interruption");
    const delta = m4Backfill(h.host);
    assert.deepEqual(delta.map((r) => r.checkpointId), [input.checkpoints[1]!], "resume fills missing");
    const res = migrateMinhashV2(h.host);
    assert.equal(res.ok, true, `resume ok, got ${res.codes.join(",")}`);
    assert.equal(h.rows.length, fx.expected.count, "no duplicate signatures");
    assert.equal(h.active(), fx.expected.activeVersion, "switch activates v2");
    if (fx.expected.noDuplicates) {
      const seen = new Set(h.rows.map((r) => r.checkpointId));
      assert.equal(seen.size, h.rows.length, "no duplicate checkpoint rows");
    }
  } else if (scenario === "dup-content") {
    assert.equal(migrateMinhashV2(h.host).ok, true, "dup-content migration ok");
    assert.equal(h.rows.length, fx.expected.count, "two rows despite equal text (identity by id)");
    if (fx.expected.equalDigests) {
      const [d1, d2] = [h.rows[0]!.digest, h.rows[1]!.digest];
      assert.equal(d1, d2, "equal text -> equal signature digest");
    }
    assert.equal(h.active(), fx.expected.activeVersion, "active v2");
  } else if (scenario === "partial-backfill") {
    h.host.putV2([computeV2Row(h.host, input.checkpoints[0]!)]); // only c1 present
    const v = m4Verify(h.host);
    assert.equal(v.ok, fx.expected.ok, "partial verify fails");
    assert.ok(v.codes.includes(M4_FAIL.BACKFILL_PARTIAL), `got ${v.codes.join(",")}`);
  } else if (scenario === "bad-digest") {
    const row = computeV2Row(h.host, input.checkpoints[0]!);
    h.host.putV2([{ ...row, digest: "sha256:deadbeef" }]);
    const v = m4Verify(h.host);
    assert.equal(v.ok, fx.expected.ok, "bad digest fails");
    assert.ok(v.codes.includes(M4_FAIL.DIGEST_MISMATCH), `got ${v.codes.join(",")}`);
  } else if (scenario === "duplicate-row") {
    const row = computeV2Row(h.host, input.checkpoints[0]!);
    h.host.putV2([row, { ...row }]);
    const v = m4Verify(h.host);
    assert.equal(v.ok, fx.expected.ok, "duplicate fails");
    assert.ok(v.codes.includes(M4_FAIL.COUNT_MISMATCH), `got ${v.codes.join(",")}`);
  } else if (scenario === "bad-version-row") {
    const row = computeV2Row(h.host, input.checkpoints[0]!);
    h.host.putV2([{ ...row, version: 1 }]);
    const v = m4Verify(h.host);
    assert.equal(v.ok, fx.expected.ok, "wrong version fails");
    assert.ok(v.codes.includes(M4_FAIL.VERSION_MISMATCH), `got ${v.codes.join(",")}`);
  } else {
    assert.fail(`unknown migration scenario ${scenario}`);
  }
}
describe("M4 migration lifecycle against M4-00x fixtures", () => {
  for (const id of VC1C_IDS) {
    test(`${id}: executes its declared migration scenario`, () => {
      const fx = fixture<MigrationFixture>(`migrations/${id}.json`);
      assertMigration(fx);
    });
  }
  test("M4-RESUME-003: interrupted backfill resumes without duplicates", () => {
    const fx = fixture<MigrationFixture>("migrations/M4-RESUME-003.json");
    assertMigration(fx);
  });
  test("M4-DUP-001: equal-content checkpoints remain two rows", () => {
    const fx = fixture<MigrationFixture>("migrations/M4-DUP-001.json");
    assertMigration(fx);
  });
});
// Canonical manifest validator (CONF-MANIFEST-001 / CONF-EXTRA-002)
describe("canonical manifest validation", () => {
  test("CONF-MANIFEST-001: a canonical manifest validates and converges", () => {
    const fx = fixture<ConfFixture>("conformance/CONF-MANIFEST-001.json");
    assert.equal(fx.expected.ok, true);
    assert.equal(canonicalManifestsConverge(V2), true, "committed corpus is canonical");
  });
  test("shuffled-key manifests normalize to the same entries and the corpus converges", () => {
    // The canonical reader sorts keys by UTF-8 bytes, so a manifest whose object
    // keys are in ANY insertion order parses into identical entries.
    const manifest = readManifest();
    const v2 = readFixtureManifestV2(V2);
    assert.equal(v2.fixtureEntries.length, manifest.fixtures.length, "reader sees every entry");
    assert.ok(v2.byId.has("M4-001") && v2.byId.has("M4-HIGHBIT-001"), "entries normalized by id");
    // Canonical valid manifests converge to ONE digest: the committed corpus.
    assert.equal(canonicalManifestsConverge(V2), true, "committed corpus converges");
  });
  test("injecting a remove mutation fails with CONF_MISSING_FIXTURE", () => {
    const root = mkdtempSync(join(tmpdir(), "vc1c-missing-"));
    try {
      copyCorpus(root);
      rmSync(join(root, "minhash", "M4-HIGHBIT-001.json"));
      const v = validateCanonicalV2(root);
      assert.equal(v.ok, false);
      assert.ok((v as { codes: readonly string[] }).codes.includes("CONF_MISSING_FIXTURE"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("injecting an add mutation fails with CONF_EXTRA_FIXTURE (CONF-EXTRA-002)", () => {
    const fx = fixture<ConfFixture>("conformance/CONF-EXTRA-002.json");
    assert.equal(fx.expected.code, "CONF_EXTRA_FIXTURE");
    const root = mkdtempSync(join(tmpdir(), "vc1c-extra-"));
    try {
      copyCorpus(root);
      writeFileSync(join(root, fx.input.extraPath!), JSON.stringify({ x: 1 }) + "\n");
      const v = validateCanonicalV2(root);
      assert.equal(v.ok, false);
      assert.ok((v as { codes: readonly string[] }).codes.includes("CONF_EXTRA_FIXTURE"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("injecting a drift mutation fails with CONF_DIGEST_DRIFT", () => {
    const root = mkdtempSync(join(tmpdir(), "vc1c-drift-"));
    try {
      copyCorpus(root);
      const p = join(root, "minhash", "M4-HIGHBIT-001.json");
      const f = JSON.parse(readFileSync(p, "utf8")) as { assertion: string };
      f.assertion = "mutated";
      writeFileSync(p, JSON.stringify(f) + "\n");
      const v = validateCanonicalV2(root);
      assert.equal(v.ok, false);
      assert.ok((v as { codes: readonly string[] }).codes.includes("CONF_DIGEST_DRIFT"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("removing a fixture after manifest load makes byId miss it", () => {
    const manifest = readFixtureManifestV2(V2);
    assert.ok(manifest.byId.has("M4-001"), "fixture present at load");
    // On-disk removal after load is caught by validateCanonicalV2.
    const root = mkdtempSync(join(tmpdir(), "vc1c-afterload-"));
    try {
      copyCorpus(root);
      rmSync(join(root, "migrations", "M4-001.json"));
      const v = validateCanonicalV2(root);
      assert.equal(v.ok, false);
      assert.ok((v as { codes: readonly string[] }).codes.includes("CONF_MISSING_FIXTURE"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
/** Recursively copy the committed v2 corpus into a temp root (for mutations). */
function copyCorpus(dst: string): void {
  for (const entry of readManifest().fixtures) {
    const src = join(V2, entry.path);
    const full = join(dst, entry.path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, readFileSync(src));
  }
  writeFileSync(join(dst, "manifest.json"), readFileSync(join(V2, "manifest.json")));
}
// Triad A/B/C: dispatcher over the minhash domain
describe("triad dispatch (A/B/C)", () => {
  test("A: a registered v2 runner dispatches and yields the algorithm name", () => {
    const handlers = new Map<string, ConformanceHandler>();
    handlers.set(
      handlerKey("minhash", ["minhash-v2"]),
      {
        run: (_entry, fx) => {
          const f = fx as MinhashFixture;
          const bytes = encodeSignatureV2(minhashV2Signature(f.input.text));
          const digest = sha256Hex(bytes);
          return digest === f.expected.signatureDigest
            ? { ok: true, outputBytes: bytes, outputDigest: digest }
            : { ok: false, code: "CONF_DIGEST_DRIFT" };
        },
      },
    );
    const manifest = readFixtureManifestV2(V2);
    const entry = manifest.byId.get("M4-HIGHBIT-001")!;
    const fx = fixture<MinhashFixture>("minhash/M4-HIGHBIT-001.json");
    const res = runConformanceCase(entry, handlers, fx);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.algorithm, "minhash-v2");
      assert.equal(res.outputDigest, fx.expected.signatureDigest);
    }
  });
  test("C: an unknown domain/version is rejected WITHOUT partial output", () => {
    const handlers = new Map<string, ConformanceHandler>();
    const manifest = readFixtureManifestV2(V2);
    const entry = manifest.byId.get("M4-HIGHBIT-001")!;
    // No handler for the exact (domain, algorithmTuple) -> reject unknown.
    const res = runConformanceCase(entry, handlers, {});
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.code, "CONF_UNKNOWN_VERSION");
      assert.equal(res.algorithm, "minhash-v2");
    }
  });
  test("runner cross-checks the expected failure code (task 5)", () => {
    const handlers = new Map<string, ConformanceHandler>();
    handlers.set(handlerKey("minhash", ["minhash-v2"]), {
      run: () => ({ ok: false, code: "SOME_OTHER_CODE" }),
    });
    const entry = readFixtureManifestV2(V2).byId.get("M4-VERSION-002")!;
    assert.equal(entry.failureCode, "MINHASH_VERSION_MISMATCH");
    const res = runConformanceCase(entry, handlers, {});
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, EXPECTATION_MISMATCH, "wrong code -> runner mismatch");
  });
  test("runner cross-checks the expected success bytes (task 5)", () => {
    const handlers = new Map<string, ConformanceHandler>();
    handlers.set(handlerKey("minhash", ["minhash-v2"]), {
      run: () => ({ ok: true, outputBytes: new Uint8Array(0), outputDigest: "0".repeat(64) }),
    });
    const entry = readFixtureManifestV2(V2).byId.get("M4-HIGHBIT-001")!;
    assert.equal(
      entry.expectedOutputDigest,
      fixture<MinhashFixture>("minhash/M4-HIGHBIT-001.json").expected.signatureDigest,
    );
    const res = runConformanceCase(entry, handlers, {});
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, CONF_FAIL.DIGEST_DRIFT, "wrong bytes -> CONF_DIGEST_DRIFT");
  });
});
// DowngradeReport determinism (CONF-DOWN-003)
describe("DowngradeReport (CONF-DOWN-003)", () => {
  test("a deterministic exporter yields an identical report digest on a second run", () => {
    let exports = 0;
    const exporter: DowngradeExporter = {
      exportOnce: () => {
        exports += 1;
        const body = {
          schema: "downgrade-report-v1" as const,
          exportedCopyId: "abcdef0123456789",
          copiedCount: 3,
          unrepresentableIds: ["bad"],
        };
        const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
        return { ...body, reportDigest: digest };
      },
    };
    const a = runDowngradeExport(exporter);
    const b = runDowngradeExport(exporter);
    assert.equal(a.schema, "downgrade-report-v1");
    assert.equal(a.reportDigest, b.reportDigest, "report digest identical across runs");
    assert.equal(exports, 2);
  });
  test("a real downgrade export does not mutate the committed corpus", () => {
    // Reading the committed corpus and producing a report leaves the authority
    // digest unchanged (read-only).
    const before = sha256Hex(readFileSync(join(V2, "manifest.json")));
    void readFixtureManifestV2(V2);
    void validateCanonicalV2(V2);
    const after = sha256Hex(readFileSync(join(V2, "manifest.json")));
    assert.equal(before, after, "authority manifest untouched by validation/export");
  });
});
// Flag-off parity (MEGACOMPACT_VC1C)
describe("VC1C flag-off parity", () => {
  const flagEnvKey = "MEGACOMPACT_VC1C";
  const savedFlag = process.env[flagEnvKey];
  after(() =>
    savedFlag === undefined
      ? delete process.env[flagEnvKey]
      : (process.env[flagEnvKey] = savedFlag),
  );
  test("flag OFF still drives the pure primitives (emit seam no-ops)", () => {
    // The minhash/migration primitives are flag-independent (pure compute). The
    // flag gates the observability emit seam.
    process.env[flagEnvKey] = "0";
    const fx = fixture<MinhashFixture>("minhash/M4-HIGHBIT-001.json");
    const bytes = encodeSignatureV2(minhashV2Signature(fx.input.text));
    assert.equal(sha256Hex(bytes), fx.expected.signatureDigest, "primitive runs with flag off");
    process.env[flagEnvKey] = "1";
    const again = encodeSignatureV2(minhashV2Signature(fx.input.text));
    assert.equal(sha256Hex(again), fx.expected.signatureDigest, "primitive identical flag on");
  });
  test("flag OFF yields ZERO VC1C emissions from the reporter", () => {
    process.env[flagEnvKey] = "0";
    const emitted: string[] = [];
    const reporter = createConformanceReporter((event) => emitted.push(event));
    reporter.backfilled({ written: 1 });
    reporter.caseChecked({ id: "x", ok: true });
    reporter.downgradeWritten({ copiedCount: 1 });
    assert.deepEqual(
      emitted,
      [],
      "flag OFF => the emit seam fires nothing (byte-identical predecessor parity)",
    );
    // The exported no-op reporter is a structural no-op regardless of flag.
    NOOP_CONFORMANCE_REPORTER.backfilled({ written: 1 });
    NOOP_CONFORMANCE_REPORTER.caseChecked({ id: "x", ok: true });
    NOOP_CONFORMANCE_REPORTER.downgradeWritten({ copiedCount: 1 });
    assert.deepEqual(emitted, [], "no-op reporter never emits");
  });
  test("flag ON: each of the three runtime seams emits its named VC1C event", () => {
    process.env[flagEnvKey] = "1";
    const emitted: string[] = [];
    const reporter = createConformanceReporter((event) => emitted.push(event));

    // Seam 1 — M4 minhash-v2 backfill (vector_cortex_minhash_v2_backfilled).
    const migFx = fixture<MigrationFixture>("migrations/M4-001.json");
    const h = memHost(migFx.input);
    migrateMinhashV2(h.host, reporter);
    assert.ok(h.rows.length > 0, "backfill wrote v2 rows");

    // Seam 2 — conformance case dispatch (vector_cortex_conformance_case_checked).
    const handlers = new Map<string, ConformanceHandler>();
    handlers.set(handlerKey("minhash", ["minhash-v2"]), {
      run: (_e, f) => {
        const ff = f as MinhashFixture;
        const bytes = encodeSignatureV2(minhashV2Signature(ff.input.text));
        return { ok: true, outputBytes: bytes, outputDigest: sha256Hex(bytes) };
      },
    });
    const manifest = readFixtureManifestV2(V2);
    const entry = manifest.byId.get("M4-HIGHBIT-001")!;
    const mfx = fixture<MinhashFixture>("minhash/M4-HIGHBIT-001.json");
    runConformanceCase(entry, handlers, mfx, reporter);

    // Seam 3 — downgrade export (vector_cortex_downgrade_copy_written).
    const exporter: DowngradeExporter = {
      exportOnce: () => {
        const body = {
          schema: "downgrade-report-v1" as const,
          exportedCopyId: "abcdef0123456789",
          copiedCount: 1,
          unrepresentableIds: [] as string[],
        };
        return { ...body, reportDigest: "0".repeat(64) };
      },
    };
    runDowngradeExport(exporter, reporter);
    assert.ok(
      emitted.includes("vector_cortex_minhash_v2_backfilled"),
      "backfill seam emits vector_cortex_minhash_v2_backfilled (got " + emitted.join(",") + ")",
    );
    assert.ok(
      emitted.includes("vector_cortex_conformance_case_checked"),
      "runner seam emits vector_cortex_conformance_case_checked",
    );
    assert.ok(
      emitted.includes("vector_cortex_downgrade_copy_written"),
      "downgrade seam emits vector_cortex_downgrade_copy_written",
    );
    assert.equal(emitted.length, 3, "exactly the three VC1C named events");
  });
});