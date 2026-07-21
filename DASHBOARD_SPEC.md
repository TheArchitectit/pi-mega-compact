# Dashboard React Parity Spec — v0.8.13

## Problem

The old static dashboard (`extensions/dashboard-server/html.ts`, 1071 lines) shows rich data.
The React rewrite (`extensions/dashboard-client/`) ships 5 shallow tab stubs — a regression.
The user pasted the old dashboard's full output; React must match it AND add 3 new tabs.

## Scope (8 tabs total)

### Existing tabs to FLESH OUT (match old html.ts fields + tooltips)

**1. OverviewTab** (`src/tabs/OverviewTab.tsx`)
Render these cards in a responsive grid (use existing components where present):

- **Context Window** card: percent meter (color: green<70 / yellow<90 / red), tokens/contextWindow sub. → `ContextGauge.tsx`
- **Trigger Status** card: 2 bullets (Armed=ctx≥fastgate, Ready=tokens≥threshold) + state text. → `TriggerStatus.tsx`
- **Vector Store** card (session): Checkpoints, Original(dropped), Kept(summaries), Freed(dropped−kept), Injected, Recall Relevance %, Storage Dedup %, Collapsed, Last ID + compression meter bar. → `CompressionCard.tsx`
- **Repo (all sessions)** card: same fields but repo-level + Sessions. → reuse CompressionCard variant or new.
- **🛡 Data Safety** card: Regions Retained, Compressed-Original (bytes), Dedup Duplicates, Permanently Deleted (always "0 B" green). → `DataSafetyCard.tsx`
- **Configuration** card: Tier(live), Preset, Pressure, Threshold, Fast Gate, Auto, Anchor. → new `ConfigSummary.tsx` or inline.
- **💰 Model & Cost Savings** card: $ saved, context-windows extended, Model, Provider, Input Rate, Output Rate. → `CacheStatusPerModel.tsx` / `ModelBadge.tsx`
- **Crew / Agents** card: Active Agents, Current Turn, Status. → `SessionInfo.tsx`
- **"What these numbers mean"** legend card (collapsible <details>).

**2. ReposTab** (`src/tabs/ReposTab.tsx`)

- **All Repositories** table: Repo, Model, Checkpoints, Tokens Saved, Retained, Last Compacted. → `RepoTable.tsx`
- **Active Repos — Live Cache Hits & Compactions** table: Repo, Model, Tier, Context %, State, Compactions(s/t), Cache Hits(s/t), Compact s/t(s), CacheHit s/t(s). (from `/api/servers`)
- **Per-repo detail modal** on row click: Model, Checkpoints, Tokens Saved, Compressed-Original, Last Compacted, Provider. → `RepoDetailModal.tsx`
- Summary tiles row: Repositories, Total Checkpoints, Total Tokens Saved, Compressed-Original. → `SummaryTiles.tsx`
- **Savings by Model** table: Model, Provider, Tokens In, Tokens Out, Freed, Ctx Window, Max Out, Reas., Sessions, Checkpoints, In $/tok, Out $/tok, $ Saved, Last Used.

**3. EventsTab** (`src/tabs/EventsTab.tsx`)

- Live event stream (SSE `/api/events` or poll), newest first, max 50. → `EventStream.tsx`
- Category filter chips (all / compact / recall / config / crew / game). → `EventCategoryFilter.tsx`
- Timestamp + event type display.

**4. ConfigTab** (`src/tabs/ConfigTab.tsx`)

- Full configuration editor: Tier(live), Preset, Pressure, Threshold, Fast Gate, Auto, Anchor.
- Game mode toggle, Theme selector, TUI mode (full/minimal). Use `/api/game-state` PUT.
- Tooltips on every label (copy from html.ts `title="..."` attributes).

**5. MetricsTab** (`src/tabs/MetricsTab.tsx`)

- **Perf** cards: Model latency (turn p50/p95, provider p50/p95), Throughput (TPS, cache hit %), Process (RSS, Heap, CPU), Snapshot cost (DB recompute p50/p95, disk write p50), TUI lag proxy (live-trim fires, cache replays, fast-gate skips). From `/api/perf`. → `PerfChart.tsx`
- Time-series chart for perf samples.
- Cache status per model table.

### NEW tabs to ADD

**6. CacheTab** (`src/tabs/CacheTab.tsx`) — NEW

