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
  /** ENC-1b: the persisted `MEGACOMPACT_EMBEDDING_DIM` value as its numeric
   *  string, when one is configured (additive, flag-gated). */
  readonly embeddingDim?: string;
  /** ENC-1b: whether `MEGACOMPACT_EMBEDDING_HEADERS` is configured. The raw
   *  headers JSON is NEVER returned — only this boolean presence marker
   *  (additive, flag-gated, redaction mirrors embeddingApiKeySet). */
  readonly embeddingHeadersSet?: boolean;
  /** ENC-1b: whether `MEGACOMPACT_ALLOW_REMOTE_EMBEDDER` is set (default off —
   *  a deliberate escape hatch that skips the loopback-only check; additive,
   *  flag-gated). */
  readonly allowRemoteEmbedder?: boolean;
  /** ENC-1b: whether `MEGACOMPACT_ENCODER_NATIVE=1` is set, i.e. the operator
   *  opted into the onnxruntime-node native backend (additive, flag-gated). */
  readonly encoderNativeOptIn?: boolean;
  /** ENC-1b: the current effective ONNX runtime backend, computed live through
   *  the existing `selectRuntimeBackend`. `modeB` (flag-off / no runtime) is
   *  projected to `wasm` for display (additive, flag-gated). */
  readonly encoderBackend?: "wasm" | "native";
  /** ENC-1b: the runtime's own demotion reason when the effective backend
   *  falls back (e.g. native selected but onnxruntime-node absent / darwin-x64
   *  demoted), surfaced verbatim; null when no demotion (additive, flag-gated). */
  readonly encoderDemotionReason?: string | null;
  /** ENC-2a: the persisted `MEGACOMPACT_NATIVE_ORT_BUDGET_MIB` value as its
   *  numeric string, when configured (additive, flag-gated). Absent when the
   *  operator has not set the knob. */
  readonly nativeOrtBudgetMib?: string;
  /** ENC-2a: the EFFECTIVE budget `installBudgetMib()` resolves to (integer
   *  MiB as a numeric string), so the dashboard can show the runtime's actual
   *  operand — persists even when `nativeOrtBudgetMib` is absent because the
   *  runtime applies the default when unset. Additive, flag-gated. */
  readonly nativeOrtBudgetEffectiveMib?: string;
  /** ENC-2a: the native onnxruntime install-guide, present (as an object) when
   *  the operator opted into the native backend AND the effective runtime is
   *  still wasm (onnxruntime-node absent) AND the host platform is installable.
   *  `null` when opt-in is off or the platform is unsupported/demoted (the guide
   *  never renders). Built ONLY from the artifacts module constants — no inline
   *  URLs or hashes in the route. Additive, flag-gated; absent = no guide. */
  readonly nativeOrtInstallGuide?: {
    /** The host's EncoderPlatform this guide is matched to. */
    readonly platform: string;
    /** The [install, restart, verify] copy-paste commands. */
    readonly commands: readonly string[];
    /** The committed operator script path (repo-rel). */
    readonly scriptPath: string;
  } | null;
  /** ENC-2a: the installed native onnxruntime version read from
   *  `~/.pi/mega-compact/native-ort/` when the probe marker/package is present
   *  and platform-matched. Absent (NOT null) when not installed, so the client
   *  hides the detected-version row. Additive, flag-gated, reader-only. */
  readonly nativeOrtInstalledVersion?: string | null;
  /** ENC-2b: the native onnxruntime qualification retest result, present (as an
   *  object) when the flag is on AND a native binding is installed AND the
   *  retest ran. `null` when the retest is flag-disabled; ABSENT when no binding
   *  is installed (the client hides the retest card). Additive, flag-gated,
   *  reader-only — computed per GET, never persisted. */
  readonly nativeOrtRetestResult?: RetestResult | null;
  /** ENC-2b: the effective backend AFTER the retest. `"native"` when the retest
   *  verdict is `qualified`; `"wasm"` on a `degraded`/`failed` verdict or flag
   *  off (the runtime never silently switches on a failed retest). Additive,
   *  flag-gated, absent when no binding installed or flag off. */
  readonly nativeOrtBackendEffective?: "native" | "wasm";
}

/** ENC-2b: the native onnxruntime qualification retest result, mirroring
 *  `src/vector-cortex/encoder/native-qualify-retest.ts`. Surfaces only the
 *  platform, version string, verdict, latency, and RSS — NEVER the binding
 *  binary contents or model weights (SECURITY_PRIVACY). */
export interface RetestResult {
  readonly platform: string;
  readonly version: string;
  readonly verdict: "qualified" | "degraded" | "failed";
  readonly p95Ms: number;
  readonly rssMiB: number;
  readonly testedAt: string;
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
  /** ENC-1b: persisted `MEGACOMPACT_EMBEDDING_DIM` as a positive integer string
   *  within `ENC_1B_MAX_EMBEDDING_DIM` (validated; additive, flag-gated). */
  readonly embeddingDim?: string;
  /** ENC-1b: persisted `MEGACOMPACT_EMBEDDING_HEADERS` JSON object string
   *  (secret-bearing — written verbatim, NEVER echoed back; validated to parse
   *  as a JSON object; additive, flag-gated). */
  readonly embeddingHeaders?: string;
  /** ENC-1b: opt in to `MEGACOMPACT_ALLOW_REMOTE_EMBEDDER` (default off — a
   *  deliberate escape hatch; additive, flag-gated). */
  readonly allowRemoteEmbedder?: boolean;
  /** ENC-1b: opt in to `MEGACOMPACT_ENCODER_NATIVE` (onnxruntime-node native
   *  backend; additive, flag-gated). */
  readonly encoderNativeOptIn?: boolean;
  /** ENC-2a: persisted `MEGACOMPACT_NATIVE_ORT_BUDGET_MIB` install budget as a
   *  positive integer string within `ENC_2BUDGET_MAX_MIB` (validated; additive,
   *  flag-gated). */
  readonly nativeOrtBudgetMib?: string;
  /** ENC-2a: an optional { boolean } guide-request key. `true` → 200 + the
   *  guide echoed (this sprint conveys the GUIDE only — no server-side
   *  execution); `false` → 400 `guide_rejected_false_nothing_to_do`.
   *  Flag-gated, additive — ignored (no-op) when the flag is off. */
  readonly nativeOrtInstallGuide?: boolean;
  /** ENC-2b: an optional { boolean } retest-request key. `true` → runs the
   *  native onnxruntime qualification retest synchronously (bounded, ~2s, the
   *  binding is on disk from the ENC-2a install — never a fetch) and returns
   *  the fresh result; `false` → 400 `retest_rejected_false_nothing_to_do`.
   *  Flag-gated, additive — ignored (no-op) when the flag is off. */
  readonly nativeOrtRetest?: boolean;
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
