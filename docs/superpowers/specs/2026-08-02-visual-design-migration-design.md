# Spec 1 — Visual Design Migration

## Overview

Migrate the dashboard from hand-written CSS to Tailwind CSS + shadcn/ui, adopting the vbrainstorm design system aesthetic (dark-first HSL tokens, electric blue primary, glass panels, subtle glow). Add a badge-tile sidebar navigation (desktop) and bottom bar (mobile). Keep all effects moderate — glass, glow, gradients — no heavy animations (no WebGL, physics, cursor trails, glitch).

Feature-flagged via `MEGACOMPACT_NEW_UI` (default ON, opt-out via `MEGACOMPACT_NEW_UI_DISABLED=true`). Uses the established `ragEnabled()` pattern — same as all 5 S57 RAG flags. Flag-OFF = byte-identical to the current GitHub-dark CSS dashboard.

## Architecture

### Design Tokens (HSL CSS variables, dark-first)

Replace `extensions/dashboard-client/src/styles/base.css` tokens with the vbrainstorm palette:

```css
:root {
  --bg: 222 47% 5%;            /* near-black blue */
  --bg-card: 222 32% 8%;
  --bg-elevated: 222 28% 12%;
  --border: 217 33% 17%;
  --foreground: 210 40% 98%;
  --muted: 215 20% 65%;
  --primary: 217 91% 60%;      /* electric blue */
  --primary-glow: 217 91% 60%;
  --success: 142 71% 45%;      /* neon green */
  --warning: 38 92% 50%;
  --danger: 0 84% 60%;
  --accent: 280 100% 70%;     /* purple accent */
  --radius: 0.75rem;
}

.light {
  --bg: 0 0% 100%;
  --bg-card: 0 0% 98%;
  --bg-elevated: 0 0% 95%;
  --border: 220 13% 91%;
  --foreground: 222 47% 11%;
  --muted: 220 9% 46%;
  /* primary, success, etc. stay the same */
}
```

### Typography

- Headings: `'JetBrains Mono', monospace`
- Body: `'Inter', system-ui, sans-serif`
- Mono/data: `'JetBrains Mono', monospace`

### Utility Classes (in base.css, Tailwind-compatible)

```css
.glass-panel { background: hsl(var(--bg-card) / 0.7); backdrop-filter: blur(10px); border: 1px solid hsl(var(--border) / 0.5); }
.electric-hover { transition: all 0.2s; }
.electric-hover:hover { border-color: hsl(var(--primary)); box-shadow: 0 0 12px hsl(var(--primary) / 0.3); }
.glow-primary { box-shadow: 0 0 20px hsl(var(--primary) / 0.4); }
.text-neon { color: hsl(var(--primary)); text-shadow: 0 0 10px hsl(var(--primary) / 0.5); }
.gradient-text { background: linear-gradient(135deg, hsl(var(--primary)), hsl(var(--accent))); -webkit-background-clip: text; background-clip: text; color: transparent; }
```

### Tailwind Config

```js
// tailwind.config.js (extensions/dashboard-client/)
export default {
  content: ['./src/**/*.{ts,tsx,html}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: 'hsl(var(--bg))',
        card: 'hsl(var(--bg-card))',
        elevated: 'hsl(var(--bg-elevated))',
        border: 'hsl(var(--border))',
        foreground: 'hsl(var(--foreground))',
        muted: 'hsl(var(--muted))',
        primary: { DEFAULT: 'hsl(var(--primary))', glow: 'hsl(var(--primary-glow))' },
        success: 'hsl(var(--success))',
        warning: 'hsl(var(--warning))',
        danger: 'hsl(var(--danger))',
        accent: 'hsl(var(--accent))',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
        display: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
}
```

### shadcn/ui Components Needed

- `Button` (variants: default/primary/ghost/outline)
- `Card` (with glass-panel variant)
- `Badge` (variants: default/success/warning/danger)
- `Toggle` (for flag switches)
- `Tabs` (for sub-tab navigation within tabs)
- `Tooltip`
- `Select` (for dropdowns)
- `Switch` (for toggles)

### Navigation — Badge-Tile Sidebar

**Desktop (>=768px):** Vertical sidebar on the left, 64px collapsed / 200px expanded. Each tab is a badge-tile: icon + label + active glow. Primary tabs at top, advanced tabs below a divider.

**Mobile (<768px):** Bottom bar, 56px tall. Primary tabs as icon-only badges. Advanced tabs accessible via a "More" sheet that slides up.