- **💾 Cache Hits & Compactions** card: Cache Hits(session), Cache Hits(total), Tokens Saved(session), Tokens Saved(total), Compactions(session), Compactions(total).
- **⏱ Time Saved (est.)** card: Compact(session), Compact(total), Cache Hit(session), Cache Hit(total).
- Source: `/api/snapshot` (snapshot.cacheHits, snapshot.compacts, snapshot.timeSaved fields).

**7. GameTab** (`src/tabs/GameTab.tsx`) — NEW

- **MEGA CACHE banner** (`#mega-cache-banner`) — animated gradient when unlocked.
- **Opie unlock tile** (achievement-tile) — shown when unlock condition met.
- **High Scores** section header.
- **Leaderboards** (2×2 grid): Cache %, Dedupe (collapsed), Turns, MEGA CACHE trophies. Each: metric leaderboard table from `/api/game-scores?metric=<cache|dedupe|turns|mega_cache>`.
- **Achievements** sub-section (achievement tiles) — delegate to AchievementsTab component.
- Game empty state: "No scores yet — run a session with game mode on."
- Source: `/api/game-scores`, `/api/game-state`, `/api/achievements`.
- Game mode ON → themed styling (use `data-theme` + accent vars).

**8. AchievementsTab** (`src/tabs/AchievementsTab.tsx`) — NEW

- Grid of achievement tiles: each shows name, description, unlocked state (locked/unlocked icon), progress bar if partial.
- Toast notification area for newly-unlocked achievements.
- Source: `/api/achievements` → `AchievementRow[]`.
- Reuse the achievement tile rendering inside GameTab too.

## Responsive scaling (NON-NEGOTIABLE — new)

The dashboard MUST scale fluidly across resolutions and window sizes — from small laptop (1280×720) to ultrawide (3440×1440) to 4K (3840×2160), and resize live without reload. Old `html.ts` had a fixed `max-width: 1200px` which cramped ultrawide and overflowed small windows. Fix this properly.

Requirements:

- **Container**: replace fixed `max-width: 1200px` with a fluid responsive container:
  - `padding: clamp(8px, 2vw, 24px)` (scales with viewport)
  - `max-width: min(1600px, 96vw)` (never fills edge-to-edge on ultrawide, but uses the space)
  - `margin: 0 auto`
- **Breakpoints** (use CSS `@media` + `clamp()` for fluid values, NOT fixed jumps):
  - `≤640px` (phone/narrow): single-column grid, tab labels abbreviate, header wraps, tables scroll horizontally (`.repos { overflow-x: auto }`).
  - `641–1024px` (tablet/small laptop): 2-column grid for cards, leaderboards stack to 1-col.
  - `1025–1600px` (laptop/desktop): 3-column grid, leaderboards 2×2.
  - `>1600px` (ultrawide/4K): 4-column grid for Overview cards, leaderboards 2×2, larger font via `clamp(13px, 0.9vw, 16px)`.
- **Grid**: use `grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr))` so cards wrap naturally and never overflow.
- **Font sizes**: use `clamp()` everywhere — base `font-size: clamp(13px, 0.9vw, 16px)`, headers `clamp(16px, 1.4vw, 22px)`, stat values `clamp(13px, 1vw, 17px)`. No hardcoded `px` font sizes.
- **Tables** (All Repos, Active Repos, Savings by Model): `width: 100%`, `overflow-x: auto` wrapper, sticky header (`position: sticky; top: 0`), `min-width` per column so columns don't crush on narrow screens — scroll horizontally instead of overflowing.
- **Meters** (Context Window, compression bars): `width: 100%`, height via `clamp(6px, 0.6vw, 10px)`.
- **Tab bar**: horizontal scroll on narrow screens (`.tabbar { overflow-x: auto }`), tabs don't wrap (wrap = layout shift).
- **Per-repo modal**: `max-width: min(520px, 92vw)`, `max-height: 86vh; overflow-y: auto`, centered via `inset: 0; margin: auto`.
- **HiDPI**: ensure `1px` borders use `calc(1px * (min(1, 96dpi / device-dpi)))` OR simpler: keep borders but test they don't vanish on retina. Use CSS vars `--border-w: 1px` for tuning.
- **Zoom**: dashboard must survive browser zoom 25%–400% (no fixed-position overlays breaking).
- **Live resize**: every layout uses `%` / `vw` / `clamp()` / `auto-fit` — NO JS resize listeners needed; pure CSS. Verify by resizing the browser window during the demo.
- Add the responsive rules to `src/styles/base.css` (shared shell + tokens) and `src/styles/overview-events.css` / `src/styles/repos-metrics.css` (tab-specific). Keep each CSS file <300 lines per project rule.
- **Verify**: after building, open `dist/index.html` in a browser, drag the window from 400px → 1920px wide → confirm no horizontal scrollbar, no overflow, cards reflow smoothly, tables scroll-x not the page.

