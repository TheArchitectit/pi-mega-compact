/**
 * vector-cortex/provider/types.ts — provider profile contract (VC5B, task 1).
 *
 * A `ProviderProfileV1` describes how a given provider/model caches and what the
 * renderer may or may not fold into the outbound prompt without breaking the
 * provider's KV-cache identity (CONTRACTS §ProviderProfileV1 + crystals).
 *
 * The renderer hashes the ENTIRE canonical outbound request by default
 * (`hashMode: "entire-canonical-request"`). A profile may EXCLUDE a field only
 * when a fixture proves that field cannot affect provider cache identity; every
 * exclusion is versioned and listed in the manifest. Unknown provider / profile /
 * version → the renderer bypasses vector-cortex rendering (a clean bypass, NOT an
 * error) and the host falls back to the predecessor prompt path.
 *
 * Pure types + registered conformance IDs: no storage, no console, no network
 * (PREVENT-PI-004 / PREVENT-011).
 */

/**
 * The hash mode the renderer uses for the canonical outbound request. The ONLY
 * supported mode is hashing the entire request bytes — partial hashing is not
 * allowed (it would let a folded field silently break cache identity).
 */
export type ProviderHashMode = "entire-canonical-request";

/**
 * A JSON-pointer exclusion: a documented proof that the named pointer cannot
 * affect provider cache identity. `fixtureId` pins the conformance row that
 * proves it; `proofDigest` is that fixture's SHA-256. Exclusions are versioned
 * per profile and MUST be listed in the manifest (CONTRACTS §ProviderProfileV1).
 */
export interface ProviderProfileExclusion {
  readonly pointer: string;
  readonly fixtureId: string;
  readonly proofDigest: string;
}

/**
 * Cache economics attached to a provider profile (VC7B).
 *
 * Prices are integer MICRO-UNITS PER TOKEN (1e-6 currency units), so a provider
 * charging $3.00 per million input tokens has `basePrice: 3`. Integers keep the
 * money path exact (see `economics.ts` for why floats are refused).
 */
export interface ProviderEconomicsV1 {
  readonly schema: "provider-economics-v1";
  /** The `ProviderProfileV1.id` these economics belong to. */
  readonly profileId: string;
  /** Profile version — economics are versioned WITH the profile they price. */
  readonly profileVersion: string;
  /** Uncached price per token, integer micro-units. The savings baseline. */
  readonly basePrice: number;
  /** Cache-READ price per token, integer micro-units. Normally < basePrice. */
  readonly readPrice: number;
  /** Cache-WRITE price per token, integer micro-units. Normally > basePrice. */
  readonly writePrice: number;
  /** Cache entry lifetime in ms. A prefix older than this cannot be read back. */
  readonly ttlMs: number;
  /** Minimum cacheable prefix in tokens; a shorter prefix is never cached. */
  readonly minPrefix: number;
  /**
   * Conformance fixture ID proving this profile's exclusion set is safe, or
   * `null` when the profile declares NO exclusions (nothing to prove). A profile
   * WITH exclusions and a null/blank id is rejected — see `validateEconomics`.
   */
  readonly exclusionFixtureId: string | null;
}

/**
 * The provider-profile contract. A renderer consumes a profile to decide how the
 * rendered prompt is serialized into the canonical outbound request without
 * invalidating the provider's cache identity.
 */
export interface ProviderProfileV1 {
  readonly schema: "provider-profile-v1";
  readonly id: string;
  readonly version: string;
  readonly hashMode: ProviderHashMode;
  /** Versioned, fixture-proven exclusions (empty = hash the whole request). */
  readonly excludedJsonPointers: readonly ProviderProfileExclusion[];
  /**
   * VC7B cache economics pricing this profile's frozen-render reuse. Every base
   * profile carries economics so the cache-economics aggregate is computable
   * without a side table; a profile WITHOUT economics is simply never cached.
   */
  readonly economics: ProviderEconomicsV1 | null;
}

/**
 * Role rules: how the rendered context may be placed relative to the host system
 * prompt. The renderer MUST use the host `before_agent_start` systemPrompt
 * prepend seam — it NEVER injects compacted context as `role:"system"`
 * (PREVENT-PI-003, critical).
 */
