/**
 * dashboard-client/src/components/EventStream.tsx — SSE event list with filters.
 *
 * Type badge colored by event type. Timestamp + expandable detail row.
 * Type filter chips (all + per-type). Virtualization: manual windowing for
 * 500+ events (render last N visible).
 */

import type React from "react";
import { useState, useMemo } from "react";
import type { SseEvent } from "@contracts";

export interface EventStreamProps {
	events: SseEvent[];
}

const TYPE_COLORS: Record<string, string> = {
	compact_start: "ev-compact",
	compact_end: "ev-compact",
	compact_trigger: "ev-trigger",
	compact_skip: "ev-trigger",
	tier_changed: "ev-tier",
	model_changed: "ev-tier",
	pressure_lifted: "ev-tier",
	checkpoint_persisted: "ev-checkpoint",
	recall_inject: "ev-recall",
	anchors_updated: "ev-recall",
	config_updated: "ev-config",
	config_preset: "ev-config",
	crew_presence_changed: "ev-crew",
	crew_turn_changed: "ev-crew",
	crew_bandit_chosen: "ev-crew",
	game_ritual_start: "ev-game",
	game_ritual_stage: "ev-game",
	game_ritual_end: "ev-game",
	game_mode_changed: "ev-game",
	game_render: "ev-game",
};

// Filterable event types (spec: compact_start/end, recall_inject, checkpoint_persisted + all).
const FILTER_TYPES = [
	"all",
	"compact_start",
	"compact_end",
	"recall_inject",
	"checkpoint_persisted",
] as const;
type FilterType = (typeof FILTER_TYPES)[number];

const RENDER_WINDOW = 200; // render last 200 to keep DOM light under 500+ events

function summarize(ev: SseEvent): string {
	switch (ev.type) {
		case "compact_start":
			return `trigger=${ev.trigger} session=${ev.sessionId.slice(0, 8)}`;
		case "compact_end":
			return `freed=${ev.tokensFreed} ok=${ev.success} cp=${ev.checkpointId.slice(0, 8)}`;
		case "compact_trigger":
			return `pressure=${ev.pressure}% threshold=${ev.threshold}% armed=${ev.armed}`;
		case "compact_skip":
			return `reason=${ev.reason}`;
		case "tier_changed":
			return `${ev.from} → ${ev.to} ctx=${ev.contextPct}%`;
		case "model_changed":
			return `${ev.providerName}/${ev.model}`;
		case "pressure_lifted":
			return `${ev.beforePct}% → ${ev.afterPct}%`;
		case "checkpoint_persisted":
			return `cp=${ev.checkpointId.slice(0, 8)} sessionTok=${ev.sessionTokens}`;
		case "recall_inject":
			return `q="${ev.query.slice(0, 40)}" chunks=${ev.chunks} tok=${ev.tokens}`;
		case "anchors_updated":
			return `count=${ev.count} pinned=${ev.pinned}`;
		case "config_updated":
			return `key=${ev.key}`;
		case "config_preset":
			return `preset=${ev.preset}`;
		case "crew_presence_changed":
			return `agents=${ev.activeAgents} turn=${ev.currentTurn}`;
		case "crew_turn_changed":
			return `turn=${ev.turnIndex} agent=${ev.agentName}`;
		case "crew_bandit_chosen":
			return `agent=${ev.chosenAgent} score=${ev.score} regret=${ev.regret}`;
		case "game_ritual_start":
		case "game_ritual_stage":
		case "game_ritual_end":
		case "game_mode_changed":
		case "game_render":
			return `stage=${ev.type}`;
	}
}

function formatTs(ts: string): string {
	try {
		const d = new Date(ts);
		return d.toLocaleTimeString();
	} catch {
		return ts;
	}
}

export function EventStream({ events }: EventStreamProps): React.ReactElement {
	const [filter, setFilter] = useState<FilterType>("all");
	const [expanded, setExpanded] = useState<number | null>(null);

	const filtered = useMemo(() => {
		const list =
			filter === "all" ? events : events.filter((e) => e.type === filter);
		// Newest first; render only the last RENDER_WINDOW to keep DOM light.
		return list.slice(-RENDER_WINDOW).reverse();
	}, [events, filter]);

	return (
		<div className="event-stream">
			<div className="event-filters" role="toolbar">
				{FILTER_TYPES.map((t) => (
					<button
						key={t}
						type="button"
						className={`filter-chip ${filter === t ? "active" : ""}`}
						onClick={() => setFilter(t)}
					>
						{t === "all" ? "all" : t.replace(/_/g, " ")}
					</button>
				))}
				<span className="event-count">{events.length} buffered</span>
			</div>
			<ul className="event-list">
				{filtered.length === 0 && (
					<li className="event-empty">No events yet.</li>
				)}
				{filtered.map((ev, idx) => {
					const cls = TYPE_COLORS[ev.type] ?? "ev-default";
					return (
						<li
							key={`${ev.ts}-${idx}`}
							className={`event-row ${cls}`}
							onClick={() => setExpanded(expanded === idx ? null : idx)}
						>
							<span className="ev-time">{formatTs(ev.ts)}</span>
							<span className="ev-type">{ev.type}</span>
							<span className="ev-summary">{summarize(ev)}</span>
							{expanded === idx && (
								<pre className="ev-detail">{JSON.stringify(ev, null, 2)}</pre>
							)}
						</li>
					);
				})}
			</ul>
		</div>
	);
}
