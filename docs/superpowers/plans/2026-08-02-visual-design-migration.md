# Visual Design Migration — Tailwind CSS v3.4 + shadcn/ui (Spec 1)

**Date:** 2026-08-02
**Component:** Dashboard client (`extensions/dashboard-client/`)
**Spec:** Visual Design Migration — vbrainstorm design system (dark-first HSL tokens, electric blue primary, glass panels, badge-tile sidebar)

## Progress Tracker (updated 2026-08-02)

| Sprint | Status | Commits | Notes |
|--------|--------|---------|-------|
| V1 Tailwind + design tokens | DONE | `13755d7` | Tailwind v3.4, HSL tokens, dark-first theme, glass-panel + electric-hover utilities. Both reviews passed. |
| V2 shadcn shell + NEW_UI flag | DONE | `69f77d6` | Sidebar + BottomBar + registry + App gate. Accessibility fixes in `83cb20f` (aria-current, aria-controls/expanded, sidebar resync). |
| V3 Tab Migration (all 12 tabs) | DONE | `a92d135` | 12 tabs migrated to Tailwind + shadcn. 5 pre-existing type errors flagged (fix agent assigned). Token collision with legacy base.css is known — resolves in V4. Tab smoke selector mismatch known (uses `[role="tab"]`, new shell uses `<button>`) — smoke update is V4 scope. |
| V4 Cleanup + Polish | DONE | `02ae9b4`, `2460f2a` | Focus-visible rings added. Legacy CSS retained (flag-OFF byte-parity). Flag wiring verified. Playwright smoke fixed for sidebar layout (12/12 tabs green). |

**Review fixes applied post-sprint:**
- `83cb20f` — V2 accessibility: aria-current on active tabs, aria-controls/expanded on toggles, sidebar advancedOpen resync on cross-device nav
- V3 type errors: 5 pre-existing dashboard-client typecheck errors (fix agent assigned)

---

## Goal

Migrate the dashboard from hand-written CSS to **Tailwind CSS v3.4 + shadcn/ui**, adopting the **vbrainstorm** design system (dark-first HSL tokens, electric blue primary `217 91% 60%`, glass panels, subtle glow). Add a **badge-tile sidebar** (desktop) and **bottom bar with a More sheet** (mobile). The migration is feature-flagged via `MEGACOMPACT_NEW_UI` using the existing `ragEnabled()` pattern — **default ON**, opt-out via `MEGACOMPACT_NEW_UI_DISABLED=true`. Flag-OFF renders the existing hand-written-CSS dashboard unchanged.

---

## Architecture

```
┌────────────────────────── extension (Node) ──────────────────────────┐
│  src/config.ts  NEW_UI() = ragEnabled("NEW_UI")  (server-side gate)  │
│              │                                                       │
│              ▼                                                       │
│  extensions/dashboard-server.ts  reads NEW_UI(), injects             │
│   window.MEGACOMPACT_NEW_UI = true/false  into served index.html     │
└──────────────────────────────────┬───────────────────────────────────┘
                                   ▼  (HTTP, localhost, loopback-only)
┌─────────────────────── dashboard client (React + Vite) ─────────────┐
│  main.tsx          imports Tailwind (index.css) + legacy CSS          │
│  config.ts         NEW_UI() = window.MEGACOMPACT_NEW_UI !== false     │
│  App.tsx           if (!NEW_UI()) return <OldDashboard />            │
│                    else <AppShell> → Sidebar | BottomBar | tabs      │
│  tabs/registry.ts  single source of truth: TabDefs + lucide icons    │
│    ▲  ▲ reused by BOTH old TabBar.tsx and new Sidebar.tsx          │
│  components/ui/*    shadcn Button/Card/Badge/Toggle/Switch/Tabs/...  │
│  components/layout/ Sidebar.tsx · BottomBar.tsx · AppShell.tsx       │
└──────────────────────────────────────────────────────────────────────┘
```

**Key decisions**

- **Single source of truth for tabs.** `TabId`, `PRIMARY_TABS`, `ADVANCED_TABS` are moved verbatim out of `App.tsx` into `tabs/registry.ts`, which adds a `icon` field (lucide-react component) and exports the `advancedTabIds` Set. Both the legacy `TabBar.tsx` and the new `Sidebar.tsx` import from it — DRY, and flag-OFF keeps working with the exact same tab data.
- **Flag routing.** The dashboard client is a browser bundle and cannot read `process.env`. The root `src/config.ts` already has the canonical `ragEnabled("NEW_UI")` server-side gate. The dashboard server reads that one boolean at startup and injects `window.MEGACOMPACT_NEW_UI` into the served HTML. The client `config.ts` reads that injected value (default ON). This reuses the existing pattern, adds **zero network calls** (PREVENT-PI-004), and keeps flag-OFF rendering byte-identical old DOM.
- **Legacy CSS preserved.** All 14 legacy CSS files stay imported (via `index.css` @import for Tailwind layers + separate legacy imports in `main.tsx`). They are *not* deleted in V1–V3 (burn-down happens in V4). Flag-OFF therefore needs no code path changes beyond the `if (!NEW_UI())` guard.
- **YAGNI.** We do not re-theme every tab's internal data visualization (charts, gauges) — the vbrainstorm tokens are applied at the shell, layout, card, badge, and navigation level. Per-tab polish beyond the shared primitives is out of scope for Spec 1 and called out at the end under "Follow-ups".

---

## Tech Stack

| Area | Choice |
|------|--------|
| React | 18.3.1 (existing) |
| Build | Vite 5.4.11, `root: "src"` (existing) |
| Types | TypeScript 5.6.3 (existing) |
| Charts | recharts ^2.15.4 (existing, untouched) |
| Styles | Tailwind CSS 3.4, PostCSS 8, autoprefixer 10 |
| Components | shadcn/ui primitives over Radix (`@radix-ui/react-*`), `class-variance-authority`, `clsx`, `tailwind-merge` |
| Icons | `lucide-react` |
| Runtime network | **None** (PREVENT-PI-004) |

New dependencies (dashboard client `package.json`):

