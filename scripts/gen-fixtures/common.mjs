// Shared helpers + path constants for the VC0A/VC0B/VC1A/VC0C fixture
// generators. Kept byte-identical to the original monolith so the emitted
// conformance fixtures never change.

import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const scriptDir = dirname(fileURLToPath(import.meta.url));
// common.mjs lives at scripts/gen-fixtures/, so V2 is two levels above.
export const V2 = join(scriptDir, "..", "..", "conformance", "vector-cortex", "v2");
export const EVAL_DIR = join(V2, "evaluation");
export const SCHEMA_DIR = join(V2, "schemas");

export const producer = "vector-cortex-gen-fixtures.mjs";

export function canonicalValue(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return String(value);
    if (typeof value === "number") return String(value); // shortest int/number
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  const keys = Object.keys(value).map((k) => k.normalize("NFC")).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalValue(value[k])}`).join(",")}}`;
}

export function canonicalJson(value) {
  return canonicalValue(value) + "\n";
}

export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function b64(s) {
  return Buffer.from(s, "utf8").toString("base64");
}

export function b64bytes(bytes) {
  return Buffer.from(bytes).toString("base64");
}
