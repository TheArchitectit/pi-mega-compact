/**
 * dashboard-client/src/tabs/index.ts — additive tab barrel (DASH-0b).
 *
 * Re-exports the 7 fixed navigational SURFACE host components defined by the
 * DASH-0a merge plan (plan.ts `DASHSurface`). These map the consolidated
 * surfaces to their host components; DASH-0d rewires App.tsx's lazy list to
 * this barrel. THIS SPRINT App.tsx does NOT switch to it — the barrel is purely
 * additive and the break-native 13-tab surface keeps rendering as today.
 *
 * Host mapping (surface → component):
 *   - overview            → OverviewTab
 *   - sessions            → SessionsTab  (TurnsTab folded in via TurnMemoryView)
 *   - cache-perf          → CacheTab
 *   - memory-graph        → MemoryMapTab
 *   - diagnostics         → VectorCortexTab
 *   - setup               → SetupTab
 *   - admin               → AdminTab  (RESERVED alias — maps to the existent
 *                            MaintenanceTab; no standalone AdminTab.tsx yet)
 *
 * PREVENT-PI-004: imports only — no network. PREVENT-011: no `any`.
 */

export { default as OverviewTab } from "./OverviewTab";
export { default as SessionsTab } from "./SessionsTab";
export { default as CacheTab } from "./CacheTab";
export { default as MemoryMapTab } from "./MemoryMapTab";
export { default as VectorCortexTab } from "./VectorCortexTab";
export { default as SetupTab } from "./SetupTab";
/** Reserved admin-surface alias: maps to the existent MaintenanceTab host. */
export { default as AdminTab } from "./MaintenanceTab";
