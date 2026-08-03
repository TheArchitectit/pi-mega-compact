/**
 * dashboard-client/src/App.tsx — Dashboard shell layout.
 *
 * SPRINT-B1: React scaffold with tab routing, header, error boundary.
 * SPRINT-C1+: tabs wired progressively with real content.
 * SPRINT-V2: NEW_UI flag splits OldDashboard (legacy) from NewDashboard (AppShell).
 */

import React, { useState, useCallback } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { TabBar } from "./components/TabBar";
import { LoadingSpinner } from "./components/LoadingSpinner";
import { useApi } from "./hooks/useApi";
import { fetchSnapshot } from "./api/client";
import type { SnapshotResponse } from "@contracts";
import { NEW_UI } from "./config";
import { AppShell } from "./components/layout/AppShell";
import {
  PRIMARY_TABS,
  ADVANCED_TABS,
  ADVANCED_TAB_IDS as advancedTabIds,
  type TabId,
} from "./tabs/registry";
export type { TabId };

// Tab components — lazy-loaded. C1 fills Overview + Events; C2/C3 fill the rest.
const OverviewTab = React.lazy(() => import("./tabs/OverviewTab"));
const ReposTab = React.lazy(() => import("./tabs/ReposTab"));
const EventsTab = React.lazy(() => import("./tabs/EventsTab"));
const SetupTab = React.lazy(() => import("./tabs/SetupTab"));
const MetricsTab = React.lazy(() => import("./tabs/MetricsTab"));
const CacheTab = React.lazy(() => import("./tabs/CacheTab"));
const SessionsTab = React.lazy(() => import("./tabs/SessionsTab"));
const WikiTab = React.lazy(() => import("./tabs/WikiTab"));
const TurnsTab = React.lazy(() => import("./tabs/TurnsTab"));
const MaintenanceTab = React.lazy(() => import("./tabs/MaintenanceTab"));
const MemoryMapTab = React.lazy(() => import("./tabs/MemoryMapTab"));
const HealthTab = React.lazy(() => import("./tabs/HealthTab"));

interface AppState {
  snapshot: SnapshotResponse | null;
  loading: boolean;
  error: Error | null;
}

function TabContent({
  activeTab,
  snapshot,
  loading,
  error,
}: AppState & { activeTab: TabId }): React.ReactElement {
  return (
    <React.Suspense fallback={<LoadingSpinner />}>
      {activeTab === "overview" && (
        <OverviewTab snapshot={snapshot} loading={loading} error={error} />
      )}
      {activeTab === "repos" && <ReposTab />}
      {activeTab === "events" && <EventsTab />}
      {activeTab === "setup" && <SetupTab />}
      {activeTab === "metrics" && <MetricsTab />}
      {activeTab === "cache" && <CacheTab />}
      {activeTab === "sessions" && <SessionsTab />}
      {activeTab === "wiki" && <WikiTab />}
      {activeTab === "turns" && <TurnsTab />}
      {activeTab === "maintenance" && <MaintenanceTab />}
      {activeTab === "memory-map" && <MemoryMapTab />}
      {activeTab === "health" && <HealthTab />}
    </React.Suspense>
  );
}

function OldDashboard({
  activeTab,
  setActiveTab,
  snapshot,
  loading,
  error,
}: AppState & {
  activeTab: TabId;
  setActiveTab: (id: TabId) => void;
}): React.ReactElement {
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
          <TabContent activeTab={activeTab} snapshot={snapshot} loading={loading} error={error} />
        </main>
      </div>
    </ErrorBoundary>
  );
}

function NewDashboard({
  activeTab,
  setActiveTab,
  snapshot,
  loading,
  error,
}: AppState & {
  activeTab: TabId;
  setActiveTab: (id: TabId) => void;
}): React.ReactElement {
  return (
    <ErrorBoundary>
      <AppShell active={activeTab} onTabChange={setActiveTab} snapshot={snapshot}>
        <TabContent activeTab={activeTab} snapshot={snapshot} loading={loading} error={error} />
      </AppShell>
    </ErrorBoundary>
  );
}

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

  if (NEW_UI()) {
    return (
      <NewDashboard
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        snapshot={snapshot}
        loading={loading}
        error={error}
      />
    );
  }

  return (
    <OldDashboard
      activeTab={activeTab}
      setActiveTab={setActiveTab}
      snapshot={snapshot}
      loading={loading}
      error={error}
    />
  );
}
