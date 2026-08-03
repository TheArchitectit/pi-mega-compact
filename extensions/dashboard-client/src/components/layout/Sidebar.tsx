import { useEffect, useState } from "react";
import { ChevronDown, Sparkles } from "lucide-react";
import { cn } from "../../utils/cn";
import {
  PRIMARY_TABS,
  ADVANCED_TABS,
  ADVANCED_TAB_IDS,
  type TabId,
} from "../../tabs/registry";
import { Badge } from "../ui/badge";

interface SidebarProps {
  active: TabId;
  onTabChange: (id: TabId) => void;
}

export function Sidebar({ active, onTabChange }: SidebarProps) {
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(
    () => ADVANCED_TAB_IDS.has(active),
  );

  // Keep the advanced section expanded whenever the active tab is advanced,
  // regardless of how the navigation happened (tab click, cross-device recalc).
  useEffect(() => {
    if (ADVANCED_TAB_IDS.has(active)) setAdvancedOpen(true);
  }, [active]);

  const Tile = ({ tab }: { tab: (typeof PRIMARY_TABS)[number] }) => {
    const Icon = tab.icon;
    const isActive = active === tab.id;
    return (
      <button
        type="button"
        onClick={() => onTabChange(tab.id)}
        className={cn(
          "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium transition-all",
          isActive
            ? "bg-primary/15 text-neon glow-primary border border-primary/40"
            : "border border-transparent text-muted hover:bg-bg-elevated hover:text-foreground",
        )}
        aria-current={isActive ? "page" : undefined}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="truncate">{tab.label}</span>
        {isActive && <Badge variant="default" className="ml-auto">●</Badge>}
      </button>
    );
  };

  return (
    <aside className="glass-panel hidden w-64 shrink-0 flex-col gap-1 p-3 lg:flex">
      <div className="mb-2 flex items-center gap-2 px-2">
        <Sparkles className="h-4 w-4 text-neon" />
        <span className="font-heading text-sm uppercase tracking-widest text-muted">
          Tabs
        </span>
      </div>
      {PRIMARY_TABS.map((tab) => (
        <Tile key={tab.id} tab={tab} />
      ))}

      <button
        type="button"
        onClick={() => setAdvancedOpen((o) => !o)}
        className="mt-2 flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm font-semibold text-muted hover:text-foreground"
        aria-expanded={advancedOpen}
        aria-controls="sidebar-advanced-section"
      >
        Advanced
        <ChevronDown
          className={cn("h-4 w-4 transition-transform", advancedOpen && "rotate-180")}
        />
      </button>
      {advancedOpen && (
        <div id="sidebar-advanced-section" className="mt-1 flex flex-col gap-1">
          {ADVANCED_TABS.map((tab) => (
            <Tile key={tab.id} tab={tab} />
          ))}
        </div>
      )}
    </aside>
  );
}
