/**
 * vector-cortex/topology/query.ts — topology query + router invalidation (VC3C).
 *
 * Owns `RouterKeyV2` (the structured router key) and `TopologyQueryV1` (the
 * generation query/index surface that serves graphs and invalidates stale
 * generations). This is the degradation seam of the sprint's failure triad:
 *
 *   A = topology index at current generation (serve the active graph);
 *   B = fresh linear scan forced when a key targets a STALE generation;
 *   C = authority sequence scan forced when the derived store is unavailable.
 *
 * Key encoding is length-delimited with unsigned-byte (prefix) ordering and a
 * FIXED five-field arity, so no field value can ambiguously prefix another and
 * two sessions `a` / `aa` can never prefix-collide at the key level
 * (M6-KEY-001). Invalidation matches the exact `(session,generation)` identity
 * bytes — never a string-prefix — and a query whose key carries a generation
 * older than the session's active one is rejected with `TOP_GENERATION_STALE`
 * (M6-STALE-002), which forces mode B.
 *
 * Pure src/ logic over an injected `TopologyQueryHost` (the source of graphs +
 * linear/authority scans) and an optional `TopologyQueryEmit`. Deterministic,
 * pi-agnostic, no console, no network (PREVENT-PI-004), no `any`
 * (PREVENT-011). The caller owns durability; every store write on the caller
 * side is best-effort and never breaks the agent loop.
 */

import { createHash } from "node:crypto";

/** Query rejected: the key's generation is stale relative to the active one. */
export const TOP_GENERATION_STALE = "TOP_GENERATION_STALE";
/** Query rejected: a key could not be decoded (malformed length-delimited bytes). */
export const TOP_KEY_DECODE_FAILED = "TOP_KEY_DECODE_FAILED";
/** Query rejected: the derived store is unavailable and no authority scan is possible. */
export const TOP_AUTHORITY_UNAVAILABLE = "TOP_AUTHORITY_UNAVAILABLE";

/** Frozen router key schema version carried in every encoded key. */
export const ROUTER_KEY_VERSION = 2;

/**
 * The structured router key. Every field is explicit — there is no string
 * concatenation of `session`+`generation` anywhere; identity and ordering are
 * derived from the length-delimited encoding below, so `a` and `aa` can never
 * collide (M6-KEY-001).
 */
export interface RouterKeyV2 {
  readonly session: string;
  readonly sourceStart: bigint;
  readonly sourceEnd: bigint;
  readonly generation: bigint;
  readonly algorithm: string;
}

/** Descriptive result of decoding a RouterKeyV2. */
export type RouterKeyDecode =
  | { ok: true; key: RouterKeyV2 }
  | { ok: false; code: "TOP_KEY_DECODE_FAILED" };

/** The three query result modes, mirroring the sprint failure triad. */
export type TopologyQueryMode = "A" | "B" | "C";

/**
 * A served query result. `mode` records which triad arm produced it:
 *   A — served from the topology index at the current generation;
 *   B — a fresh linear scan, forced because the A key was stale;
 *   C — an authority sequence scan, forced because the derived store was
 *       unavailable.
 * `matchedKey` is the EXACT encoded key that hit — the invariant is that a hit
 * always matches every structured key field, never a prefix subset (the
 * dashboard/consumers read only `matchedKey`, never a raw concatenation).
 */
export interface TopologyQueryResult {
  readonly ok: true;
  readonly mode: TopologyQueryMode;
  readonly session: string;
  readonly generation: bigint;
  readonly algorithm: string;
  /** EXACT router key that produced the hit (all five fields). */
  readonly matchedKey: string;
  /** Byte-level digest of the served graph/scan (the A graph digest). */
  readonly digest: string;
}

/** A rejected query (stale key, undecodable key, or authority unavailable). */
export interface TopologyQueryReject {
  readonly ok: false;
  readonly code: string;
  readonly mode: TopologyQueryMode | null;
}

export type TopologyQueryOutcome = TopologyQueryResult | TopologyQueryReject;

/**
 * The data sources the query layer reads from. Capability-shaped: the index only
 * asks for what it needs. `activeGeneration(session)` is the source of authority
 * for staleness; `graphAt` is the mode-A derived store (the same graph that the
 * CortexReader exposes at the active generation).
 */
