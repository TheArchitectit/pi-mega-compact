/**
 * dashboard-client/src/tabs/EventsTab.tsx — Events tab (C1).
 *
 * Live SSE event stream via useSSE + EventStream with type filters.
 * Shows connection status + event count.
 */

import type React from "react";
import { useSSE } from "../hooks/useSSE";
import { EventStream } from "../components/EventStream";

export default function EventsTab(): React.ReactElement {
	const { events, status, eventCount } = useSSE();

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
			<EventStream events={events} />
		</div>
	);
}
