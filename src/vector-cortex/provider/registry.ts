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
  type ProviderEconomicsV1,
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
  economics: ProviderProfileV1["economics"],
): ProviderProfileV1 {
  return {
    schema: "provider-profile-v1",
    id,
    version,
    hashMode: "entire-canonical-request",
    excludedJsonPointers,
    economics,
  };
}

/**
 * Build integer micro-unit economics for a base profile (VC7B). A cache WRITE
 * costs more than an uncached token, a cache READ costs less — the standard
 * provider-prompt-cache shape. `exclusionFixtureId` mirrors the profile's own
 * exclusion fixture (or null when the profile has none to prove).
 */
function econ(
  id: string,
  version: string,
  exclusionFixtureId: string | null,
  values: {
    basePrice: number;
    readPrice: number;
    writePrice: number;
    ttlMs: number;
    minPrefix: number;
  },
): ProviderEconomicsV1 {
  return {
    schema: "provider-economics-v1",
    profileId: id,
    profileVersion: version,
    basePrice: values.basePrice,
    readPrice: values.readPrice,
    writePrice: values.writePrice,
    ttlMs: values.ttlMs,
    minPrefix: values.minPrefix,
    exclusionFixtureId,
  };
}

/** Representative integer micro-unit economics for the Anthropic opus base tier. */
const OPUS_ECON: ProviderEconomicsV1 = econ(
  "anthropic-claude-opus",
  "v1",
  null,
  { basePrice: 15, readPrice: 2, writePrice: 19, ttlMs: 300_000, minPrefix: 1024 },
);

/** Representative integer micro-unit economics for the Anthropic sonnet base tier. */
const SONNET_ECON: ProviderEconomicsV1 = econ(
  "anthropic-claude-sonnet",
  "v1",
  null,
  { basePrice: 3, readPrice: 0, writePrice: 4, ttlMs: 300_000, minPrefix: 1024 },
);

/** Representative integer micro-unit economics for the OpenAI gpt base tier. */
const GPT_ECON: ProviderEconomicsV1 = econ(
  "openai-gpt",
  "v1",
  null,
  { basePrice: 5, readPrice: 1, writePrice: 6, ttlMs: 300_000, minPrefix: 1024 },
);

/** The gemini profile's versioned, fixture-proven exclusion. */
const GEMINI_EXCLUSIONS: ProviderProfileV1["excludedJsonPointers"] = [
  {
    pointer: "/requestId",
    fixtureId: "PRO-EXCLUDE-010",
    proofDigest: "sha256:excluded-request-id-proof",
  },
];

/** Representative integer micro-unit economics for the gemini base tier. */
const GEMINI_ECON: ProviderEconomicsV1 = econ(
  "google-gemini",
  "v1",
  "PRO-EXCLUDE-010",
  { basePrice: 3, readPrice: 1, writePrice: 4, ttlMs: 300_000, minPrefix: 1024 },
);

/**
 * The fixture-backed base profiles. Each entry is the REAL bundle the renderer
 * resolves; the parallel conformance fixtures prove the cache-identity behavior.
 */
const BASE_PROFILES: readonly ProviderProfileBundle[] = [
  {
    profile: profile("anthropic-claude-opus", "v1", [], OPUS_ECON),
    role: BASE_ROLE,
    tool: BASE_TOOL,
    cache: baseCache(["systemPromptPrepend", "tools", "nodes"]),
  },
  {
    profile: profile("anthropic-claude-sonnet", "v1", [], SONNET_ECON),
    role: BASE_ROLE,
    tool: BASE_TOOL,
    cache: baseCache(["systemPromptPrepend", "tools", "nodes"]),
  },
  {
    profile: profile("openai-gpt", "v1", [], GPT_ECON),
    role: BASE_ROLE,
    tool: BASE_TOOL,
    cache: baseCache(["systemPromptPrepend", "tools", "nodes"]),
  },
  {
    // A profile that proves a fixture-excluded pointer: a provider whose
    // request-id header cannot affect cache identity. Excluded + versioned, and
    // the exclusion fixture id is carried into economics so the proof is
    // honored (an unproven exclusion would fail economics validation).
    profile: profile("google-gemini", "v1", GEMINI_EXCLUSIONS, GEMINI_ECON),
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
