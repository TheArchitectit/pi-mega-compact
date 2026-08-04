/**
 * vector-cortex/residual/types.ts — reversible residual payload codec (VC4B).
 *
 * Owns `ResidualCodecV1` / `ParityShardV1` — the contract of the sprint failure
 * triad:
 *
 *   A = admitted residual (DCT + int16 + exact corrections) + RS(9,6) parity;
 *   B = exact compressed bytes (forced when the >95% accounting rejects A);
 *   C = ledger bytes (forced when A/B decode fails).
 *
 * Semantic vectors NEVER claim to recover exact text. Exact bytes come only from
 * exact payload shards (VC4A `ExactShardV1`) or this REVERSIBLE codec: a block
 * DCT-II analysis, int16 quantization, and a block-scoped exact correction
 * stream that makes post-decode byte error exactly zero for admitted artifacts.
 * Numeric erasure parity protects the codec bytes; it is not a substitute for
 * the exact payload (RESIDUAL_CODEC.md).
 *
 * Consumes only reviewer-accepted predecessor contracts (VC1A EventV2 bytes via
 * VC4A shard ranges) and the common contracts. Pure types + registered
 * conformance IDs: no storage, no console, no network (PREVENT-PI-004 /
 * PREVENT-011).
 */

/** Fixed transform block length (RESIDUAL_CODEC §byte scope: 4096). */
export const RESIDUAL_BLOCK_SIZE = 4096;

/** Reed–Solomon shard geometry: k=6 data shards, m=3 parity shards. */
export const RS_DATA_SHARDS = 6;
export const RS_PARITY_SHARDS = 3;
export const RS_TOTAL_SHARDS = RS_DATA_SHARDS + RS_PARITY_SHARDS;

/** GF(2^8) primitive polynomial for the parity field (0x11d). */
export const GF_PRIMITIVE_POLYNOMIAL = 0x11d;

/** Header magic bytes `VCR1`. */
export const RESIDUAL_MAGIC = "VCR1";

/**
 * Admission ratio: residual is admitted only when its FULL encoded size is at
 * most `floor(0.95 * exactCompressedSize)` (RESIDUAL_CODEC §admission). The
 * accounting counts every persisted byte — header, scales, coefficients,
 * corrections, shard metadata, all 9 shards, and digests.
 */
export const ADMISSION_NUMERATOR = 95;
export const ADMISSION_DENOMINATOR = 100;

/**
 * Canonical header of an encoded residual artifact. Serialized (little-endian)
 * as: magic `VCR1` (4 bytes), u32 original length, 32-byte SHA-256 of the
 * ORIGINAL payload, u16 block size, u16 data shard count `k`, u16 parity count
 * `m` — 46 bytes total.
 */
export interface ResidualHeaderV1 {
  readonly magic: typeof RESIDUAL_MAGIC;
  /** Original (pre-padding) payload length in bytes. */
  readonly originalLength: number;
  /** SHA-256 of the original payload bytes, lowercase hex (64 chars). */
  readonly payloadDigest: string;
  readonly blockSize: typeof RESIDUAL_BLOCK_SIZE;
  readonly dataShards: typeof RS_DATA_SHARDS;
  readonly parityShards: typeof RS_PARITY_SHARDS;
}

/** Serialized header byte length: 4 + 4 + 32 + 2 + 2 + 2. */
export const RESIDUAL_HEADER_BYTES = 46;

/**
 * One transform block's quantized coefficients. `scale` is the per-block float32
 * scale `max(abs(c))/32767` (exactly 0 for an all-zero block); `coefficients`
 * are the int16 quantized DCT-II coefficients in ascending frequency order.
 */
export interface QuantizedBlockV1 {
  /** Per-block float32 LE scale. Zero for an all-zero coefficient block. */
  readonly scale: number;
  /** Int16 coefficients, length exactly `RESIDUAL_BLOCK_SIZE`. */
  readonly coefficients: Int16Array;
}

/**
 * One exact byte correction inside a block: the reconstruction differed from
 * the original at `offset`, and `original` is the authoritative byte.
 */
export interface CorrectionV1 {
  /** Offset within the block, 0..4095. */
  readonly offset: number;
  /** The original (authoritative) byte value, 0..255. */
  readonly original: number;
}

/**
 * The block-scoped exact correction stream. Blocks appear in ascending
 * `blockIndex`; each block's corrections are sorted by ascending offset with no
 * duplicate offset. Omitted blocks have an implicit count of zero.
 */
export interface BlockCorrectionsV1 {
  readonly blockIndex: number;
  readonly corrections: readonly CorrectionV1[];
}

/**
 * A fully encoded residual artifact before shard splitting: the header plus the
 * per-block quantization and the exact correction stream. Serializing this in
 * canonical order produces the PROTECTED STREAM that the parity layer splits.
 */
export interface ResidualCodecV1 {
  readonly schema: "residual-codec-v1";
  readonly header: ResidualHeaderV1;
  readonly blocks: readonly QuantizedBlockV1[];
  readonly corrections: readonly BlockCorrectionsV1[];
}

