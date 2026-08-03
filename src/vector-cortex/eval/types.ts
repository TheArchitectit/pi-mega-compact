/**
 * vector-cortex/eval/types.ts — MetricEventV1 / AnnotationV1 contract types
 * and the registered EVAL conformance ID range (EVAL-001..010).
 *
 * Owned by VC0A (baseline observability). Consumes reviewer-accepted predecessor
 * contracts and common contracts only. These are pure type/schema definitions —
 * no runtime network, no side effects (PREVENT-PI-004 / PREVENT-011).
 */

/**
 * A single structured evaluation-sample observation.
 *
 * Ordering contract: canonical JSONL metric order is `(session, seq, event)`,
 * i.e. stable sort by session, then integer seq, then event-name byte order.
 */
export interface MetricEventV1 {
  /** Session identifier (opaque). */
  readonly session: string;
  /** Monotonic per-session sequence number (must not decrease within a session). */
  readonly seq: number;
  /** Event/measurement name (deterministic tiebreak within equal seq). */
  readonly event: string;
  /** Numeric value of the sample in `unit`. */
  readonly value: number;
  /** Measurement unit — must be a known unit (see UNITS); rejects unknowns. */
  readonly unit: string;
  /** Triad observer mode that produced this sample: "A" | "B" | "C". */
  readonly mode: "A" | "B" | "C";
}

/** Units the evaluator understands. Unknown units reject as EVAL_UNIT_UNKNOWN. */
export const UNITS = ["ms", "bytes", "count", "ratio"] as const;

/** A single non-monotonic or unknown-unit rejection result. */
export type EvalReject =
  | { readonly code: "EVAL_ORDER_INVALID"; readonly seq: number; readonly session: string }
  | { readonly code: "EVAL_UNIT_UNKNOWN"; readonly unit: string }
  | { readonly code: "EVAL_JSONL_TRUNCATED" };

/**
 * Histogram bucket edges for latency, in milliseconds, inclusive on both
 * boundaries (EVAL-BUCKET-001): values at exactly 1ms and 250ms land in
 * those buckets. Overflow (value > largest edge) is kept separate.
 */
export const LATENCY_BUCKETS = [1, 5, 10, 25, 50, 100, 250] as const;

/**
 * AnnotationV1 redaction metadata. Before JSONL serialization, payload bytes,
 * prompts, and exact ledger text are replaced by digest/count metadata so the
 * exact content never appears in the serialized stream (EVAL-REDACT-002).
 */
export interface AnnotationV1 {
  /** Annotation identifier (items are addressed via the corpus manifest). */
  readonly itemId: string;
  /** Redaction journal of every payload/prompt/ledger-text field redacted. */
  readonly redactions: ReadonlyArray<{
    /** Field name in the original annotation that was redacted. */
    readonly field: string;
    /** SHA-256 digest of the redacted bytes (standard base64; decodes to the
     *  same hash as the conformance fixture's `digestHex` — see annotations.test). */
    readonly digest: string;
    /** Byte length of the redacted content, when known. */
    readonly bytes: number;
    /** Redaction reason: "payload" | "prompt" | "ledger" (all are digested). */
    readonly kind: "payload" | "prompt" | "ledger";
  }>;
  /** Count of redacted occurrences across the annotation. */
  readonly redactedCount: number;
}

/**
 * Registered EVAL conformance ID range (EVAL-001..010). The acceptance test
 * reads these rows from the v2 manifest and asserts their expected bytes/results.
 * Registered BEFORE evaluation logic so the manifest/fixture seam is stable.
 */
export const EVAL_IDS = [
  "EVAL-001",
  "EVAL-002",
  "EVAL-003",
  "EVAL-004",
  "EVAL-005",
  "EVAL-006",
  "EVAL-007",
  "EVAL-008",
  "EVAL-009",
  "EVAL-010",
] as const;

export type EvalId = (typeof EVAL_IDS)[number];
