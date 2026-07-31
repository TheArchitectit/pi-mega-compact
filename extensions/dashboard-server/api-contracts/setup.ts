/**
 * api-contracts/setup.ts — Setup wizard API response types.
 *
 * Types for the /api/setup-status and /api/setup-detect endpoints used
 * by the /megasetup command and dashboard Setup tab.
 *
 * PREVENT-PI-004: type definitions only, no network code.
 * PREVENT-011: no `any` type — all types are explicit.
 */

/**
 * Response for GET /api/setup-status.
 * Returns the current embedder configuration read from the environment.
 */
export interface SetupStatusResponse {
  /** Which embedder implementation is currently active. */
  readonly currentEmbedder: "trigram" | "http" | "minilm" | "unknown";
  /** The embedding URL if httpEmbedder is active, otherwise null. */
  readonly embeddingUrl: string | null;
  /** The MEGACOMPACT_EMBED_CACHE value (number as string), or null. */
  readonly embedCache: string | null;
  /** Whether MEGACOMPACT_MINILM is set to a truthy value. */
  readonly minilm: boolean;
}

/**
 * A single detection result for one embedder backend.
 */
export interface DetectResult {
  readonly installed: boolean;
  readonly detail: string | null;
}

/**
 * Ollama-specific detection result with model listing and runtime status.
 */
export interface OllamaDetectResult extends DetectResult {
  readonly installed: boolean;
  readonly models: string[];
  readonly running: boolean;
  readonly detail: string | null;
}

/**
 * Response for GET /api/setup-detect.
 * Best-effort detection of local embedder backends available on the machine.
 * All fields are best-effort; failures are non-fatal.
 */
export interface SetupDetectResponse {
  /** Ollama detection: installed, available models, whether the server is running. */
  readonly ollama: OllamaDetectResult | null;
  /** llama.cpp / llama-server detection on PATH. */
  readonly llamaCpp: DetectResult | null;
  /** ONNX runtime detection (onnxruntime-node in node_modules). */
  readonly onnx: DetectResult | null;
  /** Error message if detection itself failed, or null. */
  readonly error: string | null;
}
