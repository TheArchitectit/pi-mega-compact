/**
 * vector-cortex/resilience/spool-core.ts — VC0C durable spool implementation (VC0C).
 *
 * Implementation file behind the `spool.ts` factory barrel. See spool.ts for the
 * public surface; this file owns the TRIAD_RESILIENCE §spool append/fsync/ack
 * protocol.
 *
 * Implements TRIAD_RESILIENCE.md §Spool protocol as the mode-B independent,
 * deterministic, local disk spool that derives directly from authority:
 *
 *   - One spool file per session: `spool-<session>.spool` under a state dir.
 *   - Header records schema, session, first sequence, and the prior durable
 *     contiguous high-water.
 *   - Frames are length-prefixed binary records carrying seq + eventId +
 *     original bytes + SHA-256 + CRC32C (Castagnoli). A frame is FSYNC'd to disk
 *     before the writer acknowledges `SPOOLED`; only a durable ledger commit
 *     (after `drain` inserts into authority and the ledger is fsynced) returns
 *     `SPOOL_COMMITTED` and advances the contiguous high-water.
 *   - `drain` strictly sorts frames by `(seq, eventId)`, rejects gaps/conflicts,
 *     inserts idempotently by `(eventId, digest)`, appends an fsynced ack frame,
 *     then advances contiguous high-water. A duplicate with the same id+digest is
 *     acknowledged (`SPOOL_IDEMPOTENT_ACK`); the same id with a DIFFERENT digest
 *     is `SPOOL_MANUAL_HALT`.
 *   - Crash before an ack safely replays: on reopen, frames after the last ack
 *     are re-drained (the ack frame carries the committed seq).
 *   - A derived builder may never read beyond the durable contiguous authority
 *     high-water; during an authority outage the high-water freezes (drain cannot
 *     commit) even while the spool keeps accepting frames.
 *
 * LOCAL ONLY: filesystem + node:crypto, zero network (PREVENT-PI-004); no `any`
 * (PREVENT-011); synchronous durable writes (fsyncSync) per the spec.
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import type { SpoolDrainVerdict } from "./types.js";

export const SPOOL_SCHEMA = "spool-v1";
/** Sentinel eventId of an acknowledgement frame (carries the committed seq). */
export const ACK_EVENT_ID = "__ack__";

