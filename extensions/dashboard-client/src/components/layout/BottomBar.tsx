import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "../../utils/cn";
import {
  PRIMARY_TABS,
  ADVANCED_TABS,
  type TabId,
} from "../../tabs/registry";

interface BottomBarProps {
  active: TabId;
  onTabChange: (id: TabId) => void;
}

export function BottomBar({ active, onTabChange }: BottomBarProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const primary = PRIMARY_TABS.slice(0, 4);

  return (
    <nav className="glass-panel fixed inset-x-3 bottom-3 z-40 flex items-center justify-around rounded-xl p-2 lg:hidden">
      {primary.map((tab) => {
        const Icon = tab.icon;
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
            className={cn(
              "flex flex-col items-center gap-1 rounded-lg px-3 py-1.5 text-[11px] font-medium",
              isActive
                ? "text-neon glow-primary"
                : "text-muted hover:text-foreground",
            )}
          >
            <Icon className="h-5 w-5" />
            {tab.label}
          </button>
        );
      })}

      <button
        type="button"
        onClick={() => setMoreOpen((o) => !o)}
        aria-expanded={moreOpen}
        className={cn(
          "flex flex-col items-center gap-1 rounded-lg px-3 py-1.5 text-[11px] font-medium",
          moreOpen ? "text-neon" : "text-muted hover:text-foreground",
        )}
      >
        <MoreHorizontal className="h-5 w-5" />
        More
      </button>

      {moreOpen && (
        <div className="absolute bottom-16 right-2 w-56 rounded-xl border border-border bg-bg-elevated p-2 shadow-panel">
          {[...PRIMARY_TABS.slice(4), ...ADVANCED_TABS].map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  onTabChange(tab.id);
                  setMoreOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm",
                  active === tab.id
                    ? "bg-primary/15 text-neon"
                    : "text-muted hover:bg-bg-elevated hover:text-foreground",
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {tab.label}
              </button>
            );
          })}
        </div>
      )}
    </nav>
  );
}
