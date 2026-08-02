/**
 * api-contracts/embedder-health.ts — Embedder health probe response types.
 *
 * Types for the GET /api/embedder-health endpoint used by the dashboard Setup
 * tab's EmbedderHealthCard. Describes the result of round-tripping a test
 * embed through the active embedder (latency + dimensions + reachability).
 *
 * PREVENT-PI-004: type definitions only, no network code.
 * PREVENT-011: no `any` type — all types are explicit.
 */

/**
 * Response for GET /api/embedder-health.
 * Probes the active embedder with a single test embed and reports reachability,
 * latency, vector dimensionality, and a masked endpoint URL.
 */
export interface EmbedderHealthResponse {
  /** Which embedder implementation is currently active in the running process. */
  readonly activeEmbedder: "trigram" | "http" | "minilm" | "unknown";
  /** "ok" — test embed succeeded; "unreachable" — endpoint not reachable (http
   *  embedder); "error" — probe threw some other error. */
  readonly status: "ok" | "unreachable" | "error";
  /** Round-trip latency of the test embed in milliseconds. */
  readonly latencyMs: number;
  /** Vector dimensionality reported by the active embedder, or 0 on error. */
  readonly dim: number;
  /** Masked endpoint URL (scheme://hostname:port, secrets/paths stripped), or
   *  null when no URL is configured. */
  readonly url: string | null;
  /** Error message when status is "unreachable" or "error", otherwise absent. */
  readonly error?: string;
}
