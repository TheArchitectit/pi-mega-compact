/**
 * vector-cortex/residual/parity.ts — Reed–Solomon (9,6) erasure parity over the
 * protected stream (VC4B).
 *
 * Construction (RESIDUAL_CODEC §erasure parity): the protected stream is split
 * into `k=6` equal, zero-padded data shards (the unpadded stream length is
 * stored on every shard). A `9x6` Vandermonde matrix `V[r][c] = alpha_r^c` with
 * evaluation points `alpha_r = r+1` is converted to a SYSTEMATIC generator
 * `G = V x inverse(V[0..5, 0..5])`; rows 0..5 are then the identity (data shards
 * pass through unchanged) and rows 6..8 produce the three parity shards in that
 * order.
 *
 * Recovery: any 6 of the 9 shards reconstruct the stream. Every shard carries
 * its own SHA-256, so an UNKNOWN corruption is DETECTED and can be promoted to a
 * known erasure — it is never blindly error-corrected. More than 3 erasures
 * fails closed (`RES_TOO_MANY_ERASURES`) to the exact source / mode C.
 *
 * Guardrails: local hashing only, no storage, no console, no network
 * (PREVENT-PI-004 / PREVENT-011).
 */

import { createHash } from "node:crypto";
import {
  gfAdd,
  gfAt,
  gfInvert,
  gfMatMul,
  gfMatrix,
  gfMul,
  gfPickRows,
  gfSet,
  gfSubRows,
  vandermonde,
  type GfMatrix,
} from "./gf256.js";
import {
  RS_DATA_SHARDS,
  RS_PARITY_SHARDS,
  RS_TOTAL_SHARDS,
  type ParityRecoveryResult,
  type ParityShardV1,
  type ResidualFailureCode,
} from "./types.js";

/** SHA-256 of a byte slice, lowercase hex. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The systematic `9x6` generator `G = V x inverse(V[0..5,0..5])`. Built once:
 * the matrix depends only on the fixed geometry and the fixed field.
 */
let cachedGenerator: GfMatrix | null = null;

export function systematicGenerator(): GfMatrix {
  if (cachedGenerator) return cachedGenerator;
  const v = vandermonde(RS_TOTAL_SHARDS, RS_DATA_SHARDS);
  const top = gfSubRows(v, 0, RS_DATA_SHARDS);
  const topInv = gfInvert(top);
  if (!topInv) {
    // The fixed Vandermonde top square over GF(2^8) with distinct points 1..6
    // is always invertible; this guard exists so a future geometry change fails
    // loudly rather than silently producing a broken generator.
    throw new Error("residual parity: singular Vandermonde top square");
  }
  cachedGenerator = gfMatMul(v, topInv);
  return cachedGenerator;
}

/** Per-shard payload length for a stream of `streamLength` bytes. */
export function shardLength(streamLength: number): number {
  return Math.ceil(streamLength / RS_DATA_SHARDS);
}

/**
 * Split the protected stream into 9 shards: 6 systematic data shards (equal
 * length, final one zero-padded) followed by 3 parity shards.
 */
export function encodeShards(stream: Uint8Array): ParityShardV1[] {
  const len = shardLength(stream.length);
  const g = systematicGenerator();

  const data: Uint8Array[] = [];
  for (let i = 0; i < RS_DATA_SHARDS; i++) {
    const shard = new Uint8Array(len);
    shard.set(stream.subarray(i * len, Math.min((i + 1) * len, stream.length)));
    data.push(shard);
  }

  const shards: ParityShardV1[] = data.map((bytes, index) => ({
    schema: "parity-shard-v1",
    index,
    kind: "data",
    bytes,
    digest: sha256Hex(bytes),
    streamLength: stream.length,
  }));

  for (let p = 0; p < RS_PARITY_SHARDS; p++) {
    const row = RS_DATA_SHARDS + p;
    const bytes = new Uint8Array(len);
    for (let c = 0; c < RS_DATA_SHARDS; c++) {
      const coefficient = gfAt(g, row, c);
      if (coefficient === 0) continue;
      const src = data[c]!;
      for (let b = 0; b < len; b++) {
        bytes[b] = gfAdd(bytes[b]!, gfMul(coefficient, src[b]!));
      }
    }
    shards.push({
      schema: "parity-shard-v1",
      index: row,
      kind: "parity",
      bytes,
      digest: sha256Hex(bytes),
      streamLength: stream.length,
    });
  }
  return shards;
}

/**
 * Verify every supplied shard's SHA-256 and return the indices whose digest
 * does NOT match. A corrupt shard is DETECTED here; the caller promotes it to a
 * known erasure rather than attempting unknown-error correction.
 */
export function detectCorruptShards(
  shards: readonly ParityShardV1[],
): number[] {
  const corrupt: number[] = [];
  for (const s of shards) {
    if (sha256Hex(s.bytes) !== s.digest) corrupt.push(s.index);
  }
  return corrupt.sort((a, b) => a - b);
}

