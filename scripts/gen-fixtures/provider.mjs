// VC5B provider fixtures (`conformance/vector-cortex/v2/provider/`).
//
// Owner VC5B (provider profiles). Each fixture declares a profile-resolution or
// cache-identity condition the acceptance test executes against the REAL provider
// registry (src/vector-cortex/provider/registry.js), no mocks.
// `input.scenario` names the resolution/cache condition the acceptance test
// executes; `input.provider`/`input.model` name the lookup key.
// `expected.ok` pins a clean resolution (optionally the exact `profileId` /
// `hashMode` / `excludedPointers`) or an exact bypass `code` (PRO_PROFILE_UNKNOWN
// / PRO_PROFILE_VERSION_UNSUPPORTED).
//
// PRO-001..015 pin known-resolution, unknown-bypass, version-gating, fixture-
// proven exclusions, and cache-identity stability. The NAMED rows pin the
// sprint's headline assertions:
//   PRO-UNKNOWN-003 — unknown model bypasses without partial render (shared named
//                     row with render, same assertion, registry-level)
//   PRO-EXCLUDE-010 — a versioned, fixture-proven exclusion does not affect cache
//                     identity
//   PRO-KNOWN-011   — a known (provider, model) resolves to its profile bundle

import { producer } from "./common.mjs";

const PROVIDER_SCHEMA = "schemas/provider-fixture.schema.json";

function providerFixture(id, assertion, input, expected) {
  return { id, schema: PROVIDER_SCHEMA, producer, assertion, kind: "provider", input, expected };
}

export const fixtures = [
  // ── Known resolution (PRO-001..005) ────────────────────────────────────────
  providerFixture("PRO-001", "a known anthropic opus provider/model resolves",
    { scenario: "resolve-known", provider: "anthropic-claude-opus", model: "v1" },
    { ok: true, profileId: "anthropic-claude-opus", hashMode: "entire-canonical-request" }),
  providerFixture("PRO-002", "a known anthropic sonnet provider/model resolves",
    { scenario: "resolve-known", provider: "anthropic-claude-sonnet", model: "v1" },
    { ok: true, profileId: "anthropic-claude-sonnet" }),
  providerFixture("PRO-003", "a known openai provider/model resolves",
    { scenario: "resolve-known", provider: "openai-gpt", model: "v1" },
    { ok: true, profileId: "openai-gpt" }),
  providerFixture("PRO-004", "a known google gemini provider/model resolves with an exclusion",
    { scenario: "resolve-known", provider: "google-gemini", model: "v1" },
    { ok: true, profileId: "google-gemini", excludedPointers: ["/requestId"] }),
  providerFixture("PRO-005", "resolution is exact-match on provider + model",
    { scenario: "resolve-exact", provider: "anthropic-claude-opus", model: "v1" },
    { ok: true, profileId: "anthropic-claude-opus" }),

  // ── Unknown clean bypass (PRO-006..008) ────────────────────────────────────
  providerFixture("PRO-006", "an unknown provider cleanly bypasses (not an error)",
    { scenario: "resolve-unknown", provider: "does-not-exist", model: "v1" },
    { ok: false, code: "PRO_PROFILE_UNKNOWN", bypassClean: true }),
  providerFixture("PRO-007", "an unknown model for a known provider cleanly bypasses",
    { scenario: "resolve-unknown", provider: "anthropic-claude-opus", model: "v9" },
    { ok: false, code: "PRO_PROFILE_UNKNOWN", bypassClean: true }),
  providerFixture("PRO-008", "an empty provider/model cleanly bypasses",
    { scenario: "resolve-unknown", provider: "", model: "" },
    { ok: false, code: "PRO_PROFILE_UNKNOWN", bypassClean: true }),

  // ── Version gating (PRO-009..010) ──────────────────────────────────────────
  providerFixture("PRO-009", "an unknown version for a known provider cleanly bypasses",
    { scenario: "resolve-unknown-version", provider: "anthropic-claude-opus", model: "v2" },
    { ok: false, code: "PRO_PROFILE_UNKNOWN", bypassClean: true }),
  providerFixture("PRO-010", "the fixture-backed base profiles are registered and resolvable",
    { scenario: "resolve-base-profiles", provider: "anthropic-claude-opus", model: "v1" },
    { ok: true, profileId: "anthropic-claude-opus" }),

  // ── Fixture-proven exclusion + cache identity (PRO-011..015) ───────────────
  providerFixture("PRO-011", "a known (provider, model) resolves to its profile bundle",
    { scenario: "resolve-known", provider: "anthropic-claude-sonnet", model: "v1" },
    { ok: true, profileId: "anthropic-claude-sonnet", hashMode: "entire-canonical-request" }),
  providerFixture("PRO-012", "an excluded pointer does not affect cache identity",
    { scenario: "resolve-excluded-cache", provider: "google-gemini", model: "v1" },
    { ok: true, profileId: "google-gemini", excludedPointers: ["/requestId"], cacheStable: true }),
  providerFixture("PRO-013", "the hash mode is entire-canonical-request for every known profile",
    { scenario: "resolve-hash-mode", provider: "openai-gpt", model: "v1" },
    { ok: true, hashMode: "entire-canonical-request" }),
  providerFixture("PRO-014", "a profile's excluded pointers are versioned and listed",
    { scenario: "resolve-exclusion-versioned", provider: "google-gemini", model: "v1" },
    { ok: true, excludedPointers: ["/requestId"] }),
  providerFixture("PRO-015", "resolution is deterministic across repeated lookups",
    { scenario: "resolve-deterministic", provider: "anthropic-claude-opus", model: "v1" },
    { ok: true, profileId: "anthropic-claude-opus", deterministic: true }),
];

export const named = [
  providerFixture(
    "PRO-UNKNOWN-003",
    "unknown model bypasses without partial render (named, registry-level)",
    { scenario: "resolve-unknown", provider: "does-not-exist", model: "v1" },
    { ok: false, code: "PRO_PROFILE_UNKNOWN", bypassClean: true },
  ),
  providerFixture(
    "PRO-EXCLUDE-010",
    "a versioned, fixture-proven exclusion does not affect cache identity (named)",
    { scenario: "resolve-excluded-cache", provider: "google-gemini", model: "v1" },
    { ok: true, profileId: "google-gemini", excludedPointers: ["/requestId"], cacheStable: true },
  ),
  providerFixture(
    "PRO-KNOWN-011",
    "a known (provider, model) resolves to its profile bundle (named)",
    { scenario: "resolve-known", provider: "anthropic-claude-sonnet", model: "v1" },
    { ok: true, profileId: "anthropic-claude-sonnet", hashMode: "entire-canonical-request" },
  ),
];
