/**
 * dash-consolidation/plan.ts — DASH-0a typed merge plan for the dashboard.
 *
 * Contract-planning only: this module records, as concrete data structures, the
 * collapse of the 13 current dashboard TabIds onto the fixed 7 navigational
 * surfaces (Overview, Sessions, Cache+Performance, Memory Graph, Diagnostics,
 * Setup, Admin). The shell (App.tsx), the lazy list, and every tab/section
 * component are untouched by this sprint — DASH-0b/0c consume this plan to
 * move components, DASH-0d wires deep links + a11y hooks against it.
 *
 * All constants are `readonly`; no `any`. Imports only the TabId union (never
 * redefined locally) so the plan can never drift from the live registry.
 */
import type { TabId } from "../tabs/registry";

/** The fixed 7 dashboard navigation surfaces. */
export type DASHSurface =
  | "overview"
  | "sessions"
  | "cache-perf"
  | "memory-graph"
  | "diagnostics"
  | "setup"
  | "admin";

/** A source TabId the plan records as kept-but-not-a-surface (legacy section). */
export interface LegacySection {
  id: TabId | "topics" | "achievements" | "game";
  disposition: "keep_but_listed_under";
  keep_but_listed_under: DASHSurface;
}

/** One row of the per-surface merge plan. */
export interface DashSurfacePlan {
  surface: DASHSurface;
  label: string;
  /** Current top-level TabIds folded into this surface. */
  sources: readonly TabId[];
  /** Delegate component/card ids that land on this surface. */
  mergedCardIds: readonly string[];
  /** Setup-only: the existent SetupTab SUB_TABS member ids (under setup, NOT admin). */
  setup_subtabs?: readonly string[];
}

/** The 7-surface merge plan keyed by surface id. */
export const DASH_TAB_PLAN: readonly DashSurfacePlan[] = [
  {
    surface: "overview",
    label: "Overview",
    sources: ["overview"],
    mergedCardIds: [],
  },
  {
    surface: "sessions",
    label: "Sessions",
    sources: ["sessions", "turns"],
    mergedCardIds: [],
  },
  {
    surface: "cache-perf",
    label: "Cache + Performance",
    sources: ["cache", "metrics"],
    mergedCardIds: [],
  },
  {
    surface: "memory-graph",
    label: "Memory Graph",
    sources: ["memory-map", "repos", "wiki"],
    mergedCardIds: [
      "MemoryMapView",
      "RaptorTreeView",
      "WikiPage",
      "WikiPageControls",
      "TopicTimeline",
      "TopicEvolutionView",
      "TopicEvolutionGraph",
    ],
  },
  {
    surface: "diagnostics",
    label: "Diagnostics",
    sources: ["vector-cortex", "events", "health"],
    mergedCardIds: [
      "VectorCortexDiagnosticsCard",
      "VectorCortexClosureCard",
      "VectorCortexCrystalsCard",
      "VectorCortexEconomicsCard",
      "VectorCortexLedgerCard",
      "VectorCortexOutcomesCard",
      "VectorCortexPlansCard",
      "VectorCortexPlatformCard",
      "VectorCortexPolicyCard",
      "VectorCortexRenderCard",
      "VectorCortexRepairCard",
      "VectorCortexRestoreCard",
      "VectorCortexRolloutCard",
      "VectorCortexShardsCard",
      "VectorCortexTopologyCard",
    ],
  },
  {
    surface: "setup",
    label: "Setup",
    sources: ["setup"],
    mergedCardIds: [
      "SettingsPanel",
      "SettingsSection",
      "ThresholdsPanel",
      "CortexSetup",
      "EmbedderSetup",
      "CortexActionsCard",
      "CortexBlockersCard",
      "CortexEncoderCard",
      "CortexRuntimeCard",
      "EmbedderHealthCard",
      "RagHealthCard",
      "CustomEndpointSection",
      "VectorCortexCosineFpCard",
      "VectorCortexRepoCorpusCard",
    ],
    // The existent SetupTab SUB_TABS member — recorded under Setup, NOT admin.
    setup_subtabs: ["config"],
  },
  {
    surface: "admin",
    label: "Admin",
    sources: ["maintenance"],
    mergedCardIds: [
      "ActionsCard",
      "DbStatsCard",
      "DebugBundleCard",
      "HealthMitigationCard",
      "SchemaHealthCard",
    ],
  },
];