```jsonc
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

---

## Design tokens (vbrainstorm)

HSL triplets (no alpha in the `:root` tokens; alpha applied via group modifiers):

```css
:root {
  --bg: 222 47% 5%;
  --bg-card: 222 32% 8%;
  --bg-elevated: 222 28% 12%;
  --border: 217 33% 17%;
  --foreground: 210 40% 98%;
  --muted: 215 20% 65%;
  --primary: 217 91% 60%;
  --primary-glow: 217 91% 60%;
  --success: 142 71% 45%;
  --warning: 38 92% 50%;
  --danger: 0 84% 60%;
  --accent: 280 100% 70%;
  --radius: 0.75rem;
}
```

| Utility | Purpose |
|---|---|
| `.glass-panel` | translucent elevated card: `bg-gradient + backdrop-blur + 1px border + inset highlight` |
| `.electric-hover` | hover lift + electric border glow |
| `.glow-primary` | box-shadow glow in primary color |
| `.text-neon` | bright primary foreground |
| `.gradient-text` | electric→violet gradient clipped to text |

Typography: JetBrains Mono headings, Inter body, JetBrains Mono for mono/data.

---

# Sprint V1 — Tailwind Setup + Design Tokens

> Goal: Tailwind, PostCSS, the vbrainstorm token layer, and the `cn()` helper are wired and building. No UI change yet.

## Task 1.1 — Install dependencies

**Files:**
- Modify: `extensions/dashboard-client/package.json`
- Test: `extensions/dashboard-client/package-lock.json` (generated)

1. Add the new dependencies to `extensions/dashboard-client/package.json` (final shape shown in Tech Stack above). Result:

```jsonc
// extensions/dashboard-client/package.json (dependencies + devDependencies)
{
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "recharts": "^2.15.4",
    "@radix-ui/react-tooltip": "^1.1.0",
    "@radix-ui/react-select": "^2.1.0",
    "@radix-ui/react-tabs": "^1.1.0",
    "@radix-ui/react-switch": "^1.1.0",
    "lucide-react": "^0.400.0",
    "class-variance-authority": "^0.7.0",
    "clsx": "^2.1.0",
    "tailwind-merge": "^2.5.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.6.3",
    "vite": "^5.4.11",
    "tailwindcss": "^3.4.0",
    "postcss": "^8.4.0",
    "autoprefixer": "^10.4.0"
  }
}
```

2. `allowScripts` must include the native esbuild binary already present (esbuild is Vite's dependency; it is unchanged, but confirm the key survives install). Keep:

```jsonc
{
  "allowScripts": {
    "esbuild@0.21.5": true
  }
}
```

3. Install:

```bash
cd /mnt/data/git/pi-mega-compact/extensions/dashboard-client && npm install
```

**Expected output:** `added N packages` and `npm` reports a clean install (peer deps satisfied). If a peer-dependency conflict arises for `@radix-ui/react-select`, it resolves within the `react ^18` range already in use.

**Test:**

```bash
cd /mnt/data/git/pi-mega-compact/extensions/dashboard-client && npm ls react tailwindcss lucide-react
```

**Expected output:** each package resolves to a coherent version (e.g. `tailwindcss@3.4.x`) with `deduped`/valid peer relationships and no `UNMET DEPENDENCY` markers.

## Task 1.2 — Tailwind + PostCSS config

**Files:**
- Create: `extensions/dashboard-client/tailwind.config.js`
- Create: `extensions/dashboard-client/postcss.config.js`

1. Create `extensions/dashboard-client/tailwind.config.js`:

```js
/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1.5rem",
      screens: { "2xl": "1600px" },
    },
    extend: {
      colors: {
        background: "hsl(var(--bg))",
        "bg-card": "hsl(var(--bg-card))",
        "bg-elevated": "hsl(var(--bg-elevated))",
        border: "hsl(var(--border))",
        foreground: "hsl(var(--foreground))",
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--foreground))" },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(222 47% 5%)",
          glow: "hsl(var(--primary-glow))",
        },
        success: "hsl(var(--success))",
        warning: "hsl(var(--warning))",
        danger: "hsl(var(--danger))",
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(222 47% 5%)" },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
        heading: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        glow: "0 0 20px -4px hsl(var(--primary-glow) / 0.5)",
        panel: "0 8px 30px -12px hsl(var(--bg) / 0.6)",
      },
    },
  },
  plugins: [],
};
```

2. Create `extensions/dashboard-client/postcss.config.js`:

```js
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

3. Because Vite auto-finds `postcss.config.js` in the Vite root, no `vite.config.ts` change is required for PostCSS pickup. Confirmed during build in Task 1.4.

**Test (config loads):**

```bash
cd /mnt/data/git/pi-mega-compact/extensions/dashboard-client && npx tailwindcss --help >/dev/null && echo "tailwind cli ok"
```

**Expected output:** `tailwind cli ok`.

## Task 1.3 — Token CSS layer + `cn()` helper

**Files:**
- Create: `extensions/dashboard-client/src/styles/index.css`
- Create: `extensions/dashboard-client/src/utils/cn.ts`

1. Create `extensions/dashboard-client/src/styles/index.css` — the vbrainstorm token layer, Tailwind directives, and the shared utility classes. This is the *only* new stylesheet; it composes Tailwind's `@layer` and the global design tokens:

```css
/* dashboard-client/src/styles/index.css — Tailwind directives + design tokens */
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --bg: 222 47% 5%;
    --bg-card: 222 32% 8%;
    --bg-elevated: 222 28% 12%;
    --border: 217 33% 17%;
    --foreground: 210 40% 98%;
    --muted: 215 20% 65%;
    --primary: 217 91% 60%;
    --primary-glow: 217 91% 60%;
    --success: 142 71% 45%;
    --warning: 38 92% 50%;
    --danger: 0 84% 60%;
    --accent: 280 100% 70%;
    --radius: 0.75rem;
  }

  * {
    @apply border-border;
  }

  html {
    @apply bg-background text-foreground antialiased;
  }

  body {
    @apply bg-background text-foreground font-sans;
    margin: 0;
  }

  h1, h2, h3, h4, h5, h6 {
    font-family: theme("fontFamily.heading");
  }
}

@layer components {
  /* Glass panel — translucent elevated surface with hairline border + top glow */
  .glass-panel {
    @apply relative rounded-lg border border-border bg-bg-card/70 backdrop-blur-md;
    box-shadow:
      inset 0 1px 0 0 hsl(var(--border) / 0.5),
      var(--tw-shadow, 0 8px 30px -12px hsl(var(--bg) / 0.6));
  }

  /* Electric hover — lift + primary border glow on hover/focus-visible */
  .electric-hover {
    @apply transition-all duration-200 hover:-translate-y-0.5;
  }
  .electric-hover:hover {
    border-color: hsl(var(--primary) / 0.7);
    box-shadow: 0 0 20px -4px hsl(var(--primary-glow) / 0.45);
  }
  .electric-hover:focus-visible {
    outline: 2px solid hsl(var(--primary) / 0.6);
    outline-offset: 2px;
  }

  /* Primary glow utility (static) */
  .glow-primary {
    box-shadow: 0 0 20px -4px hsl(var(--primary-glow) / 0.5);
  }

  /* Neon foreground text */
  .text-neon {
    color: hsl(var(--primary));
  }

  /* Electric → violet gradient clipped to text */
  .gradient-text {
    background: linear-gradient(120deg, hsl(var(--primary)), hsl(var(--accent)));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
}
```

