/**
 * dashboard-client/src/components/TabBar.tsx — tab navigation.
 */

import type { TabId } from '../App';

export interface TabBarProps {
  tabs: Array<{ id: TabId; label: string }>;
  active: TabId;
  onTabChange: (id: TabId) => void;
}

export function TabBar({ tabs, active, onTabChange }: TabBarProps): React.ReactElement {
  return (
    <nav className="tab-bar" role="tablist">
      {tabs.map(tab => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          className={active === tab.id ? 'active' : ''}
          onClick={() => onTabChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
