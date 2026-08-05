/**
 * vector-cortex/provider/registry.ts — fixture-backed base provider profile
 * registry (VC5B, task 2).
 *
 * The registry resolves a `(provider, model)` pair to a `ProviderProfileBundle`
 * (CONTRACTS §ProviderProfileV1 + role/tool/cache rules). Unknown provider/model
 * returns `PRO_PROFILE_UNKNOWN` and the renderer CLEANLY bypasses vector-cortex
 * rendering (NOT an error — the host uses the predecessor prompt path).
 *
 * Profiles are fixture-backed: each base profile is declared here as a constant
 * and is also pinned as a conformance fixture under `conformance/vector-cortex/v2/
 * provider/` (registered by `scripts/gen-fixtures/provider.mjs`). The registry is
 * the REAL resolver the acceptance suite drives; the fixtures are the committed
 * canonical corpus that proves each profile's cache-identity behavior.
 *
 * Pi-agnostic, dependency-free, zero network (PREVENT-PI-004 / PREVENT-011).
 */

import {
  PRO_PROFILE_UNKNOWN,
  type ProviderProfileBundle,
  type ProviderProfileResult,
  type ProviderProfileV1,
} from "./types.js";

/** A registry key is `provider` + `model`. Lookup is exact-match. */
function key(provider: string, model: string): string {
  return `${provider}//${model}`;
}

/**
 * The base role rule every VC5B profile shares: the renderer MUST use the host
 * `before_agent_start` prepend seam and MUST NOT inject `role:"system"`
 * (PREVENT-PI-003, critical).
 */
const BASE_ROLE = {
  useHostPrependSeam: true,
  forbidSystemRoleInjection: true,
} as const;

/**
 * The base tool rule every VC5B profile shares: exact tool bytes preserved
 * (PREVENT-PI-002) and the renderer never reorders away from the validator order.
 */
const BASE_TOOL = {
  preserveExactToolBytes: true,
  forbidToolReorder: true,
} as const;

/** Build a base cache rule (entire-canonical-request hashing by default). */
function baseCache(stableFields: readonly string[]): ProviderProfileBundle["cache"] {
  return {
    hashMode: "entire-canonical-request",
    stableFields,
  };
}

/** Build a contract-profile shape pinned as a conformance fixture too. */
function profile(
  id: string,
  version: string,
  excludedJsonPointers: ProviderProfileV1["excludedJsonPointers"],
): ProviderProfileV1 {
  return {
    schema: "provider-profile-v1",
    id,
    version,
    hashMode: "entire-canonical-request",
    excludedJsonPointers,
  };
}

/**
 * The fixture-backed base profiles. Each entry is the REAL bundle the renderer
 * resolves; the parallel conformance fixtures prove the cache-identity behavior.
 */
const BASE_PROFILES: readonly ProviderProfileBundle[] = [
  {
    profile: profile("anthropic-claude-opus", "v1", []),
    role: BASE_ROLE,
    tool: BASE_TOOL,
    cache: baseCache(["systemPromptPrepend", "tools", "nodes"]),
  },
  {
    profile: profile("anthropic-claude-sonnet", "v1", []),
    role: BASE_ROLE,
    tool: BASE_TOOL,
    cache: baseCache(["systemPromptPrepend", "tools", "nodes"]),
  },
  {
    profile: profile("openai-gpt", "v1", []),
    role: BASE_ROLE,
    tool: BASE_TOOL,
    cache: baseCache(["systemPromptPrepend", "tools", "nodes"]),
  },
  {
    // A profile that proves a fixture-excluded pointer: a provider whose
    // request-id header cannot affect cache identity. Excluded + versioned.
    profile: profile("google-gemini", "v1", [
      {
        pointer: "/requestId",
        fixtureId: "PRO-EXCLUDE-010",
        proofDigest: "sha256:excluded-request-id-proof",
      },
    ]),
    role: BASE_ROLE,
    tool: BASE_TOOL,
    cache: baseCache(["systemPromptPrepend", "tools", "nodes"]),
  },
];

const REGISTRY: ReadonlyMap<string, ProviderProfileBundle> = new Map(
  BASE_PROFILES.map((b) => [key(b.profile.id, b.profile.version), b] as const),
);

/**
 * Resolve a `(provider, model)` pair to a `ProviderProfileBundle`. Unknown
 * provider / model / version → a CLEAN bypass (`PRO_PROFILE_UNKNOWN`), never an
 * error. The renderer consults this and, on `ok:false`, selects triad C (the
 * predecessor prompt path).
 */
export function resolveProviderProfile(
  provider: string,
  model: string,
): ProviderProfileResult {
  const bundle = REGISTRY.get(key(provider, model));
  if (bundle === undefined) {
    return { ok: false, code: PRO_PROFILE_UNKNOWN };
  }
  return { ok: true, bundle };
}

/** The fixture-backed base profiles (exposed for tests / dashboard introspection). */
export const BASE_PROVIDER_PROFILES: readonly ProviderProfileBundle[] = BASE_PROFILES;

/** The set of known `(provider, model)` keys, for conformance registration. */
export const KNOWN_PROVIDER_KEYS: readonly string[] = Array.from(REGISTRY.keys());