```tsx
// extensions/dashboard-client/src/components/layout/Sidebar.tsx
import { PRIMARY_TABS, ADVANCED_TABS } from '../../tabs/registry';
import { cn } from '../../utils/cn';

interface SidebarProps {
  active: TabId;
  onSelect: (tab: TabId) => void;
  mobile: boolean;
}

export function Sidebar({ active, onSelect, mobile }: SidebarProps) {
  if (mobile) return <BottomBar tabs={[...PRIMARY_TABS, ...ADVANCED_TABS]} active={active} onSelect={onSelect} />;
  return (
    <aside className="flex flex-col gap-1 w-16 hover:w-52 transition-all duration-200 border-r border-border bg-card/50 backdrop-blur-md">
      {PRIMARY_TABS.map(t => <NavTile key={t.id} tab={t} active={active === t.id} onSelect={onSelect} />)}
      <div className="h-px bg-border mx-2 my-2" />
      {ADVANCED_TABS.map(t => <NavTile key={t.id} tab={t} active={active === t.id} onSelect={onSelect} />)}
    </aside>
  );
}

function NavTile({ tab, active, onSelect }: { tab: TabDef; active: boolean; onSelect: (id: TabId) => void }) {
  return (
    <button
      onClick={() => onSelect(tab.id)}
      className={cn(
        'flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all electric-hover',
        active ? 'bg-primary/15 text-primary glow-primary' : 'text-muted hover:text-foreground hover:bg-elevated'
      )}
      title={tab.label}
    >
      <span className="text-lg shrink-0">{tab.icon}</span>
      <span className="truncate font-mono text-sm">{tab.label}</span>
      {active && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />}
    </button>
  );
}
```

### Files to Create

| File | Lines | Purpose |
|------|-------|---------|
| `src/utils/cn.ts` | 10 | `clsx` + `tailwind-merge` helper |
| `src/components/ui/button.tsx` | 50 | shadcn Button component |
| `src/components/ui/card.tsx` | 40 | Card with glass-panel variant |
| `src/components/ui/badge.tsx` | 30 | Badge component |
| `src/components/ui/toggle.tsx` | 25 | Toggle component |
| `src/components/ui/switch.tsx` | 30 | Switch component |
| `src/components/ui/tabs.tsx` | 35 | Tabs sub-navigation |
| `src/components/ui/tooltip.tsx` | 20 | Tooltip wrapper |
| `src/components/ui/select.tsx` | 40 | Select dropdown |
| `src/components/layout/Sidebar.tsx` | 80 | Badge-tile sidebar (desktop) |
| `src/components/layout/BottomBar.tsx` | 80 | Mobile bottom bar + More sheet |
| `src/components/layout/AppShell.tsx` | 60 | Main layout: sidebar + content area |
| `src/tabs/registry.ts` | 40 | Tab definitions (id, label, icon, group). **Moves** `PRIMARY_TABS`/`ADVANCED_TABS` out of `App.tsx:46-62` into this file — single source of truth for both `TabBar` (old UI) and `Sidebar`/`BottomBar` (new UI). |
| `tailwind.config.js` | 40 | Tailwind config |
| `postcss.config.js` | 10 | PostCSS for Tailwind |

### Files to Modify

| File | Change |
|------|--------|
| `package.json` | Add deps: tailwindcss, postcss, autoprefixer, @radix-ui/react-*, lucide-react, class-variance-authority, clsx, tailwind-merge |
| `src/main.tsx` | Import `tailwindcss` + updated `base.css` |
| `src/styles/base.css` | Replace tokens with vbrainstorm HSL palette + utility classes |
| `src/App.tsx` | Replace tab bar with `<AppShell>`, use `Sidebar` component. Move `PRIMARY_TABS`/`ADVANCED_TABS` out to `tabs/registry.ts` and import from there. Keep render branches. |

### Dependencies (add to `extensions/dashboard-client/package.json`)

```json
{
  "devDependencies": {
    "tailwindcss": "^3.4.0",
    "postcss": "^8.4.0",
    "autoprefixer": "^10.4.0"
  },
  "dependencies": {
    "@radix-ui/react-tooltip": "^1.1.0",
    "@radix-ui/react-select": "^2.1.0",
    "@radix-ui/react-tabs": "^1.1.0",
    "@radix-ui/react-switch": "^1.1.0",
    "lucide-react": "^0.400.0",
    "class-variance-authority": "^0.7.0",
    "clsx": "^2.1.0",
    "tailwind-merge": "^2.5.0"
  }
}
```

## Feature Flag

```typescript
// src/config.ts — uses established ragEnabled() pattern (same as all S57 RAG flags)
export const NEW_UI = () => ragEnabled("NEW_UI");
// ragEnabled("NEW_UI") checks MEGACOMPACT_NEW_UI_DISABLED — returns true when unset (default ON)
```

