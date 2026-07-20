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
| **S35** | Achievements system: `game_achievements` table + 9 achievements (incl. the hidden Opie easter egg) + evaluation fn + `/api/achievements` + unlock toasts + dashboard tiles | M | S33, S34 |

**Total:** ~6.5 days (S30–S34 ~5.5d + S35 ~1d). Built so toggle (S31/S32) + themes test together; scoring (S33) lands in parallel with the UI sprints; achievements (S35) capstone the game-mode release.

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
- [x] **S31.1** `state.ts`: cached game state — implemented as an instance field `private cachedGameState: GameState|undefined` on `MegaRuntime` (functionally equivalent to module-level `let cached` + `ver`): `getCachedGameState()` lazy-loads from the per-repo `game_state` row via `getGameState(this.currentStateDir)` + memoizes (try/catch fallback to defaults); `bumpGameState()` evicts. Widget reads `wd.gameMode/theme/...` populated once per `snapshot()` — no DB hit on steady-state renders. (Audit P2 fix: also evict in `bindRepo()` + `resetRuntime()` so a repo switch doesn't show the prior repo's state.)
- [x] **S31.2** `widget.ts` full mode: existing layout, colors come from `getTheme(theme).ansi`. `panelBgFor(theme)` resolves the bg SGR (transparent → `""` → no bg fill, accent fg only); `panelLine/panelBar/wrapLine` thread `panelBg` and still route through `truncateToWidth` so the v0.7.9 width guard holds for transparent themes.
- [x] **S31.3** `widget.ts` minimal mode: early-return after the `wd`-truthy check renders one line `LVL n │ cache NN%` via `panelLine`, flanked by `panelBar`s. No bars/flair. Level always shown.
- [x] **S31.4** Level display: `getTurnLevel()` stub on `MegaRuntime` returns 1 until S33 wires the real formula. Rendered in the header (`LVL n`, accent-colored) when game mode is on.
- [x] **S31.5** MEGA CACHE effect + oopsie gag: when `cachePct ≥ 100` + game mode on, the cache segment renders with `ansi.mega` + a `MEGA CACHE` flare. The transient `megaCacheFlare` flag (set by the S33.4 scoring hook) renders the one-line toast `oopsie! cache went to NNN% — MEGA CACHE 🥧` in `ansi.mega` for that turn only — the flag lives on `widgetData` so it's consumed on the next `snapshot()`. Width-safe (every line exits via `panelLine` → `truncateToWidth`).
- [x] **S31.6** Guard: when `game_mode_on=false`, the widget hides level + MEGA CACHE flair but still applies theme colors (theme is independent of game_mode — threaded via `WidgetData.theme` regardless of `gameMode`).
- [x] **S31.7** Tests: `widget.test.ts` — 48-case snapshot matrix (6 themes × {full,minimal} × {gameMode on/off} × {cache<100, ≥100}) asserts ANSI bg present/absent (transparent = no `\x1b[48;`), minimal mode is one content line, gameMode-off hides level + MEGA CACHE, MEGA CACHE flare appears only when `megaCacheFlare` + gameMode on, every line `visibleWidth ≤ terminal`. `state.test.ts` — getCachedGameState defaults/memoization + bumpGameState round-trip + bindRepo cross-repo eviction (audit P2). Uses `MEGACOMPACT_STATE_DIR` + `mkdtemp` (G7).
- [x] **S31.8** Gate green: build OK, 488/488 tests pass (+1), lint clean, regression clean.

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
- [x] **S32.1** `html.ts`: hardcoded hexes replaced with `var(--…)`; a base `:root` block defines the full variable set (default=transparent maps the prior hexes for visual parity); `:root[data-theme="<id>"]` override blocks for all 6 themes injected via `themeDataBlock()` from `src/config/themes.ts` (pure helper). Client-side `applyGameState(gs)` sets `document.documentElement.dataset.theme` for instant switching (no reload).
- [x] **S32.2** Visual parity preserved: the base `:root` vars map every prior hardcoded hex (`--bg:#0d1117`, `--fg:#c9d1d9`, `--accent:#3fb950`, etc.); `html { background:#0d1117 }` backdrop guards a white flash under the transparent theme (which sets `--bg:transparent`). Default-shipped look is identical to pre-S32.
- [x] **S32.3** Settings strip (header, all tabs): game-mode toggle (`<input type=checkbox id=set-game-mode>`), theme picker (`<select id=set-theme>` with options from THEME_IDS), TUI display-mode picker (`<select id=set-tui>` full/minimal). JS on-change → `fetch('/api/game-state', {method:'PUT', body: JSON.stringify({<patch>})})` with `.catch()` (SEMANTIC-001).
- [x] **S32.4** `GET /api/game-state` → `{game_mode_on, theme, tui_display_mode}` (lazy-import `getGameState` from `../../src/store/sqlite.js`). `PUT /api/game-state` → drain body via `req.on('data'/'end')` (64KiB cap), `JSON.parse`, **non-null-object guard (audit P1: `null`/`[]`/`42` → 400 `invalid_patch_object`, not a crash)**, validate fields (`isValidTheme`, `tui_display_mode ∈ {full,minimal}`, `game_mode_on` boolean), `setGameState(clean, stateDir)`, respond 200 JSON. Invalid theme/value → 400. Cross-process: the dashboard server is a detached child with no `MegaRuntime` ref, so it writes the `game_state` table directly; `MegaRuntime`'s `fs.watch` on `stateDir/sqlite.db` evicts `cachedGameState` so the next `snapshot()` re-queries (table-per-concept + fs.watch pattern, §7 invariant).
- [x] **S32.5** `data-theme="transparent"` on `<html>` server-side (default); `applyGameState(gs)` updates `document.documentElement.dataset.theme` client-side on theme change (no full reload).
- [x] **S32.6** Every new `fetch(`/`http`/`req.on` line in `html.ts` + `server.ts` annotated `// guardrails-allow PREVENT-PI-004: <reason>` (scanner-clean). `html.ts`/`server.ts` NOT added to `PI004_EXCLUSIONS` (inline annotations only, per G2).
- [x] **S32.7** Tests (`extensions/dashboard-server-s32.test.ts`, 8 cases): GET returns seeded row; PUT {theme:'retro'}/{tui_display_mode:'minimal'}/{game_mode_on:true} round-trips; PUT invalid theme → 400 + row unchanged; **PUT body 'null' + '[]' → 400 + server stays up (audit P1 regression)**; HTML asserts `data-theme` + settings strip + theme CSS-var blocks. Uses `MEGACOMPACT_STATE_DIR` + `mkdtemp` + private ports (19330-19336) + spawn+waitFor+finally-kill (G7). Cross-process widget bump verified structurally (fs.watch wiring + API write lands; e2e runtime+server in one process is out of scope — server is detached by design).
- [x] **S32.8** Gate green: build OK, 495/495 tests pass (+2 P1 regression), `guardrails-scan` clean, `semantic-scan` clean, `regression_check --all` clean. Serial dashboard lane now 3 files (P3 fix: `dashboard-server-s32` added to `DASHBOARD_GLOB`).

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
- [x] **S33.1** `game_scores` DDL: `(repo_root TEXT, metric TEXT NOT NULL, ts INTEGER NOT NULL, value REAL NOT NULL, meta TEXT, PRIMARY KEY(repo_root, metric, ts))` + index on `(metric, ts)`.
- [x] **S33.2** `recordScore` / `leaderboard` — parameterized. `leaderboard(metric, {repoRoot?, limit})` returns sorted rows. `metric ∈ {'cache','dedupe','turns','repos','mega_cache'}`.
- [x] **S33.3** `src/game/scoring.ts`: `turnLevel(n)` = `Math.floor(Math.log2(n+1))+1` (1,2,2,3,… gentle); `isMegaCache(pct)` = `pct >= 100`; `cacheScore(hits,lookups)` = `lookups>0 ? hits/lookups*100 : 0` (fixes the NaN QA3 root cause if present).
- [x] **S33.4** Hook `turn_end` (agent-handlers): increment turn count, record `turns` score (value=turn count, meta=model id), read cache hit/lookups from the existing metrics, record `cache` score per repo. If `isMegaCache(cachePct)` → record `mega_cache` trophy row (QA10) with `meta` carrying the peak overshoot % + turn ts; **and when `cachePct > 100`** (the real ratio >1 from S30.0), set the transient `megaCacheFlare` flag on the turn (§3b) so the S31.5 widget + S34.2 dashboard render the "oopsie" gag for that turn. The `mega_cache` row IS the "Opie's Wild Ride" unlock (§3b) — `metric='mega_cache'`, `meta={peakPct, firstSeenTs}`.
- [x] **S33.5** Hook `session_compact` (compact-handlers): read dedup chunks/bytes saved from the dedup tier counters, record `dedupe` score (cumulative — `value` is the delta, leaderboard sums).
- [x] **S33.6** `repos` metric: derived (not recorded per event) — `leaderboard('repos')` computes `COUNT(DISTINCT repo_root)` from `game_scores` + the global index (QA11). No new storage.
- [x] **S33.7** All hooks gated behind `game_mode_on===true` (no scoring when game mode off).
- [x] **S33.8** Tests: score round-trip, leaderboard ordering, mega_cache trophy row, no-scoring-when-off, parameterization (G3). Use `MEGACOMPACT_STATE_DIR` (G7).
- [x] **S33.9** Gate green.

