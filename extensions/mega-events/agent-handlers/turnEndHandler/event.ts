/**
 * turnEndHandler/event.ts — structural shape of the pi `turn_end` event.
 *
 * Shared by the turnEndHandler helpers so each stays agnostic of the full
 * event shape.
 */

/** Structural shape of the pi `turn_end` event used by this handler. */
export interface TurnEndEvent {
	turnIndex: number;
	message: {
		role?: string;
		content?: unknown;
		stopReason?: string;
	};
}
