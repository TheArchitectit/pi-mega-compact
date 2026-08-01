/**
 * dashboard-client/src/components/TabBar.tsx — tab navigation with Advanced collapse.
 *
 * PRIMARY_TABS are always visible. The remaining tabs collapse behind an
 * "Advanced" toggle button.
 */

import React, { useState } from "react";
import type { TabId } from "../App";

export interface TabBarProps {
	primaryTabs: Array<{ id: TabId; label: string }>;
	advancedTabs: Array<{ id: TabId; label: string }>;
	advancedTabIds: Set<TabId>;
	active: TabId;
	onTabChange: (id: TabId) => void;
}

export function TabBar({
	primaryTabs,
	advancedTabs,
	advancedTabIds,
	active,
	onTabChange,
}: TabBarProps): React.ReactElement {
	const [advancedOpen, setAdvancedOpen] = useState(
		() => advancedTabIds.has(active), // start open if an advanced tab is active
	);

	const isAdvancedActive = advancedTabIds.has(active);

	return (
		<nav className="tab-bar" role="tablist">
			{primaryTabs.map((tab) => (
				<button
					key={tab.id}
					type="button"
					role="tab"
					aria-selected={active === tab.id}
					className={active === tab.id ? "active" : ""}
					onClick={() => onTabChange(tab.id)}
				>
					{tab.label}
				</button>
			))}

			<button
				type="button"
				className="advanced-toggle"
				aria-expanded={advancedOpen}
				onClick={() => setAdvancedOpen((o) => !o)}
			>
				Advanced {advancedOpen ? "▲" : "▼"}
			</button>

			{advancedOpen && (
				<div className="advanced-tabs">
					{advancedTabs.map((tab) => (
						<button
							key={tab.id}
							type="button"
							role="tab"
							aria-selected={active === tab.id}
							className={
								active === tab.id ? "active" : ""
							}
							onClick={() => {
								onTabChange(tab.id);
								// Keep the panel open so users can browse.
							}}
						>
							{tab.label}
						</button>
					))}
				</div>
			)}
		</nav>
	);
}