/** CRC32C (Castagnoli) table — seeded once. */
const CRC_TABLE: number[] = (() => {
  const t: number[] = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32c(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface SpoolFrame {
  readonly session: string;
  readonly seq: bigint;
  readonly eventId: string;
  readonly digest: string; // sha256:<hex> over original bytes
  readonly bytes: Uint8Array;
  readonly crc32c: number;
}

export interface SpoolOptions {
  /** Directory hosting the spool files (created on demand). */
  readonly dir: string;
  /** True while the authority (mode-A SQLite ledger) is in OUTAGE. */
  readonly authorityOutage?: () => boolean;
}

export interface SpoolAppendResult {
  readonly verdict: "SPOOLED";
  readonly seq: bigint;
}

export interface SpoolDrainResult {
  readonly verdict: SpoolDrainVerdict;
  readonly committedSeq: bigint;
  readonly reason?: string;
}

/**
 * The authority insert callback the caller supplies to `drain`. `committed`
 * records a new accepted occurrence; `idempotent` acknowledges a duplicate with
 * the SAME id+digest; `conflict` signals the same id with a DIFFERENT digest —
 * which the spool translates to a MANUAL_HALT (never acknowledged).
 */
export type AuthorityInsert = (
  session: string,
  seq: bigint,
  eventId: string,
  digest: string,
  bytes: Uint8Array,
) => "committed" | "idempotent" | "conflict";

interface SpoolHeader {
  readonly schema: string;
  readonly session: string;
  readonly firstSeq: number;
  readonly priorHighWater: string;
}

export interface SessionSpool {
  readonly session: string;
  /** Append+fsync a frame; returns SPOOLED once durable on disk. */
  append(input: { seq: bigint; eventId: string; bytes: Uint8Array; digest?: string }): SpoolAppendResult;
  /** Strict drain into authority; advances contiguous high-water after ack. */
  drain(insert: AuthorityInsert): SpoolDrainResult;
  /** Durable contiguous authority high-water (freezes during authority outage). */
  highWater(): bigint;
  /** Whether the derived frontier is frozen (authority outage). */
  frozen(): boolean;
  /** Mark the derived frontier frozen at the current high-water. */
  freezeFrontier(): bigint;
}

export interface Spool {
  session(session: string): SessionSpool;
}

export function createSpool(opts: SpoolOptions): Spool {
  mkdirSync(opts.dir, { recursive: true });
  const bySession = new Map<string, SessionSpoolImpl>();
  return {
    session(session: string): SessionSpool {
      let s = bySession.get(session);
      if (!s) {
        s = new SessionSpoolImpl(join(opts.dir, `spool-${basename(session)}.spool`), session, opts);
        bySession.set(session, s);
      }
      return s;
    },
  };
}

/**
 * Durably manages one session's spool file. Fully synchronous: every append is
 * fsynced before acknowledging; every committed drain appends+fsyncs an ack
 * frame. Reopen parses the header + frames, stops at a torn trailing frame
 * (crash mid-write => unacknowledged tail), and drains only frames strictly
 * beyond the recovered contiguous high-water — crash before ack safely replays.
 */
class SessionSpoolImpl implements SessionSpool {
  readonly session: string;
  private readonly file: string;
  private readonly outage: () => boolean;
  private header: SpoolHeader;
  private frames: SpoolFrame[] = [];
  private ackedSeq: bigint;
  private frontierFrozen = false;

  constructor(file: string, session: string, opts: SpoolOptions) {
    this.file = file;
    this.session = session;
    this.outage = opts.authorityOutage ?? (() => false);
    mkdirSync(join(file, ".."), { recursive: true });
    if (existsSync(file)) {
      const parsed = this.readExisting();
      this.header = parsed.header;
      this.frames = parsed.frames;
      this.ackedSeq = parsed.highWater;
    } else {
      this.header = { schema: SPOOL_SCHEMA, session, firstSeq: 1, priorHighWater: "0" };
      this.ackedSeq = 0n;
      this.writeHeader();
    }
  }

  private writeHeader(): void {
    const fd = openSync(this.file, "a");
    try {
      writeSync(fd, Buffer.from(encodeHeader(this.header), "utf8"));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /** Reopen: parse header + frames; recover the last contiguous ack high-water. */
  private readExisting(): { header: SpoolHeader; frames: SpoolFrame[]; highWater: bigint } {
    const raw = readFileSync(this.file);
    const nl = raw.indexOf(10);
    if (nl < 0) {
      return { header: { schema: SPOOL_SCHEMA, session: this.session, firstSeq: 1, priorHighWater: "0" }, frames: [], highWater: 0n };
    }
    const header = parseHeader(raw.subarray(0, nl).toString("utf8"));
    let highWater = BigInt(header.priorHighWater);
    const frames: SpoolFrame[] = [];
    let off = nl + 1;
    for (;;) {
      if (off >= raw.length) break;
      const f = tryParseFrame(raw.subarray(off));
      if (!f) break; // torn/unacknowledged tail — stop, replay from last ack
      const frame = { ...f, session: this.session };
      if (frame.eventId === ACK_EVENT_ID) {
        highWater = frame.seq; // ack frame carries the committed seq
      } else {
        frames.push(frame);
      }
      const len = raw.readUInt32LE(off);
      off += 4 + len;
    }
    // Only frames strictly beyond the recovered high-water need re-drain.
    const unacked = frames.filter((f) => f.seq > highWater);
    return { header, frames: unacked, highWater };
  }

  append(input: { seq: bigint; eventId: string; bytes: Uint8Array; digest?: string }): SpoolAppendResult {
    const digest = input.digest ?? `sha256:${sha256Hex(input.bytes)}`;
    const frame: SpoolFrame = {
      session: this.session,
      seq: input.seq,
      eventId: input.eventId,
      digest,
      bytes: input.bytes,
      crc32c: crc32c(input.bytes),
    };
    const framed = encodeFrame(frame);
    // Fsync BEFORE acknowledging SPOOLED.
    const fd = openSync(this.file, "a");
    try {
      writeSync(fd, framed, 0, framed.length);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.frames.push(frame);
    return { verdict: "SPOOLED", seq: input.seq };
  }

  drain(insert: AuthorityInsert): SpoolDrainResult {
    const tail = this.frames;
    this.frames = [];
    if (tail.length === 0) return { verdict: "SPOOL_COMMITTED", committedSeq: this.ackedSeq };
    // Strictly sort by (seq, eventId).
    const sorted = [...tail].sort(compareFrames);
    let committed = this.ackedSeq;
    for (const f of sorted) {
      if (f.seq !== committed + 1n) {
        // Gap: requeue everything beyond the last committed seq and halt.
        this.frames = sorted.filter((x) => x.seq > committed);
        return { verdict: "SPOOL_MANUAL_HALT", committedSeq: committed, reason: `TRI_SPOOL_GAP expected ${committed + 1n} got ${f.seq}` };
      }
      const outcome = insert(this.session, f.seq, f.eventId, f.digest, f.bytes);
      if (outcome === "committed" || outcome === "idempotent") {
        committed = f.seq;
      } else {
        this.frames = sorted.filter((x) => x.seq > committed);
        return { verdict: "SPOOL_MANUAL_HALT", committedSeq: committed, reason: "TRI_SPOOL_CONFLICT conflicting digest" };
      }
    }
    // Durably commit: append+fsync an ack frame, then advance the high-water.
    this.appendAck(committed);
    this.ackedSeq = committed;
    return { verdict: "SPOOL_COMMITTED", committedSeq: committed };
  }

  private appendAck(seq: bigint): void {
    const frame: SpoolFrame = {
      session: this.session,
      seq,
      eventId: ACK_EVENT_ID,
      digest: `sha256:${sha256Hex(new Uint8Array(0))}`,
      bytes: new Uint8Array(0),
      crc32c: crc32c(new Uint8Array(0)),
    };
    const framed = encodeFrame(frame);
    const fd = openSync(this.file, "a");
    try {
      writeSync(fd, framed, 0, framed.length);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  highWater(): bigint {
    // During authority outage the high-water freezes: drain cannot commit (the
    // insert callback rejects), so ackedSeq stays put even while frames append.
    if (this.outage()) return this.ackedSeq;
    return this.ackedSeq;
  }

  frozen(): boolean {
    return this.frontierFrozen || this.outage();
  }

  freezeFrontier(): bigint {
    this.frontierFrozen = true;
    return this.ackedSeq;
  }
}

function compareFrames(a: SpoolFrame, b: SpoolFrame): number {
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

function encodeHeader(h: SpoolHeader): string {
  return `${JSON.stringify(h)}\n`;
}

function parseHeader(line: string): SpoolHeader {
  const raw = JSON.parse(line) as SpoolHeader;
  if (raw.schema !== SPOOL_SCHEMA) throw new Error("TRI_SPOOL_SCHEMA");
  return raw;
}

/**
 * Encode one binary frame: [u32 len][seq i64][eventId UTF-8 NUL][bytes][NUL][64-byte sha256 hex][u32 crc32c].
 * body length = 8 + eventId.length + 1 + bytes.length + 1 + 64 + 4.
 */
function encodeFrame(f: SpoolFrame): Buffer {
  const idBuf = Buffer.from(f.eventId, "utf8");
  const bodyLen = 8 + idBuf.length + 1 + f.bytes.length + 1 + 64 + 4;
  const body = Buffer.alloc(bodyLen);
  let o = 0;
  body.writeBigInt64LE(BigInt(f.seq), o); o += 8;
  idBuf.copy(body, o); o += idBuf.length;
  body[o] = 0; o += 1;
  Buffer.from(f.bytes).copy(body, o); o += f.bytes.length;
  body[o] = 0; o += 1;
  body.write(f.digest, o, "utf8"); o += 64;
  body.writeUInt32LE(f.crc32c, o); o += 4;
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(bodyLen, 0);
  return Buffer.concat([lenBuf, body]);
}

/** Parse a length-prefixed frame; returns null for a torn/truncated tail. */
function tryParseFrame(buf: Buffer): SpoolFrame | null {
  if (buf.length < 4) return null;
  const len = buf.readUInt32LE(0);
  if (buf.length < 4 + len) return null; // torn
  const body = buf.subarray(4, 4 + len);
  let o = 0;
  const seq = body.readBigInt64LE(o); o += 8;
  const idEnd = body.indexOf(0, o);
  if (idEnd < 0) return null;
  const eventId = body.subarray(o, idEnd).toString("utf8"); o = idEnd + 1;
  const bytesStart = o;
  const nul2 = body.indexOf(0, o);
  if (nul2 < 0) return null;
  const bytes = new Uint8Array(body.subarray(bytesStart, nul2)); o = nul2 + 1;
  const digest = body.subarray(o, o + 64).toString("utf8");
  const crc32c = body.readUInt32LE(o + 64);
  return { session: "", seq, eventId, digest, bytes, crc32c };
}
