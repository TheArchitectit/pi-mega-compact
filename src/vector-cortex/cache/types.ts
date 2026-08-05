/**
 * vector-cortex/cache/types.ts — VC7A frozen range crystal contract.
 *
 * A CRYSTAL is a frozen, immutable rendering of a bounded set of source ranges.
 * VC5B proved a render is deterministic; VC7A makes that determinism REUSABLE by
 * freezing the rendered bytes under a key that names exactly what they depend on.
 *
 * THE IDENTITY RULE (the whole sprint in one sentence). A crystal is keyed by
 * the source ranges it COVERS, the digest of those covered bytes, the VALIDATED
 * dependency high-water it was rendered against, and the renderer/profile that
 * produced it — and by NOTHING ELSE. In particular the GLOBAL LEDGER FRONTIER is
 * deliberately excluded from identity. That exclusion is the point: appending an
 * unrelated turn advances the global frontier on every single request, so a key
 * that included it would invalidate every crystal continuously and the cache
 * would never hit. Conversely, the four fields that ARE in the key are precisely
 * the ones whose change would make the frozen bytes WRONG:
 *
 *   - covered ranges / `coveredDigest` — different bytes render differently;
 *   - `dependencyHighWater`            — a dependency that has since advanced
 *                                        may contradict what was frozen;
 *   - `rendererVersion`                — a renderer change changes the output;
 *   - `profileId` + `profileVersion`   — a provider profile changes framing.
 *
 * So: unrelated append leaves the key UNCHANGED (CRY-FRONTIER-001); one covered
 * byte, one dependency tick, one renderer bump, or one profile bump invalidates
 * it 100% (CRY-COVERED-002 / CRY-DEP-003).
 *
 * VALIDATED, NOT OBSERVED, HIGH-WATER. `dependencyHighWater` is the DURABLE
 * contiguous authority high-water the render was VALIDATED against, not whatever
 * the writer happened to see. TRIAD_RESILIENCE freezes the derived high-water
 * during an authority outage precisely so a crystal cannot be minted claiming
 * evidence the authority has not durably accepted.
 *
 * DIGEST CONVENTIONS (three fields, two shapes — do not mix them).
 *   - `DagSpan.digest` and `CrystalKeyV1.coveredDigest` are `sha256:<hex>`, WITH
 *     the prefix (they name COVERED SOURCE BYTES, matching the DAG span
 *     convention the ranges themselves carry).
 *   - `CrystalKeyV1.requestDigest` is BARE lowercase hex, matching
 *     `RenderManifestV1.requestDigest`.
 *   - `CrystalV1.contentDigest` (the store's content address) is BARE lowercase
 *     hex, matching `ExactShardV1.digest`.
 * Mixing these would either make every lookup miss or — far worse — make a
 * prefix-stripped comparison accidentally succeed across granularities.
 *
 * Pure types + registered conformance IDs: no storage, no console, no network
 * (PREVENT-PI-004 / PREVENT-011).
 */

import type { DagSpan } from "../prompt-dag/types.js";

/**
 * The immutable identity of a frozen crystal.
 *
 * Every field here is an IDENTITY field: changing any one of them yields a
 * different key, and the key is stable under any change to a field NOT listed
 * here (most importantly the global ledger frontier).
 */
export interface CrystalKeyV1 {
  /** Provider profile that framed the render (VC5B `ProviderProfile.id`). */
  readonly profileId: string;
  /** Profile version — a profile bump must invalidate frozen bytes. */
  readonly profileVersion: string;
  /** Digest of the canonical request shape, BARE lowercase hex (VC5B). */
  readonly requestDigest: string;
  /** The source ranges this crystal covers. Sorted + disjoint (see `crystal.ts`). */
  readonly sourceRanges: readonly DagSpan[];
  /** Digest over the covered ranges' pinned digests, `sha256:` prefixed. */
  readonly coveredDigest: string;
  /** VALIDATED durable dependency high-water — never the global frontier. */
  readonly dependencyHighWater: bigint;
  /** Renderer version that produced the frozen bytes (VC5B renderer). */
  readonly rendererVersion: string;
}

/**
 * A frozen crystal: immutable bytes plus the manifest that explains them.
 *
 * `bytes` are the rendered output verbatim. `contentDigest` is the SHA-256 of
 * exactly those bytes (bare lowercase hex) and is what makes the store
 * CONTENT-ADDRESSED: two writers who independently render the same key must
 * produce the same digest, and if they do not, one of them is wrong and the
 * store refuses rather than picking a winner (`CRY_KEY_COLLISION`).
 */
export interface CrystalV1 {
  readonly schema: "crystal-v1";
  /** Canonical encoding of the key (see `encodeCrystalKey`). */
  readonly keyDigest: string;
  /** The frozen rendered bytes, verbatim and immutable. */
  readonly bytes: Uint8Array;
  /** SHA-256 over `bytes`, BARE lowercase hex (the content address). */
  readonly contentDigest: string;
  /** Byte length of `bytes`, carried so readers need not touch the payload. */
  readonly byteCount: number;
  /** The identity this crystal was frozen under. */
  readonly key: CrystalKeyV1;
}

