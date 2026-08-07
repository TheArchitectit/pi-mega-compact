/**
 * api-contracts/repo-corpus.ts — REPO-A cross-repo corpus API contract.
 *
 * Reader-only shapes for GET /api/repo-corpus. The corpus manifest is written by
 * the CLI corpus-builder (scripts/repo-corpus/build.mjs) as a PSEUDONYMOUS
 * artifact — repo IDs/counts/digests/cross-repo-overlap descriptors only, never
 * payload content (EVAL-REDACT-002). The canonicalRemote→pseudonym mapping is a
 * pure in-memory function and never leaves the builder. No `any`.
 */

/** Derived endpoint status (from vc-status.ts). */
export type RepoCorpusStatus =
  | "live"
  | "awaiting_data"
  | "deferred"
  | "structural"
  | "off";

/** One pseudonymous repo in the corpus manifest. */
export interface RepoCorpusRepoV1 {
  readonly repoPseudonym: string;
  readonly sessions: number;
  readonly sessionIds: readonly string[];
  readonly events: number;
  /** SHA-256 over the repo's session-id slice + count (content-free). */
  readonly digest: string;
}

/** A recorded cross-repo session overlap descriptor (IDs only, never text). */
export interface RepoCorpusOverlapV1 {
  readonly repoA: string;
  readonly repoB: string;
  readonly sharedSessions: number;
  readonly sharedIds: readonly string[];
}

/** The corpus manifest the builder emits (pseudonymous). */
export interface RepoCorpusManifestV1 {
  readonly schema: "repo-corpus-manifest-v1";
  readonly ownerPseudonym: string;
  readonly datasetVersion: string;
  readonly effectiveSeq: number;
  readonly totalEvents: number;
  readonly repos: readonly RepoCorpusRepoV1[];
  readonly overlaps: readonly RepoCorpusOverlapV1[];
}

/** Per-repo consent state projection used by the reader route (pseudonymous). */
export interface RepoCorpusConsentStateV1 {
  readonly schema: "repo-corpus-consent-state-v1";
  readonly perRepo: readonly RepoCorpusConsentRowV1[];
}

/** One repo's consent row (never payload content). */
export interface RepoCorpusConsentRowV1 {
  readonly repoPseudonym: string;
  readonly consentedCrossRepo: boolean;
  readonly revokedAt?: string;
}

/** Per-repo status row in RepoCorpusStatusV1. */
export interface RepoCorpusPerRepoStatusV1 {
  readonly repoPseudonym: string;
  readonly sessions: number;
  readonly consentedCrossRepo: boolean;
  readonly revokedAt?: string;
}

/** Response body for GET /api/repo-corpus. */
export interface RepoCorpusStatusV1 {
  readonly schema: "repo-corpus-status-v1";
  readonly corpus: RepoCorpusManifestV1 | null;
  readonly perRepo: readonly RepoCorpusPerRepoStatusV1[];
  readonly totalEvents: number;
  readonly status: RepoCorpusStatus;
}
