/**
 * vector-cortex/conformance/manifest.ts — FixtureManifestV2 (VC1C).
 *
 * Owns the v2 conformance manifest: reads the authoritative
 * `conformance/vector-cortex/v2/manifest.json` plus the on-disk fixture tree
 * and validates it canonically. Each FixtureManifestV2 entry carries:
 *   id, domain, inputDigest, expectedDigest, failureCode, algorithmTuple.
 *
 * Canonical validation rejects a mismatched corpus with the frozen codes:
 *   CONF_EXTRA_FIXTURE   — a file on disk that the manifest does not list;
 *   CONF_MISSING_FIXTURE — a manifest entry with no file on disk;
 *   CONF_DIGEST_DRIFT    — on-disk bytes do not match the manifest SHA-256.
 *
 * Key ordering rule (canonical JSON): object keys are sorted by UTF-8 bytes;
 * a manifest that is not canonical (or a fixture whose canonical re-serialization
 * differs) is itself a digest-drift / noncanonical condition. The invariant:
 * canonical valid manifests converge to ONE digest (the corpus is a single
 * reproducible byte image).
 *
 * Pure FS reads + pure predicates; no network, no side effects on authority
 * data (PREVENT-PI-004 / PREVENT-011).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash as sha256 } from "node:crypto";
import { join, relative, sep } from "node:path";

/** Frozen VC1C conformance failure codes (the "reject unknown / extra / drifted"). */
export const CONF_FAIL = {
  EXTRA_FIXTURE: "CONF_EXTRA_FIXTURE",
  MISSING_FIXTURE: "CONF_MISSING_FIXTURE",
  DIGEST_DRIFT: "CONF_DIGEST_DRIFT",
  NONCANONICAL: "CONF_NONCANONICAL",
  UNKNOWN_DOMAIN: "CONF_UNKNOWN_DOMAIN",
} as const;
export type ConfFailureCode = (typeof CONF_FAIL)[keyof typeof CONF_FAIL];

/** A normalized FixtureManifestV2 entry. */
export interface FixtureManifestEntry {
  readonly id: string;
  readonly domain: string;
  readonly path: string;
  readonly algorithm: string;
  readonly expected: string;
  readonly inputDigest: string;
  readonly expectedDigest: string;
  readonly expectedOutputDigest?: string;
  readonly failureCode?: string;
  readonly algorithmTuple: readonly string[];
}

/** The parsed, normalized v2 manifest. */
export interface FixtureManifestV2 {
  readonly version: string;
  readonly owner: readonly string[];
  readonly fixtureEntries: readonly FixtureManifestEntry[];
  /** id -> entry index for O(1) lookup. */
  readonly byId: ReadonlyMap<string, FixtureManifestEntry>;
}

/** Result of a canonical manifest validation. */
export type ManifestValidateResult =
  | { ok: true; entryCount: number }
  | { ok: false; codes: readonly ConfFailureCode[]; issues: readonly string[] };

/** Walk a directory tree returning relative POSIX paths (sorted). */
function walk(dir: string, base: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, base, acc);
    else acc.push(relative(base, p).split(sep).join("/"));
  }
  return acc.sort();
}

/**
 * Canonical JSON bytes for a value (UTF-8, NFC keys, sorted, shortest numbers).
 * Matches the stricter `canonicalNumber` in scripts/vector-cortex-conformance.mjs:
 * a non-finite number or -0 has no canonical shortest representation and is
 * rejected, so the two "canonical" serializers can never diverge for the same
 * value (thereby preserving the "converge to one digest" invariant).
 */