export interface ProviderRoleRule {
  /** Always true for VC5B: placement is the host prepend seam, never role:system. */
  readonly useHostPrependSeam: true;
  /** A renderer MUST NOT emit a `role:"system"` message for compacted context. */
  readonly forbidSystemRoleInjection: true;
}

/**
 * Tool rules: the renderer preserves EXACT tool bytes (PREVENT-PI-002 — never
 * split a toolCall/toolResult pair). A profile declares whether the provider
 * tolerates tool reordering; VC5B renders in the validator's stable order and
 * never reorders, so this is a validation constraint, not a permission.
 */
export interface ProviderToolRule {
  /** Exact tool bytes are preserved verbatim (no normalization/transcoding). */
  readonly preserveExactToolBytes: true;
  /** The renderer never reorders tools away from the validator's order. */
  readonly forbidToolReorder: true;
}

/**
 * Cache rules: what the profile pins about provider cache identity so the
 * renderer's canonical hash stays stable across otherwise-equivalent renders.
 */
export interface ProviderCacheRule {
  /** The hash mode the renderer uses when this profile is active. */
  readonly hashMode: ProviderHashMode;
  /** Cache-stable fields the renderer must not reorder or drop. */
  readonly stableFields: readonly string[];
}

/**
 * A fully-resolved provider profile bundle: the contract plus the role/tool/cache
 * rules the renderer enforces. The fixture-backed base registry returns these.
 */
export interface ProviderProfileBundle {
  readonly profile: ProviderProfileV1;
  readonly role: ProviderRoleRule;
  readonly tool: ProviderToolRule;
  readonly cache: ProviderCacheRule;
}

/**
 * Provider profile resolution failure codes. These are NOT errors that should
 * break the agent loop — `PRO_PROFILE_UNKNOWN` is a clean bypass signal.
 */
export type ProviderProfileCode =
  /** No matching profile for the provider/model; the renderer bypasses cleanly. */
  | "PRO_PROFILE_UNKNOWN"
  /** A profile matched but its version is unsupported by the renderer. */
  | "PRO_PROFILE_VERSION_UNSUPPORTED";

/**
 * The provider-profile resolution verdict. `ok:true` carries the resolved
 * bundle; `ok:false` carries a bypass code. Every `ok:false` is a CLEAN bypass
 * (the host uses the predecessor prompt path) — never an error.
 */
export type ProviderProfileResult =
  | { readonly ok: true; readonly bundle: ProviderProfileBundle }
  | { readonly ok: false; readonly code: ProviderProfileCode };

/**
 * The sentinel returned for an unknown provider/model. The renderer sees this as
 * a CLEAN bypass decision, not an error, and emits `vector_cortex_provider_bypassed`.
 */
export const PRO_PROFILE_UNKNOWN: ProviderProfileCode = "PRO_PROFILE_UNKNOWN";

/**
 * Registered PRO conformance ID range (PRO-001..015). The acceptance aggregator
 * reads these rows from the v2 manifest and asserts each returns its manifest
 * `ok`/`code` / pinned `requestDigest`.
 */
export const PRO_IDS: readonly string[] = Array.from(
  { length: 15 },
  (_v, i) => `PRO-${String(i + 1).padStart(3, "0")}`,
);

/** Named VC5B provider conformance assertions (the sprint's headline rows). */
export const PRO_NAMED_IDS = ["PRO-UNKNOWN-003"] as const;

/** Injected emit callback — same (event, fields) shape as the other VC seams. */
export type ProviderEmitter = (
  event: string,
  fields: Record<string, unknown>,
) => void;

/** The two structured events the VC5B provider seam emits. */
export type ProviderEventName =
  | "vector_cortex_render_validated"
  | "vector_cortex_provider_bypassed";

/** Typed, best-effort reporter bound to the two provider/render event names. */
export interface ProviderReporter {
  readonly renderValidated: (fields: Record<string, unknown>) => void;
  readonly providerBypassed: (fields: Record<string, unknown>) => void;
}

/**
 * Aggregate-only provider/render metrics for the dashboard (counts only, never
 * prompt text or node payloads).
 */
export interface ProviderMetricsV1 {
  readonly rendersValidated: number;
  readonly providersBypassed: number;
  readonly nodesRendered: number;
}
