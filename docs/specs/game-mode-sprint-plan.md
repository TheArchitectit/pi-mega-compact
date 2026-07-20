# Game Mode + Theme System — QA Review & Sprint Plan

- **Branch:** `game-mode`
- **Spec:** [docs/game-mode-design.md](../game-mode-design.md) (v0.2)
- **Status:** QA-reviewed + sprint-plan ready (no code yet)
- **Sprint series:** S30–S34 (continues the numeric series; latest shipped = S29)
- **Effort scale:** S ≈ ½ day, M ≈ 1 day, L ≈ 2 days

---

## 1. Guardrail Adherence Review

Reviewed against: [docs/AGENT_GUARDRAILS.md](../AGENT_GUARDRAILS.md),
`.guardrails/prevention-rules/pattern-rules.json` (v2.2.0),
`scripts/guardrails-scan.mjs`, `scripts/semantic-scan.mjs`.

| # | Rule | Verdict | Requirement for game-mode code |
|---|------|---------|--------------------------------|
| G1 | **PREVENT-PI-004** (critical: zero remote network) | ✅ Plan is clean | All state/scores in local node:sqlite. The dashboard toggle panel writes via the **existing localhost dashboard server** — new `/api/game-state` endpoints go in `extensions/dashboard-server/server.ts` with `// guardrails-allow PREVENT-PI-004: <reason>` on each `fetch`/http line (matches existing pattern). **No new network paths.** |
| G2 | **PREVENT-PI-004 exclusions list** | ⚠️ Action | `guardrails-scan.mjs` `PI004_EXCLUSIONS` only lists `extensions/dashboard-server.ts` (the barrel). After the v0.7.9 split, network code lives in `extensions/dashboard-server/server.ts`. That submodule is **not excluded** — it passes today via inline `guardrails-allow` annotations. New game-mode endpoints MUST keep that annotation discipline (do NOT rely on exclusion). |
| G3 | **PREVENT-PI-002** (parameterized SQL) | ✅ Plan is clean | All new `game_state` / `game_scores` SQL uses `@param` placeholders, no string concat. |
| G4 | **PREVENT-PI-001** (anchor-floor / no message drops) | N/A | Game mode drops no messages. |
| G5 | **PREVENT-PI-003** (no `role:"system"` injection) | ✅ Plan is clean | Level-up / MEGA CACHE effects are **render-only** (statusbar widget + dashboard HTML). They MUST NOT inject game messages into the agent stream. |
| G6 | **SEMANTIC-001** (unhandled promises) | ⚠️ Action | Dashboard panel JS fetches + async server handlers need `.catch()` / try-catch. TUI command path is sync (node:sqlite is sync) — no promise surface there. |
| G7 | **Test/Prod separation** | ⚠️ Action | All game-mode tests MUST use `MEGACOMPACT_STATE_DIR` override; never touch the real user state dir. Follow existing `*.test.ts` isolation pattern. |
| G8 | **Scope / no feature creep** | ✅ | Each sprint has a tight file list (§4). No unrelated refactors. |
| G9 | **`src/` pi-agnostic** | ⚠️ Action | Theme palettes, scoring math, game-state SQL go in `src/` with NO pi runtime types. Pi command wiring + widget rendering stay in `extensions/`. |
| G10 | **Git safety** (no force-push, single commit, no `--no-verify`) | ✅ | One focused commit per sprint; AI-attribution footer required (pre-commit hook). |
| G11 | **Doc length / maps** | ⚠️ Action | Update `docs/INDEX_MAP.md` + `docs/HEADER_MAP.md` when adding this spec. |
| G12 | **Verification gate** | ✅ | Every sprint exits only when `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all` is green. |

**Verdict:** the v0.2 spec is **adherent**; the ⚠️ items are implementation requirements carried into the sprint TODOs, not spec defects.

---

## 2. QA Review of the v0.2 Spec — Issues & Resolutions

