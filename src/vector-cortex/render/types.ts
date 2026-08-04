/**
 * vector-cortex/render/types.ts — the validated prompt renderer contract (VC5B,
 * task 1).
 *
 * The renderer consumes VC5A's handoff — a `PlanV1` (selected node IDs in stable
 * Kahn order + `dagDigest` + `tokenTotal`) and the validator's `order` — and
 * produces a `RenderManifestV1`: the EXACT node render order, the SHA-256 digest
 * of the entire canonical outbound request, and the active profile ID. The
 * renderer NEVER re-orders — it replays the validator's stable order verbatim.
 *
 * It renders through the host `before_agent_start` systemPrompt PREPEND seam,
 * never as a `role:"system"` message (PREVENT-PI-003, critical). Tool bytes are
 * preserved EXACTLY (PREVENT-PI-002 — a toolCall/toolResult pair is never split).
 *
 * Pure types + registered conformance IDs: no storage, no console, no network
 * (PREVENT-PI-004 / PREVENT-011).
 */

import type { ProviderProfileBundle } from "../provider/types.js";

/**
 * A single rendered node in the outbound prompt. `bytes` are the EXACT serialized
 * node bytes (tool bytes preserved verbatim). `orderIndex` is the validator's
 * stable position — never mutated by the renderer.
 */
export interface RenderedNode {
  readonly id: string;
  readonly kind: string;
  /** Exact serialized bytes (NFC UTF-8; tool bytes verbatim). */
  readonly bytes: Uint8Array;
  /** The validator's stable position for this node. */
  readonly orderIndex: number;
}

/**
 * The renderer output: a `RenderManifestV1`. This is NOT a raw `role:"system"`
 * message — it is the validated render plan the validator and host consume.
 */
export interface RenderManifestV1 {
  readonly schema: "render-manifest-v1";
  /** The exact node render order (validator's stable Kahn order, replayed). */
  readonly nodeOrder: readonly string[];
  /** SHA-256 hex of the ENTIRE canonical outbound request bytes. */
  readonly requestDigest: string;
  /** Active provider profile ID (or "unknown" for a clean bypass). */
  readonly profileId: string;
  /** Active provider profile version (or "unknown" for a clean bypass). */
  readonly profileVersion: string;
  /** Total rendered token payload (framed-ish, for dashboard only). */
  readonly tokenTotal: number;
}

/**
 * The canonical outbound request the renderer emits through the host prepend seam.
 * `systemPromptPrepend` carries the compacted context via the
 * `before_agent_start` prepend — it is NEVER a `role:"system"` message. `tools`
 * carries exact tool bytes, verbatim.
 */
export interface CanonicalOutboundRequest {
  /** Compacted context placed via the host prepend seam (NOT role:system). */
  readonly systemPromptPrepend: string;
  /** Exact tool bytes, verbatim and in validator order. */
  readonly tools: readonly { readonly id: string; readonly bytes: string }[];
  /** The rendered node payloads in validator order. */
  readonly nodes: readonly RenderedNode[];
}

/**
 * Render failure codes. The UNIQUE failure-injection code is
 * `REN_PROFILE_DIGEST_MISMATCH`: the provider profile is changed AFTER render but
 * BEFORE validation, so the re-hashed canonical request no longer matches the
 * manifest digest — the renderer selects triad C (predecessor prompt path).
 */
export type RenderFailureCode =
  /** The selected node set diverges from the validator's stable order. */
  | "REN_ORDER_MISMATCH"
  /** A tool's bytes differ from the source (exact-byte contract violated). */
  | "REN_TOOL_BYTE_MISMATCH"
  /** The rendered byte length diverges from the validator's pinned length. */
  | "REN_BYTE_LENGTH_MISMATCH"
  /** A provider constraint is violated by the rendered request. */
  | "REN_PROVIDER_CONSTRAINT_VIOLATED"
  /** Profile changed after render but before validation (unique injection). */
  | "REN_PROFILE_DIGEST_MISMATCH"
  /** No provider profile resolved (clean bypass, not an error). */
  | "REN_PROFILE_UNKNOWN";

/**
 * The render verdict. `ok:true` carries the manifest + the canonical request and
 * its digest. `ok:false` carries exactly one failure code and the triad the
 * renderer must select (A stays on the validated render; C falls back to the
 * predecessor prompt path for an unknown profile).
 */
export type RenderResult =
  | {
      readonly ok: true;
      readonly manifest: RenderManifestV1;
      readonly request: CanonicalOutboundRequest;
    }
  | {
      readonly ok: false;
      readonly code: RenderFailureCode;
      /** The triad the host must select: A validated render, C predecessor path. */
      readonly triad: "A" | "C";
    };

/**
 * Required inputs to the renderer. `order` is VC5A's validator order; `plan` is
 * the VC5A plan handoff; `nodes` carries the raw node payloads keyed by ID.
 */
export interface RenderInput {
  /** Validator's stable Kahn order (VC5A handoff — never reordered). */
  readonly order: readonly string[];
  /** Selected node IDs from the plan (must equal `order` as a set). */
  readonly selectedNodeIds: readonly string[];
  /** DAG structure digest (VC5A handoff — post-plan mutation is detectable). */
  readonly dagDigest: string;
  /** Raw node payloads keyed by node ID (exact bytes). */
  readonly nodes: ReadonlyMap<string, { readonly kind: string; readonly bytes: Uint8Array }>;
  /** Resolved provider profile bundle (unknown → clean bypass). */
  readonly profile: ProviderProfileBundle | null;
  /** The framing token overhead already accounted by VC5A. */
  readonly tokenTotal: number;
}

/**
 * The triad mode VC5B selects (TRIAD_RESILIENCE). A/B/C are independent:
 *   A = validated profile render (the good outcome);
 *   B = uncached profile-safe render forced by a cache constraint;
 *   C = existing predecessor prompt path forced by an unknown profile.
 */
export type RenderMode = "A" | "B" | "C";

/** Injected emit callback — same (event, fields) shape as the other VC seams. */
export type RenderEmitter = (event: string, fields: Record<string, unknown>) => void;

/** The two structured events the VC5B render seam emits. */
export type RenderEventName =
  | "vector_cortex_render_validated"
  | "vector_cortex_provider_bypassed";

/** Typed, best-effort reporter bound to the two render event names. */
export interface RenderReporter {
  readonly renderValidated: (fields: Record<string, unknown>) => void;
  readonly providerBypassed: (fields: Record<string, unknown>) => void;
}

/**
 * Aggregate-only render metrics for the dashboard (counts/tokens only, never
 * prompt text or node payloads).
 */
export interface RenderMetricsV1 {
  readonly rendersValidated: number;
  readonly providersBypassed: number;
  readonly nodesRendered: number;
  readonly tokenTotal: number;
}

/**
 * Registered REN conformance ID range (REN-001..020). The acceptance aggregator
 * reads these rows from the v2 manifest and asserts each returns its manifest
 * `ok`/`code` / pinned `requestDigest`.
 */
export const REN_IDS: readonly string[] = Array.from(
  { length: 20 },
  (_v, i) => `REN-${String(i + 1).padStart(3, "0")}`,
);

/** Named VC5B render conformance assertions (the sprint's headline rows). */
export const REN_NAMED_IDS = [
  "REN-ORDER-001",
  "REN-TOOL-002",
  "REN-BYPASS-003",
] as const;