export interface TopologyQueryHost {
  /** The current (active) generation for a session, or undefined when absent. */
  readonly activeGeneration: (session: string) => bigint | undefined;
  /**
   * The topology graph at an exact (session, generation, algorithm) key, or
   * undefined when that generation is not indexed. Mode-A source.
   */
  readonly graphAt: (
    session: string,
    generation: bigint,
    algorithm: string,
  ) => { readonly digest: string } | undefined;
  /**
   * Fresh linear scan over `[sourceStart, sourceEnd]`. Mode-B source, forced
   * when a key targets a stale generation.
   */
  readonly linearScan: (
    session: string,
    sourceStart: bigint,
    sourceEnd: bigint,
  ) => { readonly digest: string };
  /**
   * Authority sequence scan over `[sourceStart, sourceEnd]`. Mode-C source,
   * forced when the derived store is unavailable; returns undefined when the
   * authority itself is unavailable (authority outage freezes the derived
   * high-water).
   */
  readonly authorityScan: (
    session: string,
    sourceStart: bigint,
    sourceEnd: bigint,
  ) => { readonly digest: string } | undefined;
  /** Whether the derived (mode-A) store is available at all. */
  readonly derivedAvailable: (session: string) => boolean;
}

/** Optional structured-event emitter (same shape as the other VC seams). */
export type TopologyQueryEmit = (event: string, fields: Record<string, unknown>) => void;

/** The two VC3C events the query seam can emit. */
export type TopologyQueryEvent =
  | "vector_cortex_router_generation_invalidated"
  | "vector_cortex_topology_query_demoted";

/**
 * Reader/writer surface of the query index. This file owns the PURE logic; the
 * production wiring (which host + emitter to use, and how invalidation is made
 * durable) lives at the delegate seam in tieredRouter.ts so src/ stays
 * pi-agnostic.
 */
export interface TopologyQueryV1 {
  /** Serve a query; rejects with TOP_GENERATION_STALE when the key is stale. */
  readonly query: (key: RouterKeyV2) => TopologyQueryOutcome;
  /**
   * Invalidate an EXACT (session,generation). Emits
   * `vector_cortex_router_generation_invalidated`. Cross-session keys never
   * evict each other (M6 enforcement: exact byte match).
   */
  readonly invalidate: (session: string, generation: bigint) => void;
  /** Number of distinct generations currently indexed (diagnostic). */
  readonly generationalCount: (session: string) => number;
}

/**
 * Create the query surface. `emit` is optional and flag-gated (the caller passes
 * a reporter produced by the same pattern VC3A/VC3B use — zero emissions when
 * `MEGACOMPACT_VC3C=0`, byte-identical to the predecessor). Pure in-memory index
 * over the injected host; durability of invalidation is the caller's job.
 */
export function createTopologyQuery(
  host: TopologyQueryHost,
  emit?: TopologyQueryEmit,
): TopologyQueryV1 {
  // session -> Set of indexed generation strings (exact, byte-identity).
  const generations = new Map<string, Set<string>>();

  const fire = (event: TopologyQueryEvent, fields: Record<string, unknown>): void => {
    if (!emit) return;
    try {
      emit(event, fields);
    } catch {
      /* non-fatal observability — never break the agent loop */
    }
  };

  const query = (key: RouterKeyV2): TopologyQueryOutcome => {
    const active = host.activeGeneration(key.session);
    // Mode C: derived store unavailable -> authority sequence scan.
    if (!host.derivedAvailable(key.session)) {
      const cDigest = host.authorityScan(key.session, key.sourceStart, key.sourceEnd);
      if (cDigest === undefined) {
        return { ok: false, code: TOP_AUTHORITY_UNAVAILABLE, mode: "C" };
      }
      fire("vector_cortex_topology_query_demoted", {
        session: key.session,
        generation: key.generation.toString(),
        code: "DERIVED_UNAVAILABLE",
        toMode: "C",
      });
      return {
        ok: true,
        mode: "C",
        session: key.session,
        generation: key.generation,
        algorithm: key.algorithm,
        matchedKey: encodeRouterKeyV2(key),
        digest: cDigest.digest,
      };
    }

    // A key is stale when its generation is below the active one (or the active
    // generation is unset and the requested generation is non-zero).
    const stale =
      active === undefined
        ? key.generation !== 0n
        : key.generation < active;

    if (stale) {
      // Mode B: fresh linear scan forced by a stale A key.
      const bDigest = host.linearScan(key.session, key.sourceStart, key.sourceEnd);
      fire("vector_cortex_topology_query_demoted", {
        session: key.session,
        generation: key.generation.toString(),
        activeGeneration: active === undefined ? null : active.toString(),
        code: "STALE_GENERATION",
        toMode: "B",
      });
      return {
        ok: true,
        mode: "B",
        session: key.session,
        generation: key.generation,
        algorithm: key.algorithm,
        matchedKey: encodeRouterKeyV2(key),
        digest: bDigest.digest,
      };
    }

    // Mode A: topology index at the current generation. If the derived store is
    // up but has not indexed this exact (generation, algorithm) yet, that is a
    // mode-A miss (no graph to serve) — force the fresh linear scan rather than
    // fabricate a graph or report a false staleness (Q03: the index cannot be
    // trusted to hold every current generation; B recomputes from source).
    const graph = host.graphAt(key.session, key.generation, key.algorithm);
    if (graph === undefined) {
      const bDigest = host.linearScan(key.session, key.sourceStart, key.sourceEnd);
      fire("vector_cortex_topology_query_demoted", {
        session: key.session,
        generation: key.generation.toString(),
        code: "GENERATION_MISS",
        toMode: "B",
      });
      return {
        ok: true,
        mode: "B",
        session: key.session,
        generation: key.generation,
        algorithm: key.algorithm,
        matchedKey: encodeRouterKeyV2(key),
        digest: bDigest.digest,
      };
    }
    return {
      ok: true,
      mode: "A",
      session: key.session,
      generation: key.generation,
      algorithm: key.algorithm,
      matchedKey: encodeRouterKeyV2(key),
      digest: graph.digest,
    };
  };

  const invalidate = (session: string, generation: bigint): void => {
    const invalidationIdentity = invalidationKey(session, generation);
    const set = generations.get(session);
    if (set) set.delete(invalidationIdentity);
    fire("vector_cortex_router_generation_invalidated", {
      session,
      generation: generation.toString(),
      key: invalidationIdentity,
    });
  };

  const generationalCount = (session: string): number => {
    return generations.get(session)?.size ?? 0;
  };

  return { query, invalidate, generationalCount };
}