/** Structural validation shared by recovery paths. */
function validateShards(
  shards: readonly ParityShardV1[],
): { ok: true; length: number; streamLength: number } | { ok: false; code: ResidualFailureCode } {
  if (shards.length === 0) return { ok: false, code: "RES_TOO_MANY_ERASURES" };
  const seen = new Set<number>();
  const length = shards[0]!.bytes.length;
  const streamLength = shards[0]!.streamLength;
  for (const s of shards) {
    if (s.index < 0 || s.index >= RS_TOTAL_SHARDS || !Number.isInteger(s.index)) {
      return { ok: false, code: "RES_DUPLICATE_SHARD_INDEX" };
    }
    if (seen.has(s.index)) return { ok: false, code: "RES_DUPLICATE_SHARD_INDEX" };
    seen.add(s.index);
    if (s.bytes.length !== length) {
      return { ok: false, code: "RES_SHARD_LENGTH_MISMATCH" };
    }
    if (s.streamLength !== streamLength) {
      return { ok: false, code: "RES_SHARD_LENGTH_MISMATCH" };
    }
  }
  if (shardLength(streamLength) !== length) {
    return { ok: false, code: "RES_SHARD_LENGTH_MISMATCH" };
  }
  return { ok: true, length, streamLength };
}

/**
 * Reconstruct the protected stream from AT LEAST 6 surviving shards.
 *
 * Every supplied shard is digest-checked first: a shard whose SHA-256 does not
 * match its recorded digest is treated as a KNOWN erasure (it is dropped from
 * the surviving set), which is exactly how a corrupt parity shard becomes the
 * third erasure in the sprint's failure-injection case. If fewer than 6 shards
 * survive that check, recovery fails closed with `RES_TOO_MANY_ERASURES` and
 * never attempts unknown-error correction.
 */
export function recoverStream(
  shards: readonly ParityShardV1[],
): ParityRecoveryResult {
  const structural = validateShards(shards);
  if (!structural.ok) return structural;
  const { length, streamLength } = structural;

  // Digest check: promote every detected corruption to a known erasure.
  const corrupt = new Set(detectCorruptShards(shards));
  const survivors = shards
    .filter((s) => !corrupt.has(s.index))
    .slice()
    .sort((a, b) => a.index - b.index);

  if (survivors.length < RS_DATA_SHARDS) {
    return { ok: false, code: "RES_TOO_MANY_ERASURES" };
  }

  // Deterministic selection: the six lowest surviving indices.
  const chosen = survivors.slice(0, RS_DATA_SHARDS);
  const g = systematicGenerator();
  const sub = gfPickRows(g, chosen.map((s) => s.index));
  const subInv = gfInvert(sub);
  if (!subInv) return { ok: false, code: "RES_SINGULAR_MATRIX" };

  // Recover the six data shards: D = inverse(G_chosen) x S_chosen.
  const recoveredData: Uint8Array[] = [];
  for (let r = 0; r < RS_DATA_SHARDS; r++) {
    const out = new Uint8Array(length);
    for (let c = 0; c < RS_DATA_SHARDS; c++) {
      const coefficient = gfAt(subInv, r, c);
      if (coefficient === 0) continue;
      const src = chosen[c]!.bytes;
      for (let b = 0; b < length; b++) {
        out[b] = gfAdd(out[b]!, gfMul(coefficient, src[b]!));
      }
    }
    recoveredData.push(out);
  }

  const stream = new Uint8Array(streamLength);
  for (let i = 0; i < RS_DATA_SHARDS; i++) {
    const start = i * length;
    if (start >= streamLength) break;
    const take = Math.min(length, streamLength - start);
    stream.set(recoveredData[i]!.subarray(0, take), start);
  }

  const present = new Set(chosen.map((s) => s.index));
  const recoveredIndices: number[] = [];
  for (let i = 0; i < RS_TOTAL_SHARDS; i++) if (!present.has(i)) recoveredIndices.push(i);
  return { ok: true, stream, recoveredIndices };
}

/**
 * Recover with an EXPLICIT erasure set: the named indices are treated as lost
 * regardless of their digest. More than `m=3` marked erasures fails closed with
 * `RES_TOO_MANY_ERASURES` before any matrix work — including the case where
 * three data shards are marked AND a fourth (parity) shard is corrupt.
 */
export function recoverWithErasures(
  shards: readonly ParityShardV1[],
  erasedIndices: readonly number[],
): ParityRecoveryResult {
  const erased = new Set(erasedIndices);
  if (erased.size > RS_PARITY_SHARDS) {
    return { ok: false, code: "RES_TOO_MANY_ERASURES" };
  }
  const kept = shards.filter((s) => !erased.has(s.index));
  // A corruption among the KEPT shards is an additional known erasure; if that
  // pushes the total past m=3 the recovery fails closed rather than attempting
  // unknown-error correction.
  const corrupt = detectCorruptShards(kept);
  if (erased.size + corrupt.length > RS_PARITY_SHARDS) {
    return { ok: false, code: "RES_TOO_MANY_ERASURES" };
  }
  return recoverStream(kept);
}

/** Rebuild the full 9-shard set from a recovered stream (repair path). */
export function repairShards(stream: Uint8Array): ParityShardV1[] {
  return encodeShards(stream);
}

/** Test/diagnostic helper: the systematic generator's parity rows. */
export function parityRows(): number[][] {
  const g = systematicGenerator();
  const rows: number[][] = [];
  for (let r = RS_DATA_SHARDS; r < RS_TOTAL_SHARDS; r++) {
    const row: number[] = [];
    for (let c = 0; c < RS_DATA_SHARDS; c++) row.push(gfAt(g, r, c));
    rows.push(row);
  }
  return rows;
}

/** Test helper: assert the generator's top square really is the identity. */
export function generatorIsSystematic(): boolean {
  const g = systematicGenerator();
  for (let r = 0; r < RS_DATA_SHARDS; r++) {
    for (let c = 0; c < RS_DATA_SHARDS; c++) {
      const expected = r === c ? 1 : 0;
      if (gfAt(g, r, c) !== expected) return false;
    }
  }
  return true;
}

export { gfMatrix, gfSet };