/**
 * One Reed–Solomon shard over the protected stream. Shards 0..5 are the
 * systematic data shards (the protected stream split into `k=6` equal,
 * zero-padded pieces); shards 6..8 are the parity shards, in that order. Every
 * shard carries its own SHA-256 so an unknown corruption is DETECTED (and can
 * then be marked as a known erasure) even though it is never blindly corrected.
 */
export interface ParityShardV1 {
  readonly schema: "parity-shard-v1";
  /** Shard index 0..8 (0..5 data, 6..8 parity). */
  readonly index: number;
  readonly kind: "data" | "parity";
  /** Shard payload bytes; every shard has the same length. */
  readonly bytes: Uint8Array;
  /** SHA-256 of `bytes`, lowercase hex. */
  readonly digest: string;
  /** Length of the UNPADDED protected stream (needed to truncate on recovery). */
  readonly streamLength: number;
}

/** Byte accounting handed forward to VC4C (spec §next handoff). */
export interface ResidualAccountingV1 {
  /** Every persisted residual byte: header + scales + coefficients + corrections + shards + digests. */
  readonly encodedSize: number;
  /** Size of the competing exact compressed representation. */
  readonly exactCompressedSize: number;
  /** `floor(0.95 * exactCompressedSize)` — the inclusive admission ceiling. */
  readonly admissionCeiling: number;
  /** Number of correction entries across every block (density numerator). */
  readonly correctionCount: number;
  /** Number of transform blocks. */
  readonly blockCount: number;
}

/** Failure codes the residual codec / parity layer can return. */
export type ResidualFailureCode =
  | "RES_QUANTIZE_RANGE"
  | "RES_TOO_MANY_ERASURES"
  | "RES_DUPLICATE_SHARD_INDEX"
  | "RES_SHARD_DIGEST_MISMATCH"
  | "RES_SHARD_LENGTH_MISMATCH"
  | "RES_SINGULAR_MATRIX"
  | "RES_PAYLOAD_DIGEST_MISMATCH"
  | "RES_HEADER_INVALID"
  | "RES_CORRECTION_DUPLICATE_OFFSET"
  | "RES_CORRECTION_RANGE"
  | "RES_NOT_ADMITTED";

/** Encode result: an admitted artifact, or the exact reason it was not admitted. */
export type ResidualEncodeResult =
  | {
      ok: true;
      /** Mode A: the residual was admitted. */
      admitted: true;
      codec: ResidualCodecV1;
      shards: readonly ParityShardV1[];
      accounting: ResidualAccountingV1;
    }
  | {
      ok: true;
      /** Mode B: encode succeeded but accounting rejected it; store exact bytes. */
      admitted: false;
      code: "RES_NOT_ADMITTED";
      accounting: ResidualAccountingV1;
    }
  | { ok: false; code: ResidualFailureCode };

/** Decode result: the exact original bytes, or the exact failure code. */
export type ResidualDecodeResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; code: ResidualFailureCode };

/** Parity reconstruction result over a (possibly partial) shard set. */
export type ParityRecoveryResult =
  | { ok: true; stream: Uint8Array; recoveredIndices: readonly number[] }
  | { ok: false; code: ResidualFailureCode };

/** The two structured events the VC4B reporter emits. */
export type ResidualEventName =
  | "vector_cortex_residual_admitted"
  | "vector_cortex_parity_recovery_failed";

/** Injected emit callback — same (event, fields) shape as the other VC seams. */
export type ResidualEmitter = (
  event: ResidualEventName,
  fields: Record<string, unknown>,
) => void;

/** Typed, best-effort reporter bound to the two residual event names. */
export interface ResidualReporter {
  readonly residualAdmitted: (fields: Record<string, unknown>) => void;
  readonly parityRecoveryFailed: (fields: Record<string, unknown>) => void;
}

/**
 * Aggregate-only residual metrics exposed to the dashboard. NEVER payload:
 * counts, byte totals and ratios only (SECURITY_PRIVACY — the exact ledger is
 * not training data and residual payloads are never rendered).
 */
export interface ResidualMetricsV1 {
  readonly encodeAttempts: number;
  readonly admittedCount: number;
  readonly rejectedCount: number;
  readonly recoveryFailures: number;
  readonly encodedByteTotal: number;
  readonly exactByteTotal: number;
}

/**
 * Registered RES conformance ID range (RES-001..050). The acceptance test reads
 * these rows from the v2 manifest and asserts each returns its manifest
 * `ok`/`code`. The three named assertions (RES-DCT-001 / RES-RS-002 /
 * RES-ADMIT-003) live alongside them.
 */
export const RES_IDS: readonly string[] = Array.from(
  { length: 50 },
  (_v, i) => `RES-${String(i + 1).padStart(3, "0")}`,
);

/** Named RES conformance assertions (the sprint's headline rows). */
export const RES_NAMED_IDS = [
  "RES-DCT-001",
  "RES-RS-002",
  "RES-ADMIT-003",
] as const;
