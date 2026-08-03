/**
 * dashboard-client/src/types/card.ts — Overview tab card identity + fixed order.
 *
 * Every card on the Overview grid maps to a stable CardId. The default order
 * is the canonical render order; the user can reorder via drag-and-drop and
 * their order is persisted by useCardPositions.
 */

/** Identifies each card on the Overview grid. */
export type CardId =
	| "trigger"
	| "vector"
	| "repo-all"
	| "data-safety"
	| "config"
	| "model"
	| "crew"
	| "cache-hits"
	| "time-saved"
	| "rag-health"
	| "legend";

/**
 * Canonical default order of the Overview cards, matching the pre-dnd render
 * order. Any persisted order must contain exactly these ids (no extras, no
 * missing) to be accepted.
 */
export const DEFAULT_CARD_ORDER: CardId[] = [
	"trigger",
	"vector",
	"repo-all",
	"data-safety",
	"config",
	"model",
	"crew",
	"cache-hits",
	"time-saved",
	"rag-health",
	"legend",
];