In `App.tsx`:
```tsx
if (!NEW_UI()) return <OldDashboard />; // existing CSS dashboard
// ... new shadcn/ui dashboard
```

## Mobile Responsiveness

- `AppShell`: `flex` row on desktop, `flex-col` on mobile
- Content area: `flex-1 overflow-auto`, padding `p-4 md:p-6`
- Sidebar: hidden <768px, BottomBar shown
- Cards: `grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4`
- Tables: horizontal scroll on mobile, full width on desktop
- Charts: full width, height `h-64 md:h-80`
- Font sizes: `text-sm md:text-base` for labels

## Sprint Breakdown

### Sprint V1 — Tailwind Setup + Design Tokens
**Files:** `package.json`, `tailwind.config.js`, `postcss.config.js`, `src/styles/base.css`, `src/main.tsx`, `src/utils/cn.ts`
**Acceptance:**
- `npm run build:dashboard` succeeds with Tailwind classes available
- CSS variables match vbrainstorm palette
- `cn()` utility works
- Existing dashboard renders (just with new CSS tokens, no layout changes yet)
- No visual regressions — existing components still layout correctly

### Sprint V2 — shadcn/ui Components + Layout
**Files:** All `src/components/ui/*.tsx`, `src/components/layout/Sidebar.tsx`, `src/components/layout/BottomBar.tsx`, `src/components/layout/AppShell.tsx`, `src/tabs/registry.ts`, `src/App.tsx`
**Acceptance:**
- Sidebar renders on desktop (>=768px) with badge-tiles
- BottomBar renders on mobile (<768px)
- All 12 tabs accessible from sidebar/bottom bar
- Tab switching works
- Glass-panel, glow, electric-hover effects visible
- `MEGACOMPACT_NEW_UI_DISABLED=1` shows old dashboard

### Sprint V3 — Tab Migration
**Files:** All existing tab components (`src/tabs/*.tsx`) — add Tailwind classes, use shadcn/ui components
**Acceptance:**
- All 12 tabs use new design language
- Cards use `<Card>` component with glass-panel
- Buttons use shadcn `<Button>`
- Badges use shadcn `<Badge>`
- Mobile-responsive layouts per tab
- No functionality changes — same data, same interactions

### Sprint V4 — Cleanup + Polish
**Files:** Remove old CSS files that conflict, consolidate styles
**Acceptance:**
- Old tab-bar CSS removed
- No duplicate styling
- Playwright tab-smoke passes
- Dashboard-tab-smoke green
- Build + test + lint gate green

## QA Review Checklist

- [ ] All new files <500 lines
- [ ] `cn()` utility used consistently for conditional classes
- [ ] No raw `#hex` colors — all via CSS variables
- [ ] Mobile: sidebar hidden <768px, bottom bar visible
- [ ] Mobile: "More" sheet shows advanced tabs
- [ ] Desktop: sidebar hover expands from icon-only to full label
- [ ] Active tab has glow + dot indicator
- [ ] Glass-panel blur works in Chrome/Firefox
- [ ] Dark mode: default. Light mode: toggleable via `data-theme`
- [ ] `MEGACOMPACT_NEW_UI_DISABLED=1` = old dashboard, byte-identical
- [ ] No new network calls (PREVENT-PI-004)
- [ ] Playwright tab-smoke: all 12 tabs render non-empty
- [ ] `npm run build:dashboard` succeeds
- [ ] `npm test` passes
- [ ] `npm run lint` passes (guardrails-scan + tsc)
- [ ] `python3 scripts/regression_check.py --all` passes

## Risks + Mitigations

| Risk | Mitigation |
|------|------------|
| Tailwind v3 vs v4 confusion | Pin to v3.4.x (stable, postcss.config.js + tailwind.config.js pattern). v4 JIT-mode not needed for this bundle size. |
| Existing CSS conflicts with Tailwind | Keep old CSS files during migration; remove only in Sprint V4 after all tabs migrated |
| Bundle size increase | Tailwind v3 purge only includes used classes; audit with `vite build --report` |
| Mobile layout broken by desktop-only components | Test at 375px, 768px, 1280px breakpoints every sprint |
| Feature flag doesn't fully isolate | Sprint V2 verifies `NEW_UI_DISABLED` reverts to old dashboard |

## Out of Scope

- Heavy animations (WebGL, physics, cursor trails, glitch effects)
- Light mode polish (token exists, but dark-first is the target)
- Custom icon design — using lucide-react defaults
- Theme toggle UI (can be added later)
- Component unit tests (covered by Playwright tab-smoke + existing test suite)
- Auth/tokens (dashboards are local, no auth)
- Backend API changes (purely frontend migration)