2. Create `extensions/dashboard-client/src/utils/cn.ts` (sits alongside existing `utils/format.ts` and `utils/types.ts`):

```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Combine className inputs then de-duplicate/merge conflicting Tailwind classes. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

3. Verify file size stays well under the 500-line limit. (index.css ≈ 120 lines, cn.ts ≈ 8 lines.)

**Test (build):**

```bash
cd /mnt/data/git/pi-mega-compact && npm run build:dashboard
```

**Expected output:** Vite completes with `✓ built in …` and no Tailwind/PostCSS errors. (Legacy CSS continues to load at runtime; Tailwind classes are now compiled.)

## Task 1.4 — Wire `index.css` into the entry point (flag-safe)

> The new stylesheet must load without changing flag-OFF render output. We append it to `main.tsx` imports; legacy CSS remains imported exactly as today.

**Files:**
- Modify: `extensions/dashboard-client/src/main.tsx`

1. Add a single line importing `./styles/index.css` at the top of the import list, above the legacy CSS imports:

```tsx
// extensions/dashboard-client/src/main.tsx — React entry point.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/index.css"; // Tailwind + design tokens (Spec 1)
import "./styles/base.css";
import "./styles/overview-events.css";
import "./styles/repos-metrics.css";
import "./styles/repos-extra.css";
import "./styles/overview-extra.css";
import "./styles/config.css";
import "./styles/metrics-extra.css";
import "./styles/game-achievements.css";
import "./styles/sessions.css";
import "./styles/repostack.css";
import "./styles/session-gauges.css";
import "./styles/turns.css";
import "./styles/maintenance.css";
import "./styles/cache.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("dashboard-client: #root element not found in index.html");
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

2. Because the Tailwind `base` layer resets are additive and the legacy CSS still applies its own tokens to `.dashboard-app` and descendants, flag-OFF output is unchanged at the *class* level. Visual regression is verified in V4.

**Test (full dashboard build + smoke):**

```bash
cd /mnt/data/git/pi-mega-compact && npm run build:dashboard && node scripts/dashboard-tab-smoke.mjs
```

**Expected output:** build succeeds; `dashboard-tab-smoke` reports all tabs healthy (12 tabs, 0 failures).

## Task 1.5 — V1 commit

```bash
cd /mnt/data/git/pi-mega-compact && git add extensions/dashboard-client/package.json extensions/dashboard-client/package-lock.json extensions/dashboard-client/tailwind.config.js extensions/dashboard-client/postcss.config.js extensions/dashboard-client/src/styles/index.css extensions/dashboard-client/src/utils/cn.ts extensions/dashboard-client/src/main.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): add Tailwind v3 + design-token layer (V1)

Wire Tailwind, PostCSS, the vbrainstorm HSL token layer, and cn() helper.
No UI change; legacy CSS untouched. Part of the visual design migration.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

**Expected output:** pre-commit hook runs lint + regression gate; commit created with the `Co-Authored-By:` trailer (hook-enforced).

---

# Sprint V2 — shadcn/ui Components + Layout (NEW_UI shell)

> Goal: flag plumbing, the shadcn primitives, the new Sidebar/BottomBar/AppShell layout, and the tab registry. Flag-OFF still renders `<OldDashboard>` byte-identical.

## Task 2.1 — Client-side config flag

**Files:**
- Create: `extensions/dashboard-client/src/config.ts`
- Modify: `extensions/dashboard-client/src/hooks/useApi.ts` *(none — no change to hooks)*

1. Create `extensions/dashboard-client/src/config.ts` — client reads the server-injected `window.MEGACOMPACT_NEW_UI`, defaulting to ON (matches the `ragEnabled()` "default ON, opt-out via `_DISABLED`" semantics):

```ts
/**
 * dashboard-client/src/config.ts — client-side runtime config for the dashboard.
 *
 * The dashboard Server reads `src/config.ts` (server) NEW_UI() and injects the
 * resolved boolean into the served HTML as window.MEGACOMPACT_NEW_UI. Default
 * is ON; opt-out via MEGACOMPACT_NEW_UI_DISABLED=true on the server.
 */
declare global {
  interface Window {
    MEGACOMPACT_NEW_UI?: boolean;
  }
}

/** True when the vbrainstorm visual design migration is enabled (default ON). */
export const NEW_UI = (): boolean => window.MEGACOMPACT_NEW_UI !== false;

export {};
```

2. (No changes to `useApi.ts`.)

**Test (typecheck):**

```bash
cd /mnt/data/git/pi-mega-compact/extensions/dashboard-client && npm run typecheck
```

**Expected output:** `tsc --noEmit` exits 0 with no errors.

## Task 2.2 — Server-side flag injection (reuse `ragEnabled`)

**Files:**
- Modify: `extensions/dashboard-client/../dashboard-server.ts` (i.e. `extensions/dashboard-server.ts`)
- Modify: `src/config.ts`

1. Add the canonical server-side flag to root `src/config.ts`, next to the other `ragEnabled` uses (around line 124):

```ts
/** Spec 1: vbrainstorm visual design migration for the dashboard. */
export const NEW_UI = (): boolean => ragEnabled("MEGACOMPACT_NEW_UI");
```

2. In `extensions/dashboard-server.ts`, before the HTML is served, inject the boolean. Concretely: when serving `index.html`, read `NEW_UI()` and inject a tiny inline script into the `<head>`:

```ts
import { NEW_UI } from "../src/config.js";

function injectUiFlag(html: string): string {
  const flag = NEW_UI() ? "true" : "false";
  const script = `<script>window.MEGACOMPACT_NEW_UI=${flag}</script>`;
  if (html.includes("</head>")) {
    return html.replace("</head>", `${script}</head>`);
  }
  return html + script;
}
```

> Implementation note: locate where the server reads the built `dist/index.html` and route its string through `injectUiFlag(...)` before responding. Exact insertion point is wherever `index.html` bytes are loaded into the response body; the grep anchor is the `readFile`/`createReadStream` of `dist/index.html`.

3. **No network calls introduced** — this is a local String replace on already-served HTML (PREVENT-PI-004 satisfied; localhost loopback server is the pre-existing, audited exception).

**Test (server boots):**

```bash
cd /mnt/data/git/pi-mega-compact && npm run build 2>&1 | tail -5
```

**Expected output:** build succeeds, both server and dashboard compile.

## Task 2.3 — shadcn primitives (Button, Card, Badge)

**Files:**
- Create: `extensions/dashboard-client/src/components/ui/button.tsx`
- Create: `extensions/dashboard-client/src/components/ui/card.tsx`
- Create: `extensions/dashboard-client/src/components/ui/badge.tsx`

1. Create `button.tsx`:

```tsx
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../utils/cn";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90 glow-soft",
        outline: "border border-border bg-transparent hover:bg-bg-elevated hover:text-foreground",
        ghost: "hover:bg-bg-elevated hover:text-foreground",
        glass: "glass-panel electric-hover",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  ),
);
Button.displayName = "Button";

