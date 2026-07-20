# Game Mode — Gamified Compaction Stats + Theme System (Design Spec v0.2)

- **Status:** design spec (v0.2) — ready for implementation planning
- **Branch:** `game-mode`
- **Scope:** score-tracking fun + a theme/toggle system, **built together** so
  game-mode toggle, themes, and TUI display mode can be tested as one unit.
  A mini-game inside the high-score dashboard is a *later* phase.

## 1. Goal

Make a game out of the stats the app already tracks (turns, dedupe, cache hits,
repo count). Store scores locally and surface them in a new dashboard tab. Add a
**theme system** + a **toggle panel** so the whole thing is visually fun, and the
tester-reported "too retro" default can be swapped, with a **minimalist TUI**
option for users who want less chrome.

## 2. Scoring model — per-metric separate leaderboards

No single global XP/level pool. Each metric is its own score + leaderboard; the
dashboard shows a **scorecard per category**:

| Metric | Score basis | Leaderboard dim |
|--------|-------------|-----------------|
| Cache | cache hit % (and hits) | per repo |
| Dedupe | total bytes/chunks deduped | global (cumulative) |
| Turns | high-score turns | global |
| Repos | repo count badge ("most repos") | global badge |

## 3. MEGA CACHE

- When a session's **cache hit % reaches 100%**, trigger a "level up" fun effect
  for that turn.
- Known display overshoot: cache % can render **> 100%**. **S30.0 finding
  (characterized):** the overshoot is a **genuine ratio >1, NOT a NaN/Infinity
  bug** — `dedupHitRate = injected / cps.length` at `src/vectorStore.ts:748`,
  where the numerator (`injectedCheckpointIds`, marked via `store.markInjected`
  at `src/recall.ts:171,339`) counts **cross-repo / cross-session foreign
  checkpoint IDs** injected into this session, while the denominator
  (`cps.length` = `listCheckpoints(sessionId)`) is only **this session's own
  persisted checkpoints**. Cross-repo recall inflates the numerator without
  inflating the denominator → ratio >1. The same-session path cannot overshoot
  (the `wasInjected` guard dedups `injectedCheckpointIds`).
  **Decision: embrace it, don't fix it** — this is a real signal (cross-repo
  recall is pulling in more than the session produced), so when cache > 100%,
  label it **MEGA CACHE** with an extra/special fun effect. No source clamp
  (that would hide the feature). Render sites (`/mega-status`
  `mega-commands.ts:129,165`, dashboard `html.ts:394`) remain unclamped.
  See `docs/specs/game-mode-sprint-plan.md` QA3.
- **Effect flavor** (per surface):
  - Dashboard (HTML): CSS keyframe flash/pulse + a MEGA CACHE badge/banner.
  - TUI widget (ANSI): color cycle (orange->red blink) on the cache bar + a
    `MEGA CACHE` text flare (lightning bolt glyph where width-safe).
  - No external assets — pure code (CSS keyframes + ANSI escapes).

## 3b. MEGA CACHE overshoot — "oopsie" alert + hidden unlock

When the cache hit % overshoots 100% (the real ratio >1 characterized in
§3 — cross-repo recall inflating the numerator), fire **two** things, both
**hidden until they happen** (they never show in the dashboard or TUI on a
fresh install):

1. **Transient "oopsie" gag** (per-overshoot, not persisted as a banner):
   - TUI: a one-line toast on the widget for that turn —
     `oopsie! cache went to 117% — MEGA CACHE 🥧` (ANSI mega color, flares
     once, then the widget returns to normal on the next render).
   - Dashboard: a transient toast/banner on the Game Mode tab for that turn —
     same copy, CSS mega-flash keyframe, auto-dismisses.
   - No mascot character — it's playful slang, not a named voice. The 🥧 emoji
     is the only "face".

