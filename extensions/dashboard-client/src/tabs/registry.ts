import type { LucideIcon } from "lucide-react";
import {
  LayoutGrid,
  Database,
  MessagesSquare,
  GitBranch,
  HeartPulse,
  FolderGit2,
  ScrollText,
  Settings,
  BarChart3,
  BookOpen,
  Wrench,
  Network,
  Activity,
} from "lucide-react";

export type TabId =
  | "overview"
  | "repos"
  | "events"
  | "setup"
  | "metrics"
  | "cache"
  | "sessions"
  | "wiki"
  | "turns"
  | "maintenance"
  | "memory-map"
  | "health"
  | "vector-cortex";

export interface TabDef {
  id: TabId;
  label: string;
  icon: LucideIcon;
}

export const PRIMARY_TABS: TabDef[] = [
  { id: "overview", label: "Overview", icon: LayoutGrid },
  { id: "cache", label: "Cache", icon: Database },
  { id: "sessions", label: "Sessions", icon: MessagesSquare },
  { id: "turns", label: "Turns", icon: GitBranch },
  { id: "health", label: "Health", icon: HeartPulse },
];

export const ADVANCED_TABS: TabDef[] = [
  { id: "repos", label: "Repos", icon: FolderGit2 },
  { id: "events", label: "Events", icon: ScrollText },
  { id: "setup", label: "Setup", icon: Settings },
  { id: "metrics", label: "Metrics", icon: BarChart3 },
  { id: "wiki", label: "Wiki", icon: BookOpen },
  { id: "maintenance", label: "Maintenance", icon: Wrench },
  { id: "memory-map", label: "Memory Map", icon: Network },
  { id: "vector-cortex", label: "Vector Cortex", icon: Activity },
];

export const ADVANCED_TAB_IDS: ReadonlySet<TabId> = new Set(
  ADVANCED_TABS.map((t) => t.id),
);

/**
 * The fixed 7 dashboard navigation SURFACE ids from the DASH-0a merge plan
 * (plan.ts `DASHSurface`). These are the consolidated surfaces consumed by the
 * additive `tabs/index.ts` barrel. The existent 13-tab `TabId` union above is
 * LEFT UNCHANGED (rollback-safe) — this constant documents the 7 surfaces the
 * DASH-0d rewire will navigate, and deliberately does NOT replace TabId.
 */
export const DASH_SURFACE_IDS = [
  "overview",
  "sessions",
  "cache-perf",
  "memory-graph",
  "diagnostics",
  "setup",
  "admin",
] as const;

/** The fixed 7 consolidated navigational surface ids (DASH-0d navigation set).
 *  Distinct from the legacy 13-tab `TabId` union, which is retained for the
 *  flag-off (pre-rollup) surface set + the sidebar/AppShell nav types. */
export type DashTabId = (typeof DASH_SURFACE_IDS)[number];

/** Exactly 7 top-level navigational surfaces (DASH-0d tab-count contract). */
export const DASH_TAB_COUNT: number = DASH_SURFACE_IDS.length;

/**
 * DASH-0c: labels for the consolidated surfaces. Additive — the 13-tab
 * `PRIMARY_TABS`/`ADVANCED_TABS` labels above stay untouched (rollback-safe;
 * the live 13-tab UI renders as today until the DASH-0d rewire). `cache-perf`
 * takes the "Cache+Performance" label once MetricsTab folds in as a Performance
 * section; `admin` hosts the combined Maintenance+Config AdminTab.
 */
export const DASH_SURFACE_LABELS: Readonly<Record<string, string>> = {
  overview: "Overview",
  sessions: "Sessions",
  "cache-perf": "Cache+Performance",
  "memory-graph": "Memory Graph",
  diagnostics: "Diagnostics",
  setup: "Setup",
  admin: "Admin",
} as const;
