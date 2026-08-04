/**
 * heal/_restore-fixture.ts — conformance fixture I/O for VC6B restoration rows.
 *
 * Sibling of `_acceptance-fixture.ts` (which owns the VC6A closure-optimization
 * rows); split out so neither file approaches the 300-line soft limit and so the
 * base64/BigInt decoding lives next to the contract it reconstitutes.
 *
 * DECODING IS THE POINT. Fixtures are canonical JSON, which cannot express bytes
 * or bigints, so the corpus stores `originalBytesBase64` + numeric `seq`. These
 * loaders turn those back into the REAL `ExactShardV1` / `EventV2` objects the
 * production readers consume — no mocks, no stubs, no parallel "test shape". If
 * the decode were lossy the digests would not match and the acceptance test would
 * fail loudly, which is exactly the guarantee we want from a byte-identity sprint.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

import type { EventV2, ExactShardV1, ShardRange } from "./restore-types.js";
import { V2, readManifest } from "./_acceptance-fixture.js";

/** A `ShardRange` as it appears in JSON: `seq` bounds are numbers, not bigints. */
export interface RestoreFxRange {
  sessionId: string;
  seqStart: number;
  seqEnd: number;
  byteStart: number;
  byteEnd: number;
}

export interface RestoreFxSpan {
  nodeId: string;
  range: RestoreFxRange;
  digest: string;
}

export interface RestoreFxShard {
  sessionId: string;
  range: RestoreFxRange;
  originalBytesBase64: string;
  digest: string;
  byteCount: number;
  case: "tool-pair" | "anchor" | "invalid-utf8" | "anchor+invalid";
}

export interface RestoreFxEvent {
  sessionId: string;
  seq: number;
  eventId: string;
  role: "policy" | "user" | "assistant" | "tool";
  kind: string;
  originalBytesBase64: string;
  bytesDigest: string;
  occurredAtMs: number;
  toolCallId?: string;
}

export interface RestoreFxInput {
  scenario: string;
  sessionId: string;
  request: { spans: RestoreFxSpan[] };
  exactShards: RestoreFxShard[];
  ledgerEvents: RestoreFxEvent[];
}

export interface RestoreFxExpected {
  ok: boolean;
  code?: string;
  restoredCount: number;
  missingCount: number;
  mode: "A" | "B" | "C";
}

export interface RestoreFx {
  id: string;
  schema: string;
  producer: string;
  assertion: string;
  kind: string;
  input: RestoreFxInput;
  expected: RestoreFxExpected;
}

/** Read one registered restoration fixture (asserting it IS registered). */
export function restorationFixture(id: string): RestoreFx {
  const m = readManifest();
  const row = m.fixtures.find((f) => f.id === id && f.path.startsWith("restoration/"));
  assert.ok(row, `fixture ${id} registered under restoration/ in manifest`);
  return JSON.parse(readFileSync(join(V2, row!.path), "utf8")) as RestoreFx;
}

/** base64 -> exact bytes, byte-for-byte (invalid UTF-8 included). */
export function decodeBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

/** JSON number seq bounds -> the bigint bounds `ShardRange` declares. */
export function decodeRange(r: RestoreFxRange): ShardRange {
  return {
    sessionId: r.sessionId,
    seqStart: BigInt(r.seqStart),
    seqEnd: BigInt(r.seqEnd),
    byteStart: r.byteStart,
    byteEnd: r.byteEnd,
  };
}

/** Reconstitute a real `ExactShardV1` from its fixture row. */
export function decodeShard(s: RestoreFxShard): ExactShardV1 {
  return {
    schema: "exact-shard-v1",
    sessionId: s.sessionId,
    range: decodeRange(s.range),
    kind: "exact",
    originalBytes: decodeBytes(s.originalBytesBase64),
    digest: s.digest,
    byteCount: s.byteCount,
    case: s.case,
  };
}

/**
 * Reconstitute a real `EventV2`. `utf8` is re-derived by strict classification
 * (never lossy replacement) so an invalid-UTF-8 fixture produces the
 * `{valid:false, base64}` discriminant the VC1A contract requires.
 */
export function decodeEvent(e: RestoreFxEvent): EventV2 {
  const bytes = decodeBytes(e.originalBytesBase64);
  let utf8: EventV2["utf8"];
  try {
    utf8 = { valid: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    utf8 = { valid: false, base64: e.originalBytesBase64 };
  }
  return {
    schema: "event-v2",
    sessionId: e.sessionId,
    seq: BigInt(e.seq),
    eventId: e.eventId,
    role: e.role,
    kind: e.kind,
    originalBytes: bytes,
    bytesDigest: e.bytesDigest as EventV2["bytesDigest"],
    utf8,
    ...(e.toolCallId !== undefined ? { toolCallId: e.toolCallId } : {}),
    occurredAtMs: BigInt(e.occurredAtMs),
  };
}

/** Flag-pinned wrapper: VC6B gated by MEGACOMPACT_VC6B (defaults ON). */
export function withVc6bFlagsOn(fn: () => void): () => void {
  return (): void => {
    const saved = process.env.MEGACOMPACT_VC6B;
    process.env.MEGACOMPACT_VC6B = "1";
    try {
      fn();
    } finally {
      if (saved === undefined) delete process.env.MEGACOMPACT_VC6B;
      else process.env.MEGACOMPACT_VC6B = saved;
    }
  };
}