// ---------------------------------------------------------------------------
// Length-delimited, unsigned-byte-ordered key encoding (M6-KEY-001)
// ---------------------------------------------------------------------------

/**
 * Encode one field: `u32BE(byteLength) || bytes`. Non-negative numbers are
 * encoded as their unsigned big-endian byte form (leading zeros trimmed). This
 * is the standard big-endian length-prefixed encoding: two fields compare in
 * unsigned-byte order exactly as their values do, and no value is an ambiguous
 * prefix of another.
 */
function encodeLengthDelimited(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, bytes.length, false);
  out.set(bytes, 4);
  return out;
}

/** Big-endian unsigned bytes of a non-negative bigint (length-prefixed below). */
function bigintBytes(n: bigint): Uint8Array {
  let v = n;
  const out: number[] = [];
  if (v === 0n) return new Uint8Array([0]);
  while (v > 0n) {
    out.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  return Uint8Array.from(out);
}

/** UTF-8 bytes of a string. */
function strBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Encode a RouterKeyV2 into its canonical, length-delimited, unsigned-byte-ordered
 * byte form. Version-prefixed (1 byte) + five length-delimited fields in fixed
 * order (session, sourceStart, sourceEnd, generation, algorithm). Fixed arity +
 * length-delimiting means no key is a strict prefix of another and sessions `a`
 * and `aa` never collide (M6-KEY-001).
 */
export function encodeRouterKeyV2(key: RouterKeyV2): string {
  const version = Uint8Array.of(ROUTER_KEY_VERSION);
  const session = encodeLengthDelimited(strBytes(key.session));
  const sourceStart = encodeLengthDelimited(bigintBytes(key.sourceStart));
  const sourceEnd = encodeLengthDelimited(bigintBytes(key.sourceEnd));
  const generation = encodeLengthDelimited(bigintBytes(key.generation));
  const algorithm = encodeLengthDelimited(strBytes(key.algorithm));
  return "rk2:" + Buffer.from(concat([version, session, sourceStart, sourceEnd, generation, algorithm])).toString("hex");
}

/**
 * Decode a RouterKeyV2 from its canonical byte form. Returns
 * TOP_KEY_DECODE_FAILED on malformed bytes (bad version, truncated length, or
 * trailing garbage). Never parses by string prefix.
 */
export function decodeRouterKeyV2(encoded: string): RouterKeyDecode {
  if (!encoded.startsWith("rk2:")) return { ok: false, code: "TOP_KEY_DECODE_FAILED" };
  const hex = encoded.slice(4);
  if (!/^[0-9a-f]*$/.test(hex) || hex.length % 2 !== 0) {
    return { ok: false, code: "TOP_KEY_DECODE_FAILED" };
  }
  const buf = Buffer.from(hex, "hex");
  const bytes = new Uint8Array(buf);
  const reader = new Reader(bytes);
  const version = reader.u8();
  if (version !== ROUTER_KEY_VERSION) return { ok: false, code: "TOP_KEY_DECODE_FAILED" };
  const sessionBytes = reader.lenPrefixed();
  const ssBytes = reader.lenPrefixed();
  const seBytes = reader.lenPrefixed();
  const genBytes = reader.lenPrefixed();
  const algoBytes = reader.lenPrefixed();
  if (reader.remaining() !== 0) return { ok: false, code: "TOP_KEY_DECODE_FAILED" };
  if (sessionBytes === null || ssBytes === null || seBytes === null || genBytes === null || algoBytes === null) {
    return { ok: false, code: "TOP_KEY_DECODE_FAILED" };
  }
  const session = new TextDecoder().decode(sessionBytes);
  const sourceStart = bytesToBigint(ssBytes);
  const sourceEnd = bytesToBigint(seBytes);
  const generation = bytesToBigint(genBytes);
  const algorithm = new TextDecoder().decode(algoBytes);
  return { ok: true, key: { session, sourceStart, sourceEnd, generation, algorithm } };
}

/** Sequential length-delimited byte reader. */
class Reader {
  private readonly bytes: Uint8Array;
  private off = 0;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  u8(): number {
    const v = this.bytes[this.off];
    this.off += 1;
    return v;
  }
  lenPrefixed(): Uint8Array | null {
    if (this.off + 4 > this.bytes.length) return null;
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.off, 4);
    const len = view.getUint32(0, false);
    this.off += 4;
    if (this.off + len > this.bytes.length) return null;
    const out = this.bytes.slice(this.off, this.off + len);
    this.off += len;
    return out;
  }
  remaining(): number {
    return this.bytes.length - this.off;
  }
}

