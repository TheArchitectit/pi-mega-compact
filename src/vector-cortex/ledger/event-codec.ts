/**
 * vector-cortex/ledger/event-codec.ts — EventV2 byte-authority codec, Mode A
 * (VC1A, TRIAD_RESILIENCE).
 *
 * A retains `originalBytes` + a SHA-256 `bytesDigest` and classifies strict
 * UTF-8 (success) vs invalid-byte content WITHOUT replacement decoding:
 * `TextDecoder(..., {fatal:true})` either yields text or throws — invalid input
 * is represented only as `{valid:false, base64}` and is NEVER lossy-replaced.
 * `canonicalNfc` is computed ONLY as a derived field for valid UTF-8 and is
 * NEVER used for identity, digest, or byte reconstruction — `decode` returns the
 * authoritative `originalBytes` exactly.
 *
 * Mode B (`./event-codecB.ts`) is a genuinely independent implementation of the
 * same byte rule; A and B share no subroutine and must agree byte-for-byte.
 *
 * Pure/deterministic — no console, no network, no side effects (PREVENT-PI-004).
 */

import nodeCrypto from "node:crypto";
import type { BytesDigest, EventCodec, EventEncodeInput, EventV2 } from "./types.js";

/** Mode-A internal SHA-256 helper (NOT shared with mode B). */
function digestSha256A(bytes: Uint8Array): BytesDigest {
  const hex = nodeCrypto.createHash("sha256").update(bytes).digest("hex");
  return `sha256:${hex}`;
}

/** Mode-A internal base64 (NOT shared with mode B). */
function base64EncodeA(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * Strict UTF-8 classification with FATAL decoding (never replaces invalid bytes
 * with U+FFFD). Returns the decoded text, or `{valid:false, base64}`.
 */
export function classifyUtf8(bytes: Uint8Array): { valid: true; text: string } | { valid: false; base64: string } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { valid: true, text };
  } catch {
    return { valid: false, base64: base64EncodeA(bytes) };
  }
}

/** Build the Mode-A byte-authority codec. */
export function createEventCodec(): EventCodec {
  return {
    encode(input: EventEncodeInput): EventV2 {
      const bytes = input.bytes;
      const bytesDigest = digestSha256A(bytes);
      const utf8 = classifyUtf8(bytes);
      const event: EventV2 = {
        schema: "event-v2",
        sessionId: input.sessionId,
        seq: input.seq,
        eventId: input.eventId,
        role: input.role,
        kind: input.kind,
        originalBytes: bytes,
        bytesDigest,
        utf8,
        occurredAtMs: input.occurredAtMs,
      };
      if (input.toolCallId !== undefined) event.toolCallId = input.toolCallId;
      // canonicalNfc is a DERIVED search key — valid UTF-8 only, never identity.
      if (utf8.valid) event.canonicalNfc = utf8.text.normalize("NFC");
      return event;
    },

    decode(event: EventV2): Uint8Array {
      return event.originalBytes;
    },

    classifyUtf8,
  };
}

export type { BytesDigest, EventV2 };
