# Sprint D3 — Documentation & Release

**Date:** 2026-07-21
**Focus:** Update all documentation, release notes, migration guide, tester guide
**Priority:** P1
**Effort:** S (≈ ½ day)
**Status:** PLANNED
**Depends on:** Sprint D2 (observability)

---

## SAFETY PROTOCOLS

- Read `docs/AGENT_GUARDRAILS.md` + `skills/shared-prompts/four-laws.md` first.
- Gate before commit:
  ```bash
  npm run build && npm run build:dashboard && npm test && npm run lint && python3 scripts/regression_check.py --all && node scripts/guardrails-scan.mjs
  ```

---

## PROBLEM STATEMENT

The React dashboard is a significant change from the HTML template. Documentation must be updated for users (install, usage, troubleshooting) and developers (architecture, testing, contributing).

---

## SCOPE BOUNDARY

**IN SCOPE (may modify):**
- `extensions/DASHBOARD.md` — update architecture, quick start, development section.
- `TESTER_GUIDE.md` — add React dashboard testing checklist.
- `RELEASE_NOTES.md` — add dashboard v2 section.
- `CHANGELOG.md` — add sprint entries.
- `docs/INDEX_MAP.md` — update dashboard entries.
- `docs/HEADER_MAP.md` — update dashboard entries.
- `INSTALL_AND_USAGE.md` — update dashboard section.
- `extensions/dashboard-client/README.md` (NEW) — development setup.

**OUT OF SCOPE:**
- Code changes.
- `src/` modules.

---

## EXECUTION DIRECTIONS

```
1. DASHBOARD Update extensions/DASHBOARD.md:
             - New architecture diagram (React client → API server).
             - Updated quick start (build:dashboard + /dashboard).
             - Development section (cd extensions/dashboard-client && npm run dev).
             - Updated data files table.
             - Updated browser UI section.
2. TESTER    TESTER_GUIDE.md: add "React Dashboard" section:
             - Build and serve checklist.
             - Tab-by-tab verification steps.
             - Error state testing (stop server, verify offline banner).
             - Theme switching verification.
             - Game mode settings verification.
3. RELEASE   RELEASE_NOTES.md: add "Dashboard v2" section:
             - What's new (React, tabs, resilience, diagnostics).
             - Migration: existing dashboard still works (backward compat).
             - New commands: /dashboard (unchanged).
4. CHANGELOG CHANGELOG.md: sprint entries A1–D3.
5. MAPS      INDEX_MAP.md + HEADER_MAP.md: add new sprint spec entries,
             update dashboard architecture references.
6. INSTALL   INSTALL_AND_USAGE.md: update dashboard section with new build step.
7. README    extensions/dashboard-client/README.md: dev setup, architecture,
             available scripts.
```

---

## QA VERIFICATION ROUND

Before proceeding to T1, verify:

1. **Build + Test + Lint + Regression + Guardrails** — all green.
2. **Docs:** all updated files render correctly (no broken links).
3. **Maps:** INDEX_MAP and HEADER_MAP have correct entries.
4. **Tester guide:** checklist is actionable and complete.
5. **Release notes:** accurate and user-facing.

---

## ACCEPTANCE CRITERIA

- [ ] DASHBOARD.md updated with React architecture.
- [ ] TESTER_GUIDE.md has dashboard testing section.
- [ ] RELEASE_NOTES.md documents dashboard v2.
- [ ] CHANGELOG.md has sprint entries.
- [ ] INDEX_MAP.md and HEADER_MAP.md updated.
- [ ] INSTALL_AND_USAGE.md updated.
- [ ] All gates green.

---

## ROLLBACK PROCEDURE

```bash
git revert <sha>
```