| ID | Issue | Severity | Resolution (locked into sprints) |
|----|-------|----------|--------------------------------|
| QA1 | **"Global TUI skin" is impossible** — pi's TUI is not themeable by an extension; we can only theme **our** mega-compact status widget. | High | **Scope correction:** theme applies to the mega-compact statusbar widget + the whole dashboard HTML page. We do NOT theme pi's chrome. Spec §5 updated in code-level intent. |
| QA2 | **Dashboard theming is a refactor**, not an add. Colors are hardcoded throughout `extensions/dashboard-server/html.ts` (`#161b22`, `#30363d`, …). | High | **S32 refactors `html.ts` to CSS custom properties** on `:root[data-theme]`. One variable layer; all existing rules reference variables. Existing look preserved under a `retro`-equivalent default token set. |
| QA3 | **MEGA CACHE >100% overshoot is uncharacterized.** "Embracing" a NaN/Infinity bug would render garbage. | High | **S30 pre-task:** characterize the overshoot source (cache hit % calc). If it's a genuine ratio >1 (hits > lookups) → embrace + label MEGA CACHE. If it's NaN/Infinity → fix the calc, keep MEGA CACHE label at exactly 100%. Either way the **label + effect** ship; only the ">100%" framing depends on the finding. |
| QA4 | **Widget render hot path** — reading theme from SQLite every render. | Med | **S31:** module-level cached `GameState` with a version counter bumped on write (`/mega-game` + dashboard PUT both bump). Widget reads the cache, never the DB, per render. |
| QA5 | **Toggle panel placement** was TBD (own tab vs panel). | Med | **Decision:** a persistent **settings strip in the dashboard header** (visible on all tabs), holding game-mode on/off + theme picker + TUI display-mode picker. Aligns with "global skin". |
| QA6 | **Minimal TUI contents** were undefined. | Low | **Decision:** minimal mode = one line `LVL n │ cache NN%` (level + cache %, no bars/flair). Level is always shown. |
| QA7 | **Open Q1 (schema)** — new table vs reuse `session_state`. | Med | **Decision:** new `game_state` table, single row (`id=1`). Clean, no pollution of session_state. |
| QA8 | **Open Q2 (score schema).** | Med | **Decision:** new `game_scores` table: `(repo_root TEXT, metric TEXT, ts INTEGER, value REAL, meta TEXT)`, parameterized. |
| QA9 | **Open Q3 (turn definition).** | Med | **Decision:** a "turn" = one agent turn (`turn_start`→`turn_end`), aligned with `extensions/mega-events/agent-handlers.ts`. Score recorded on `turn_end`. |
| QA10 | **Open Q5 (MEGA CACHE persist).** | Low | **Decision:** both — transient per-turn effect **and** a persisted trophy-case row in `game_scores` (`metric='mega_cache'`). |
| QA11 | **"Most repos" badge** has no source for repo count. | Low | **Decision:** derive from the existing cross-repo index (`src/store/sqlite/global-index.ts` `DISTINCT repo_root`). No new storage. |
| QA12 | **No score source for dedupe** is defined. | Low | **Decision:** hook into the existing dedup pipeline result (chunks/bytes deduped) at `session_compact` — read from the existing dedup tier counters. |

---

## 3. Sprint Roadmap (S30–S34)

| Sprint | Goal | Effort | Depends on |
|--------|------|--------|------------|
| **S30** | Foundation: `game_state` table + `src/config/themes.ts` (6 palettes) + `/mega-game` command (state only) + MEGA CACHE overshoot characterization | M | — |
| **S31** | TUI widget theming + full/minimal display modes + level display + MEGA CACHE ANSI effect | M | S30 |
| **S32** | Dashboard CSS-variable skin + `data-theme` switching + header settings strip (3 toggles) + `/api/game-state` endpoints | L | S30 |
| **S33** | Scoring schema + hooks: record cache/dedupe/turns/repos scores on `turn_end`/`session_compact` | M | S30 |
| **S34** | Game Mode / High Score dashboard tab: leaderboards + MEGA CACHE banner + level-up animation + release | L | S32, S33 |

**Total:** ~5.5 days. Built so toggle (S31/S32) + themes test together; scoring (S33) lands in parallel with the UI sprints.

---

## 4. Per-Sprint Detail