function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        throw new Error(`non-canonical number: ${value}`);
      }
      if (Number.isInteger(value) && Number.isSafeInteger(value)) return String(value);
      return JSON.stringify(value);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalValue(v)).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>)
    .map((k) => k.normalize("NFC"))
    .sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalValue((value as Record<string, unknown>)[k])}`,
  );
  return `{${parts.join(",")}}`;
}

function canonicalJson(value: unknown): Buffer {
  return Buffer.from(`${canonicalValue(value)}\n`, "utf8");
}

function sha256Hex(bytes: Uint8Array): string {
  return sha256("sha256").update(bytes).digest("hex");
}

/** parse a manifest.json (must be a valid v2 manifest object). */
function parseManifest(raw: string): {
  version: string;
  owner: string;
  fixtures: Array<{
    id: string;
    path: string;
    sha256: string;
    algorithm: string;
    expected: string;
    domain?: string;
    outputDigest?: string;
  }>;
} {
  const obj = JSON.parse(raw) as {
    version?: unknown;
    owner?: unknown;
    fixtures?: unknown;
  };
  if (obj === null || typeof obj !== "object" || !Array.isArray(obj.fixtures)) {
    throw new Error("CONF_MANIFEST_INVALID: manifest.fixtures must be an array");
  }
  return {
    version: typeof obj.version === "string" ? obj.version : "2",
    owner: typeof obj.owner === "string" ? obj.owner : "",
    fixtures: obj.fixtures as Array<{
      id: string;
      path: string;
      sha256: string;
      algorithm: string;
      expected: string;
      domain?: string;
      outputDigest?: string;
    }>,
  };
}

/**
 * Read + normalize the v2 manifest and on-disk tree into a FixtureManifestV2.
 * `fixtureRoot` is the conformance v2 root directory (injected by callers so
 * `src/` stays runtime-independent of a hardcoded path).
 */
export function readFixtureManifestV2(fixtureRoot: string): FixtureManifestV2 {
  const manifestRaw = readFileSync(join(fixtureRoot, "manifest.json"), "utf8");
  const manifest = parseManifest(manifestRaw);
  const byId = new Map<string, FixtureManifestEntry>();
  const entries: FixtureManifestEntry[] = [];
  for (const fx of manifest.fixtures) {
    const expectedDigest = String(fx.sha256 ?? "");
    const domain = fx.domain ?? domainOf(fx.path);
    const inputDigest = canonicalFileDigest(join(fixtureRoot, fx.path));
    const entry: FixtureManifestEntry = {
      id: fx.id,
      domain,
      path: fx.path,
      algorithm: fx.algorithm,
      expected: fx.expected,
      inputDigest,
      expectedDigest,
      expectedOutputDigest:
        typeof fx.outputDigest === "string" && fx.outputDigest.length > 0
          ? fx.outputDigest
          : undefined,
      failureCode: fx.expected === "ok" ? undefined : fx.expected,
      algorithmTuple: String(fx.algorithm).split(";").filter(Boolean).map((s) => s.trim()),
    };
    entries.push(entry);
    byId.set(fx.id, entry);
  }
  return {
    version: manifest.version,
    owner: manifest.owner.split(",").map((s) => s.trim()).filter(Boolean),
    fixtureEntries: entries,
    byId,
  };
}

/** The v2 domain a fixture path belongs to (first path segment). */
export function domainOf(path: string): string {
  return path.split("/")[0] ?? "";
}

/**
 * SHA-256 over the canonical JSON bytes of a fixture file. A missing file
 * returns "" so `validateCanonicalV2` can report CONF_MISSING_FIXTURE instead of
 * throwing ENOENT part-way through manifest normalization.
 */
function canonicalFileDigest(absPath: string): string {
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch {
    return "";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw; // non-JSON (e.g. seeds as bytes) — digest raw
  }
  return sha256Hex(canonicalJson(parsed));
}

/**
 * Validate the on-disk v2 corpus against the manifest. Rejects an extra,
 * missing, or digest-drifted fixture file with the frozen codes. Also verifies
 * the manifest itself is canonical (sorted keys, shortest numbers) — a
 * noncanonical manifest is reported as NONCANONICAL.
 */
export function validateCanonicalV2(fixtureRoot: string): ManifestValidateResult {
  const codes: ConfFailureCode[] = [];
  const issues: string[] = [];
  const manifestRaw = readFileSync(join(fixtureRoot, "manifest.json"), "utf8");
  try {
    const canonicalBytes = canonicalJson(JSON.parse(manifestRaw));
    if (Buffer.from(manifestRaw, "utf8").toString("hex") !== canonicalBytes.toString("hex")) {
      codes.push(CONF_FAIL.NONCANONICAL);
      issues.push("manifest.json is not canonical");
    }
  } catch {
    codes.push(CONF_FAIL.NONCANONICAL);
    issues.push("manifest.json is not valid JSON");
  }

  const manifest = readFixtureManifestV2(fixtureRoot);
  const listedPaths = new Set(manifest.fixtureEntries.map((e) => e.path));

  // Extra-file detection: every file under the root (except manifest) listed.
  const onDisk = walk(fixtureRoot, fixtureRoot).filter((p) => p !== "manifest.json");
  for (const p of onDisk) {
    if (!listedPaths.has(p)) {
      codes.push(CONF_FAIL.EXTRA_FIXTURE);
      issues.push(`extra fixture: ${p}`);
    }
  }

  // Missing + digest-drift for every listed fixture.
  for (const entry of manifest.fixtureEntries) {
    const abs = join(fixtureRoot, entry.path);
    if (!exists(abs)) {
      codes.push(CONF_FAIL.MISSING_FIXTURE);
      issues.push(`missing fixture: ${entry.path}`);
      continue;
    }
    const raw = readFileSync(abs, "utf8");
    let canonicalHex: string;
    try {
      canonicalHex = sha256Hex(canonicalJson(JSON.parse(raw)));
    } catch {
      canonicalHex = sha256Hex(Buffer.from(raw, "utf8"));
    }
    if (canonicalHex !== entry.expectedDigest) {
      codes.push(CONF_FAIL.DIGEST_DRIFT);
      issues.push(`digest drift for ${entry.path}: expected ${entry.expectedDigest} got ${canonicalHex}`);
    }
  }

  // The canonical-key ordering invariant: a canonical valid manifest is a single
  // reproducible digest. (Extra-file presence also breaks purity but is the
  // extra/missing covers it.) Noncanonical keys are caught above.
  if (codes.length === 0) {
    return { ok: true, entryCount: manifest.fixtureEntries.length };
  }
  return { ok: false, codes: dedupeCodes(codes), issues };
}

/** True if the manifest+corpus is canonical (converges to one digest). */
export function canonicalManifestsConverge(fixtureRoot: string): boolean {
  const v = validateCanonicalV2(fixtureRoot);
  return v.ok;
}

function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function dedupeCodes(codes: ConfFailureCode[]): ConfFailureCode[] {
  const out: ConfFailureCode[] = [];
  for (const c of codes) if (!out.includes(c)) out.push(c);
  return out;
}
