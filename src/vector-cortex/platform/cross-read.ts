/**
 * platform/cross-read.ts — VC8C neutral stdin/stdout cross-conformance framing.
 *
 * Both the TS reference and an external Rust binary speak ONE neutral wire
 * format: a sequence of length-prefixed JSON records. Each record is:
 *
 *   [4-byte big-endian length][exactly that many bytes of canonical JSON]
 *
 * The TS side encodes and decodes this framing; the external runner (a local
 * subprocess, PREVENT-PI-004: never a URL) reads the same frames on stdin and
 * writes them back on stdout. Parity is then byte-for-byte: the canonical JSON
 * bytes of each record and the failure code must match in both directions.
 *
 * `outputBytes` is the OCAML-free canonical representation of a fixture's
 * produced bytes as a HEX STRING, so byte-equality is a plain string compare and
 * the wire JSON never carries raw binary.
 *
 * Everything here is PURE: no clock, no storage, no network, no flag read. The
 * flag gates only the reporter seam in emit.ts.
 *
 * PREVENT-011: no `any` type. PREVENT-PI-004: no network.
 */

import { RUST_FRAME_TRUNCATED, RUST_PARITY_MISMATCH } from "./types.js";

/** One neutral record exchanged between a TS reference and an external runner. */
export interface NeutralRecord {
  readonly fixtureId: string;
  /** Produced output bytes as a hex string (canonical byte comparison). */
  readonly outputBytes: string;
  /** The machine failure code, or null when the fixture succeeded. */
  readonly failureCode: string | null;
}

/** The result of decoding a neutral frame stream. */
export type NeutralDecodeResult =
  | { readonly ok: true; readonly records: ReadonlyArray<NeutralRecord> }
  | { readonly ok: false; readonly code: string };

/** The result of comparing two neutral records. */
export type NeutralCompareResult = { readonly ok: true } | { readonly ok: false; readonly code: string };

/** Canonical JSON bytes for a neutral record (the wire form of a record body). */
export function encodeRecordJson(record: NeutralRecord): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(record));
}

/**
 * Encode a list of neutral records into the length-framed neutral wire format.
 * Each record is written as a 4-byte big-endian length followed by exactly that
 * many canonical JSON bytes, concatenated in order.
 */
export function encodeNeutralFrame(fixtures: ReadonlyArray<NeutralRecord>): Uint8Array {
  const parts: Array<Uint8Array> = [];
  for (const fixture of fixtures) {
    const body = encodeRecordJson(fixture);
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, body.length, false);
    parts.push(header, body);
  }
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Decode a neutral frame stream back into records. A partial trailing frame
 * (a length prefix with fewer body bytes than declared) returns
 * `{ ok: false, code: "RUST_FRAME_TRUNCATED" }` — the invariant the sprint's
 * unique failure injection exercises.
 */
export function decodeNeutralFrame(bytes: Uint8Array): NeutralDecodeResult {
  const records: NeutralRecord[] = [];
  let offset = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  while (offset + 4 <= bytes.byteLength) {
    const len = view.getUint32(offset, false);
    offset += 4;
    if (offset + len > bytes.byteLength) {
      return { ok: false, code: RUST_FRAME_TRUNCATED };
    }
    const body = decoder.decode(bytes.subarray(offset, offset + len));
    offset += len;
    try {
      records.push(JSON.parse(body) as NeutralRecord);
    } catch {
      return { ok: false, code: RUST_FRAME_TRUNCATED };
    }
  }
  if (offset !== bytes.byteLength) {
    // Trailing bytes fewer than one length prefix — the frame was cut mid-header.
    return { ok: false, code: RUST_FRAME_TRUNCATED };
  }
  return { ok: true, records };
}

/**
 * Compare one expected record against one actual record. Both the canonical
 * output bytes (as hex strings) and the failure code must match. Any byte or
 * code difference returns `{ ok: false, code: "RUST_PARITY_MISMATCH" }`.
 */
export function compareFixtureOutput(
  expected: NeutralRecord,
  actual: NeutralRecord,
): NeutralCompareResult {
  if (expected.fixtureId !== actual.fixtureId) {
    return { ok: false, code: RUST_PARITY_MISMATCH };
  }
  if (expected.outputBytes !== actual.outputBytes) {
    return { ok: false, code: RUST_PARITY_MISMATCH };
  }
  if (expected.failureCode !== actual.failureCode) {
    return { ok: false, code: RUST_PARITY_MISMATCH };
  }
  return { ok: true };
}