### S30 — Foundation: state + themes + command

**Goal:** a working `/mega-game` command backed by SQLite + a single source of truth for theme palettes. No UI changes yet.

**Files (IN scope):**
- `src/store/sqlite/schema.ts` — add `game_state` table DDL.
- `src/store/sqlite/game-state.ts` (new) — `getGameState(db)`, `setGameState(db, partial)`, parameterized. Pi-agnostic.
- `src/store/sqlite.ts` (barrel) — re-export `game-state.ts`.
- `src/config/themes.ts` (new) — 6 themes, each `{ id, label, css: {bg,fg,accent,mega}, ansi: {bg,fg,accent,mega,bold} }`. Pi-agnostic.
- `extensions/mega-game-cmds.ts` (new) — `registerGameCommands(pi, db)` → `/mega-game` subcommand parser.
- `extensions/mega-compact.ts` (entry) — register the command.
- `docs/game-mode-design.md` — note QA3 overshoot finding.
- `src/store/sqlite/game-state.test.ts` (new) — state round-trip, default fallback, parameterization.
- `extensions/mega-game-cmds.test.ts` (new) — command parsing matrix.

**Pre-defined TODOs:**
- [ ] **S30.0 (pre)** Characterize the cache-hit-% >100% overshoot: locate the calc, determine NaN vs ratio>1. Record finding in `docs/game-mode-design.md` §3. (Resolves QA3.)
- [ ] **S30.1** `game_state` DDL: `CREATE TABLE IF NOT EXISTS game_state (id INTEGER PRIMARY KEY CHECK(id=1), game_mode_on INTEGER NOT NULL DEFAULT 0, theme TEXT NOT NULL DEFAULT 'transparent', tui_display_mode TEXT NOT NULL DEFAULT 'full' CHECK(tui_display_mode IN('full','minimal')));` + seed default row.
- [ ] **S30.2** `getGameState` / `setGameState` — parameterized upsert (`INSERT ... ON CONFLICT(id) DO UPDATE`), returns typed `{game_mode_on:boolean, theme:string, tui_display_mode:'full'|'minimal'}`.
- [ ] **S30.3** `src/config/themes.ts`: define 6 palettes with concrete hex + ANSI codes:
  - `transparent` — bg=none, fg=#c9d1d9, accent=#3fb950, mega=#f0883e; ANSI: no bg, fg=39, accent=32, mega=33, bold=1.
  - `retro` — bg=#003300, fg=#33ff33, accent=#00ff41, mega=#39ff14; ANSI: bg=40, fg=92, accent=92, mega=1;92.
  - `orange-bold` — bg=#1a0f00, fg=#ff8c00, accent=#ff6b00, mega=#ff4500; ANSI: bg=48;5;52, fg=38;5;208, mega=1;38;5;202.
  - `cyan-neon` — bg=#001a1a, fg=#00ffff, accent=#22d3ee, mega=#7df9ff; ANSI: bg=48;5;23, fg=38;5;51, mega=1;38;5;51.
  - `amber-mono` — bg=#1a1200, fg=#ffb000, accent=#ff8c00, mega=#ff5500; ANSI: bg=48;5;58, fg=38;5;214, mega=1;38;5;208.
  - `grayscale` — bg=#161616, fg=#b0b0b0, accent=#8b949e, mega=#e6edf3; ANSI: bg=48;5;235, fg=38;5;249, mega=1;38;5;255.
  - Export `THEME_IDS`, `DEFAULT_THEME='transparent'`, `getTheme(id)`, `nextTheme(id)`.
- [ ] **S30.4** `/mega-game` command: `on|off` → set `game_mode_on`; `theme <id|next>` → set/cycle `theme` (validate against `THEME_IDS`); `tui full|minimal` → set `tui_display_mode`; bare → print state. Return a pi result notice.
- [ ] **S30.5** Wire registration in `extensions/mega-compact.ts`.
- [ ] **S30.6** Tests: state round-trip, invalid theme rejected (falls back + error notice), `theme next` wraps, command parses all subcommands. Use `MEGACOMPACT_STATE_DIR`.
- [ ] **S30.7** Gate: `npm run build && npm test && npm run lint && python3 scripts/regression_check.py --all` green.

