/**
 * encoder/heads-candidate.ts — ENC-0c head-candidate load seam (delegate impl).
 *
 * Loads/validates a `head-candidate-v1` five-head candidate staged under
 * `~/.pi/mega-compact-encoder/candidates/<version>/` after training on the
 * frozen ENC-0b bge-small trunk. Flag-off / absent / malformed / wrong dims /
 * non-finite / digest / trunk mismatch each return null or {ok:false} — a bad
 * candidate is NEVER force-loaded; the runtime keeps the ENC-0b survivor
 * byte-identical. No `any` (PREVENT-011), local-only, structured logging.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ENC_0C_ENABLED } from "../../config/vector-cortex.js";
import { ENCODER_HEAD_DIMS, ENCODER_HEAD_ORDER } from "./types.js";
import type { EncoderHeadName, ModelManifestV1 } from "./types.js";

export const HEAD_CANDIDATE_SCHEMA = "head-candidate-v1" as const;
const MANIFEST_FILE = "manifest.json";

export interface HeadCandidateHeadDigest {
  readonly name: EncoderHeadName;
  readonly dim: number;
  readonly sha256: string;
  readonly bytes: number;
}

/** On-disk candidate contract; `trunkDigest` pins the frozen trunk. */
export interface HeadCandidateManifest {
  readonly schema: typeof HEAD_CANDIDATE_SCHEMA;
  readonly version: string;
  readonly trunkDigest: string;
  readonly heads: readonly HeadCandidateHeadDigest[];
  readonly totalBytes: number;
}

/** Loaded candidate: parsed Float32Array weights per head. */
export interface HeadCandidate {
  readonly schema: typeof HEAD_CANDIDATE_SCHEMA;
  readonly version: string;
  readonly trunkDigest: string;
  readonly dims: Readonly<Record<EncoderHeadName, number>>;
  readonly weights: Readonly<Record<EncoderHeadName, Float32Array>>;
  readonly digests: Readonly<Record<EncoderHeadName, string>>;
}

export type HeadCandidateValidation = { readonly ok: true } | { readonly ok: false; readonly code: string };

export const HEAD_CANDIDATE_FAIL = {
  INVALID: "ENC0C_CANDIDATE_INVALID",
  TRUNK_MISMATCH: "ENC0C_TRUNK_MISMATCH",
  DIM_MISMATCH: "ENC0C_DIM_MISMATCH",
  NON_FINITE: "ENC0C_NON_FINITE",
  DIGEST_MISMATCH: "ENC0C_DIGEST_MISMATCH",
} as const;

function sha256(buf: Uint8Array): string { return createHash("sha256").update(buf).digest("hex"); }
function finiteDim(values: Float32Array, dim: number): boolean {
  if (values.length !== dim) return false;
  for (const v of values) if (!Number.isFinite(v)) return false;
  return true;
}

/** Parse the candidate manifest object, or null if invalid. */
type ParsedManifest = { version: string; trunkDigest: string; heads: HeadCandidateHeadDigest[] };
function parseManifest(m: Record<string, unknown> | null): ParsedManifest | null {
  if (!m || m["schema"] !== HEAD_CANDIDATE_SCHEMA) return null;
  const version = typeof m["version"] === "string" ? m["version"] : "";
  const trunkDigest = typeof m["trunkDigest"] === "string" ? m["trunkDigest"] : "";
  if (!version || !trunkDigest || !Array.isArray(m["heads"])) return null;
  const heads: HeadCandidateHeadDigest[] = [];
  for (const item of m["heads"] as unknown[]) {
    const rec = item as Record<string, unknown> | null;
    if (!rec || typeof rec !== "object") return null;
    const name = rec["name"];
    if (typeof name !== "string" || !ENCODER_HEAD_ORDER.includes(name as EncoderHeadName)) return null;
    heads.push({
      name: name as EncoderHeadName,
      dim: Number(rec["dim"] ?? 0),
      sha256: typeof rec["sha256"] === "string" ? rec["sha256"] : "",
      bytes: Number(rec["bytes"] ?? 0),
    });
  }
  return { version, trunkDigest, heads };
}

/** All 5 dims match, weights finite, digests hold. */
export function validateHeadCandidate(candidate: HeadCandidate): HeadCandidateValidation {
  for (const h of ENCODER_HEAD_ORDER) {
    const dim = candidate.dims[h];
    if (dim !== ENCODER_HEAD_DIMS[h]) return { ok: false, code: HEAD_CANDIDATE_FAIL.DIM_MISMATCH };
    const w = candidate.weights[h];
    if (!w || !finiteDim(w, dim)) return { ok: false, code: HEAD_CANDIDATE_FAIL.NON_FINITE };
    const buf = new Uint8Array(w.buffer, w.byteOffset, w.byteLength);
    if (sha256(buf) !== candidate.digests[h]) return { ok: false, code: HEAD_CANDIDATE_FAIL.DIGEST_MISMATCH };
  }
  return { ok: true };
}

/** Load a candidate against the frozen trunk; null on any violation, never throws. */
export function loadHeadCandidate(candidateDir: string, manifest: ModelManifestV1): HeadCandidate | null {
  if (!ENC_0C_ENABLED()) return null;
  let raw: string;
  try {
    raw = readFileSync(join(candidateDir, MANIFEST_FILE), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const m = parseManifest(parsed as Record<string, unknown> | null);
  if (!m || m.trunkDigest !== manifest.onnx.sha256) return null;
  const weights: Partial<Record<EncoderHeadName, Float32Array>> = {};
  const digests: Partial<Record<EncoderHeadName, string>> = {};
  const dims: Partial<Record<EncoderHeadName, number>> = {};
  for (const rec of m.heads) {
    const want = rec.dim * 4;
    if (!Number.isInteger(want) || want <= 0 || rec.dim !== ENCODER_HEAD_DIMS[rec.name]) return null;
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(candidateDir, `${rec.name}.bin`));
    } catch {
      return null;
    }
    const f = new Float32Array(bytes.buffer, bytes.byteOffset, rec.dim);
    const d = sha256(bytes);
    if (bytes.length !== want || d !== rec.sha256) return null;
    weights[rec.name] = f.slice();
    digests[rec.name] = d;
    dims[rec.name] = rec.dim;
  }
  for (const h of ENCODER_HEAD_ORDER) {
    if (weights[h] === undefined || digests[h] === undefined || dims[h] === undefined) return null;
  }
  const candidate: HeadCandidate = {
    schema: HEAD_CANDIDATE_SCHEMA, version: m.version, trunkDigest: m.trunkDigest,
    dims: dims as Record<EncoderHeadName, number>,
    weights: weights as Record<EncoderHeadName, Float32Array>,
    digests: digests as Record<EncoderHeadName, string>,
  };
  return validateHeadCandidate(candidate).ok ? candidate : null;
}