export { Button, buttonVariants };
```

2. Create `card.tsx`:

```tsx
import * as React from "react";
import { cn } from "../../utils/cn";

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("glass-panel p-4", className)} {...props} />
  ),
);
Card.displayName = "Card";

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("mb-3 flex flex-col space-y-1.5", className)} {...props} />
  ),
);
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3 ref={ref} className={cn("font-heading text-sm font-semibold leading-none tracking-tight", className)} {...props} />
  ),
);
CardTitle.displayName = "CardTitle";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("text-sm", className)} {...props} />
  ),
);
CardContent.displayName = "CardContent";

export { Card, CardHeader, CardTitle, CardContent };
```

3. Create `badge.tsx`:

```tsx
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../utils/cn";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none",
  {
    variants: {
      variant: {
        default: "border-primary/40 bg-primary/15 text-neon",
        success: "border-success/40 bg-success/15 text-success",
        warning: "border-warning/40 bg-warning/15 text-warning",
        danger: "border-danger/40 bg-danger/15 text-danger",
        outline: "border-border text-foreground",
        accent: "border-accent/40 bg-accent/15 text-accent",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
```

4. Note: `glow-soft` referenced by the Button `default` variant is provided by `.glow-primary` semantics; rename it to the utility defined in V1 by editing the Button variant string to `glow-primary`. (Keep the component's contract; use the token utility that exists.)

**Test (typecheck):**

```bash
cd /mnt/data/git/pi-mega-compact/extensions/dashboard-client && npm run typecheck
```

**Expected output:** exits 0.

## Task 2.4 — shadcn primitives (Tabs, Switch, Toggle, Tooltip, Select)

**Files:**
- Create: `extensions/dashboard-client/src/components/ui/tabs.tsx`
- Create: `extensions/dashboard-client/src/components/ui/switch.tsx`
- Create: `extensions/dashboard-client/src/components/ui/toggle.tsx`
- Create: `extensions/dashboard-client/src/components/ui/tooltip.tsx`
- Create: `extensions/dashboard-client/src/components/ui/select.tsx`

1. Create `tabs.tsx` (Radix Tabs, used for advanced-group sub-navigation in Sidebar):

```tsx
import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "../../utils/cn";

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn("inline-flex items-center gap-1 rounded-lg bg-bg-elevated p-1", className)}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium text-muted transition-all hover:text-foreground data-[state=active]:bg-primary/15 data-[state=active]:text-neon",
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = TabsPrimitive.Content;

export { Tabs, TabsList, TabsTrigger, TabsContent };
```

2. Create `switch.tsx` (Radix Switch, for settings toggles):

```tsx
import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";
import { cn } from "../../utils/cn";

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    ref={ref}
    className={cn(
      "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-border transition-colors data-[state=checked]:bg-primary data-[state=unchecked]:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none block h-4 w-4 rounded-full bg-foreground shadow-lg transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0.5",
      )}
    />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
```

3. Create `toggle.tsx` (simple two-state pill toggle used in tab/toolbar groups):

```tsx
import * as React from "react";
import { cn } from "../../utils/cn";

export interface ToggleProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  pressed?: boolean;
  onPressedChange?: (pressed: boolean) => void;
}

export function Toggle({ pressed, onPressedChange, className, onClick, ...props }: ToggleProps) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={(e) => {
        onClick?.(e);
        onPressedChange?.(!pressed);
      }}
      className={cn(
        "inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium transition-all",
        pressed
          ? "border-primary/50 bg-primary/15 text-neon glow-primary"
          : "border-border bg-transparent text-muted hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}
```

4. Create `tooltip.tsx`:

```tsx
import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "../../utils/cn";

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 overflow-hidden rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-xs text-foreground shadow-panel",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
```

5. Create `select.tsx` (Radix Select, minimal subset):

```tsx
import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check } from "lucide-react";
import { cn } from "../../utils/cn";

const Select = SelectPrimitive.Root;
const SelectValue = SelectPrimitive.Value;

const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      "flex h-9 w-full items-center justify-between rounded-md border border-border bg-bg-elevated px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/60",
      className,
    )}
    {...props}
  >
    {children}
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      className={cn("z-50 min-w-[8rem] overflow-hidden rounded-md border border-border bg-bg-elevated text-foreground shadow-panel", className)}
      {...props}
    >
      <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-pointer select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm text-foreground focus:bg-primary/15 focus:text-neon data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="h-4 w-4" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

export { Select, SelectValue, SelectTrigger, SelectContent, SelectItem };
```

**Test (typecheck):**

```bash
cd /mnt/data/git/pi-mega-compact/extensions/dashboard-client && npm run typecheck
```

**Expected output:** exits 0. Radix peer deps resolve.

## Task 2.5 — Tab registry (single source of truth)

**Files:**
- Create: `extensions/dashboard-client/src/tabs/registry.ts`
- Modify: `extensions/dashboard-client/src/App.tsx` (import registry; remove inline defs)

1. Create `src/tabs/registry.ts`. It owns `TabId`, `TabDef` (now with `icon`), `PRIMARY_TABS`, `ADVANCED_TABS`, and `advancedTabIds`. Keep labels byte-identical to the current defs:

```ts
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
  FolderTree,
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
  | "topics"
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
  { id: "topics", label: "Topics", icon: FolderTree },
  { id: "maintenance", label: "Maintenance", icon: Wrench },
  { id: "memory-map", label: "Memory Map", icon: Network },
];

export const ADVANCED_TAB_IDS: ReadonlySet<TabId> = new Set(
  ADVANCED_TABS.map((t) => t.id),
);
```

2. Modify `extensions/dashboard-client/src/App.tsx`:
   - Replace the inline `TabId`/`TabDef`/`PRIMARY_TABS`/`ADVANCED_TABS`/`advancedTabIds` definitions (lines 30–64) with imports from `./tabs/registry`.
   - Keep the lazy-loaded tab components and the `useApi` snapshot logic untouched.

```tsx
// extensions/dashboard-client/src/App.tsx — Dashboard shell layout.
import React, { useState, useCallback } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { TabBar } from "./components/TabBar";
import { LoadingSpinner } from "./components/LoadingSpinner";
import { useApi } from "./hooks/useApi";
import { fetchSnapshot } from "./api/client";
import type { SnapshotResponse } from "@contracts";
import {
  PRIMARY_TABS,
  ADVANCED_TABS,
  ADVANCED_TAB_IDS,
  type TabId,
} from "./tabs/registry";

/* ...lazy tab component declarations unchanged (OverviewTab … HealthTab) ... */