**Acceptance:** `/mega-game` round-trips state through SQLite; themes file is the single palette source; gate green.
**Rollback:** `git revert <sha>` — no data migration (new table is additive).

---

### S31 — TUI widget theming + display modes + level

**Goal:** the mega-compact status widget reflects the active theme + display mode; shows turn level; MEGA CACHE ANSI effect.

**Files (IN scope):**
- `extensions/mega-runtime/widget.ts` — read cached `GameState`, apply ANSI accents, branch full vs minimal, render level, MEGA CACHE blink.
- `extensions/mega-runtime/state.ts` — hold the cached `GameState` + version counter; expose `getCachedGameState()` / `bumpGameState()`.
- `extensions/mega-game-cmds.ts` — call `bumpGameState()` after every write (S30 extension).
- `src/config/themes.ts` — if any ANSI helper is missing (add pure helpers only).
- `extensions/mega-runtime/widget.test.ts` (new or extend) — render snapshots for each theme × {full,minimal} × {normal, mega-cache}.

**Pre-defined TODOs:**
- [ ] **S31.1** `state.ts`: module-level `let cached: GameState|null` + `let ver=0`; `getCachedGameState(db)` lazy-loads + memoizes; `bumpGameState(db)` re-reads + bumps `ver`. Widget calls `getCachedGameState` (no DB hit on steady-state renders).
- [ ] **S31.2** `widget.ts` full mode: existing layout, but colors come from `getTheme(theme).ansi`. Background fill skipped when theme=`transparent` (accent fg only).
- [ ] **S31.3** `widget.ts` minimal mode: one line `LVL n │ cache NN%` (level + cache %). No bars/flair. Level always shown.
- [ ] **S31.4** Level display: derive turn level (see S33 for the level formula; S31 renders the number S33 produces). **If S33 not landed yet**, render level from a placeholder `getTurnLevel(db)` stub returning 1 — S33 replaces the stub.
- [ ] **S31.5** MEGA CACHE effect + oopsie gag: when cache % ≥ 100, render the cache segment with `ansi.mega` + a `MEGA CACHE` text flare. Use the S30.0 characterization: it's a real ratio (cross-repo injected IDs / this-session checkpoints), so show the actual % (e.g. `117%`). **Oopsie gag (§3b):** when a transient `megaCacheFlare` flag is set on the turn (set by the S33.4 scoring hook when `cachePct > 100`), render a one-line toast `oopsie! cache went to NNN% — MEGA CACHE 🥧` in `ansi.mega` for that turn only — flares once, then the widget returns to normal on the next render (the flag is consumed). Width-safe (respect `truncateToWidth`).
- [ ] **S31.6** Guard: when `game_mode_on=false`, widget renders **without** game-mode flair (level hidden, no MEGA CACHE) but still respects theme colors (theme is independent of game_mode).
- [ ] **S31.7** Tests: snapshot matrix (6 themes × 2 modes × 2 states) — assert ANSI codes present/absent, width ≤ terminal, no bg fill for transparent.
- [ ] **S31.8** Gate green.

**Acceptance:** switching `/mega-game theme` / `tui minimal` / `off` visibly changes the widget; MEGA CACHE flares at ≥100%; gate green.
**Rollback:** `git revert <sha>` — widget falls back to prior rendering.

---

### S32 — Dashboard CSS-variable skin + settings strip

**Goal:** the whole dashboard HTML page is skinned by the active theme; a header settings strip toggles all 3 settings; `/api/game-state` GET/PUT.

