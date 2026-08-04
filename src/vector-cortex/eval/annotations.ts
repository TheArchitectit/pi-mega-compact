/**
 * vector-cortex/eval/annotations.ts — redaction metadata + JSONL serialization.
 *
 * Payload bytes, prompts, and exact ledger text are NEVER serialized. Before a
 * JSONL line is written, each such field is replaced by a SHA-256 digest + byte
 * count + redaction kind (EVAL-REDACT-002: prompt bytes never appear in JSONL).
 * The redaction journal is itself the AnnotationV1 output.
 *
 * Uses node:crypto for the digest (pure local math, PREVENT-PI-004 safe).
 */

import { createHash } from "node:crypto";
import type { AnnotationV1 } from "./types.js";

export type RedactKind = "payload" | "prompt" | "ledger";

/** A raw content field awaiting redaction before serialization. */
export interface RawContent {
  /** Field name in the original annotation. */
  readonly field: string;
  /** Kind of content — determines the redaction reason. */
  readonly kind: RedactKind;
  /** Original bytes; digested, never serialized. */
  readonly bytes: Uint8Array;
}

/** Canonical serialization of an annotation: digest/count metadata only. */
export interface SerializedAnnotation {
  readonly jsonl: string;
  readonly annotation: AnnotationV1;
}

/** SHA-256 over bytes, unpadded base64 (conformance canonical binary form). */
export function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64");
}

/** Replace every raw content field with its digest/count metadata. */
export function redactAnnotation(
  itemId: string,
  contents: ReadonlyArray<RawContent>,
): AnnotationV1 {
  const redactions = contents.map((c) => ({
    field: c.field,
    digest: digestBytes(c.bytes),
    bytes: c.bytes.byteLength,
    kind: c.kind,
  }));
  return {
    itemId,
    redactions,
    redactedCount: redactions.length,
  };
}

/**
 * Serialize one set of raw contents to a single redacted JSONL line. Returns
 * the annotation with its digest metadata and the JSONL text; the raw bytes
 * never appear in the returned string.
 */
export function serializeRedactedJsonl(
  itemId: string,
  contents: ReadonlyArray<RawContent>,
): SerializedAnnotation {
  const annotation = redactAnnotation(itemId, contents);
  return {
    annotation,
    jsonl: `${JSON.stringify(annotation)}\n`,
  };
}
