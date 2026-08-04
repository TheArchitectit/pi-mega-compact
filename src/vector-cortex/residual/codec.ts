/**
 * vector-cortex/residual/codec.ts — reversible residual payload codec (VC4B).
 *
 * Encode: split `EventV2.originalBytes` into 4096-byte blocks (zero-padding only
 * the final block), map bytes to `x=(byte-127.5)/127.5`, take the orthonormal
 * DCT-II, quantize to int16 with a per-block float32 scale, reconstruct, and
 * append a block-scoped EXACT correction stream wherever the reconstruction
 * differs. Post-decode byte error for an admitted artifact is therefore exactly
 * ZERO — the digest is verified before admission, never assumed.
 *
 * Admission (RESIDUAL_CODEC §admission): residual is admitted only when the FULL
 * encoded size — header, scales, coefficients, corrections, shard index/length
 * metadata, all 9 shards and their digests — is `<= floor(0.95 *
 * exactCompressedSize)` AND the complete decode + digest check succeeds.
 * Otherwise the caller stores the exact compressed payload (mode B). Coefficient
 * bytes alone are never compared.
 *
 * Emits `vector_cortex_residual_admitted` / `vector_cortex_parity_recovery_failed`
 * through the flag-gated reporter and exposes AGGREGATE-ONLY residual metrics
 * (counts/byte totals — never payload).
 *
 * Guardrails: local hashing only, no storage, no console, no network
 * (PREVENT-PI-004 / PREVENT-011).
 */

import { createHash } from "node:crypto";
import { VC4B_ENABLED } from "../../config/vector-cortex.js";
import {
  bytesToSignal,
  forwardDct,
  inverseDct,
  signalToBytes,
  splitBlocks,
} from "./dct.js";
import {
  applyCorrections,
  dequantizeBlock,
  diffBlock,
  quantizeBlock,
} from "./quantize.js";
import { encodeShards, recoverStream, sha256Hex } from "./parity.js";
import { parseStream, serializeStream } from "./stream.js";
import {
  ADMISSION_DENOMINATOR,
  ADMISSION_NUMERATOR,
  RESIDUAL_BLOCK_SIZE,
  RESIDUAL_MAGIC,
  RS_DATA_SHARDS,
  RS_PARITY_SHARDS,
  type BlockCorrectionsV1,
  type ParityShardV1,
  type QuantizedBlockV1,
  type ResidualAccountingV1,
  type ResidualCodecV1,
  type ResidualDecodeResult,
  type ResidualEmitter,
  type ResidualEncodeResult,
  type ResidualMetricsV1,
  type ResidualReporter,
} from "./types.js";

/** Per-shard persisted metadata: u8 index + u32 LE length + 32-byte digest. */
const SHARD_METADATA_BYTES = 1 + 4 + 32;

/**
 * The inclusive admission ceiling `floor(0.95 * exactCompressedSize)`, computed
 * in integer arithmetic so the boundary is exact (a fractional 0.95 multiply
 * would make the "one byte above rejects" case depend on float rounding).
 */
export function admissionCeiling(exactCompressedSize: number): number {
  return Math.floor(
    (exactCompressedSize * ADMISSION_NUMERATOR) / ADMISSION_DENOMINATOR,
  );
}

/** Total persisted bytes of the shard set (payload + per-shard metadata). */
export function shardSetBytes(shards: readonly ParityShardV1[]): number {
  return shards.reduce(
    (n, s) => n + s.bytes.length + SHARD_METADATA_BYTES,
    0,
  );
}

/** Build the codec artifact (transform + quantize + exact corrections). */
export function buildArtifact(
  payload: Uint8Array,
): { ok: true; codec: ResidualCodecV1 } | { ok: false; code: "RES_QUANTIZE_RANGE" } {
  const digest = sha256Hex(payload);
  const rawBlocks = splitBlocks(payload, RESIDUAL_BLOCK_SIZE);
  const blocks: QuantizedBlockV1[] = [];
  const corrections: BlockCorrectionsV1[] = [];

  for (let b = 0; b < rawBlocks.length; b++) {
    const original = rawBlocks[b]!;
    const quantized = quantizeBlock(forwardDct(bytesToSignal(original)));
    if (!quantized.ok) return { ok: false, code: "RES_QUANTIZE_RANGE" };
    blocks.push(quantized.block);
    // Reconstruct and diff: any residual byte error becomes an exact correction.
    const reconstructed = signalToBytes(
      inverseDct(dequantizeBlock(quantized.block)),
    );
    const diff = diffBlock(original, reconstructed);
    if (diff.length > 0) corrections.push({ blockIndex: b, corrections: diff });
  }

  return {
    ok: true,
    codec: {
      schema: "residual-codec-v1",
      header: {
        magic: RESIDUAL_MAGIC,
        originalLength: payload.length,
        payloadDigest: digest,
        blockSize: RESIDUAL_BLOCK_SIZE,
        dataShards: RS_DATA_SHARDS,
        parityShards: RS_PARITY_SHARDS,
      },
      blocks,
      corrections,
    },
  };
}

/**
 * Encode a payload and decide admission against the competing exact compressed
 * size. Admission requires BOTH the <=95% byte accounting AND a full decode whose
 * digest matches the original payload.
 */
