/**
 * vector-cortex/encoder/types.ts — VC2A contract (ModelManifestV1 /
 * EncoderRuntime).
 *
 * The offline encoder runtime owns the learned-asset path (triad mode A: a
 * qualified local ONNX). MODEL_ASSET.md is the normative target. This
 * sprint (VC2A) ships the manifest + verification + shaped-inference contract;
 * the trained weights are packaged in VC2C (MODEL_ASSET: "package.json changes
 * occur only in VC2C"), but the verification, digest-before-load, platform
 * demotion, shape rejection and RSS/latency budget all land here so a later
 * sprint only substitutes real weights.
 *
 * Contract-first (ENGINEERING_PRACTICES §3): this types file is the reviewed
 * gate; implementations import from it; consumers import only types + factory.
 *
 * Pi-agnostic and dependency-free (PREVENT-PI-004 — local assets only, the
 * runtime never fetches). No `any` (PREVENT-011).
 */

/** The normative encoder pool; a tokenizer must be digest-covered. */
export type EncoderPlatform =
  | "linux-x64"
  | "linux-arm64"
  | "darwin-x64"
  | "darwin-arm64"
  | "win32-x64";

/** Supported matrix from MODEL_ASSET.md §qualification. */
export const ENCODER_SUPPORTED_PLATFORMS: readonly EncoderPlatform[] = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
];

/** ONNX opset required by the normative v1 target (opset 17). */
export const ENCODER_OPSET = 17;
/** Batch must be exactly 1 (single-request inference). */
export const ENCODER_BATCH = 1;
/** Maximum accepted token count (WordPiece, deterministic truncation). */
export const ENCODER_MAX_TOKENS = 512;
/** Caps the encoder's MARGINAL footprint (bytes) at 150 MiB (MODEL_ASSET
 *  §qualification). The budget bounds the encoder's own incremental allocation
 *  (in-process allocation counter + any externally staged asset working set),
 *  NOT the whole-process RSS — in a live pi extension the process baseline
 *  routinely exceeds 150 MiB, so measuring absolute RSS would make mode A
 *  unreachable in production (code-review Q01). */
export const ENCODER_RSS_BUDGET_BYTES = 150 * 1024 * 1024;
/** p95 inference budget in milliseconds (MODEL_ASSET §qualification). */
export const ENCODER_LATENCY_P95_MS = 40;
/** Semantic projection head width (MODEL_ASSET: 384 float32 L2-normalized). */
export const ENCODER_SEMANTIC_WIDTH = 384;

/** A digest-pinned asset file declared in the manifest. */
export interface ManifestAssetFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** The five independent projection heads (MODEL_ASSET §decision record). */
export interface EncoderHeads {
  readonly semantic: number;
  readonly dependency: number;
  readonly contradiction: number;
  readonly cacheStability: number;
  readonly payloadRouting: number;
}

/**
 * ModelManifestV1 — the digest/opset/platform/input/output contract for the
 * offline encoder asset. Every byte of the ONNX + tokenizer is covered by a
 * SHA-256 recorded here; verification hashes the files BEFORE load.
 */
export interface ModelManifestV1 {
  readonly schema: "model-manifest-v1";
  readonly modelVersion: string;
  readonly opset: number;
  readonly batch: number;
  readonly maxTokens: number;
  readonly platform: EncoderPlatform;
  readonly hiddenWidth: number;
  readonly semanticWidth: number;
  readonly heads: EncoderHeads;
  readonly onnx: ManifestAssetFile;
  readonly tokenizer: ManifestAssetFile;
  readonly totalBytes: number;
  readonly trainingManifestDigest: string;
}

/** Result of loading the encoder runtime (mode A qualified load). */
export type EncoderLoadResult =
  | { ok: true; mode: "A"; embeddedBytes: number; rssBytes: number; sessionId: string }
  | { ok: false; mode: "B" | "C"; code: string };

/** A single shaped inference request: batch 1, max 512 tokens. */
export interface EncoderInput {
  readonly tokens: readonly number[];
}

/** Result of a single inference (mode A only; mode B/C do not infer). */
export type EncoderInferResult =
  | { ok: true; semantic: Float32Array; rssBytes: number; latencyMs: number; shapeError: null }
  | { ok: false; code: string; shapeError: string };

/**
 * EncoderRuntime — allocate only after manifest verification; infer only for a
 * verified, qualified asset. `mode` is "A" when the local qualified ONNX is
 * active; "B" when an unsupported platform / missing asset / digest mismatch
 * demoted to the asset-free trigram (no remote fetch); "C" when both A and B
 * initialization failed (lexical fallback).
 */
export interface EncoderRuntime {
  readonly schema: "encoder-runtime-v1";
  readonly mode: EncoderMode;
  load(assetDir: string): EncoderLoadResult;
  infer(input: EncoderInput): EncoderInferResult;
}

export type EncoderMode = "A" | "B" | "C";

/** Exact VC2A failure codes (returned, never thrown across the boundary). */
export const ENC_FAIL = {
  /** opset != 17. */
  OPSET_INVALID: "ENC_OPSET_INVALID",
  /** batch != 1. */
  BATCH_INVALID: "ENC_BATCH_INVALID",
  /** maxTokens > 512. */
  TOKENS_EXCEEDED: "ENC_TOKENS_EXCEEDED",
  /** input token count > declared maxTokens / 512, or not batch 1. */
  SHAPE_INVALID: "ENC_SHAPE_INVALID",
  /** asset file unreadable (truncated during digest read, allocator failure). */
  ASSET_UNREADABLE: "ENC_ASSET_UNREADABLE",
  /** on-disk digest does not match the manifest (one-byte mutation). */
  DIGEST_MISMATCH: "ENC_DIGEST_MISMATCH",
  /** platform not in the supported matrix (selects trigram B). */
  PLATFORM_UNSUPPORTED: "ENC_PLATFORM_UNSUPPORTED",
  /** manifest missing/invalid (selects trigram B). */
  MANIFEST_INVALID: "ENC_MANIFEST_INVALID",
  /** measured RSS over the 150 MiB budget (selects trigram B). */
  RSS_BUDGET_EXCEEDED: "ENC_RSS_BUDGET_EXCEEDED",
  /** mode C forced by the rollback path (MEGACOMPACT_VC2A=0 / forcedMode "C").
   *  Distinct from MANIFEST_INVALID so a non-corrupt, correctly-shaped asset
   *  present on disk is not mis-reported as "manifest invalid" when the runtime
   *  is simply rolled back to the predecessor path (code-review Q04). */
  ROLLBACK: "ENC_ROLLBACK_ACTIVE",
} as const;

/** The 8 registered VC2A conformance IDs (task 1: "register ENC-001..008"). */
export const ENC_IDS: readonly string[] = [
  "ENC-001",
  "ENC-002",
  "ENC-003",
  "ENC-004",
  "ENC-005",
  "ENC-006",
  "ENC-007",
  "ENC-008",
];
