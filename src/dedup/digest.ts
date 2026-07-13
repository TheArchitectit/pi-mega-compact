/**
 * digest.ts — content-addressable digest (Sprint 9).
 *
 * Dual-hash design (QA #2 spirit, local): a primary + a secondary hash guard
 * against a single-hash collision silently merging distinct content. The L0 dedup
 * key is `(content_hash, content_hash2)` — both must agree to declare a duplicate.
 *
 * `content_hash` is the full 64-hex SHA-256 of the normalized text. `content_hash2`
 * is a second independent view (SHA-256 of the reversed normalized text) so a
 * collision on one alone does not dedup. `content_hash_version` lets Sprint 11/12
 * plug in stronger digests later without breaking old rows.
 */

import { createHash } from "node:crypto";
import { normalize } from "./normalize.js";

export const CONTENT_HASH_VERSION = 1;

export interface ContentDigest {
  contentHash: string;
  contentHash2: string;
  contentHashVersion: number;
  normalizedText: string;
}

/** Compute the canonical content digest for a (possibly raw) region text. */
export function computeContentDigest(text: string): ContentDigest {
  const normalizedText = normalize(text);
  const contentHash = createHash("sha256").update(normalizedText).digest("hex");
  // Secondary: hash the reversed normalized string so it's an independent view.
  const contentHash2 = createHash("sha256")
    .update(normalizedText.split("").reverse().join(""))
    .digest("hex");
  return {
    contentHash,
    contentHash2,
    contentHashVersion: CONTENT_HASH_VERSION,
    normalizedText,
  };
}
