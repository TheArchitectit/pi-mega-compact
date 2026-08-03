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
  | "health";

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
];

export const ADVANCED_TAB_IDS: ReadonlySet<TabId> = new Set(
  ADVANCED_TABS.map((t) => t.id),
);
