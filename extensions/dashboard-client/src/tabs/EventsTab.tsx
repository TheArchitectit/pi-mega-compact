/**
 * dashboard-client/src/tabs/EventsTab.tsx — Events tab (C1).
 *
 * Live SSE event stream via useSSE + EventStream with category filter chips.
 * Shows connection status + event count. Category filter uses the existing
 * EventCategoryFilter component to filter by all/compact/recall/config/crew/game.
 */

import type React from "react";
import { useState, useMemo } from "react";
import type { SseEvent } from "@contracts";
import { useSSE } from "../hooks/useSSE";
import { EventStream } from "../components/EventStream";
import {
	EventCategoryFilter,
	type EventCategory,
} from "../components/EventCategoryFilter";

const COMPACT_TYPES = new Set([
	"compact_start",
	"compact_end",
	"compact_trigger",
	"compact_skip",
]);
const CONFIG_TYPES = new Set([
	"config_updated",
	"config_preset",
	"tier_changed",
	"model_changed",
	"pressure_lifted",
	"anchors_updated",
	"checkpoint_persisted",
]);
const CREW_TYPES = new Set([
	"crew_presence_changed",
	"crew_turn_changed",
	"crew_bandit_chosen",
]);
const GAME_TYPES = new Set([
	"game_ritual_start",
	"game_ritual_stage",
	"game_ritual_end",
	"game_mode_changed",
	"game_render",
]);

function matchesCategory(ev: SseEvent, cat: EventCategory): boolean {
	if (cat === "all") return true;
	const t = ev.type;
	if (cat === "compact") return COMPACT_TYPES.has(t);
	if (cat === "recall") return t === "recall_inject";
	if (cat === "config") return CONFIG_TYPES.has(t);
	if (cat === "crew") return CREW_TYPES.has(t);
	return GAME_TYPES.has(t); // cat === "game"
}

export default function EventsTab(): React.ReactElement {
	const { events, status, eventCount } = useSSE();
	const [category, setCategory] = useState<EventCategory>("all");

	const filtered = useMemo(
		() => events.filter((e) => matchesCategory(e, category)),
		[events, category],
	);

	const statusCls = `sse-status sse-${status}`;
	const statusLabel =
		status === "connected"
			? "connected"
			: status === "connecting"
				? "connecting…"
				: status === "error"
					? "error"
					: "disconnected";

	return (
		<div className="events-tab">
			<div className="events-header">
				<span className={statusCls} role="status">
					<span className="sse-dot" aria-hidden="true" />
					{statusLabel}
				</span>
				<span className="event-count">{eventCount} events received</span>
			</div>
			<EventCategoryFilter active={category} onFilter={setCategory} />
			<EventStream events={filtered} />
		</div>
	);
}