export default function App(): React.ReactElement {
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const {
    data: snapshot,
    loading,
    error,
  } = useApi<SnapshotResponse>(
    useCallback(() => fetchSnapshot(), []),
    {
      pollInterval: 5000,
    },
  );

  const tier = snapshot?.tier ?? "unknown";
  const version = snapshot?.model?.name ?? "";

  return (
    <ErrorBoundary>
      <div className="dashboard-app">
        <header className="dashboard-header">
          <h1>
            mega-compact dashboard
            <span className="tier">{tier}</span>
            {version && <span className="version-pill">{version}</span>}
          </h1>
        </header>
        <TabBar
          primaryTabs={PRIMARY_TABS}
          advancedTabs={ADVANCED_TABS}
          advancedTabIds={ADVANCED_TAB_IDS}
          active={activeTab}
          onTabChange={setActiveTab}
        />
        <main className="dashboard-content">
          {/* ...tab render switch unchanged... */}
        </main>
      </div>
    </ErrorBoundary>
  );
}
```

3. `TabBarProps` expects `{ id: TabId; label: string }`. Registry `TabDef` now has an extra `icon` field — structurally compatible (extra fields are allowed when passing the array), so `TabBar.tsx` compiles **without modification**. This keeps flag-OFF path byte-identical.

**Test (typecheck + smoke):**

```bash
cd /mnt/data/git/pi-mega-compact/extensions/dashboard-client && npm run typecheck && cd /mnt/data/git/pi-mega-compact && npm run build:dashboard && node scripts/dashboard-tab-smoke.mjs
```

**Expected output:** typecheck exits 0; build succeeds; smoke passes all 12 tabs.

## Task 2.6 — Sidebar, BottomBar, AppShell

**Files:**
- Create: `extensions/dashboard-client/src/components/layout/Sidebar.tsx`
- Create: `extensions/dashboard-client/src/components/layout/BottomBar.tsx`
- Create: `extensions/dashboard-client/src/components/layout/AppShell.tsx`

1. Create `src/components/layout/Sidebar.tsx` — desktop badge-tile sidebar (hidden below `lg`). Renders primary tiles, then an Advanced group that collapses/expands:

```tsx
import React, { useState } from "react";
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
      >
        Advanced
        <ChevronDown
          className={cn("h-4 w-4 transition-transform", advancedOpen && "rotate-180")}
        />
      </button>
      {advancedOpen && (
        <div className="mt-1 flex flex-col gap-1">
          {ADVANCED_TABS.map((tab) => (
            <Tile key={tab.id} tab={tab} />
          ))}
        </div>
      )}
    </aside>
  );
}
```

2. Create `src/components/layout/BottomBar.tsx` — mobile bottom nav with a "More" sheet (shown `< lg`, hidden on desktop). Uses a Radix Select-style popover via the `Tabs`/`Select` primitives; simplest robust form is a controlled popover panel:

```tsx
import React, { useState } from "react";
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
```

3. Create `src/components/layout/AppShell.tsx` — composes header, sidebar, tab content, bottom bar:

```tsx
import React from "react";
import type { SnapshotResponse } from "@contracts";
import { Sidebar } from "./Sidebar";
import { BottomBar } from "./BottomBar";
import { cn } from "../../utils/cn";
import type { TabId } from "../../tabs/registry";

interface AppShellProps {
  active: TabId;
  onTabChange: (id: TabId) => void;
  snapshot: SnapshotResponse | undefined;
  children: React.ReactNode;
}

export function AppShell({ active, onTabChange, snapshot, children }: AppShellProps) {
  const tier = snapshot?.tier ?? "unknown";
  const version = snapshot?.model?.name ?? "";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-[1600px] gap-6 px-4 py-4">
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
              <span className={cn("rounded-md border border-border bg-bg-elevated px-2 py-0.5 text-xs text-muted")}>
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
```

**Test (typecheck):**

```bash
cd /mnt/data/git/pi-mega-compact/extensions/dashboard-client && npm run typecheck
```

**Expected output:** exits 0.

## Task 2.7 — Gate App.tsx on NEW_UI

**Files:**
- Modify: `extensions/dashboard-client/src/App.tsx`

1. Split the current default `App` into an `OldDashboard` (the current render, unchanged) and the `App` shell that branches on `NEW_UI()`. Keep the existing body of the old render in `OldDashboard` verbatim so flag-OFF is byte-identical:

```tsx
import { NEW_UI } from "./config";

/* ...lazy imports + registry imports unchanged... */

/* Old render — byte-identical to today's export default body. */
function OldDashboard(): React.ReactElement {
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const {
    data: snapshot,
    loading,
    error,
  } = useApi<SnapshotResponse>(
    useCallback(() => fetchSnapshot(), []),
    { pollInterval: 5000 },
  );

  const tier = snapshot?.tier ?? "unknown";
  const version = snapshot?.model?.name ?? "";

  return (
    <ErrorBoundary>
      <div className="dashboard-app">
        <header className="dashboard-header">
          <h1>
            mega-compact dashboard
            <span className="tier">{tier}</span>
            {version && <span className="version-pill">{version}</span>}
          </h1>
        </header>
        <TabBar
          primaryTabs={PRIMARY_TABS}
          advancedTabs={ADVANCED_TABS}
          advancedTabIds={ADVANCED_TAB_IDS}
          active={activeTab}
          onTabChange={setActiveTab}
        />
        <main className="dashboard-content">
          <React.Suspense fallback={<LoadingSpinner />}>
            {activeTab === "overview" && (
              <OverviewTab snapshot={snapshot} loading={loading} error={error} />
            )}
            {activeTab === "repos" && <ReposTab />}
            {activeTab === "events" && <EventsTab />}
            {activeTab === "setup" && <SetupTab />}
            {activeTab === "metrics" && <MetricsTab />}
            {activeTab === "cache" && <CacheTab />}
            {activeTab === "sessions" && <SessionsTab />}
            {activeTab === "topics" && <TopicsTab />}
            {activeTab === "turns" && <TurnsTab />}
            {activeTab === "maintenance" && <MaintenanceTab />}
            {activeTab === "memory-map" && <MemoryMapTab />}
            {activeTab === "health" && <HealthTab />}
          </React.Suspense>
        </main>
      </div>
    </ErrorBoundary>
  );
}

/* New shell — used when NEW_UI() is true. */
function NewDashboard(): React.ReactElement {
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const {
    data: snapshot,
    loading,
    error,
  } = useApi<SnapshotResponse>(
    useCallback(() => fetchSnapshot(), []),
    { pollInterval: 5000 },
  );

  return (
    <AppShell active={activeTab} onTabChange={setActiveTab} snapshot={snapshot}>
      <React.Suspense fallback={<LoadingSpinner />}>
        {activeTab === "overview" && (
          <OverviewTab snapshot={snapshot} loading={loading} error={error} />
        )}
        {activeTab === "repos" && <ReposTab />}
        {activeTab === "events" && <EventsTab />}
        {activeTab === "setup" && <SetupTab />}
        {activeTab === "metrics" && <MetricsTab />}
        {activeTab === "cache" && <CacheTab />}
        {activeTab === "sessions" && <SessionsTab />}
        {activeTab === "topics" && <TopicsTab />}
        {activeTab === "turns" && <TurnsTab />}
        {activeTab === "maintenance" && <MaintenanceTab />}
        {activeTab === "memory-map" && <MemoryMapTab />}
        {activeTab === "health" && <HealthTab />}
      </React.Suspense>
    </AppShell>
  );
}

export default function App(): React.ReactElement {
  return NEW_UI() ? <NewDashboard /> : <OldDashboard />;
}
```

2. Because both branches mount under the same `<ErrorBoundary>` wrapper is fine to leave outside per-component; each branch renders its own ErrorBoundary (as the original did) — `NewDashboard` may omit the ErrorBoundary duplication and let `AppShell` content be guarded, but keep the original `OldDashboard`'s ErrorBoundary verbatim.

**Test (full build + smoke + flag verification):**

```bash
# Default (ON) path
cd /mnt/data/git/pi-mega-compact && npm run build:dashboard && node scripts/dashboard-tab-smoke.mjs
```

**Expected output:** build succeeds; smoke passes all 12 tabs.

```bash
# Flag-OFF path — server injects window.MEGACOMPACT_NEW_UI=false.
# Verify the client branch: temporarily set the flag and confirm OldDashboard renders.
cd /mnt/data/git/pi-mega-compact && MEGACOMPACT_NEW_UI_DISABLED=1 node scripts/dashboard-tab-smoke.mjs
```

**Expected output:** smoke still exercises the same tabs (renders OldDashboard), passes without failures — confirming the flag-OFF code path is intact and not broken by the new registry.

## Task 2.8 — V2 commit

```bash
cd /mnt/data/git/pi-mega-compact && git add extensions/dashboard-client/src/config.ts src/config.ts extensions/dashboard-server.ts extensions/dashboard-client/src/components/ui extensions/dashboard-client/src/components/layout extensions/dashboard-client/src/tabs/registry.ts extensions/dashboard-client/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): shadcn shell + NEW_UI flag (V2)

