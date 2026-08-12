/**
 * dashboard-client/src/tabs/dashHashRouter.ts — DASH-0d additive hash→surface
 * deep-link router.
 *
 * The dashboard has historically had NO URL-routing (single `useState<TabId>
 * ("overview")` in App.tsx). DASH-0d adds an ADDITIVE hash listener so every
 * legacy deep link (e.g. `#turns`, `#metrics`, `#repos`) still lands on a live
 * consolidated surface, and an empty hash keeps the current behavior (the
 * caller's default tab). It does NOT replace the existing tab state — App.tsx
 * keeps `useState` and this hook only *points* at a surface when the hash maps
 * to one.
 *
 * Mapping (DASH-0a `DEEP_LINK_TARGETS` + the DASH-0d release set):
 *   #sessions, #turns          → sessions
 *   #cache, #metrics           → cache-perf
 *   #repos, #wiki, #memory-map → memory-graph
 *   #events, #health, #vector-cortex → diagnostics
 *   #maintenance, #config      → admin
 *   #setup, #overview          → themselves
 *   (empty)                    → null (current behavior)
 *
 * PREVENT-PI-004: browser `location` + `hashchange` only — no network.
 * PREVENT-011: no `any`. Pure client view concern; no endpoint reads added.
 */

import { useEffect, useState } from "react";
import type { DashTabId, TabId } from "./registry";

/**
 * The consolidated surface a legacy hash resolves to. Every key is a legacy
 * deep-link fragment mapped onto the fixed 7 surfaces. `config`/`setup`/
 * `overview` are explicit release aliases so no old bookmark goes dead.
 */
export const HASH_TO_SURFACE: Readonly<Record<string, DashTabId>> = {
  overview: "overview",
  sessions: "sessions",
  turns: "sessions",
  cache: "cache-perf",
  metrics: "cache-perf",
  "memory-map": "memory-graph",
  repos: "memory-graph",
  wiki: "memory-graph",
  "vector-cortex": "diagnostics",
  events: "diagnostics",
  health: "diagnostics",
  setup: "setup",
  config: "admin",
  maintenance: "admin",
};

/** Resolve the current `location.hash` to a consolidated surface (null if empty). */
export function resolveHashToSurface(hash: string): DashTabId | null {
  const clean = hash.replace(/^#/, "").trim();
  if (!clean) return null;
  const surface = HASH_TO_SURFACE[clean];
  return surface ?? null;
}

/**
 * Full-view legacy hash→tab resolver. In the default (non-consolidated) view,
 * `activeTab` is a 13-tab `TabId` — most hash values ARE valid legacy tab ids
 * (e.g. `#metrics` → `"metrics"`), except `#config` which has no standalone
 * legacy tab and maps to `maintenance` (the admin surface).
 */
export const HASH_TO_LEGACY_TAB: Readonly<Record<string, TabId>> = {
	overview: "overview",
	sessions: "sessions",
	turns: "turns",
	cache: "cache",
	metrics: "metrics",
	repos: "repos",
	wiki: "wiki",
	"memory-map": "memory-map",
	events: "events",
	health: "health",
	"vector-cortex": "vector-cortex",
	maintenance: "maintenance",
	setup: "setup",
	config: "maintenance", // no standalone legacy config tab → admin surface
};

/** Resolve the current `location.hash` to a legacy 13-tab id (null if empty/unmapped). */
export function resolveHashToLegacyTab(hash: string): TabId | null {
	const clean = hash.replace(/^#/, "").trim();
	if (!clean) return null;
	return HASH_TO_LEGACY_TAB[clean] ?? null;
}

/**
 * Additive hash listener. Returns the consolidated `DashTabId` the current
 * `location.hash` maps to, or `null` when the hash is empty (current behavior)
 * or unmapped. Re-syncs whenever the hash changes.
 */
export function useHashTab(): DashTabId | null {
  const [surface, setSurface] = useState<DashTabId | null>(() =>
    resolveHashToSurface(window.location.hash),
  );

  useEffect(() => {
    const onHashChange = () => setSurface(resolveHashToSurface(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return surface;
}