/** Exactly 7 fixed surfaces. */
export const DASH_TAB_COUNT = 7;

/**
 * Legacy sections rendered today that are kept-but-folded under a surface.
 * One explicit bucket per non-surface tab/section so the audit stays total.
 */
export const DASH_LEGACY_SECTIONS: readonly LegacySection[] = [
  { id: "topics", disposition: "keep_but_listed_under", keep_but_listed_under: "admin" },
  { id: "achievements", disposition: "keep_but_listed_under", keep_but_listed_under: "admin" },
  { id: "game", disposition: "keep_but_listed_under", keep_but_listed_under: "admin" },
];

/** Old route -> new { surface, sub-tab hint } map, one entry per current TabId.
 *  Feeds the DASH-0d hash router; does not change App.tsx routing this sprint. */
export const DEEP_LINK_TARGETS: Readonly<Record<TabId, { surface: DASHSurface; subTabHint: string }>> = {
  overview: { surface: "overview", subTabHint: "overview" },
  sessions: { surface: "sessions", subTabHint: "session-list" },
  turns: { surface: "sessions", subTabHint: "turn-list" },
  cache: { surface: "cache-perf", subTabHint: "cache-cards" },
  metrics: { surface: "cache-perf", subTabHint: "perf-cards" },
  "memory-map": { surface: "memory-graph", subTabHint: "memory-map" },
  repos: { surface: "memory-graph", subTabHint: "repo-list" },
  wiki: { surface: "memory-graph", subTabHint: "wiki" },
  "vector-cortex": { surface: "diagnostics", subTabHint: "cortex" },
  events: { surface: "diagnostics", subTabHint: "event-log" },
  health: { surface: "diagnostics", subTabHint: "health" },
  setup: { surface: "setup", subTabHint: "settings" },
  maintenance: { surface: "admin", subTabHint: "maintenance" },
};

/** One a11y landmark row per fixed surface (DASH-0d axe-hook contract).
 *  No ARIA markup is emitted this sprint — this constant IS the contract. */
export interface NavMapRow {
  surface: DASHSurface;
  navLabel: string;
  subNavLabel: string | null;
}

export const DASH_NAV_MAP: readonly NavMapRow[] = [
  { surface: "overview", navLabel: "Overview", subNavLabel: null },
  { surface: "sessions", navLabel: "Session windows", subNavLabel: "Session turns" },
  { surface: "cache-perf", navLabel: "Performance cards", subNavLabel: "Cache status" },
  { surface: "memory-graph", navLabel: "Memory graph", subNavLabel: "Wiki + repos" },
  { surface: "diagnostics", navLabel: "Diagnostics groups", subNavLabel: "Event + health" },
  { surface: "setup", navLabel: "Setup", subNavLabel: "Sub-tabs" },
  { surface: "admin", navLabel: "Admin", subNavLabel: "Maintenance" },
];

/** Per-surface responsive plan: column strategy + sub-tab toggle collapse.
 *  All grids stay `grid-cols-1 md:grid-cols-3`, matching existent card grids;
 *  below `sm` sub-tab toggles collapse to a horizontal scroll region. */
export interface ResponsivePlan {
  surface: DASHSurface;
  grid: "grid-cols-1 md:grid-cols-3";
  subTabCollapseBelow: "sm";
}

export const DASH_RESPONSIVE: readonly ResponsivePlan[] = DASH_TAB_PLAN.map((p) => ({
  surface: p.surface,
  grid: "grid-cols-1 md:grid-cols-3",
  subTabCollapseBelow: "sm",
}));