Add client/server NEW_UI flag (ragEnabled pattern), shadcn/ui primitives,
tab registry (single source of truth), and Sidebar/BottomBar/AppShell.
Flag-OFF renders the legacy dashboard byte-identical.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

**Expected output:** commit created with AI-attribution trailer; pre-commit gate passes.

---

# Sprint V3 — Tab Migration (Tailwind + shadcn across all 12 tabs)

> Goal: convert each tab's outer shell (container, sub-nav, cards, badges) to Tailwind + shadcn primitives, reusing the shared `Card`/`Badge`/`Button`/`Switch`. Per-tab data visualization internals (recharts, gauges) are left as-is unless they already use shared card chrome. Every task here is a small, verifiable change.

> TDD/contract note: tabs are verified via `dashboard-tab-smoke.mjs` (they must still mount and render) and `npm run typecheck` after each migration. The smoke script is the contract; a tab migration that breaks mounting is a failed task.

## Task 3.1 — Overview tab

**Files:**
- Modify: `extensions/dashboard-client/src/tabs/OverviewTab.tsx`

1. Replace the tab's outermost container with the vbrainstorm shell. Concretely, change the root element from `.overview`/legacy class to Tailwind utilities, and wrap the summary tiles in shadcn `Card` components:

```tsx
// Within OverviewTab render — replace the legacy root container:
<div className="flex flex-col gap-4">
  <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
    <SummaryTiles snapshot={snapshot} loading={loading} error={error} />
  </div>
  <Card>
    <CardHeader>
      <CardTitle>Overview</CardTitle>
    </CardHeader>
    <CardContent>{/* existing overview content unchanged */}</CardContent>
  </Card>
</div>
```

> Keep the exact data + subcomponents (`SummaryTiles`, trend cards) unchanged; only the chrome (root container + card wrappers) migrates. Where a component like `SummaryTiles` already renders its own `card-grid`, replace `card-grid` with `grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4`.

2. Repeat the chrome swap for each sub-card that uses `.card-grid`/`.panel` primitives → `Card` + Tailwind grid.

**Test:**

```bash
cd /mnt/data/git/pi-mega-compact/extensions/dashboard-client && npm run typecheck && cd /mnt/data/git/pi-mega-compact && npm run build:dashboard && node scripts/dashboard-tab-smoke.mjs
```

**Expected output:** Overview still passes the smoke (mounts + renders); typecheck 0; build succeeds.

## Task 3.2 — Cache tab

**Files:**
- Modify: `extensions/dashboard-client/src/tabs/CacheTab.tsx`
- Modify: `extensions/dashboard-client/src/components/CacheHitsCard.tsx`, `CacheStatusPerModel.tsx`, `ProviderCacheCard.tsx`, `CacheHitRateTrendCard.tsx`

1. Swap `CacheTab`'s root `data-something-grid`/`.card-grid` to Tailwind grid; wrap stat cards in `Card`/`CardHeader`/`CardContent`. For table-like providers list, use `Badge` for statuses:

```tsx
<div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
  <Card>
    <CardHeader><CardTitle>Cache Hits</CardTitle></CardHeader>
    <CardContent>
      {/* existing cache-hit content */}
      <Badge variant="success">HIT</Badge>
      <Badge variant="muted">MISS</Badge>
    </CardContent>
  </Card>
  {/* …other cache cards… */}
</div>
```

**Test:** same commands as Task 3.1. Expected: Cache tab still mounts; smoke passes.

## Task 3.3 — Sessions tab

**Files:**
- Modify: `extensions/dashboard-client/src/tabs/SessionsTab.tsx`
- Modify: `extensions/dashboard-client/src/components/SessionsMemoryChart.tsx`, `ActiveSessionsTable.tsx`, `SessionContextGauges.tsx`, `SessionInfo.tsx`

1. Wrap the sessions layout (chart + active table + per-session gauges) in the Tailwind grid and `Card` chrome. Keep `SessionsMemoryChart` recharts internals unchanged; only its container becomes a `Card`.

**Test:** same commands. Expected: Sessions still mounts; smoke passes.

## Task 3.4 — Turns tab

**Files:**
- Modify: `extensions/dashboard-client/src/tabs/TurnsTab.tsx`

1. Convert the turns list/timeline container to Tailwind list utilities; turn rows become `Card`-styled rows with `Badge` for turn status. Preserve all existing data fields and event handlers.

**Test:** same commands. Expected: Turns still mounts; smoke passes.

## Task 3.5 — Health tab

**Files:**
- Modify: `extensions/dashboard-client/src/tabs/HealthTab.tsx`

