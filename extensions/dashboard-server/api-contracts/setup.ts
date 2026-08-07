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
  /** Which embedder implementation is currently active in the running process. */
  readonly currentEmbedder: "trigram" | "http" | "minilm" | "unknown";
  /** Which embedder was configured via the dashboard (from .mega-compact.env). */
  readonly configuredEmbedder: "trigram" | "http" | "minilm";
  /** The URL configured in .mega-compact.env, if any. */
  readonly configuredUrl: string | null;
  /** True when the configured embedder differs from the active one (restart needed). */
  readonly restartRequired: boolean;
  /** The embedding URL if httpEmbedder is active, otherwise null. */
  readonly embeddingUrl: string | null;
  /** The MEGACOMPACT_EMBED_CACHE value (number as string), or null. */
  readonly embedCache: string | null;
  /** Whether MEGACOMPACT_MINILM is set to a truthy value. */
  readonly minilm: boolean;
  /** ENC-1a: the external embedder endpoint URL persisted in the per-repo
   *  `.mega-compact.env`, when one is configured (additive, flag-gated). */
  readonly embeddingEndpointUrl?: string;
  /** ENC-1a: whether an external embedder API key is configured. The raw key is
   *  NEVER returned — only this boolean presence marker (additive, flag-gated). */
  readonly embeddingApiKeySet?: boolean;
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

/** Request body for POST /api/setup-configure. */
export interface SetupConfigureRequest {
  /** Which embedder to configure. "trigram" clears the URL (uses built-in).
   *  "custom" writes a user-supplied URL and opts in to non-loopback endpoints
   *  (sets MEGACOMPACT_ALLOW_REMOTE_EMBEDDER=1) for third-party / hosted APIs.
   *  "onnx" points at a local ONNX text-embeddings-inference server. */
  readonly embedder: "ollama" | "llama" | "trigram" | "custom" | "onnx";
  /** Override URL (required for "custom"; optional defaults for ollama/llama/onnx). */
  readonly url?: string;
  /** ENC-1a: external embedder endpoint URL, persisted to the per-repo
   *  `.mega-compact.env` (additive, flag-gated). */
  readonly embeddingEndpointUrl?: string;
  /** ENC-1a: external embedder API key, persisted to the per-repo
   *  `.mega-compact.env` only — never returned by any GET (additive, flag-gated). */
  readonly embeddingApiKey?: string;
}

/** Response for POST /api/setup-configure. */
export interface SetupConfigureResponse {
  /** The embedder that was configured. */
  readonly embedder: string;
  /** The URL that was written (null for trigram). */
  readonly url: string | null;
  /** Path to the .mega-compact.env file that was written. */
  readonly envPath: string;
  /** Whether the user needs to restart pi to activate. */
  readonly restartRequired: boolean;
  /** The already-active embedder, if the new config matches (no restart needed). */
  readonly alreadyActive: boolean;
}
