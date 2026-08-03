/**
 * dashboard-client/src/hooks/useCardPositions.ts — persisted, deterministic
 * card order for the Overview tab.
 *
 * The order is read from localStorage on mount, validated against
 * DEFAULT_CARD_ORDER (must contain exactly the same CardIds — no missing,
 * no extras — and no duplicate ids), and falls back to the default if invalid.
 * Pure deterministic: no Date.now() / Math.random() anywhere.
 */
import { useCallback, useState } from "react";
import type { CardId } from "../types/card";
import { DEFAULT_CARD_ORDER } from "../types/card";

const STORAGE_KEY = "mega-compact-card-order";

/** Returns true when `ids` is a valid permutation of DEFAULT_CARD_ORDER. */
function isValidOrder(ids: unknown): ids is CardId[] {
	if (!Array.isArray(ids)) return false;
	if (ids.length !== DEFAULT_CARD_ORDER.length) return false;

	const expected = new Set<CardId>(DEFAULT_CARD_ORDER);
	const seen = new Set<CardId>();

	for (const id of ids) {
		// every entry must be a known CardId
		if (typeof id !== "string" || !expected.has(id as CardId)) return false;
		// no duplicates
		if (seen.has(id as CardId)) return false;
		seen.add(id as CardId);
	}
	return true;
}

/** Loads a persisted order from localStorage, validating it first. */
function loadOrder(): CardId[] {
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (raw == null) return DEFAULT_CARD_ORDER;
		const parsed: unknown = JSON.parse(raw);
		return isValidOrder(parsed) ? parsed : DEFAULT_CARD_ORDER;
	} catch {
		return DEFAULT_CARD_ORDER;
	}
}

export interface UseCardPositionsResult {
	order: CardId[];
	moveCard: (id: CardId, overId: CardId) => void;
}

export function useCardPositions(): UseCardPositionsResult {
	const [order, setOrder] = useState<CardId[]>(loadOrder);

	const moveCard = useCallback((id: CardId, overId: CardId) => {
		setOrder((prev) => {
			const from = prev.indexOf(id);
			const to = prev.indexOf(overId);
			if (from === -1 || to === -1 || from === to) return prev;

			const next = [...prev];
			next.splice(from, 1);
			next.splice(to, 0, id);
			try {
				window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
			} catch {
				// storage unavailable (private mode / quota) — ignore; order
				// still holds for the session
			}
			return next;
		});
	}, []);

	return { order, moveCard };
}
