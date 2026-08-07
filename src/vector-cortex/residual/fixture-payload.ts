/**
 * vector-cortex/residual/fixture-payload.ts — deterministic payload
 * materialization for the VC4B conformance corpus.
 *
 * The residual fixtures describe their payloads GENERATIVELY (`kind` + `length`
 * + `seed`) rather than embedding megabytes of base64, so this module is the
 * single normative generator both the fixture producer and the acceptance test
 * agree on. Every generator is pure and deterministic — the same descriptor
 * always yields byte-identical output, which is what makes the committed
 * fixtures meaningful.
 *
 * Pure byte generation: no storage, no console, no network (PREVENT-PI-004 /
 * PREVENT-011).
 */

/** A generative payload descriptor as carried by a residual fixture. */
export interface PayloadDescriptor {
  readonly kind: string;
  readonly length?: number;
  readonly seed?: number;
  readonly value?: number;
  readonly outlierOffset?: number;
  readonly bytesBase64?: string;
}

/** Linear congruential generator (numerical-recipes constants), deterministic. */
function lcgBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  // guardrails-allow PREVENT-STUB-001: VC4B (deterministic generative filler; permanent fixture determinism, not a runtime stub)
  // guardrails-allow PREVENT-MOCK-001: VC4B deterministic synthetic payload bytes, fixture-only; same descriptor always yields identical bytes (accuracy floor acknowledged)
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = (state >>> 24) & 0xff;
  }
  return out;
}

/**
 * Materialize a fixture payload descriptor into exact bytes.
 *
 *   empty        zero bytes
 *   zeros        `length` 0x00 bytes
 *   constant     `length` copies of `value`
 *   sequence     `i % 256`
 *   lcg          deterministic pseudorandom stream from `seed`
 *   text         repeating printable ASCII (valid UTF-8)
 *   invalid-utf8 a stream containing lone continuation/overlong bytes
 *   dc-outlier   all 0xff except one 0x00 at `outlierOffset` (forces the exact
 *                correction stream: a DC-dominant block whose coarse scale
 *                cannot reproduce the outlier's neighbourhood)
 *   alternating  0x00/0xff alternation (maximum Nyquist energy)
 */
export function materializePayload(d: PayloadDescriptor): Uint8Array {
  const length = d.length ?? 0;
  switch (d.kind) {
    case "empty":
      return new Uint8Array(0);
    case "zeros":
      return new Uint8Array(length);
    case "constant":
      return new Uint8Array(length).fill((d.value ?? 0) & 0xff);
    case "sequence":
      return Uint8Array.from({ length }, (_v, i) => i % 256);
    case "lcg":
      return lcgBytes(length, d.seed ?? 1);
    case "text": {
      const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789 ";
      return Uint8Array.from({ length }, (_v, i) =>
        alphabet.charCodeAt(i % alphabet.length),
      );
    }
    case "invalid-utf8": {
      // Deliberately invalid: lone 0x80 continuation, 0xff (never valid), and
      // the overlong 0xc0 0xaf encoding of "/". Never normalized by the codec.
      const pattern = [0xff, 0x80, 0xc0, 0xaf, 0x00, 0xfe];
      return Uint8Array.from({ length }, (_v, i) => pattern[i % pattern.length]!);
    }
    case "dc-outlier": {
      const out = new Uint8Array(length).fill(255);
      const at = d.outlierOffset ?? 0;
      if (at < length) out[at] = 0;
      return out;
    }
    case "alternating":
      return Uint8Array.from({ length }, (_v, i) => (i % 2 === 0 ? 0 : 255));
    case "literal":
      return new Uint8Array(Buffer.from(d.bytesBase64 ?? "", "base64"));
    default:
      throw new Error(`unknown residual payload kind: ${d.kind}`);
  }
}
