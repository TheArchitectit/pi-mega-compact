/**
 * dashboard-client/src/types/repo-corpus.ts — REPO-A client view types.
 *
 * Reader-only consent status card view. The live API payload is the server
 * contract RepoCorpusStatusV1 (imported via @contracts); these types shape the
 * card's rendering of one repo's consent state — counts + IDs + status only,
 * never payload content (EVAL-REDACT-002).
 */

/** One repo's consent status row rendered by the card. */
export interface RepoCorpusCardRow {
  readonly repoPseudonym: string;
  readonly sessions: number;
  readonly consentedCrossRepo: boolean;
  readonly revokedAt?: string;
}

/** Card-level rendering state derived from the live status. */
export interface RepoCorpusCardView {
  readonly present: boolean; // a corpus manifest exists
  readonly totalEvents: number;
  readonly repos: readonly RepoCorpusCardRow[];
  readonly overlapCount: number;
  readonly status: string; // live / awaiting_data / off — never empty
}