**Files (IN scope):**
- `extensions/dashboard-server/html.ts` — refactor hardcoded colors to CSS variables on `:root[data-theme]`; add `data-theme` attribute on `<html>`; add the settings strip HTML.
- `extensions/dashboard-server/server.ts` — `GET /api/game-state` + `PUT /api/game-state` handlers (annotated `// guardrails-allow PREVENT-PI-004:`).
- `extensions/dashboard-server/snapshot.ts` / `types.ts` — add `game_state` to the snapshot if needed.
- `extensions/dashboard-server/state.ts` — snapshot reads `getGameState`.
- `src/config/themes.ts` — add `themeCssVars(theme)` → string of `--bg/--fg/--accent/--mega` declarations (pure).
- `extensions/dashboard-server/html.test.ts` (extend) — theme variable presence + settings strip.
- `extensions/dashboard-server/server.test.ts` (extend) — GET/PUT round-trip, invalid theme 400.

**Pre-defined TODOs:**
- [ ] **S32.1** `html.ts`: replace every hardcoded hex with a `var(--…)`. Define the variable set once in a `:root` block. Map each theme to a `:root[data-theme="<id>"]` block via `themeCssVars()` (server injects the active block + the full set so client-side switching is instant).
- [ ] **S32.2** Preserve the existing look under `retro`-equivalent values (verify visual parity for the default-shipped theme token set).
- [ ] **S32.3** Settings strip (header, all tabs): game-mode toggle (checkbox), theme picker (`<select>`), TUI display-mode picker (`<select>` full/minimal). JS: on change → `PUT /api/game-state` (with `.catch()` — SEMANTIC-001).
- [ ] **S32.4** `GET /api/game-state` → `{game_mode_on, theme, tui_display_mode}`. `PUT /api/game-state` → validate body, `setGameState`, call `bumpGameState()` (so the TUI widget picks it up live), respond 200. Invalid theme → 400.
- [ ] **S32.5** `data-theme` attribute set server-side from the active theme on initial render; client updates it on theme change (no full reload).
- [ ] **S32.6** `dashboard-server` is a `PI004_EXCLUSIONS`-adjacent file — annotate every new `fetch`/http line with `// guardrails-allow PREVENT-PI-004: <reason>` (G2). Do NOT add to the exclusion list.
- [ ] **S32.7** Tests: html asserts `data-theme` + all vars present; server GET/PUT round-trip; invalid theme → 400; PUT bumps the widget cache (unit-test `bumpGameState` call).
- [ ] **S32.8** Gate green + `guardrails-scan` clean + `semantic-scan` clean.

**Acceptance:** dashboard restyles on theme change from both the settings strip and `/mega-game`; TUI widget updates live (via `bumpGameState`); gate green.
**Rollback:** `git revert <sha>` — restores hardcoded colors.

---

### S33 — Scoring schema + hooks

**Goal:** record scores for the 4 metrics on the right events. No UI yet (S34 renders).

**Files (IN scope):**
- `src/store/sqlite/schema.ts` — `game_scores` DDL.
- `src/store/sqlite/game-scores.ts` (new) — `recordScore(db, {repo_root, metric, value, meta})`, `leaderboard(db, metric, opts)`, parameterized.
- `src/store/sqlite.ts` (barrel) — re-export.
- `src/game/scoring.ts` (new) — pure helpers: `turnLevel(turnCount)`, `isMegaCache(cachePct)`, score derivations. Pi-agnostic.
- `extensions/mega-events/agent-handlers.ts` — on `turn_end`, record `turns` + `cache` scores.
- `extensions/mega-events/compact-handlers.ts` — on `session_compact`, record `dedupe` score.
- `src/store/sqlite/game-scores.test.ts` (new) + `src/game/scoring.test.ts` (new).

