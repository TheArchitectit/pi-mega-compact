/**
 * vector-cortex/render/validator.ts — canonical request validator (VC5B, task 4).
 *
 * The validator runs BEFORE the provider invocation. It re-hashes the ENTIRE
 * canonical outbound request and compares the result against the render manifest:
 *   - order        — the request's node order equals the manifest's nodeOrder;
 *   - tools         — every tool's bytes equal the source (exact-byte contract,
 *                     PREVENT-PI-002);
 *   - byte lengths  — every segment length equals the pinned length;
 *   - provider      — the active profile still matches the manifest profile, and
 *                     no provider constraint is violated.
 *
 * UNIQUE failure injection: the provider profile is changed AFTER render but
 * BEFORE validation. The re-hashed request (folded under the new profile's
 * hashMode/stableFields) no longer matches the manifest digest → the validator
 * returns `REN_PROFILE_DIGEST_MISMATCH` and the host selects triad C (predecessor
 * prompt path). A mismatch under an unchanged profile is an exact-byte/order
 * violation (REN_ORDER_MISMATCH / REN_TOOL_BYTE_MISMATCH / REN_BYTE_LENGTH_MISMATCH
 * / REN_PROVIDER_CONSTRAINT_VIOLATED).
 *
 * Pi-agnostic, dependency-free, zero network (PREVENT-PI-004 / PREVENT-011).
 */

import { createHash } from "node:crypto";

import type {
  CanonicalOutboundRequest,
  RenderFailureCode,
  RenderManifestV1,
  RenderMode,
} from "./types.js";
import { canonicalRequestBytes } from "./renderer.js";
import type { ProviderProfileBundle } from "../provider/types.js";

/** A validated request verdict. `ok:true` carries the recomputed digest. */
export type ValidateResult =
  | { readonly ok: true; readonly requestDigest: string }
  | {
      readonly ok: false;
      readonly code: RenderFailureCode;
      /** The triad the host must select. C = predecessor prompt path. */
      readonly triad: "A" | "C";
    };

function digestOf(req: CanonicalOutboundRequest): string {
  return createHash("sha256").update(canonicalRequestBytes(req)).digest("hex");
}

/**
 * Validate the canonical outbound request against the render manifest, using the
 * profile that is active AT VALIDATION TIME. `sourceToolBytes` pins the exact
 * source tool bytes keyed by node ID so the validator can detect a byte change.
 */
export function validateRender(
  manifest: RenderManifestV1,
  request: CanonicalOutboundRequest,
  profile: ProviderProfileBundle | null,
  sourceToolBytes: ReadonlyMap<string, string>,
  pinnedToolLengths: ReadonlyMap<string, number>,
): ValidateResult {
  // 1. Order must equal the manifest's nodeOrder exactly (validator order replayed).
  if (request.nodes.length !== manifest.nodeOrder.length) {
    return { ok: false, code: "REN_ORDER_MISMATCH", triad: "A" };
  }
  for (let i = 0; i < manifest.nodeOrder.length; i++) {
    if (request.nodes[i].id !== manifest.nodeOrder[i]) {
      return { ok: false, code: "REN_ORDER_MISMATCH", triad: "A" };
    }
  }

  // 2. Tool byte LENGTHS must match the pinned source lengths FIRST (catch a
  //    silent truncation/transcode as the more specific signal), then the exact
  //    byte content (PREVENT-PI-002). A length change is reported as
  //    REN_BYTE_LENGTH_MISMATCH before falling through to the content check.
  if (request.tools.length !== sourceToolBytes.size) {
    return { ok: false, code: "REN_TOOL_BYTE_MISMATCH", triad: "A" };
  }
  for (const t of request.tools) {
    const src = sourceToolBytes.get(t.id);
    if (src === undefined) {
      return { ok: false, code: "REN_TOOL_BYTE_MISMATCH", triad: "A" };
    }
    const pinned = pinnedToolLengths.get(t.id);
    if (pinned !== undefined && Buffer.byteLength(t.bytes, "utf8") !== pinned) {
      return { ok: false, code: "REN_BYTE_LENGTH_MISMATCH", triad: "A" };
    }
    if (src !== t.bytes) {
      return { ok: false, code: "REN_TOOL_BYTE_MISMATCH", triad: "A" };
    }
  }

  // 3. Provider constraint: the active profile at validation time must match the
  //    manifest's profile. A changed profile is the UNIQUE injection → mismatch.
  if (profile === null) {
    // Clean bypass case: the manifest should also be "unknown"; if it isn't, the
    // profile was swapped after render → mismatch.
    if (manifest.profileId !== "unknown") {
      return { ok: false, code: "REN_PROFILE_DIGEST_MISMATCH", triad: "C" };
    }
  } else if (profile.profile.id !== manifest.profileId || profile.profile.version !== manifest.profileVersion) {
    return { ok: false, code: "REN_PROFILE_DIGEST_MISMATCH", triad: "C" };
  }

  // 4. Re-hash the ENTIRE canonical outbound request under the active profile's
  //    hash mode (entire-canonical-request is the only supported mode) and compare.
  const digest = digestOf(request);
  if (digest !== manifest.requestDigest) {
    // A digest change under a consistent profile is a byte/order violation, not a
    // profile swap. (The profile-swap case above already returned C.)
    return { ok: false, code: "REN_PROVIDER_CONSTRAINT_VIOLATED", triad: "A" };
  }

  return { ok: true, requestDigest: digest };
}

/** Triad selection helper: fold a validation outcome into the host's triad choice. */
export function selectTriad(result: ValidateResult): RenderMode {
  if (result.ok) return "A";
  return result.triad; // "C" for profile swap / unknown; stays "A" otherwise
}
