# mega-runtime

Runtime state and widget rendering for the mega-compact dashboard.

## Module structure

`MegaRuntime` (in `runtime.ts`) is a delegates-only orchestrator: field
declarations, the constructor, and 1-line delegates to `*Impl` free functions in
single-responsibility modules. Keep it that way — when adding logic, put the body
in a new `*.ts` module and add a thin delegate, rather than growing `runtime.ts`
(see `DECOMPOSITION.md` + the "no large files" rule in `CLAUDE.md` §6).

| Module | Responsibility |
|---|---|
| `state.ts` | Barrel re-export of `MegaRuntime` (backwards-compat import path) |
| `runtime.ts` | `MegaRuntime` class — delegates-only orchestrator (fields + constructor + 1-line delegates) |
| `runtime-snapshot.ts` | `snapshotImpl()` — the full `snapshot()` body (dashboard write + widget-data compute + gate) |
| `runtime-helpers.ts` | `materialSigImpl` / `embedderNameImpl` / `driftStatusImpl` / `getTurnLevelImpl` + `RuntimeHelpersContext` |
| `pressure-getters.ts` | `pressureImpl` / `effectiveThresholdImpl` / `pressureBandImpl` (the pressure accessors) |
| `reset-runtime.ts` | `resetRuntimeImpl()` — per-session state reset |
| `append-event.ts` | `appendEventImpl()` — structured events.log sink |
| `get-state-dir.ts` | `getStateDirImpl()` — bound repo state dir (S21) |
| `render-widget.ts` | `renderWidgetImpl()` — width-aware above-editor widget factory |
| `status.ts` | `setStatusImpl()` — status-key text mirrored to pi's status line |
| `engine-view.ts` | `engineViewImpl()` — pi→engine message adapter passthrough |
| `snapshot.ts` | `computeMegaSnapshot()` pure function |
| `dashboard-snapshot.ts` | `computeDashboardSnapshot()` |
| `widget.ts` | Barrel — `buildWidgetLines()` + re-exports from `widget-ansi.ts` / `widget-types.ts` |
| `widget-ansi.ts` | ANSI palette (`C`), `PULSE`, panel layout + border-effect helpers, token/time formatters |
| `widget-types.ts` | `TickerEntry` + `WidgetData` interfaces (pure types) |
| `effects.ts` | Effect/flare helpers (`setEffectImpl`, `armMegaCacheFlareImpl`, etc.) |
| `game-state.ts` | Game-state cache + watcher (`ensureGameStateWatcherImpl`, `bumpGameStateImpl`, `disposeRuntimeImpl`) |
| `capture-model.ts` | Model capture (`captureModelImpl`) |
| `bind-repo.ts` | Repo binding utilities (`bindRepoImpl`) |
| `perf.ts` | Perf sample recording + interval (`ensurePerfIntervalImpl`, `disposePerf`) |
| `helpers.ts` | Shared constants/types (`SessionRuntime`, `STATUS_KEY`, `WIDGET_KEY`, …) |
| `query.ts` | Query helpers (`recentUserQuery`) |