1. Swap health indicator cards to `Card` + status `Badge` (`success`/`warning`/`danger` mapping to health states). Keep any live-status polling/SSE wiring unchanged.

**Test:** same commands. Expected: Health still mounts; smoke passes.

## Task 3.6 — Repos tab

**Files:**
- Modify: `extensions/dashboard-client/src/tabs/ReposTab.tsx`
- Modify: `extensions/dashboard-client/src/components/RepoTable.tsx`, `ActiveReposTable.tsx`, `RepoAllSessionsCard.tsx`, `RepoContextStack.tsx`, `RepoDetailModal.tsx`

1. Convert the repos table container and row hover to Tailwind; rows use `electric-hover`; repo badge/status uses `Badge`. `RepoDetailModal` keeps its accessibility/keydown behavior; only styling classes change.

**Test:** same commands. Expected: Repos still mounts; smoke passes.

## Task 3.7 — Events tab

**Files:**
- Modify: `extensions/dashboard-client/src/tabs/EventsTab.tsx`
- Modify: `extensions/dashboard-client/src/components/EventStream.tsx`, `EventCategoryFilter.tsx`

1. Convert the event stream container and category filter chips to Tailwind. Filter chips become `Toggle`/`Badge` buttons; the stream list uses Tailwind list + `mono` font for event payloads (matches `font-mono`).

**Test:** same commands. Expected: Events still mounts; smoke passes.

## Task 3.8 — Setup tab

**Files:**
- Modify: `extensions/dashboard-client/src/tabs/SetupTab.tsx`

1. Convert the setup form/section containers to `Card` + Tailwind spacing; form inputs that mirror shadcn `Select`/`Switch` are migrated to the UI primitives where they are simple toggles/filters. Keep any submit/validation logic unchanged.

**Test:** same commands. Expected: Setup still mounts; smoke passes.

## Task 3.9 — Metrics tab

**Files:**
- Modify: `extensions/dashboard-client/src/tabs/MetricsTab.tsx`
- Modify: `extensions/dashboard-client/src/components/PerfCards.tsx`, `PerfChart.tsx`, `LegendCard.tsx`

1. Wrap metric cards and perf charts in `Card` chrome; legends become `Badge`/muted text. Keep recharts internals unchanged.

**Test:** same commands. Expected: Metrics still mounts; smoke passes.

## Task 3.10 — Topics tab

**Files:**
- Modify: `extensions/dashboard-client/src/tabs/TopicsTab.tsx`

1. Convert the topic list container to Tailwind; topic counts use `Badge`. Preserve data + handlers.

**Test:** same commands. Expected: Topics still mounts; smoke passes.

## Task 3.11 — Maintenance tab

**Files:**
- Modify: `extensions/dashboard-client/src/tabs/MaintenanceTab.tsx`
- Modify: `extensions/dashboard-client/src/tabs/MaintenanceTab/ActionsCard.tsx` (if present)

1. Convert the action buttons to `Button` (danger/outline variants for destructive/admin actions) and containers to `Card`. Keep `window.confirm` flows untouched. *(The ActionsCard is referenced under `tabs/MaintenanceTab/`; confirm the actual file path — `ls` earlier showed a `MaintenanceTab` subdir.)*

**Test:** same commands. Expected: Maintenance still mounts; smoke passes.

## Task 3.12 — Memory Map tab

**Files:**
- Modify: `extensions/dashboard-client/src/tabs/MemoryMapTab.tsx`
- Modify: `extensions/dashboard-client/src/memory-map-layout.ts`, `memory-map-shapes.tsx`

1. Convert the memory-map layout containers / legend to Tailwind + `Card`; keep the graph/shape rendering logic (`memory-map-shapes.tsx`) unchanged — these are bespoke SVG canvas code, not CSS-chrome.

**Test:** same commands. Expected: Memory Map still mounts; smoke passes.

## Task 3.13 — V3 full gate + commit

**Test (full gate, after all tab migrations):**

```bash
cd /mnt/data/git/pi-mega-compact && npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all && node scripts/guardrails-scan.mjs && npm run build:dashboard && node scripts/dashboard-tab-smoke.mjs
```

**Expected output:** build passes; all `node --test` tests pass; lint clean; regression_check reports all checks pass; guardrails-scan no violations; dashboard build succeeds; tab smoke passes all 12 tabs.

**Commit:**