**Pre-defined TODOs:**
- [ ] **S33.1** `game_scores` DDL: `(repo_root TEXT, metric TEXT NOT NULL, ts INTEGER NOT NULL, value REAL NOT NULL, meta TEXT, PRIMARY KEY(repo_root, metric, ts))` + index on `(metric, ts)`.
- [ ] **S33.2** `recordScore` / `leaderboard` — parameterized. `leaderboard(metric, {repoRoot?, limit})` returns sorted rows. `metric ∈ {'cache','dedupe','turns','repos','mega_cache'}`.
- [ ] **S33.3** `src/game/scoring.ts`: `turnLevel(n)` = `Math.floor(Math.log2(n+1))+1` (1,2,2,3,… gentle); `isMegaCache(pct)` = `pct >= 100`; `cacheScore(hits,lookups)` = `lookups>0 ? hits/lookups*100 : 0` (fixes the NaN QA3 root cause if present).
- [ ] **S33.4** Hook `turn_end` (agent-handlers): increment turn count, record `turns` score (value=turn count, meta=model id), read cache hit/lookups from the existing metrics, record `cache` score per repo. If `isMegaCache(cachePct)` → record `mega_cache` trophy row (QA10) with `meta` carrying the peak overshoot % + turn ts; **and when `cachePct > 100`** (the real ratio >1 from S30.0), set the transient `megaCacheFlare` flag on the turn (§3b) so the S31.5 widget + S34.2 dashboard render the "oopsie" gag for that turn. The `mega_cache` row IS the "Opie's Wild Ride" unlock (§3b) — `metric='mega_cache'`, `meta={peakPct, firstSeenTs}`.
- [ ] **S33.5** Hook `session_compact` (compact-handlers): read dedup chunks/bytes saved from the dedup tier counters, record `dedupe` score (cumulative — `value` is the delta, leaderboard sums).
- [ ] **S33.6** `repos` metric: derived (not recorded per event) — `leaderboard('repos')` computes `COUNT(DISTINCT repo_root)` from `game_scores` + the global index (QA11). No new storage.
- [ ] **S33.7** All hooks gated behind `game_mode_on===true` (no scoring when game mode off).
- [ ] **S33.8** Tests: score round-trip, leaderboard ordering, mega_cache trophy row, no-scoring-when-off, parameterization (G3). Use `MEGACOMPACT_STATE_DIR` (G7).
- [ ] **S33.9** Gate green.

**Acceptance:** playing a session with game mode on populates `game_scores`; leaderboards return correct order; gate green.
**Rollback:** `git revert <sha>` — table is additive; drop table manually if desired.

---

### S34 — High Score dashboard tab + animations + release

**Goal:** the Game Mode / High Score tab renders leaderboards, MEGA CACHE banner, turn levels; level-up animation; ship.

**Files (IN scope):**
- `extensions/dashboard-server/html.ts` — new tab button `data-tab="game"` + `#panel-game`; leaderboard tables; MEGA CACHE banner; CSS keyframes for level-up pulse + mega flash.
- `extensions/dashboard-server/server.ts` — `GET /api/game-scores?metric=…` handler (annotated `guardrails-allow PREVENT-PI-004`).
- `extensions/dashboard-server/snapshot.ts` / `state.ts` — include score summaries if needed.
- `src/store/sqlite/game-scores.ts` — any leaderboard query tweaks.
- `extensions/mega-runtime/widget.ts` — level-up animation trigger on new turn (S31 stub → real).
- `extensions/dashboard-server/html.test.ts` (extend) + `server.test.ts` (extend).
- `RELEASE_NOTES.md` + `CHANGELOG.md` — game-mode release notes.
- `docs/INDEX_MAP.md` + `docs/HEADER_MAP.md` — add the new spec + tab.

**Pre-defined TODOs:**
- [ ] **S34.1** Tab + panel: per-metric leaderboards (cache per repo, dedupe global, turns global, repos badge). Render via `GET /api/game-scores`.
- [ ] **S34.2** MEGA CACHE banner + **Opie's Wild Ride** hidden unlock (§3b):
  - **Transient oopsie gag:** when the `megaCacheFlare` flag is set on the latest turn, show a transient toast `oopsie! cache went to NNN% — MEGA CACHE 🥧` with the CSS mega-flash keyframe, auto-dismissing.
  - **Hidden unlock tile ("🏆 Opie's Wild Ride"):** HIDDEN until a `mega_cache` trophy row exists for this repo — no locked tile, no `???` teaser, no hint on a fresh install. Once the first overshoot happens, render a `🏆 Opie's Wild Ride` tile showing the best (highest) peak % across all sessions + when it first happened (from `game_scores` `mega_cache` `meta`). It stays (one-time unlock). `/mega-game` bare status stays terse — the unlock only surfaces in the dashboard, not the TUI command output.
