/**
 * dashboard-client/src/App.tsx — Dashboard shell layout.
 *
 * SPRINT-B1: React scaffold with tab routing, header, error boundary.
 * SPRINT-C1+: tabs wired progressively with real content.
 * SPRINT-V2: NEW_UI flag splits OldDashboard (legacy) from NewDashboard (AppShell).
 * DASH-0d: the `TabContent` lazy list + switch consolidate onto the 7 fixed
 * navigational surfaces (Overview, Sessions, Cache+Performance, Memory Graph,
 * Diagnostics, Setup, Admin) behind MEGACOMPACT_DASH_0D. An additive hash router
 * maps every legacy #deep-link to a live consolidated surface. Flag-OFF
 * reproduces the pre-rollup 13-tab surface list byte-identically (the
 * DASH-0D-LEGACY region). The consolidated rendering is the DASH-0D-CONSOLIDATED
 * region — both are parsed by scripts/dash-tab-count.mjs.
 */

import React, { useState, useEffect, useCallback } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { TabBar } from "./components/TabBar";
import { LoadingSpinner } from "./components/LoadingSpinner";
import { useApi } from "./hooks/useApi";
import { fetchSnapshot, fetchSettings } from "./api/client";
import type { SnapshotResponse, SettingsResponse } from "@contracts";
import { NEW_UI } from "./config";
import { AppShell } from "./components/layout/AppShell";
import {
  PRIMARY_TABS,
  ADVANCED_TABS,
  ADVANCED_TAB_IDS as advancedTabIds,
  DASH_SURFACE_IDS,
  DASH_SURFACE_LABELS,
  type TabId,
  type DashTabId,
} from "./tabs/registry";
import { useHashTab } from "./tabs/dashHashRouter";
export type { TabId };

// Tab components — lazy-loaded. DASH-0d: the consolidated 7 host components come
// from the merged barrel homes; the 13 legacy-only components stay for flag-off.
const OverviewTab = React.lazy(() => import("./tabs/OverviewTab"));
const SessionsTab = React.lazy(() => import("./tabs/SessionsTab"));
const CacheTab = React.lazy(() => import("./tabs/CacheTab"));
const MemoryMapTab = React.lazy(() => import("./tabs/MemoryMapTab"));
const VectorCortexTab = React.lazy(() => import("./tabs/VectorCortexTab"));
const SetupTab = React.lazy(() => import("./tabs/SetupTab"));
const AdminTab = React.lazy(() => import("./tabs/AdminTab"));
// Legacy-only host components (flag-off pre-rollup surface set).
const ReposTab = React.lazy(() => import("./tabs/ReposTab"));
const EventsTab = React.lazy(() => import("./tabs/EventsTab"));
const MetricsTab = React.lazy(() => import("./tabs/MetricsTab"));
const WikiTab = React.lazy(() => import("./tabs/WikiTab"));
const TurnsTab = React.lazy(() => import("./tabs/TurnsTab"));
const MaintenanceTab = React.lazy(() => import("./tabs/MaintenanceTab"));
const HealthTab = React.lazy(() => import("./tabs/HealthTab"));

interface AppState {
  snapshot: SnapshotResponse | null;
  loading: boolean;
  error: Error | null;
}

const DASH_0D_KEY = "MEGACOMPACT_DASH_0D";

/**
 * Resolve the DASH-0d consolidation flag from the server-authoritative
 * `/api/rag-settings` state (the dashboard client has no `process` global).
 * Absent/not-yet-loaded => true (default ON), matching the server default.
 */
function dash0dEnabled(settings: SettingsResponse | null): boolean {
  if (!settings) return true;
  for (const cat of settings.categories) {
    for (const s of cat.settings) {
      if (s.key === DASH_0D_KEY && s.type === "boolean") return s.value === true;
    }
  }
  return true;
}

/** The unified active-tab state: a legacy 13-tab TabId OR a consolidated surface. */
type ActiveTab = TabId | DashTabId;

/** Consolidated 7-surface content (DASH-0d). Parsed by scripts/dash-tab-count.mjs. */
function ConsolidatedContent({
  activeTab,
  snapshot,
  loading,
  error,
}: AppState & { activeTab: DashTabId }): React.ReactElement {
  return (
    <React.Suspense fallback={<LoadingSpinner />}>
      {/* DASH-0D-CONSOLIDATED */}
      {activeTab === "overview" && (
        <OverviewTab snapshot={snapshot} loading={loading} error={error} />
      )}
      {activeTab === "sessions" && <SessionsTab />}
      {activeTab === "cache-perf" && <CacheTab />}
      {activeTab === "memory-graph" && <MemoryMapTab />}
      {activeTab === "diagnostics" && <VectorCortexTab />}
      {activeTab === "setup" && <SetupTab />}
      {activeTab === "admin" && <AdminTab />}
      {/* DASH-0D-CONSOLIDATED-END */}
    </React.Suspense>
  );
}

