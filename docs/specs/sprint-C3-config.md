# Sprint C3 — Config & Settings Tab

**Date:** 2026-07-21
**Focus:** Configuration management tab + Game Mode settings integration
**Priority:** P1
**Effort:** S (≈ ½ day)
**Status:** PLANNED
**Depends on:** Sprint C2 (repos/metrics tabs)

---

## SAFETY PROTOCOLS

- Read `docs/AGENT_GUARDRAILS.md` + `skills/shared-prompts/four-laws.md` first.
- Gate before commit:
  ```bash
  npm run build && npm run build:dashboard && npm test && npm run lint && python3 scripts/regression_check.py --all && node scripts/guardrails-scan.mjs
  ```
- PREVENT-PI-004: all API calls use relative paths. No external network.
- PREVENT-PI-004 annotation: PUT `/api/game-state` is annotated `// guardrails-allow PREVENT-PI-004: localhost dashboard settings (loopback-only)`.

---

## PROBLEM STATEMENT

Game mode settings (theme, TUI display, on/off) are only configurable via `/mega-game` CLI command. A Config tab in the dashboard provides a GUI for these settings plus read-only config display.

---

## SCOPE BOUNDARY

**IN SCOPE (may modify):**
- `extensions/dashboard-client/src/tabs/ConfigTab.tsx` (NEW)
- `extensions/dashboard-client/src/components/GameModeSettings.tsx` (NEW)
- `extensions/dashboard-client/src/components/ConfigDisplay.tsx` (NEW) — read-only config.
- `extensions/dashboard-client/src/components/ThemePreview.tsx` (NEW) — theme swatch.
- `extensions/dashboard-client/src/App.tsx` — wire tab.
- `extensions/dashboard-client/src/api/client.ts` — add `putGameState()` + `fetchGameState()`.

**OUT OF SCOPE:**
- Server-side changes (game-state endpoints already exist from S32).
- New game features.
- `src/` modules.

---

## EXECUTION DIRECTIONS

```
1. CONFIG    ConfigTab.tsx: two sections — Game Mode Settings + Config Display.
2. GAME      GameModeSettings.tsx: toggle (on/off), theme picker (6 themes with
             preview swatches), TUI display mode (full/minimal).
             PUT /api/game-state on change. Optimistic update + rollback on error.
3. PREVIEW   ThemePreview.tsx: small color swatch showing bg/fg/accent/mega.
             Click to apply. Shows current selection.
4. DISPLAY   ConfigDisplay.tsx: read-only view of snapshot.config (threshold,
             anchor, preserve, auto mode, fast gate). Fetch /api/snapshot.
5. CLIENT    api/client.ts: putGameState(patch), fetchGameState().
             All relative paths (PREVENT-PI-004).
6. WIRE      App.tsx: register Config tab.
7. TEST      Component tests: toggle fires PUT, theme picker validation,
             rollback on API error.
```

---

## QA VERIFICATION ROUND

Before proceeding to D1, verify:

1. **Build + Test + Lint + Regression + Guardrails** — all green.
2. **Visual:** Config tab shows game settings + read-only config.
3. **Toggle:** game mode on/off updates server + reflects in UI.
4. **Theme:** picking a theme updates the dashboard appearance.
5. **Rollback:** simulate API error, verify UI reverts.
6. **Consistency:** settings match `/mega-game` CLI output.

---

## ACCEPTANCE CRITERIA

- [ ] Config tab allows game mode toggle, theme selection, TUI mode.
- [ ] Changes persist via PUT /api/game-state.
- [ ] Read-only config display shows current settings.
- [ ] Theme preview shows color swatches.
- [ ] All gates green.

---

## ROLLBACK PROCEDURE

```bash
git revert <sha>
```