export function encodeResidual(
  payload: Uint8Array,
  exactCompressedSize: number,
  emit?: ResidualEmitter,
): ResidualEncodeResult {
  const built = buildArtifact(payload);
  if (!built.ok) return { ok: false, code: built.code };
  const codec = built.codec;

  const stream = serializeStream(codec);
  const shards = encodeShards(stream);
  const encodedSize = stream.length + shardSetBytes(shards);
  const correctionCount = codec.corrections.reduce(
    (n, b) => n + b.corrections.length,
    0,
  );
  const accounting: ResidualAccountingV1 = {
    encodedSize,
    exactCompressedSize,
    admissionCeiling: admissionCeiling(exactCompressedSize),
    correctionCount,
    blockCount: codec.blocks.length,
  };

  const reporter = createResidualReporter(emit);
  if (encodedSize > accounting.admissionCeiling) {
    return { ok: true, admitted: false, code: "RES_NOT_ADMITTED", accounting };
  }

  // Never admit without proving the full decode round-trips to the exact bytes.
  const verified = decodeResidual(shards, emit);
  if (!verified.ok) return { ok: false, code: verified.code };
  if (sha256Hex(verified.bytes) !== codec.header.payloadDigest) {
    return { ok: false, code: "RES_PAYLOAD_DIGEST_MISMATCH" };
  }

  reporter.residualAdmitted({
    encodedSize,
    exactCompressedSize,
    admissionCeiling: accounting.admissionCeiling,
    blockCount: accounting.blockCount,
    correctionCount,
  });
  return { ok: true, admitted: true, codec, shards, accounting };
}

/**
 * Decode from a (possibly partial / partially corrupt) shard set: recover the
 * protected stream, invert the transform, apply the exact corrections, truncate
 * to the original length, and verify the payload digest.
 */
export function decodeResidual(
  shards: readonly ParityShardV1[],
  emit?: ResidualEmitter,
): ResidualDecodeResult {
  const reporter = createResidualReporter(emit);
  const recovered = recoverStream(shards);
  if (!recovered.ok) {
    reporter.parityRecoveryFailed({
      code: recovered.code,
      shardCount: shards.length,
    });
    return { ok: false, code: recovered.code };
  }
  const codec = parseStream(recovered.stream);
  if (!codec) {
    reporter.parityRecoveryFailed({
      code: "RES_HEADER_INVALID",
      shardCount: shards.length,
    });
    return { ok: false, code: "RES_HEADER_INVALID" };
  }
  return decodeArtifact(codec);
}

/** Decode a parsed artifact directly (no parity layer). */
export function decodeArtifact(codec: ResidualCodecV1): ResidualDecodeResult {
  const blockSize = codec.header.blockSize;
  const out = new Uint8Array(codec.blocks.length * blockSize);
  const byIndex = new Map<number, readonly { offset: number; original: number }[]>();
  for (const b of codec.corrections) byIndex.set(b.blockIndex, b.corrections);

  for (let b = 0; b < codec.blocks.length; b++) {
    const reconstructed = signalToBytes(
      inverseDct(dequantizeBlock(codec.blocks[b]!)),
    );
    const applied = applyCorrections(reconstructed, byIndex.get(b) ?? []);
    if (!applied.ok) return { ok: false, code: applied.code };
    out.set(reconstructed, b * blockSize);
  }

  const bytes = out.subarray(0, codec.header.originalLength);
  if (sha256Hex(bytes) !== codec.header.payloadDigest) {
    return { ok: false, code: "RES_PAYLOAD_DIGEST_MISMATCH" };
  }
  // Return an independent copy so the caller cannot alias the working buffer.
  return { ok: true, bytes: Uint8Array.from(bytes) };
}

/** SHA-256 of arbitrary bytes (re-exported so callers need one import). */
export function payloadDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ── aggregate-only metrics + reporter ───────────────────────────────────────

/**
 * Accumulate AGGREGATE-ONLY residual metrics (counts/byte totals). Never
 * payload, never prompt text: the dashboard reads this shape and nothing else.
 */
export function accumulateMetrics(
  previous: ResidualMetricsV1,
  result: ResidualEncodeResult,
): ResidualMetricsV1 {
  if (!result.ok) {
    return { ...previous, encodeAttempts: previous.encodeAttempts + 1 };
  }
  const base = {
    ...previous,
    encodeAttempts: previous.encodeAttempts + 1,
    encodedByteTotal: previous.encodedByteTotal + result.accounting.encodedSize,
    exactByteTotal:
      previous.exactByteTotal + result.accounting.exactCompressedSize,
  };
  return result.admitted
    ? { ...base, admittedCount: base.admittedCount + 1 }
    : { ...base, rejectedCount: base.rejectedCount + 1 };
}

/** A zeroed metrics accumulator. */
export function emptyMetrics(): ResidualMetricsV1 {
  return {
    encodeAttempts: 0,
    admittedCount: 0,
    rejectedCount: 0,
    recoveryFailures: 0,
    encodedByteTotal: 0,
    exactByteTotal: 0,
  };
}

/** Build the flag-gated typed reporter (mirrors the VC4A shard reporter). */
export function createResidualReporter(emit?: ResidualEmitter): ResidualReporter {
  const fire = (
    event: Parameters<ResidualEmitter>[0],
    fields: Record<string, unknown>,
  ): void => {
    if (!VC4B_ENABLED()) return;
    if (!emit) return;
    try {
      emit(event, fields);
    } catch {
      /* non-fatal observability — never break the agent loop */
    }
  };
  return {
    residualAdmitted(fields) {
      fire("vector_cortex_residual_admitted", fields);
    },
    parityRecoveryFailed(fields) {
      fire("vector_cortex_parity_recovery_failed", fields);
    },
  };
}