/** VC7A failure codes (registered CRY codes). */
export type CrystalFailureCode =
  /** Two covered ranges in the same session overlap — identity is ambiguous. */
  | "CRY_RANGE_OVERLAP"
  /** A key already exists with DIFFERENT bytes; the store never overwrites. */
  | "CRY_KEY_COLLISION"
  /** A covered range is malformed (reversed/negative seq or byte bounds). */
  | "CRY_RANGE_INVALID"
  /** The key names no covered ranges — a crystal must cover something. */
  | "CRY_RANGE_EMPTY"
  /** The key exceeds the covered-range or aggregate-byte bound. */
  | "CRY_KEY_LIMIT"
  /** The store is unavailable — triad mode C, nothing is served from cache. */
  | "CRY_STORE_UNAVAILABLE";

/** The verdict of canonical key encoding. */
export type CrystalKeyResult =
  | { readonly ok: true; readonly keyDigest: string; readonly key: CrystalKeyV1 }
  | { readonly ok: false; readonly codes: readonly CrystalFailureCode[] };

/**
 * The verdict of a store write.
 *
 * `written` distinguishes a FIRST write from an idempotent re-write of identical
 * bytes: both are `ok`, because re-freezing the same crystal is legitimate (two
 * concurrent renders raced), but only the first actually stored anything. A
 * different-bytes write is never `ok` and never mutates the stored crystal.
 */
export type CrystalWriteResult =
  | { readonly ok: true; readonly written: boolean; readonly contentDigest: string }
  | { readonly ok: false; readonly code: CrystalFailureCode; readonly contentDigest: string };

/**
 * Runtime triad mode for the crystal path (TRIAD_RESILIENCE).
 *
 *   A — the crystal store answered the read (the fast, normal path);
 *   B — a miss or a collision forced a FRESH deterministic render. This is an
 *       INDEPENDENT algorithm: no crystal, no store index, the renderer runs
 *       from the plan exactly as it would have before VC7A existed;
 *   C — the store is unavailable, so the cache is BYPASSED entirely. Mode C
 *       serves nothing from cache and states the loss of old semantic context;
 *       it never substitutes a stale or partially-written crystal.
 */
export type CrystalMode = "A" | "B" | "C";

/** Reader-only aggregate for GET /api/vector-cortex/cache-crystals. */
export interface CrystalStoreStats {
  readonly mode: CrystalMode;
  /** Distinct crystals currently held. */
  readonly crystalCount: number;
  /** Aggregate frozen bytes held (sum of `byteCount`). */
  readonly totalBytes: number;
  /** Reads answered from the store (mode A). */
  readonly hits: number;
  /** Reads with no stored crystal, forcing a fresh render (mode B). */
  readonly misses: number;
  /** Bytes served from hits — the cache's observable benefit. */
  readonly hitBytes: number;
  /** First writes that actually stored a crystal. */
  readonly writes: number;
  /** Idempotent re-writes of byte-identical crystals. */
  readonly duplicateWrites: number;
  /** Same-key, different-bytes writes refused (`CRY_KEY_COLLISION`). */
  readonly collisions: number;
}

/**
 * Maximum covered ranges in one key. A key is caller-shaped input; this bound
 * exists so a single lookup cannot be turned into an unbounded sort/hash of
 * attacker-chosen ranges (CRY_KEY_LIMIT).
 */
export const CRYSTAL_LIMIT_RANGES = 256;

/** Maximum aggregate covered bytes across a key's ranges (8 MiB). */
export const CRYSTAL_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * Registered VC7A crystal conformance ID range (CRY-001..015). The acceptance
 * aggregator reads these rows from the v2 manifest and asserts each returns its
 * manifest `ok`/`code`.
 */
export const CRYSTAL_IDS: readonly string[] = Array.from(
  { length: 15 },
  (_v, i) => `CRY-${String(i + 1).padStart(3, "0")}`,
);

/**
 * Registered VC7A provider-identity conformance rows (PRO-016..023), continuing
 * VC5B's PRO-001..015. These pin the PROFILE half of crystal identity: a profile
 * or renderer bump must invalidate, and a profile-irrelevant change must not.
 */
export const CRYSTAL_PROVIDER_IDS: readonly string[] = Array.from(
  { length: 8 },
  (_v, i) => `PRO-${String(i + 16).padStart(3, "0")}`,
);

/** Named VC7A conformance assertions (the sprint's headline rows). */
export const CRYSTAL_NAMED_IDS = [
  "CRY-FRONTIER-001",
  "CRY-COVERED-002",
  "CRY-DEP-003",
] as const;

/** The two structured events the VC7A reporter emits. */
export type CrystalEventName =
  | "vector_cortex_crystal_written"
  | "vector_cortex_crystal_collision";

export type { DagSpan };
