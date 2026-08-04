/**
 * vector-cortex/encoder/trigram.ts — VC2B mode B: asset-free trigram encoder.
 *
 * Trigram B is a deterministic, asset-free (no learned model, no manifest, no
 * calibration) 512-dim fixed feature encoding of a token/phrase sequence. It is
 * the mode-B fallback selected when the learned asset (mode A) is removed,
 * missing, unsupported, or digest-bad — and it never imports the learned asset
 * or learned calibration (task 4). It derives directly from textual authority:
 * the same document hashed via its byte-level trigrams yields the same 512-dim
 * vector regardless of the asset state.
 *
 * Width is fixed at `ENCODER_TRIGRAM_WIDTH = 512` (VC2B task 4 "trigram B at 512
 * dimensions"). The vector is L2-normalized; a zero-norm (empty) input maps to
 * the all-zero vector, matching the heads convention of the VectorSet.
 *
 * Failure-triad independence: B's algorithm/index is distinct from A (learned
 * projections) and C (token/phrase lexical) — it is a deterministic hashed
 * n-gram bag-of-hashes, computed purely in-process with no external asset.
 *
 * Pi-agnostic, zero network (PREVENT-PI-004), no `any` (PREVENT-011).
 */

import { createHash } from "node:crypto";
import { l2Normalize } from "./heads.js";
import {
  createEncoderHeadsReporter,
  type EncoderHeadsReporter,
} from "./emit-vc2b.js";

/** Fixed output width of trigram B (VC2B task 4). */
export const ENCODER_TRIGRAM_WIDTH = 512;

/** Tokenize a phrase into byte-level trigrams (3-byte sliding windows). For a
 *  short phrase with fewer than 3 bytes we still emit the available shingles. */
function trigrams(text: string): string[] {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length === 0) return [];
  const out: string[] = [];
  const n = bytes.length;
  for (let i = 0; i < Math.max(1, n - 2); i++) {
    const chunk = bytes.slice(i, i + 3);
    out.push(chunk.toString("hex"));
  }
  // For phrases shorter than 3 bytes, the whole string is one shingle.
  if (n < 3) out.push(bytes.toString("hex"));
  return out;
}

/**
 * Encode a phrase into a 512-dim L2-normalized trigram vector (all-zero on
 * empty input). Deterministic: the same text always yields the same vector
 * (repeat drift == 0) — no asset, no calibration, no network.
 */
export function embedTrigram512(text: string): Float32Array {
  const width = ENCODER_TRIGRAM_WIDTH;
  const out = new Float32Array(width);
  // Feistel-style double hashing of each trigram into a bucket index + weight.
  for (const tg of trigrams(text)) {
    const h1 = createHash("sha256").update(tg).digest();
    const bucket = h1.readUInt32BE(0) % width;
    const weight = (h1.readUInt32BE(4) / 4294967295) * 2 - 1;
    out[bucket] += weight;
  }
  return l2Normalize(out);
}

/**
 * The 512-dim vector is produced even when the learned asset is absent: this is
 * the mode-B selection point. Returns `{ ok: true, dim, width }` always — there
 * is no asset to consult (task 4 + ENC-FALLBACK-003). Selecting mode B also
 * emits `vector_cortex_encoder_fallback_selected` via the flag-gated reporter
 * (task 5) — the production seam that makes the fallback event live in the
 * runtime, not dead test-only wiring.
 */
export function selectTrigramBFallback(
  options: { readonly reporter?: EncoderHeadsReporter } = {},
): { ok: true; dim: number; width: number; mode: "B" } {
  const reporter = options.reporter ?? createEncoderHeadsReporter();
  const selection = { ok: true as const, mode: "B" as const, dim: ENCODER_TRIGRAM_WIDTH, width: ENCODER_TRIGRAM_WIDTH };
  reporter.fallbackSelected({ mode: selection.mode, dim: selection.dim, width: selection.width });
  return selection;
}

export { l2Normalize };