/** Non-negative bigint from its unsigned big-endian bytes. */
function bytesToBigint(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

/**
 * Canonical invalidation identity for an exact (session,generation) pair, using
 * the SAME length-delimited scheme so two pairs can only match by exact byte
 * equality (never by string prefix — `a` never matches `aa`). Returned as hex
 * for use as a registry key.
 */
export function invalidationKey(session: string, generation: bigint): string {
  const sessionF = encodeLengthDelimited(strBytes(session));
  const genF = encodeLengthDelimited(bigintBytes(generation));
  return "inv:" + Buffer.from(concat([sessionF, genF])).toString("hex");
}

/** One deterministic SHA-256 (hex) digest over the canonical key bytes. */
export function keyDigest(key: RouterKeyV2): string {
  return `sha256:${createHash("sha256").update(Buffer.from(encodeRouterKeyV2(key).slice(4), "hex")).digest("hex")}`;
}

/**
 * Shared invalidation-capability seam (narrow delegate, no routing rewrite).
 * Records the EXACT (session,generation) identity and, when `enabled`, best-effort
 * emits `vector_cortex_router_generation_invalidated`. Falsy `enabled` (flag OFF)
 * is a strict no-op so the predecessor keying is byte-identical to pre-sprint.
 * Exactness is enforced by `invalidationKey` (length-delimited, never a string
 * prefix — `a` never matches `aa`), the same identity M6 validates.
 */
export function routerGenerationInvalidationSeam(
  key: RouterKeyV2,
  enabled: boolean,
  emit?: TopologyQueryEmit,
): void {
  if (!enabled) return;
  const identity = invalidationKey(key.session, key.generation);
  if (emit) {
    try {
      emit("vector_cortex_router_generation_invalidated", {
        session: key.session,
        generation: key.generation.toString(),
        key: identity,
      });
    } catch {
      /* non-fatal observability — never break the agent loop */
    }
  }
}

/** Registered TOP query conformance ID range (TOP-021..030). */
export const TOP_QUERY_IDS = [
  "TOP-021",
  "TOP-022",
  "TOP-023",
  "TOP-024",
  "TOP-025",
  "TOP-026",
  "TOP-027",
  "TOP-028",
  "TOP-029",
  "TOP-030",
] as const;

/** Registered named TOP-query conformance IDs. */
export const TOP_QUERY_NAMED_IDS = [
  "TOP-QUERY-003",
  "M6-KEY-001",
  "M6-STALE-002",
] as const;