```bash
cd /mnt/data/git/pi-mega-compact && git add extensions/dashboard-client/src/tabs extensions/dashboard-client/src/components
git commit -m "$(cat <<'EOF'
feat(dashboard): migrate all 12 tabs to Tailwind + shadcn (V3)

Convert tab chrome (containers, cards, badges, buttons, filters) to the
vbrainstorm Tailwind + shadcn system. Tab mount/render verified by tab smoke.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

**Expected output:** commit created; full gate green.

---

# Sprint V4 — Cleanup + Polish + Verify

> Goal: remove superseded hand-written CSS that no tab references under NEW_UI, apply polish, and run the definitive verification (flag ON + working, flag OFF + working).

## Task 4.1 — Audit legacy CSS usage

**Files:**
- Read: `extensions/dashboard-client/src/styles/*.css`

1. Grep the migrated tabs/components for each legacy class in `base.css` + per-tab stylesheets to determine what is still referenced:

```bash
cd /mnt/data/git/pi-mega-compact/extensions/dashboard-client/src && for f in styles/*.css; do echo "== $f =="; grep -oE '\.[a-zA-Z0-9_-]+' "$f" | sort -u | head -40; done
```

**Expected output:** a per-file list of the class selectors defined, to be matched against usage. Remove a stylesheet only if *no* migrated source file references any of its selectors AND flag-OFF does not need it. Because **flag-OFF must stay byte-identical**, legacy stylesheets are deleted ONLY in the V4 migration step after confirming each one is unused by `OldDashboard` too — otherwise keep them.

## Task 4.2 — Consolidate removed CSS

**Files:**
- Modify: `extensions/dashboard-client/src/main.tsx`
- Delete: unused `styles/*.css` files (only those flagged as fully unused in Task 4.1)

1. Remove the now-unused legacy CSS imports from `main.tsx`:

```tsx
import "./styles/index.css"; // Tailwind + design tokens (kept)
// Remove individual per-tab legacy sheets that are confirmed unused:
// e.g. delete:  overview-events.css, turns.css, cache.css, … (only confirmed-unused ones)
```

> **YAGNI/note:** Do NOT delete `base.css` if anything still references it — e.g. ErrorBoundary, LoadingSpinner, or the flag-OFF `OldDashboard` shell rely on shared tokens there. Only burn down sheets confirmed dead in 4.1.

2. Ensure the A11y baseline is preserved: the new shell still provides `aria-selected`/`aria-expanded`/`role="tablist"` where the old TabBar did (Sidebar/BottomBar carry these). Audit with the accessibility lens in 4.4.

**Test:**

```bash
cd /mnt/data/git/pi-mega-compact && npm run build:dashboard && node scripts/dashboard-tab-smoke.mjs
```

**Expected output:** build + smoke pass with reduced CSS set.

## Task 4.3 — Polish (focus rings, hover lift, empty states)

**Files:**
- Modify: `extensions/dashboard-client/src/styles/index.css` (if needed)
- Modify: any tab container revealed as missing `focus-visible` chrome

1. Confirm every interactive element (buttons, tiles, switches, selects) has a `focus-visible` ring. The shared `electric-hover` and shadcn primitives already provide these; add a small `@layer components` rule if any bespoke element lacks one:

```css
@layer base {
  :where(button, [role="tab"], a):focus-visible {
    outline: 2px solid hsl(var(--primary) / 0.6);
    outline-offset: 2px;
  }
}
```

**Test:** manual visual pass (optional) + rerun smoke.

```bash
cd /mnt/data/git/pi-mega-compact && npm run build:dashboard && node scripts/dashboard-tab-smoke.mjs
```

**Expected output:** passes.

## Task 4.4 — Accessibility audit (A11y)

**Files:**
- Read: the new `components/layout/*`, `components/ui/*`, `tabs/registry.ts`

1. Verify semantics against WCAG:
   - `<nav role="tablist">`/`role="tab"` + `aria-selected` on Sidebar tiles and BottomBar buttons (present in code in 2.6).
   - `aria-expanded` on the Advanced collapse and More sheet toggles.
   - Color: `--muted` text on `--bg-card`/`--bg` meets contrast for body text; primary-neon on dark satisfies AA for large/icon text.
   - Keyboard: all interactive elements focusable and operable (buttons, not divs).
   - Tooltip/Select portal content has proper labels; Radix handles focus-trap for Select.

**Test (automated harness if available; otherwise manual checklist):** run `node scripts/dashboard-tab-smoke.mjs` plus a manual keyboard-tab-through of the new Sidebar/BottomBar.

**Expected output:** no new focus/keyboard regressions; tab smoke passes.

## Task 4.5 — Feature-flag verification (both directions)

**Files:** none (verification only).

1. **Flag ON (default):** confirm the new shell renders.

```bash
cd /mnt/data/git/pi-mega-compact && npm run build:dashboard && node scripts/dashboard-tab-smoke.mjs
```

**Expected output:** smoke passes all 12 tabs through the new shell.

2. **Flag OFF:** confirm OldDashboard still renders and inherits the same tab data:

```bash
cd /mnt/data/git/pi-mega-compact && MEGACOMPACT_NEW_UI_DISABLED=1 node scripts/dashboard-tab-smoke.mjs
```

**Expected output:** smoke passes all 12 tabs (OldDashboard path), confirming ON/OFF parity and that the flag toggle does not break navigation.

3. Confirm the OPT-OUT env is honored end-to-end by checking the server-injected flag resolves correctly (server reads root `NEW_UI()`, client reads `window.MEGACOMPACT_NEW_UI`).

## Task 4.6 — Full gate + typecheck + file-size compliance

**Test (definitive gate):**

```bash
cd /mnt/data/git/pi-mega-compact && npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all && node scripts/guardrails-scan.mjs
```

**Expected output:** all gates green; `regression_check.py --all` passes; `guardrails-scan.mjs` reports no violations (in particular NO PREVENT-PI-004 network violation and no file over the line limits).

**File-size check:**

```bash
cd /mnt/data/git/pi-mega-compact/extensions/dashboard-client/src && for f in $(find . -name '*.ts' -o -name '*.tsx'); do n=$(wc -l < "$f"); if [ "$n" -ge 500 ]; then echo "OVER: $f ($n)"; fi; done; echo "size check done"
```

**Expected output:** `size check done` with no `OVER:` lines (all new files comfortably under 500; pointer/shell pattern honored).

## Task 4.7 — V4 commit + optional release

```bash
cd /mnt/data/git/pi-mega-compact && git add extensions/dashboard-client/src/styles extensions/dashboard-client/src/main.tsx extensions/dashboard-client/src/styles/index.css
git commit -m "$(cat <<'EOF'
feat(dashboard): cleanup + polish + flag verification (V4)

Burn down unused legacy CSS, add focus-visible polish, verify NEW_UI
ON/OFF parity, and pass the full regression gate.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

**Expected output:** commit created. (Do NOT bump/publish unless requested; publishing a new package version runs through `./scripts/deploy.sh <version>` per the release pipeline — out of scope for this migration plan.)

---

## Acceptance criteria

1. `npm run build:dashboard` succeeds.
2. `node scripts/dashboard-tab-smoke.mjs` passes all 12 tabs (both ON and `MEGACOMPACT_NEW_UI_DISABLED=1`).
3. Full gate green: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all && node scripts/guardrails-scan.mjs`.
4. `MEGACOMPACT_NEW_UI_DISABLED=1` renders the byte-identical legacy dashboard (flag-OFF parity).
5. No network calls at runtime (PREVENT-PI-004) — the flag is a server-side String replace + local boolean.
6. All new files under 500 lines; tabs live in `tabs/registry.ts` as the single source of truth consumed by both `TabBar` (old) and `Sidebar`/`BottomBar` (new).
7. Desktop shows badge-tile Sidebar; mobile shows BottomBar + More sheet.

## Risks / mitigations

- **Vite PostCSS discovery:** PostCSS config in the Vite root is auto-detected; if build fails to apply Tailwind, confirm `tailwind.config.js` `content` glob and that `vite.config.ts` `root: "src"` doesn't shadow the postcss config path (config files live at package root, not `src/`).
- **Radix peer range:** `@radix-ui/react-select@^2.x` targets React 18 — confirm `npm install` resolves peers without requiring React 19; if it does, pin the last `^1.x` Select.
- **Registry breaking TabBar:** adding the `icon` field to `TabDef` keeps `TabBarProps` compatible (structural typing allows extra props); confirmed by typecheck in 2.5.
- **CSS burn-down risk to flag-OFF:** legacy stylesheets are removed only when confirmed unused by BOTH the new shell and OldDashboard; otherwise they stay imported (V4 Task 4.1/4.2).
- **`glow-soft` naming:** the Button variant references a utility; align it to the actual `glow-primary` utility defined in V1 during Task 2.3 to avoid a dead class.

## Follow-ups (out of scope for Spec 1)

- Re-theming internal data visualizations (recharts series colors, context gauges) with the full vbrainstorm palette.
- Themed dashboard-vs-extension parity for the `--accent` violet across both charts and the light/dark picker.
- Dark/light design-token toggle (C3 theme picker parity) using the same HSL tokens.