2. **Hidden unlock — "Opie's Wild Ride"** (persisted trophy, the name only
   appears once it's been triggered at least once):
   - A `game_scores` row with `metric='mega_cache'` and `meta` carrying the
     peak overshoot % + the turn ts (QA10 already decided the trophy row;
     this names it).
   - Before the first overshoot ever happens: the dashboard Game Mode tab and
     the `/mega-game` status show **nothing** about it — no locked tile, no
     "???" teaser, no hint it exists. It's a true secret.
   - After the first overshoot: a **"🏆 Opie's Wild Ride"** tile/banner
     appears on the Game Mode tab with the peak % + when it first happened.
     It stays (it's a one-time unlock) and can show the best (highest) peak
     across all sessions.
   - `/mega-game` bare status stays terse — the unlock only surfaces in the
     dashboard, not the TUI command output (keeps the command clean).

Why both: the gag is the *moment* (rewards the overshoot when it happens),
the unlock is the *trophy* (proof it happened, persists for bragging rights).
The hidden-until-triggered rule makes it a real easter egg — a user who
never overshoots never knows it's there.

Implementation home (cross-references the sprint plan):
- Scoring hook (S33.4): when `isMegaCache(cachePct)` and `cachePct > 100`,
  record the `mega_cache` trophy row with the peak % + ts, and set a
  transient `megaCacheFlare` flag on the turn (consumed by the widget +
  dashboard render for that turn only).
- TUI widget (S31.5): render the one-line oopsie gag when the flare is set.
- Dashboard (S34.2): the MEGA CACHE banner shows the oopsie gag on the
  triggering turn; the "Opie's Wild Ride" tile is hidden until a `mega_cache`
  trophy row exists, then shows peak % + first-seen ts.

## 4. Levels on turns

- Every new turn -> the cache bar does a little **level-up** animation.
- Turns display their **level** on them — in both the TUI statusbar widget and
  the dashboard. In minimal TUI mode the level still shows (it's essential),
  just without the bar animation.

## 5. Theme system (visual effect modes)

Six themes for v1. Each theme defines **both** an HTML/CSS palette (dashboard)
**and** an ANSI accent mapping (TUI widget), since the TUI is ANSI and the
dashboard is HTML:

| Theme | Style | Default? |
|-------|-------|----------|
| `transparent` | no bg fill, colored accents only | yes, default |
| `retro` | 8-bit green | (current / "too retro" per tester #1) |
| `orange-bold` | bold orange | |
| `cyan-neon` | cyan/neon | |
| `amber-mono` | warm phosphor amber | |
| `grayscale` | minimal grayscale | |

- **Theme scope = global skin**: the selected theme restyles the **whole
  dashboard HTML page** (all tabs/panels) **and the TUI statusbar widget**.
- **`transparent` (default)** semantics:
  - Dashboard: no `background-color`; default terminal bg shows through.
  - TUI: the widget emits **no ANSI background fill** but still colors the
    **foreground accents** (e.g. level number in green, MEGA CACHE in orange) so
    game-mode stays visible against any terminal bg.

## 6. Toggle panel — three toggles, both surfaces, shared state

Three independent settings, each exposed in **two places** (TUI command +
dashboard panel), all reading/writing the same SQLite state so they stay in sync:

1. **game_mode** (on/off) — master switch for scoring + level-up + MEGA CACHE.
2. **theme** (one of the 6 names) — the visual skin.
3. **tui_display_mode** (`full` | `minimal`) — TUI widget density. `full` =
   current widget (bars, stats, flair). `minimal` = essentials only (e.g.
   level + cache %, one line, no bars/flair). Independent of which theme is
   active; affects the TUI widget only, not the dashboard.

- **TUI command** (`/mega-game`, subcommand flags, within pi's command model):
  - `/mega-game` -> print current state: `{ game_mode, theme, tui_display_mode }`
  - `/mega-game on` / `/mega-game off` -> toggle game mode
  - `/mega-game theme <name>` -> set theme by name
  - `/mega-game theme next` -> cycle to next theme
  - `/mega-game tui full` / `/mega-game tui minimal` -> set TUI display mode
- **Dashboard panel**: a Settings/panel section with all three toggles
  (game-mode switch + theme picker + TUI display-mode picker). Writes go to the
  same SQLite row(s) as the TUI command.

## 7. State storage

- **Global** row in the existing node:sqlite store:
  `{ game_mode_on: boolean, theme: string, tui_display_mode: 'full'|'minimal' }`.
- Single choice across all repos. Survives restarts. Editable from TUI or
  dashboard; both surfaces read the same row -> always in sync.
- **PREVENT-PI-004 clean**: local SQLite only, zero network.
- New SQLite table vs reuse `session_state`/`stats` — open impl question (sec 9).

## 8. Dashboard

- New **Game Mode / High Score** tab: per-metric leaderboards + MEGA CACHE
  highlights + turn-level display.
- The toggle panel (game-mode + theme + TUI display mode) lives in a Settings
  section (exact placement TBD — own tab vs panel within the Game Mode tab).
- Whole page is skinned by the active theme.

## 9. Open implementation questions (resolve before/while building)

1. Persistence schema — new `game_state` table vs reuse `session_state`/`stats`?
2. Score schema — new `game_scores` table(s) for the leaderboards?
3. What counts as a "turn" for scoring — every agent turn, every compaction,
   every session? (aligns with turn_start/turn_end handlers in
   extensions/mega-events/agent-handlers.ts)
4. Per-metric leaderboard dimensions — confirm per-repo (cache) vs global
   (dedupe/turns/repos) vs add time-windowed views later?
5. Does MEGA CACHE persist as a record (trophy case) or stay a transient
   per-turn effect?
6. Where exactly does the dashboard toggle panel sit — own tab vs panel inside
   the Game Mode tab?
7. How does the TUI widget read theme + display mode on each render without a
   perf hit (cached read + reload-on-change)?
8. Theme palette concrete hex/ANSI codes per theme (define in a single source
   of truth, e.g. src/config/themes.ts).
9. Minimal TUI exact contents — which fields make the cut for one-line mode?

## 9b. Achievements (S35)

A proper achievements system on top of the S33 scores + S34 High Score tab.
Each achievement is a named, unlockable badge with a description + a trigger
condition evaluated over the `game_scores` table. Unlocked achievements show
on the Game Mode tab; locked ones show as `???` (teaser) UNLESS the achievement
is marked `hidden` (easter-egg — see Opie's Wild Ride, §3b).

Achievement record (in a new `game_achievements` table, S35.1):
  `{ id TEXT PK, title TEXT, description TEXT, hidden INTEGER, icon TEXT,
     unlocked_at INTEGER NULL }`

Achievement set (v1 — grounded in the metrics S33 already records):

| id | title | trigger | hidden? |
|----|-------|---------|--------|
| `first_blood` | First Blood — first compaction | `compact_count >= 1` (meta) | no |
| `centurion` | Centurion — 100 turns played | `turns` max value >= 100 | no |
| `mega_cache` | Opie's Wild Ride — cache > 100% | `mega_cache` trophy row exists (§3b) | YES (easter egg) |
| `dedup_master` | Dedup Master — 1MB deduped | `dedupe` sum >= 1,048,576 bytes | no |
| `globetrotter` | Globetrotter — recall across 3+ repos | `repos` distinct >= 3 | no |
| `level_10` | Level 10 — reach turn level 10 | `turnLevel(max turns) >= 10` | no |
| `night_owl` | Night Owl — compact after 2am local | a compact with ts hour == 2-4 | no |
| `flawless` | Flawless — 100% cache (no overshoot) | a `cache` score row with value == 100 AND no `mega_cache` row for that turn | no |
| `comeback` | Comeback — compact 5x in one session | 5 `dedupe` rows same session/ts window | no |

Evaluation: a pure `evaluateAchievements(scores)` fn in `src/game/scoring.ts`
(pi-agnostic) returns the unlocked set + newly-unlocked ids. Called from the
S33 scoring hooks (after a score is recorded) + a `/api/achievements` endpoint
(S35). Newly-unlocked achievements fire a one-time toast (same oopsie-gag
pattern from §3b) so the moment of unlock is celebrated.

Hidden achievements: never teased — they only appear on the dashboard once
unlocked (same invariant as Opie's Wild Ride; gated by the `hidden` flag +
`unlocked_at IS NOT NULL`, NOT a feature flag).

## 10. Future (out of scope for v1)

- Mini-game inside the high-score dashboard.
- Time-windowed leaderboards (daily/weekly).
- Per-repo theme overrides (currently global).