## Constraints (NON-NEGOTIABLE)

- **Files < 300 lines** (project rule: prefer <300, split <500). Split big tabs into sub-components under `src/components/`.
- **No new API endpoints** — all wrappers already exist in `src/api/client.ts` (fetchSnapshot, fetchGameScores, fetchAchievements, fetchPerf, fetchServers, fetchSummary, fetchGameState, putGameState, etc.). DO NOT touch server.ts.
- **No `any` types** (PREVENT-011). Use the `@contracts` types already imported in client.ts.
- **PREVENT-PI-004**: only relative-path `fetch()` (already the pattern). Never add absolute URLs.
- **Keep `src/` pi-agnostic** — dashboard-client has its own tsconfig; React components must not import pi runtime types.
- **Copy tooltips verbatim** from `html.ts` `title="..."` attributes — they are user-facing explanations.
- **Don't delete `html.ts`** — it remains the fallback when `dist/` is absent.
- **Styling**: use CSS variables already defined (`--bg`, `--fg`, `--accent`, `--mega`, `--card-bg`, `--border`, `--muted`, `--dim`, `--green`, `--yellow`, `--red`, `--blue`, `--purple`). Add new vars to `src/index.css` if needed. Responsive grid via existing `.grid` / `.card` / `.stat-grid` classes.
- **Polling**: reuse `useApi` hook (5s interval for snapshot; 15s for perf/scores/achievements).

## Acceptance

1. `npm run build:dashboard` succeeds (tsc + vite), zero TS errors, zero `any`.
2. `npm run lint` passes.
3. All 8 tabs render real data from the existing APIs (no "loading…" forever, no empty stubs).
4. Every field the user pasted from the old dashboard is visible in the React app:
   - Context Window %, Trigger Status, Vector Store (9 fields), Repo all-sessions (7 fields), Data Safety (4), Configuration (7), Model & Cost Savings (5 + rate fields), Crew/Agents (3), Cache Hits & Compactions (6), Time Saved (4), All Repositories table, Active Repos table, Savings by Model table, Summary tiles, Event Stream.
   - PLUS Game leaderboards + Achievements tiles.
5. `dist/` builds and is included in the tarball (already fixed via .gitignore + files field).
6. Bump `package.json` version to `0.8.13`.
7. Run `npm run build` (server) + `npm run build:dashboard` (client) + `npm run lint` before reporting done.

## Out of scope

- Do NOT modify `extensions/dashboard-server/server.ts` or any server-side code.
- Do NOT modify `src/` (the pi-extension core) — only `extensions/dashboard-client/`.
- Do NOT add new npm dependencies — React 18 + existing deps suffice.

## Key files (reference)

- OLD dashboard (data source of truth): `extensions/dashboard-server/html.ts` (1071 lines) — read the full `<body>` + the `renderSnapshot`/`renderGameState`/`renderAchievements` JS to see every field + tooltip.
- API client: `extensions/dashboard-client/src/api/client.ts` — all wrappers exist.
- Contracts: `extensions/dashboard-server/api-contracts/` (snapshot.ts, multi-repo.ts, core.ts, endpoints.ts, game.ts, perf.ts, achievements.ts).
- Existing components: `extensions/dashboard-client/src/components/*.tsx` (17 files, mostly stubs).
- Existing tabs: `extensions/dashboard-client/src/tabs/*.tsx` (5 stubs).
- Server endpoints: `/api/snapshot`, `/api/version`, `/api/index`, `/api/repos`, `/api/summary`, `/api/drift`, `/api/servers`, `/api/events` (SSE), `/api/game-state` (GET/PUT), `/api/game-scores`, `/api/perf`, `/api/achievements`.

## Build / verify

```
npm run build:dashboard   # vite build → extensions/dashboard-client/dist/
npm run build            # tsc server + src
npm run lint
```
