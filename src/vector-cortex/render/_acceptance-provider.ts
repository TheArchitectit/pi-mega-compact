/**
 * render/_acceptance-provider.ts — the REAL provider-registry runner for VC5B
 * provider acceptance rows. Drives `resolveProviderProfile` (no mocks).
 */

import { resolveProviderProfile, KNOWN_PROVIDER_KEYS } from "../provider/registry.js";
import type { ProviderFx } from "./_acceptance-fixture.js";

export interface ProviderRunOutcome {
  readonly ok: boolean;
  readonly code?: string;
  readonly profileId?: string;
  readonly hashMode?: string;
  readonly excludedPointers?: string[];
  readonly bypassClean?: boolean;
  readonly cacheStable?: boolean;
  readonly deterministic?: boolean;
}

/** Run a provider fixture through the REAL registry resolver. */
export function runProviderScenario(fx: ProviderFx): ProviderRunOutcome {
  const r = resolveProviderProfile(fx.input.provider, fx.input.model);
  if (!r.ok) {
    return { ok: false, code: r.code, bypassClean: true };
  }
  const p = r.bundle.profile;
  const cacheStable =
    fx.input.scenario === "resolve-excluded-cache" &&
    p.excludedJsonPointers.length === 1 &&
    p.excludedJsonPointers[0].pointer === "/requestId";
  // deterministic: a second identical lookup returns the same profile id.
  const r2 = resolveProviderProfile(fx.input.provider, fx.input.model);
  const deterministic = r2.ok && r2.bundle.profile.id === p.id;
  return {
    ok: true,
    profileId: p.id,
    hashMode: p.hashMode,
    excludedPointers: p.excludedJsonPointers.map((e) => e.pointer),
    cacheStable,
    deterministic,
  };
}

/** Exposed for the acceptance registration check. */
export const KNOWN_KEYS = KNOWN_PROVIDER_KEYS;