**Acceptance:** playing a session with game mode on populates `game_scores`; leaderboards return correct order; gate green.
**Rollback:** `git revert <sha>` — table is additive; drop table manually if desired.

---

### S34 — High Score dashboard tab + animations + release

(Note: S34's release-notes/CHANGELOG/map TODOs move to S35 so the game-mode
release ships as one unit with achievements included. S34 keeps the tab +
leaderboards + MEGA CACHE + level-up animation + the Opie hidden unlock.)

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
- [ ] **S34.7** (moved to S35.10) — release notes + CHANGELOG + INDEX_MAP/HEADER_MAP updates ship with the achievements sprint so game-mode releases as one unit.
- [ ] **S34.8** Full gate green; `guardrails-scan` + `semantic-scan` clean; manual dashboard + TUI smoke test for the High Score tab + Opie hidden unlock.

**Acceptance:** High Score tab shows live leaderboards after a session; MEGA CACHE banner fires on ≥100%; level-up animates; `/mega-game` + settings strip both work; gate green.
**Rollback:** `git revert <sha>` — tab is additive; scores/table remain but are unused (drop in a follow-up if needed).

---

### S35 — Achievements system (capstone)

**Goal:** a proper achievements system on top of the S33 scores + S34 High Score
tab. 9 achievements (8 visible + 1 hidden easter egg = Opie's Wild Ride, §3b).
Newly-unlocked achievements fire a one-time toast; the Game Mode tab gets an
achievements row of tiles.

**Files (IN scope):**
- `src/store/sqlite/schema.ts` — `game_achievements` table DDL.
- `src/store/sqlite/game-achievements.ts` (new) — `getAchievement(db,id)`, `listAchievements(db)`, `unlockAchievement(db,id)`, `isUnlocked(db,id)`, parameterized. Pi-agnostic.
- `src/store/sqlite.ts` (barrel) — re-export.
- `src/game/scoring.ts` (extend) — `evaluateAchievements(scores)` pure fn: returns `{unlocked: string[], newlyUnlocked: string[]}`. Pi-agnostic.
- `extensions/mega-events/agent-handlers.ts` + `compact-handlers.ts` — after a score is recorded (S33.4/S33.5), call `evaluateAchievements` + `unlockAchievement` for newly-unlocked ids; set a transient `achievementFlare` (mirrors §3b megaCacheFlare).
- `extensions/mega-runtime/widget.ts` — render a one-line achievement unlock toast when `achievementFlare` is set (ANSI accent, one turn, consumed).
- `extensions/dashboard-server/html.ts` — achievements tile row on the Game Mode tab; CSS keyframe for unlock pulse; hidden achievements render NOTHING until unlocked (`hidden=1 AND unlocked_at IS NULL`).
- `extensions/dashboard-server/server.ts` — `GET /api/achievements` → `{id,title,description,icon,hidden,unlocked_at}[]` (annotated `guardrails-allow PREVENT-PI-004`).
- `extensions/mega-game-cmds.ts` — `/mega-game achievements` lists unlocked (terse; hidden ones only show if unlocked).
- `RELEASE_NOTES.md` + `CHANGELOG.md` — game-mode release notes (moved from S34; ships as one release with achievements).
- `docs/INDEX_MAP.md` + `docs/HEADER_MAP.md` — update for the achievements spec + new table.
- Tests: `src/store/sqlite/game-achievements.test.ts` + `src/game/scoring.test.ts` (extend with `evaluateAchievements`); `extensions/dashboard-server/{html,server}.test.ts` (extend).

**Pre-defined TODOs:**
- [ ] **S35.1** `game_achievements` DDL: `(id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, icon TEXT, unlocked_at INTEGER NULL)`. Seed the 9 achievement rows (id/title/description/hidden/icon) on first open (idempotent).
- [ ] **S35.2** `game-achievements.ts` accessors — `getAchievement`, `listAchievements`, `unlockAchievement` (sets `unlocked_at` only if currently NULL, returns whether it was newly unlocked), `isUnlocked`. Parameterized (PREVENT-002).
- [ ] **S35.3** `evaluateAchievements(scores)` in `src/game/scoring.ts` — pure fn over the `game_scores` aggregates: returns `{unlocked: string[], newlyUnlocked: string[]}` (newly = unlocked-but-not-yet-persisted). Conditions per §9b table (compact_count, turns max, mega_cache row, dedupe sum, repos distinct, turn level, ts hour, flawless 100%-no-overshoot, 5 compacts same session).
- [ ] **S35.4** Wire evaluation into the S33 scoring hooks: after a score is recorded, call `evaluateAchievements` → for each `newlyUnlocked` id, `unlockAchievement` (records `unlocked_at`) + set a transient `achievementFlare` with the title (consumed by widget + dashboard for that turn).
- [ ] **S35.5** TUI widget: when `achievementFlare` is set, render a one-line toast `🏆 Achievement unlocked: <title>` in `ansi.accent` for that turn (consumed next render). Width-safe.
- [ ] **S35.6** Dashboard Game Mode tab: an achievements tile row. Hidden achievements (`hidden=1 AND unlocked_at IS NULL`) render NOTHING (no teaser) — same invariant as Opie. Unlocked achievements show icon + title + unlocked_at. Locked-but-visible achievements show `??? <title>` (teaser).
- [ ] **S35.7** `GET /api/achievements` → JSON array; `metric`-style validation n/a (fixed ids). Annotated `guardrails-allow PREVENT-PI-004`.
- [ ] **S35.8** `/mega-game achievements` — terse list of unlocked achievements (hidden ones only appear once unlocked).
- [ ] **S35.9** Tests: achievement seed idempotency, unlock idempotency (second unlock is a no-op), `evaluateAchievements` triggers (each of the 9 conditions), hidden-achievement render gating (hidden+locked = nothing rendered), `achievementFlare` toast, parameterization (G3), `MEGACOMPACT_STATE_DIR` (G7).
- [ ] **S35.10** Release notes + CHANGELOG: document `/mega-game`, the 6 themes, minimal TUI, the High Score tab, MEGA CACHE, achievements (incl. the hidden easter-egg rule). Update `INDEX_MAP.md` + `HEADER_MAP.md`.
- [ ] **S35.11** Full gate green; `guardrails-scan` + `semantic-scan` clean; manual dashboard + TUI smoke test (unlock an achievement, verify toast + tile).

**Acceptance:** 9 achievements seed on first open; playing a session with game mode on unlocks the earned ones; newly-unlocked fire a toast (TUI + dashboard); the Game Mode tab shows an achievements row (hidden ones invisible until unlocked); `/mega-game achievements` lists unlocks; release notes shipped; gate green.
**Rollback:** `git revert <sha>` — table + tiles additive; drop table manually if desired.

---

## 5. Consolidated Pre-Defined TODO Ledger

Total: 52 TODOs across S30–S35.

- **S30:** 7 todos (S30.0–S30.7) — overshoot characterization, DDL, state accessors, themes file, command, registration, tests, gate. ✅ SHIPPED (commit fb4ec17).
- **S31:** 8 todos (S31.1–S31.8) — ✅ DONE (commits `98a9b3f` + `a0d9b5c`). cache + full/minimal mode + level stub + MEGA CACHE flare + oopsie gag + game-mode-off guard + 48-case test matrix + bindRepo eviction (audit P2).
- **S32:** 8 todos (S32.1–S32.8) — ✅ DONE (commits `60b7f73` + `fa8cc20`). CSS-var skin (transparent-default parity) + settings strip (game-mode/theme/tui selects) + GET/PUT /api/game-state (non-object guard) + fs.watch cross-process eviction + 8 test cases (incl. P1 null/array regression). Gate green (495/495).
- **S33:** 9 todos (S33.1–S33.9) — ✅ DONE (commit `e4ac3ec`). game_scores DDL + recordScore/leaderboard (nextTs monotonic, split repoFilter) + pure scoring helpers + turn_end/session_compact hooks (incl. mega_cache trophy + megaCacheFlare) + game_mode_on gate + 9 test cases. Gate green (507/507).
- **S34:** 9 todos (S34.1–S34.9) — tab, banner + Opie hidden unlock, levels, animations, API, empty state. (Release notes/maps moved to S35.)
- **S35:** 11 todos (S35.1–S35.11) — achievements DDL, accessors, evaluateAchievements, hook wiring, TUI toast, dashboard tiles, /api/achievements, /mega-game achievements, tests, release notes + maps, gate.

Cross-cutting TODOs (apply to every sprint):
- [ ] One focused commit per sprint with `Co-Authored-By:` footer (G10).
- [ ] `src/` files have NO pi runtime types (G9).
- [ ] All SQL parameterized (G3).
- [ ] All tests use `MEGACOMPACT_STATE_DIR` (G7).
- [ ] Every new dashboard `fetch`/http line annotated `// guardrails-allow PREVENT-PI-004:` (G1/G2).
- [ ] Every async path has `.catch()` / try-catch (G6).
- [ ] **Hidden-until-triggered invariant (§3b "Opie's Wild Ride" + §9b achievements):** the unlock tile/dashboard copy is rendered ONLY when the underlying condition is met (a `mega_cache` trophy row, or an achievement `unlocked_at IS NOT NULL`). A fresh install shows nothing about hidden unlocks — no locked tile, no teaser. Gate with `hasMegaCacheTrophy()` / `isUnlocked()` checks, NOT feature flags. Applies to both the MEGA CACHE easter egg and hidden achievements.
- [ ] **Table-per-concept + fs.watch cross-process invariant:** each game concept is its own SQLite table (`game_state`, `game_scores`, `game_achievements`) — the single source of truth read by **both** the dashboard server (child process) and the TUI widget (parent process). The dashboard server never holds a `MegaRuntime` ref, so it cannot call in-process methods; instead `MegaRuntime` keeps an `fs.watch` on `stateDir/sqlite.db` (the WAL-mode store) that evicts the relevant cache (`cachedGameState` for S32; the scores/achievements caches for S34/S35) on any write, so the next `snapshot()` re-queries and the widget reflects dashboard-side changes even while idle. The in-process `/mega-game` path still calls `bumpGameState()` for instant updates. The per-frame render path (`buildWidgetLines`) never touches the DB — it reads `widgetData` (populated in `snapshot()`), so QA4 (widget render hot path) stays satisfied.

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

## 7. Deferred (future phases, out of scope for S30–S35)

- Mini-game inside the High Score dashboard.
- Time-windowed leaderboards (daily/weekly).
- Per-repo theme overrides.
- Animated transitions between themes in the TUI.
