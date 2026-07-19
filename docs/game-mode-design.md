# Game Mode — Gamified Compaction Stats (Design Brainstorm)

- **Status:** brainstorm / design capture (v0.1)
- **Branch:** `game-mode`
- **Scope:** score-tracking fun first; a mini-game inside the high-score dashboard is a *later* phase.

## Goal

Make a game out of the stats the app already tracks (turns, dedupe, cache hits,
repo count). Store scores locally and surface them in a new dashboard tab.

## Scoring model — per-metric separate leaderboards

No single global XP/level pool. Each metric is its own score + leaderboard; the
dashboard shows a **scorecard per category**:

| Metric | Score basis | Leaderboard dim |
|--------|-------------|-----------------|
| Cache | cache hit % (and hits) | per repo |
| Dedupe | total bytes/chunks deduped | global (cumulative) |
| Turns | high-score turns | global |
| Repos | repo count badge ("most repos") | global badge |

## MEGA CACHE

- When a session's **cache hit % reaches 100%**, trigger a "level up" fun effect
  for that turn.
- Known display overshoot: cache % can render **> 100%** (likely a display bug —
  see v0.7.8 `fix(statusbar): cap context % display at ">100%"` which capped the
  *context* %; cache % may still overshoot). **Embrace it, don't fix it:** when
  cache > 100%, label it **MEGA CACHE** with an extra/special fun effect
  (flashing, special color, badge, dashboard banner).

## Levels on turns

- Every new turn → the cache bar does a little **level-up** animation.
- Turns display their **level** on them (statusbar widget and/or dashboard).

## Storage

- All scores stored **locally** via the extension's existing persistence layer
  (node:sqlite, state dir). **No network — honors PREVENT-PI-004.**

## Dashboard

- New **Game Mode / High Score** tab in the dashboard: per-metric leaderboards +
  MEGA CACHE highlights.

## Future (out of scope for now)

- Mini-game inside the high-score dashboard.

## Open questions (resolve before implementation)

1. Per-metric leaderboard dimensions — per-repo vs global vs time-windowed?
2. What counts as a "turn" for scoring — every agent turn, every compaction, every session?
3. Persistence schema — new SQLite table(s) vs reuse `session_state` / `stats`?
4. MEGA CACHE effect specifics — CSS animation? dashboard banner? statusbar flair?
5. Where does the "level on turn" render — statusbar widget, dashboard, or both?
6. Does MEGA CACHE persist as a record (trophy case) or is it a transient per-turn effect?