- [ ] **S34.3** Turn-level display in the dashboard: show level per recent turn (from `game_scores` `turns`/meta).
- [ ] **S34.4** Level-up animation: dashboard — CSS keyframe pulse on the cache bar when a new level is hit (client compares last-seen level). TUI — S31's ANSI blink fires on the level-up turn.
- [ ] **S34.5** `GET /api/game-scores?metric=<m>&limit=<n>` → JSON rows; `metric` validated against the allow-list (no SQL injection — parameterized anyway, G3).
- [ ] **S34.6** Empty state: "No scores yet — run a session with game mode on."
- [ ] **S34.7** Release notes: document `/mega-game`, the 6 themes, minimal TUI, the High Score tab, MEGA CACHE.
- [ ] **S34.8** Update `INDEX_MAP.md` + `HEADER_MAP.md`.
- [ ] **S34.9** Full gate green; `guardrails-scan` + `semantic-scan` clean; manual dashboard + TUI smoke test.

**Acceptance:** High Score tab shows live leaderboards after a session; MEGA CACHE banner fires on ≥100%; level-up animates; `/mega-game` + settings strip both work; release notes shipped; gate green.
**Rollback:** `git revert <sha>` — tab is additive; scores/table remain but are unused (drop in a follow-up if needed).

---

## 5. Consolidated Pre-Defined TODO Ledger

Total: 41 TODOs across S30–S34.

- **S30:** 7 todos (S30.0–S30.7) — overshoot characterization, DDL, state accessors, themes file, command, registration, tests, gate.
- **S31:** 8 todos (S31.1–S31.8) — cache, full mode, minimal mode, level, MEGA effect, game-mode-off guard, tests, gate.
- **S32:** 8 todos (S32.1–S32.8) — CSS vars, parity, settings strip, endpoints, data-theme, guardrail annotations, tests, gate.
- **S33:** 9 todos (S33.1–S33.9) — DDL, accessors, scoring math, turn_end hook, compact hook, repos metric, game-mode gate, tests, gate.
- **S34:** 9 todos (S34.1–S34.9) — tab, banner, levels, animations, API, empty state, release notes, maps, gate.

Cross-cutting TODOs (apply to every sprint):
- [ ] One focused commit per sprint with `Co-Authored-By:` footer (G10).
- [ ] `src/` files have NO pi runtime types (G9).
- [ ] All SQL parameterized (G3).
- [ ] All tests use `MEGACOMPACT_STATE_DIR` (G7).
- [ ] Every new dashboard `fetch`/http line annotated `// guardrails-allow PREVENT-PI-004:` (G1/G2).
- [ ] Every async path has `.catch()` / try-catch (G6).
- [ ] **Hidden-until-triggered invariant (§3b "Opie's Wild Ride"):** the unlock tile/dashboard copy is rendered ONLY when a `mega_cache` trophy row exists. A fresh install (no overshoot yet) shows nothing about it — no locked tile, no teaser. Gate this with a `hasMegaCacheTrophy()` check, not a feature flag.

---

## 6. Resolved Open Questions (from spec §9)

| Q | Resolution | Sprint |
|---|------------|--------|
| Q1 schema | new `game_state` table, single row | S30 |
| Q2 score schema | new `game_scores` table | S33 |
| Q3 turn definition | one agent turn (`turn_end`) | S33 |
| Q4 leaderboard dims | cache per-repo; dedupe/turns/repos global | S34 |
| Q5 MEGA CACHE persist | trophy-case row + transient effect | S33 |
| Q6 toggle panel placement | dashboard header settings strip | S32 |
| Q7 widget perf | module-level cached GameState + version bump | S31 |
| Q8 theme palettes | concrete hex+ANSI defined in `src/config/themes.ts` | S30 |
| Q9 minimal TUI contents | `LVL n │ cache NN%` one line | S31 |

## 7. Deferred (future phases, out of scope for S30–S34)

- Mini-game inside the High Score dashboard.
- Time-windowed leaderboards (daily/weekly).
- Per-repo theme overrides.
- Animated transitions between themes in the TUI.