/** Pre-rollup 13-tab content (flag-off). Parsed by scripts/dash-tab-count.mjs. */
function LegacyContent({
  activeTab,
  snapshot,
  loading,
  error,
}: AppState & { activeTab: TabId }): React.ReactElement {
  return (
    <React.Suspense fallback={<LoadingSpinner />}>
      {/* DASH-0D-LEGACY */}
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
      {activeTab === "vector-cortex" && <VectorCortexTab />}
      {/* DASH-0D-LEGACY-END */}
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
          <LegacyContent activeTab={activeTab} snapshot={snapshot} loading={loading} error={error} />
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
  viewToggle,
}: AppState & {
  activeTab: TabId;
  setActiveTab: (id: TabId) => void;
  viewToggle?: React.ReactNode;
}): React.ReactElement {
  return (
    <ErrorBoundary>
      <AppShell active={activeTab} onTabChange={setActiveTab} snapshot={snapshot}>
        {viewToggle ? <div className="view-toggle-wrap">{viewToggle}</div> : null}
        <LegacyContent activeTab={activeTab} snapshot={snapshot} loading={loading} error={error} />
      </AppShell>
    </ErrorBoundary>
  );
}

/** DASH-0d consolidated 7-surface navigation rail (flag-ON New UI path). */
function ConsolidatedNav({
  active,
  onSelect,
}: {
  active: DashTabId;
  onSelect: (id: DashTabId) => void;
}): React.ReactElement {
  return (
    <nav className="consolidated-nav" role="tablist" aria-label="Dashboard surfaces">
      {DASH_SURFACE_IDS.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={active === id}
          className={active === id ? "active" : ""}
          onClick={() => onSelect(id)}
        >
          {DASH_SURFACE_LABELS[id] ?? id}
        </button>
      ))}
    </nav>
  );
}

export default function App(): React.ReactElement {
  const [activeTab, setActiveTab] = useState<ActiveTab>("overview");
  // DASH-0d consolidated 7-surface view is OPT-IN. The default is the full
  // NewDashboard layout (left Sidebar + mobile BottomBar, 13 tabs). A toggle
  // button (rendered when the consolidated code is available) lets the operator
  // switch to the minimal 7-surface view on demand.
  const [consolidatedView, setConsolidatedView] = useState(false);
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

  // Server-resolved DASH-0d flag (default ON when settings absent).
  const { data: settingsData } = useApi<SettingsResponse>(
    useCallback(() => fetchSettings(), []),
    { pollInterval: 0, maxRetries: 0 },
  );
  const dash0dOn = dash0dEnabled(settingsData);
  const canConsolidate = NEW_UI() && dash0dOn;

  // Additive hash→surface deep-link router: every legacy #hash maps to a live
  // consolidated surface; empty hash keeps current behavior (default overview).
  // Only active under the DASH-0d 7-surface rendering — flag-off keeps the
  // pre-rollup 13-tab behavior unchanged (hash ignored).
  const hashSurface = useHashTab();
  useEffect(() => {
    if (canConsolidate && consolidatedView && hashSurface != null)
      setActiveTab(hashSurface);
  }, [canConsolidate, consolidatedView, hashSurface]);

  // The toggle button renders inside both view headers when the consolidated
  // code is available. Default view = full (Sidebar+BottomBar); minimal = 7
  // surfaces.
  const ViewToggle = canConsolidate ? (
    <button
      type="button"
      className="view-toggle-btn"
      onClick={() => setConsolidatedView((v) => !v)}
      aria-pressed={consolidatedView}
      title={consolidatedView ? "Switch to full dashboard" : "Switch to minimal dashboard"}
    >
      {consolidatedView ? "Full view" : "Minimal view"}
    </button>
  ) : null;

  // Consolidated 7-surface view — OPT-IN via the toggle button above.
  if (canConsolidate && consolidatedView) {
    const current = DASH_SURFACE_IDS.includes(activeTab as DashTabId)
      ? (activeTab as DashTabId)
      : "overview";
    return (
      <ErrorBoundary>
        <div className="dashboard-app">
          <header className="dashboard-header">
            <h1>mega-compact dashboard <span className="tier">{snapshot?.tier ?? "unknown"}</span></h1>
            {ViewToggle}
          </header>
          <ConsolidatedNav active={current} onSelect={(id: DashTabId) => setActiveTab(id)} />
          <main className="dashboard-content">
            <ConsolidatedContent
              activeTab={current}
              snapshot={snapshot}
              loading={loading}
              error={error}
            />
          </main>
        </div>
      </ErrorBoundary>
    );
  }

  // Default view (full): always a legacy TabId (hash routing is gated on
  // canConsolidate && consolidatedView above, so activeTab stays a 13-tab id
  // here).
  const legacyTab = (activeTab as TabId) ?? "overview";

  if (NEW_UI()) {
    return (
      <NewDashboard
        activeTab={legacyTab}
        setActiveTab={(id: TabId) => setActiveTab(id)}
        snapshot={snapshot}
        loading={loading}
        error={error}
        viewToggle={ViewToggle}
      />
    );
  }

  return (
    <OldDashboard
      activeTab={legacyTab}
      setActiveTab={(id: TabId) => setActiveTab(id)}
      snapshot={snapshot}
      loading={loading}
      error={error}
    />
  );
}
