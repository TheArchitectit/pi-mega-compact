/**
 * vector-cortex/residual/stream.ts — canonical PROTECTED STREAM serialization
 * for the VC4B residual codec.
 *
 * The protected stream is `header + all block scales/coefficient arrays +
 * corrections` (RESIDUAL_CODEC §erasure parity), serialized in exactly this
 * canonical order so encode and decode are byte-symmetric:
 *
 *   header (46 bytes)  magic `VCR1` | u32 LE originalLength | 32-byte SHA-256
 *                      | u16 LE blockSize | u16 LE k | u16 LE m
 *   blocks             for each block in ascending index:
 *                        float32 LE scale | 4096 * int16 LE coefficient
 *   corrections        varint blockCount, then per non-empty block
 *                        u32 LE blockIndex | varint count
 *                        | count * (u16 LE offset, u8 original)
 *
 * Pure serialization: no storage, no console, no network (PREVENT-PI-004 /
 * PREVENT-011).
 */

import {
  parseCorrections,
  serializeCorrections,
} from "./quantize.js";
import {
  RESIDUAL_BLOCK_SIZE,
  RESIDUAL_HEADER_BYTES,
  RESIDUAL_MAGIC,
  RS_DATA_SHARDS,
  RS_PARITY_SHARDS,
  type QuantizedBlockV1,
  type ResidualCodecV1,
  type ResidualHeaderV1,
} from "./types.js";

/** Per-block serialized size: float32 scale + n int16 coefficients. */
export function blockBytes(blockSize: number = RESIDUAL_BLOCK_SIZE): number {
  return 4 + blockSize * 2;
}

/** Serialize the canonical 46-byte header. */
export function serializeHeader(header: ResidualHeaderV1): Uint8Array {
  const out = new Uint8Array(RESIDUAL_HEADER_BYTES);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = RESIDUAL_MAGIC.charCodeAt(i);
  view.setUint32(4, header.originalLength, true);
  const digest = Buffer.from(header.payloadDigest, "hex");
  out.set(digest.subarray(0, 32), 8);
  view.setUint16(40, header.blockSize, true);
  view.setUint16(42, header.dataShards, true);
  view.setUint16(44, header.parityShards, true);
  return out;
}

/** Parse the canonical header. Returns null on magic/geometry mismatch. */
export function parseHeader(bytes: Uint8Array): ResidualHeaderV1 | null {
  if (bytes.length < RESIDUAL_HEADER_BYTES) return null;
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== RESIDUAL_MAGIC.charCodeAt(i)) return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const originalLength = view.getUint32(4, true);
  const payloadDigest = Buffer.from(bytes.subarray(8, 40)).toString("hex");
  const blockSize = view.getUint16(40, true);
  const dataShards = view.getUint16(42, true);
  const parityShards = view.getUint16(44, true);
  if (blockSize !== RESIDUAL_BLOCK_SIZE) return null;
  if (dataShards !== RS_DATA_SHARDS || parityShards !== RS_PARITY_SHARDS) return null;
  return {
    magic: RESIDUAL_MAGIC,
    originalLength,
    payloadDigest,
    blockSize: RESIDUAL_BLOCK_SIZE,
    dataShards: RS_DATA_SHARDS,
    parityShards: RS_PARITY_SHARDS,
  };
}

/** Serialize the full protected stream for one encoded artifact. */
export function serializeStream(codec: ResidualCodecV1): Uint8Array {
  const head = serializeHeader(codec.header);
  const perBlock = blockBytes(codec.header.blockSize);
  const corrections = serializeCorrections(codec.corrections);
  const out = new Uint8Array(
    head.length + codec.blocks.length * perBlock + corrections.length,
  );
  out.set(head, 0);
  const view = new DataView(out.buffer);
  let pos = head.length;
  for (const block of codec.blocks) {
    view.setFloat32(pos, block.scale, true);
    pos += 4;
    for (let i = 0; i < block.coefficients.length; i++) {
      view.setInt16(pos, block.coefficients[i]!, true);
      pos += 2;
    }
  }
  out.set(corrections, pos);
  return out;
}

/** Parse a protected stream back into the codec artifact. Null on malformed. */
export function parseStream(stream: Uint8Array): ResidualCodecV1 | null {
  const header = parseHeader(stream);
  if (!header) return null;
  const perBlock = blockBytes(header.blockSize);
  const blockCount = Math.ceil(header.originalLength / header.blockSize);
  const bodyEnd = RESIDUAL_HEADER_BYTES + blockCount * perBlock;
  if (stream.length < bodyEnd) return null;
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const blocks: QuantizedBlockV1[] = [];
  let pos = RESIDUAL_HEADER_BYTES;
  for (let b = 0; b < blockCount; b++) {
    const scale = view.getFloat32(pos, true);
    pos += 4;
    const coefficients = new Int16Array(header.blockSize);
    for (let i = 0; i < header.blockSize; i++) {
      coefficients[i] = view.getInt16(pos, true);
      pos += 2;
    }
    blocks.push({ scale, coefficients });
  }
  const parsed = parseCorrections(stream, pos);
  if (!parsed) return null;
  // Every correction must name a block that exists.
  for (const block of parsed.blocks) {
    if (block.blockIndex >= blockCount) return null;
  }
  return {
    schema: "residual-codec-v1",
    header,
    blocks,
    corrections: parsed.blocks,
  };
}
