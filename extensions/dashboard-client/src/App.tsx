/**
 * dashboard-client/src/App.tsx — Dashboard shell layout.
 *
 * SPRINT-B1: React scaffold with tab routing, header, error boundary.
 * SPRINT-C1+: tabs wired progressively with real content.
 */

import React, { useState, useCallback } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { TabBar } from "./components/TabBar";
import { LoadingSpinner } from "./components/LoadingSpinner";
import { useApi } from "./hooks/useApi";
import { fetchSnapshot } from "./api/client";
import type { SnapshotResponse } from "@contracts";

// Tab components — lazy-loaded. C1 fills Overview + Events; C2/C3 fill the rest.
const OverviewTab = React.lazy(() => import("./tabs/OverviewTab"));
const ReposTab = React.lazy(() => import("./tabs/ReposTab"));
const EventsTab = React.lazy(() => import("./tabs/EventsTab"));
const ConfigTab = React.lazy(() => import("./tabs/ConfigTab"));
const SetupTab = React.lazy(() => import("./tabs/SetupTab"));
const MetricsTab = React.lazy(() => import("./tabs/MetricsTab"));
const CacheTab = React.lazy(() => import("./tabs/CacheTab"));
const GameTab = React.lazy(() => import("./tabs/GameTab"));
const AchievementsTab = React.lazy(() => import("./tabs/AchievementsTab"));
const SessionsTab = React.lazy(() => import("./tabs/SessionsTab"));
const TopicsTab = React.lazy(() => import("./tabs/TopicsTab"));
const TurnsTab = React.lazy(() => import("./tabs/TurnsTab"));
const MaintenanceTab = React.lazy(() => import("./tabs/MaintenanceTab"));
const MemoryMapTab = React.lazy(() => import("./tabs/MemoryMapTab"));
const HealthTab = React.lazy(() => import("./tabs/HealthTab"));

export type TabId =
	| "overview"
	| "repos"
	| "events"
	| "config"
	| "setup"
	| "metrics"
	| "cache"
	| "game"
	| "achievements"
	| "sessions"
	| "topics"
	| "turns"
	| "maintenance"
	| "memory-map"
	| "health";

type TabDef = { id: TabId; label: string };

const PRIMARY_TABS: TabDef[] = [
	{ id: "overview", label: "Overview" },
	{ id: "cache", label: "Cache" },
	{ id: "sessions", label: "Sessions" },
	{ id: "turns", label: "Turns" },
	{ id: "health", label: "Health" },
];

const ADVANCED_TABS: TabDef[] = [
	{ id: "repos", label: "Repos" },
	{ id: "events", label: "Events" },
	{ id: "config", label: "Config" },
	{ id: "setup", label: "Setup" },
	{ id: "metrics", label: "Metrics" },
	{ id: "game", label: "Game" },
	{ id: "achievements", label: "Achievements" },
	{ id: "topics", label: "Topics" },
	{ id: "maintenance", label: "Maintenance" },
	{ id: "memory-map", label: "Memory Map" },
];

const advancedTabIds = new Set<TabId>(ADVANCED_TABS.map((t) => t.id));

export default function App(): React.ReactElement {
	const [activeTab, setActiveTab] = useState<TabId>("overview");
	const {
		data: snapshot,
		loading,
		error,
	} = useApi<SnapshotResponse>(
		useCallback(() => fetchSnapshot(), []),
		{
			// Poll every 5s so Overview stays live without SSE. D1 will add retry/stale.
			pollInterval: 5000,
		},
	);

	const tier = snapshot?.tier ?? "unknown";
	const version = snapshot?.model?.name ?? "";

	return (
		<ErrorBoundary>
			<div className="dashboard-app">
				<header className="dashboard-header">
					<h1>
						mega-compact dashboard
						<span className="tier">{tier}</span>
						{version && <span className="version-pill">{version}</span>}
					</h1>
				</header>
				<TabBar
					primaryTabs={PRIMARY_TABS}
					advancedTabs={ADVANCED_TABS}
					advancedTabIds={advancedTabIds}
					active={activeTab}
					onTabChange={setActiveTab}
				/>
				<main className="dashboard-content">
					<React.Suspense fallback={<LoadingSpinner />}>
						{activeTab === "overview" && (
							<OverviewTab
								snapshot={snapshot}
								loading={loading}
								error={error}
							/>
						)}
						{activeTab === "repos" && <ReposTab />}
						{activeTab === "events" && <EventsTab />}
						{activeTab === "config" && <ConfigTab />}
						{activeTab === "setup" && <SetupTab />}
						{activeTab === "metrics" && <MetricsTab />}
						{activeTab === "cache" && <CacheTab />}
						{activeTab === "game" && <GameTab />}
						{activeTab === "achievements" && <AchievementsTab />}
						{activeTab === "sessions" && <SessionsTab />}
						{activeTab === "topics" && <TopicsTab />}
						{activeTab === "maintenance" && <MaintenanceTab />}
						{activeTab === "memory-map" && <MemoryMapTab />}
						{activeTab === "health" && <HealthTab />}
					</React.Suspense>
				</main>
			</div>
		</ErrorBoundary>
	);
}
