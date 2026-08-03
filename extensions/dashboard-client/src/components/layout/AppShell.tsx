import React from "react";
import type { SnapshotResponse } from "@contracts";
import { Sidebar } from "./Sidebar";
import { BottomBar } from "./BottomBar";
import type { TabId } from "../../tabs/registry";

interface AppShellProps {
  active: TabId;
  onTabChange: (id: TabId) => void;
  snapshot: SnapshotResponse | null;
  children: React.ReactNode;
}

export function AppShell({ active, onTabChange, snapshot, children }: AppShellProps) {
  const tier = snapshot?.tier ?? "unknown";
  const version = snapshot?.model?.name ?? "";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full gap-6 px-4 py-4 xl:px-6">
        <Sidebar active={active} onTabChange={onTabChange} />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="mb-4 flex items-center gap-3">
            <h1 className="font-heading text-lg font-semibold">
              <span className="gradient-text">mega-compact dashboard</span>
            </h1>
            <span className="rounded-md border border-border bg-bg-elevated px-2 py-0.5 text-xs text-muted">
              {tier}
            </span>
            {version && (
              <span className="rounded-md border border-border bg-bg-elevated px-2 py-0.5 text-xs text-muted">
                {version}
              </span>
            )}
          </header>
          <main className="flex-1 pb-20 lg:pb-4">{children}</main>
        </div>
      </div>
      <BottomBar active={active} onTabChange={onTabChange} />
    </div>
  );
}
