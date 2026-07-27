# mega-runtime — Decomposition Tracker

This file tracks the progressive decomposition of the original `mega-runtime.ts`
monolith (2 600+ lines) into focused single-responsibility modules.

---

## Current State (raptor-promotion branch)

### Completed — Phase 1: Extract pure helpers

The original `state.ts` (later `mega-runtime.ts`) has been split into:

| File | Lines | Responsibility |
|---|---|---|
| `state.ts` | 10 | **Re-export placeholder** — re-exports `MegaRuntime` from `runtime.ts` so all existing imports keep working |
| `runtime.ts` | ~782 | **MegaRuntime class** — the orchestrator (constructor, snapshot, dispose, etc.) |
| `snapshot.ts` | ~229 | `computeMegaSnapshot()` — pure function, no class state |
| `dashboard-snapshot.ts` | ~173 | `computeDashboardSnapshot()` — dashboard-specific snapshot variant |
| `widget.ts` | ~422 | Widget rendering: ANSI palette (`C`), constants, `TickerEntry`/`WidgetData` interfaces, `buildWidgetLines()` |
| `effects.ts` | ~129 | Effect/flare helpers: `armMegaCacheFlareImpl`, `armAchievementFlareImpl`, `setEffectImpl`, `pushTickerImpl` |
| `game-state.ts` | ~125 | Game state cache: `ensureGameStateWatcherImpl`, `bumpGameStateImpl`, `refreshWidgetGameStateImpl` |
| `capture-model.ts` | ~101 | Model capture: `captureModelImpl` |
| `bind-repo.ts` | ~81 | Repo binding: `resolveRepoId`, `resolveMemoRoot` |
| `perf.ts` | ~60 | Perf sample helpers: `recordPerfSample`, `ensurePerfIntervalImpl`, `disposePerf` |
| `helpers.ts` | ~100 | Shared constants/types (`MEGA_HOME`, `DEFAULT_CONFIG`, `MegaConfig`, etc.) |
| `query.ts` | ~30 | Query helpers |

All **661 tests pass** (0 failures).

### Not yet committed

The following files are **new/modified and need to be committed**:

- **Modified:** `state.ts` (now re-export), `endpoints.ts` (dashboard API contract)
- **New:** `runtime.ts`, `dashboard-snapshot.ts`, `widget.ts`, `effects.ts`, `game-state.ts`, `capture-model.ts`, `bind-repo.ts`, `perf.ts`, `snapshot.ts`

---

## Remaining Work — Phase 2: Split the big files

### Sprint: Split `runtime.ts` (~782 lines)

`runtime.ts` contains the entire `MegaRuntime` class. The class has natural groupings:

| Proposed file | Methods to extract | Estimated lines |
|---|---|---|
| `runtime.ts` (slimmed) | `constructor`, `dispose`, `bindRepo`, `snapshot`, `resetRuntime`, `setStatus`, `getStateDir`, `appendEvent`, `engineView` | ~300 |
| `runtime-widget.ts` | `renderWidget` (delegates to widget.ts) | ~30 |
| `runtime-cache.ts` | `materialSig`, `embedderName`, `driftStatus`, `getTurnLevel`, `getCachedGameState` | ~80 |
| `runtime-effects.ts` | `armMegaCacheFlare`, `armAchievementFlare`, `setEffect`, `pushTicker` (thin wrappers already in effects.ts) | ~30 |

**Challenge:** These are all methods on a single class. Options:
1. Keep the class in `runtime.ts` but move private helpers to standalone functions
2. Use mixins / composition (e.g., `class MegaRuntime extends MegaRuntimeBase`)
3. Move groups of methods into standalone functions that receive `this` context

### Sprint: Split `widget.ts` (~422 lines)

`widget.ts` has clear separable sections:

| Proposed file | Content | Estimated lines |
|---|---|---|
| `widget.ts` (slimmed) | `buildWidgetLines()` — the main render function | ~180 |
| `widget-constants.ts` | `C` (ANSI palette), all constant definitions | ~40 |
| `widget-types.ts` | `TickerEntry`, `WidgetData`, `WidgetLine`, etc. interfaces | ~50 |
| `widget-layout.ts` | Layout helpers (bar rendering, truncation, padding) | ~100 |

---

## Sprint Backlog (prioritised)

1. **Commit Phase 1** — stage all new/modified files, push to `raptor-promotion`
2. **Split `widget.ts`** — lower risk, pure rendering code, easy to verify
3. **Split `runtime.ts`** — higher risk, class methods; needs careful design
4. **Verify `state.ts` re-export** — after each split, confirm `state.ts` → `runtime.ts` → final modules chain works
5. **Run full test suite** after each split
6. **Final cleanup** — remove `state.ts` placeholder once all consumers are updated to import directly

---

## Notes

- `state.ts` is intentionally kept as a re-export to avoid a breaking change in `extensions/mega-runtime.ts:18` which imports `MegaRuntime` from `./mega-runtime/state.js`
- `state.test.ts` and `widget.test.ts` exist alongside the source — they use `createRequire` to load compiled JS, not direct TS imports
