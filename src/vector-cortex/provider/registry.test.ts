/**
 * provider/registry.test.ts — unit tests for the fixture-backed provider registry (VC5B).
 * Drives the REAL resolveProviderProfile (no mocks).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveProviderProfile, BASE_PROVIDER_PROFILES, KNOWN_PROVIDER_KEYS } from "./registry.js";
import { PRO_PROFILE_UNKNOWN } from "./types.js";

test("a known (provider, model) resolves to its bundle", () => {
  const r = resolveProviderProfile("anthropic-claude-opus", "v1");
  assert.equal(r.ok, true);
  assert.equal(r.bundle.profile.id, "anthropic-claude-opus");
  assert.equal(r.bundle.profile.version, "v1");
  assert.equal(r.bundle.profile.hashMode, "entire-canonical-request");
});

test("all base profiles hash the entire canonical request", () => {
  for (const b of BASE_PROVIDER_PROFILES) {
    assert.equal(b.profile.hashMode, "entire-canonical-request");
    assert.equal(b.cache.hashMode, "entire-canonical-request");
  }
});

test("every base profile forbids role:system injection and tool reorder", () => {
  for (const b of BASE_PROVIDER_PROFILES) {
    assert.equal(b.role.useHostPrependSeam, true);
    assert.equal(b.role.forbidSystemRoleInjection, true);
    assert.equal(b.tool.preserveExactToolBytes, true);
    assert.equal(b.tool.forbidToolReorder, true);
  }
});

test("an unknown provider cleanly bypasses (PRO_PROFILE_UNKNOWN)", () => {
  const r = resolveProviderProfile("does-not-exist", "v1");
  assert.equal(r.ok, false);
  assert.equal(r.code, PRO_PROFILE_UNKNOWN);
});

test("an unknown model for a known provider cleanly bypasses", () => {
  const r = resolveProviderProfile("anthropic-claude-opus", "v9");
  assert.equal(r.ok, false);
  assert.equal(r.code, PRO_PROFILE_UNKNOWN);
});

test("resolution is exact-match on provider + model", () => {
  const r = resolveProviderProfile("openai-gpt", "v1");
  assert.equal(r.ok, true);
  assert.equal(r.bundle.profile.id, "openai-gpt");
});

test("a profile with a fixture-proven exclusion lists it versioned", () => {
  const r = resolveProviderProfile("google-gemini", "v1");
  assert.equal(r.ok, true);
  assert.equal(r.bundle.profile.excludedJsonPointers.length, 1);
  assert.equal(r.bundle.profile.excludedJsonPointers[0].pointer, "/requestId");
  assert.equal(r.bundle.profile.excludedJsonPointers[0].fixtureId, "PRO-EXCLUDE-010");
});

test("KNOWN_PROVIDER_KEYS covers every base profile", () => {
  assert.equal(KNOWN_PROVIDER_KEYS.length, BASE_PROVIDER_PROFILES.length);
  assert.ok(KNOWN_PROVIDER_KEYS.includes("anthropic-claude-opus//v1"));
});
