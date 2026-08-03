/**
 * dashboard-client/src/components/EventCategoryFilter.tsx
 *
 * Category-level filter chips for the Events tab. Filters SSE events by
 * category: all / compact / recall / config / crew / game.
 */

import type React from "react";
import { Toggle } from "../components/ui/toggle";

export type EventCategory =
	| "all"
	| "compact"
	| "recall"
	| "config"
	| "crew"
	| "game";

const CATEGORIES: readonly EventCategory[] = [
	"all",
	"compact",
	"recall",
	"config",
	"crew",
	"game",
] as const;

export interface EventCategoryFilterProps {
	/** Currently active category. */
	active: EventCategory;
	/** Called when the user selects a category. */
	onFilter: (category: EventCategory) => void;
}

export function EventCategoryFilter({
	active,
	onFilter,
}: EventCategoryFilterProps): React.ReactElement {
	return (
		<div className="flex flex-wrap gap-2" role="toolbar" aria-label="Event category filter">
			{CATEGORIES.map((cat) => (
				<Toggle
					key={cat}
					pressed={active === cat}
					onClick={() => onFilter(cat)}
				>
					{cat}
				</Toggle>
			))}
		</div>
	);
}
