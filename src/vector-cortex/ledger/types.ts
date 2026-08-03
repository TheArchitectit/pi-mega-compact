/**
 * vector-cortex/ledger/types.ts — EventV2 / EventCodec byte-authority contract
 * types, validation result codes, and the registered EVT conformance ID range.
 *
 * Owned by VC1A (canonical byte events). Consumes only reviewer-accepted
 * predecessor contracts and [common contracts](../../CONTRACTS.md §EventV2),
 * which are NORMATIVE here. `originalBytes` and its SHA-256 digest are the byte
 * authority; strict UTF-8 classification is never lossy; `canonicalNfc` is a
 * DERIVED comparison/search key only (never identity, digest, or reconstruction).
 *
 * Pure type/schema definitions + a short pure digest/classify predicate runtime
 * (validator codes). No network, no side effects (PREVENT-PI-004 / PREVENT-011).
 */

/** SHA-256 digest over the authoritative `originalBytes`, `sha256:<hex>`. */
export type BytesDigest = `sha256:${string}`;

/**
 * EventV2 — the neutral byte-authority ledger occurrence. `schema:"event-v2"`
 * is the discriminant tag of the union. Two events whose bytes differ by NFC
 * normalization are DISTINCT identities (different `originalBytes`, different
 * `bytesDigest`); their `canonicalNfc` (derived) may coincide but never drives
 * equality, hashing, or byte reconstruction.
 */
export interface EventV2 {
  schema: "event-v2";
  sessionId: string;
  seq: bigint;
  eventId: string;
  role: "policy" | "user" | "assistant" | "tool";
  kind: string;
  /** Authoritative original event bytes (byte authority). */
  originalBytes: Uint8Array;
  /** DigitalObjectIdentifier over originalBytes (authoritative digest). */
  bytesDigest: BytesDigest;
  /**
   * Strict UTF-8 classification (NO lossy replacement). Invalid input is
   * represented only as `{valid:false, base64}`.
   */
  utf8: { valid: true; text: string } | { valid: false; base64: string };
  /** DERIVED NFC comparison/search key, valid UTF-8 only. Never identity. */
  canonicalNfc?: string;
  /** On a tool RESULT, references exactly one earlier CALL in this session. */
  toolCallId?: string;
  /** Wall-clock occurrence timestamp (monotonic for ordering; not the sort key). */
  occurredAtMs: bigint;
}

/** Inputs to the byte-authority encoder. `bytes` is the sole byte source. */
export interface EventEncodeInput {
  sessionId: string;
  seq: bigint;
  eventId: string;
  role: "policy" | "user" | "assistant" | "tool";
  kind: string;
  bytes: Uint8Array;
  toolCallId?: string;
  occurredAtMs: bigint;
}

/**
 * EventCodec — byte-authority contract (normative, [CONTRACTS §EventV2]).
 * `encode` computes the SHA-256 digest + strict UTF-8 classification + derived
 * NFC; `decode` returns the authoritative `originalBytes` unchanged. Decoding
 * never reconstructs bytes from normalized text — only from originalBytes.
 */
export interface EventCodec {
  encode(input: EventEncodeInput): EventV2;
  decode(event: EventV2): Uint8Array;
  /**
   * Strict UTF-8 classification: `fatal` decode succeeds, or the raw bytes are
   * reported as `{valid:false, base64}` — never replacement-decode to U+FFFD.
   */
  classifyUtf8(bytes: Uint8Array): { valid: true; text: string } | { valid: false; base64: string };
}

/** Canonical validator failure codes (VC1A). */
export type ValidationCode =
  /** sha256(originalBytes) !== bytesDigest (authority corruption). */
  | "EVT_DIGEST_MISMATCH"
  /** The stored `utf8` discriminant contradicts a strict re-classification. */
  | "EVT_UTF8_TAG_INVALID"
  /** Duplicate (sessionId, seq, eventId) occurrence. */
  | "EVT_DUPLICATE_ID";

/**
 * Deterministic validation result. `ok:false` carries the deduplicated failure
 * codes (fixed priority order) AND the per-occurrence `issues` with real
 * locators (sessionId/seq/eventId) so consumers can identify WHICH event failed.
 */
export type ValidationResult =
  | { ok: true; ordered: readonly EventV2[] }
  | { ok: false; codes: readonly ValidationCode[]; issues: readonly ValidationIssue[] };

/** A single flagged validation issue (code + the offending occurrence locator). */
export interface ValidationIssue {
  readonly code: ValidationCode;
  readonly sessionId: string;
  readonly seq: bigint;
  readonly eventId: string;
}

/**
 * Registered EVT conformance ID range (EVT-001..015). The acceptance test reads
 * these rows from the v2 manifest and asserts each returns its manifest bytes or
 * exactly its listed failure code. Mirrors CUT_IDS / M3_IDS in replay/types.ts.
 */
export const EVT_IDS = [
  "EVT-001",
  "EVT-002",
  "EVT-003",
  "EVT-004",
  "EVT-005",
  "EVT-006",
  "EVT-007",
  "EVT-008",
  "EVT-009",
  "EVT-010",
  "EVT-011",
  "EVT-012",
  "EVT-013",
  "EVT-014",
  "EVT-015",
] as const;
