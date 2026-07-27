# mega-runtime — Decomposition Tracker

This file tracks the progressive decomposition of the original `mega-runtime.ts`
monolith (2 600+ lines) into focused single-responsibility modules.

---

## Current State (raptor-promotion branch)

### Completed — Phase 1: Extract pure helpers

The original `state.ts` (later `mega-runtime.ts`) has been split into:

| File | Lines | Responsibility |
|---|---|---|
| `state.ts` | 8 | **Re-export placeholder** — re-exports `MegaRuntime` from `runtime.ts` so all existing imports keep working |
| `runtime.ts` | ~522 | **MegaRuntime class** — the orchestrator (constructor, dispose, bindRepo, 1-line delegate methods) |
| `runtime-snapshot.ts` | ~289 | `snapshotImpl(ctx, ctxPi)` — the full `snapshot()` body (vector stats, threshold/armed/ready, drift, widget, dashboard.json write) |
| `runtime-helpers.ts` | ~119 | Extracted private helpers: `materialSigImpl`, `embedderNameImpl`, `driftStatusImpl`, `getTurnLevelImpl` + `RuntimeHelpersContext` |
| `snapshot.ts` | ~229 | `computeMegaSnapshot()` — pure function, no class state |
| `dashboard-snapshot.ts` | ~173 | `computeDashboardSnapshot()` — dashboard-specific snapshot variant |
| `widget.ts` | ~172 | **Thin barrel** — owns `buildWidgetLines()` + re-exports from `widget-ansi.ts`/`widget-types.ts` |
| `widget-ansi.ts` | ~218 | ANSI palette (`C`), `PULSE`, panel layout helpers, ambient border-effect helpers, token/time formatters |
| `widget-types.ts` | ~81 | `TickerEntry` + `WidgetData` interfaces (pure types, zero imports) |
| `effects.ts` | ~129 | Effect/flare helpers: `armMegaCacheFlareImpl`, `armAchievementFlareImpl`, `setEffectImpl`, `pushTickerImpl` |
| `game-state.ts` | ~125 | Game state cache: `ensureGameStateWatcherImpl`, `bumpGameStateImpl`, `refreshWidgetGameStateImpl` |
| `capture-model.ts` | ~101 | Model capture: `captureModelImpl` |
| `bind-repo.ts` | ~81 | Repo binding: `resolveRepoId`, `resolveMemoRoot` |
| `perf.ts` | ~60 | Perf sample helpers: `recordPerfSample`, `ensurePerfIntervalImpl`, `disposePerf` |
| `helpers.ts` | ~73 | Shared constants/types (`MEGA_HOME`, `DEFAULT_CONFIG`, `MegaConfig`, etc.) |
| `query.ts` | ~29 | Query helpers (`recentUserQuery`) |

All tests pass (the suite is built and run via `npm test` → `node scripts/run-tests.mjs`).

### Completed — Phase 2a: Split `widget.ts` (~422 → 172 + 218 + 81 lines)

The original monolithic `widget.ts` has been decomposed into three files with a
preserved barrel so **no consumer import changed**:

| New file | Content | Source of the code |
|---|---|---|
| `widget-types.ts` | `TickerEntry`, `WidgetData` interfaces | moved verbatim from the old `widget.ts` |
| `widget-ansi.ts` | `C` palette, `PULSE`, `DEFAULT_PANEL_BG`, `panelBgFor`, `themeAnsi`, `sgrReset`, `wrapLine`, `panelLine`, `panelBar`, `EFFECT_BASE`, `effectBorderSgr`, `effectBar`, `fmtTokens`, `ramp`, `sinceCompactStr` | moved verbatim; the previously-private helpers are now `export`ed |
| `widget.ts` (slimmed) | `buildWidgetLines()` + `export { … } from "./widget-ansi.js"` + `export type { … } from "./widget-types.js"` | the render function stays here; barrel re-exports keep `./widget.js` resolving `C`, `TickerEntry`, `WidgetData`, `buildWidgetLines` |

**Compatibility:** the only names the old `widget.ts` exported were `C`,
`TickerEntry`, `WidgetData`, `buildWidgetLines`; every other helper was a
non-exported `const`/`function`. The new `widget.ts` re-exports **all** of them
(additive — more public surface, no removed names), and there is **zero name
collision** with the sibling barrels (`helpers.ts`/`state.ts`/`query.ts`), so the
`extensions/mega-runtime.ts` `export * from "./mega-runtime/widget.js"` keeps
resolving identically. Verified: `tsc --noEmit` passes; `widget.test.ts`
(S31 matrix + ambient-effect + footer-stability + achievement-flare) green.

---

## Completed — Phase 2b: Extract `runtime.ts` private helpers (~783 → ~754 lines + 120)

The four pure/instance helpers were extracted from the `MegaRuntime` class into
`runtime-helpers.ts` following the established context-interface + free-function
+ thin-delegate pattern (same as `effects.ts` / `game-state.ts` / `capture-model.ts`
/ `bind-repo.ts` / `perf.ts`).

| New file | Content | Source of the code |
|---|---|---|
| `runtime-helpers.ts` | `RuntimeHelpersContext` interface + `materialSigImpl(ctx)`, `embedderNameImpl()`, `driftStatusImpl(ctx)`, `getTurnLevelImpl(ctx)` | moved verbatim from the old private methods |
| `runtime.ts` (slightly slimmer) | the four methods are now 1-line delegates (`return *Impl(this)`); `driftCache` is now public so `MegaRuntime` satisfies `RuntimeHelpersContext` structurally | — |

**What moved:**
- `materialSig()` → `materialSigImpl(ctx)` — pure over all-public fields.
- `embedderName()` → `embedderNameImpl()` — trivially pure (reads `process.env`).
- `driftStatus()` → `driftStatusImpl(ctx)` — required `driftCache` to become
  public (one-token change; internal state, not an API contract). The
  `detectCrossRepoDrift` import moved into `runtime-helpers.ts` (was only used
  there) and was dropped from `runtime.ts`.
- `getTurnLevel()` → `getTurnLevelImpl(ctx)` — the `turnLevel` import moved into
  `runtime-helpers.ts` and was dropped from `runtime.ts`.

All call sites (`this.materialSig()`, `this.embedderName()`, `this.driftStatus()`,
`this.getTurnLevel()`) are unchanged — the thin in-class delegates preserve the
existing API. Verified: `tsc --noEmit` passes; full suite green.

## Completed — Phase 2c: Extract `snapshot()` body to `runtime-snapshot.ts` (~783 → ~522 lines + 289)

The `snapshot()` method — the single largest method on `MegaRuntime` — was
extracted into `runtime-snapshot.ts` as `snapshotImpl(self, ctx?)`, following
the same context-interface + free-function + thin-delegate pattern.

| New file | Content | Source of the code |
|---|---|---|
| `runtime-snapshot.ts` | `RuntimeSnapshotContext` interface + `snapshotImpl(self, ctx?)` — the full snapshot body: material-sig gate, vector stats, effective threshold/armed/ready, drift status, `computeMegaSnapshot` → `widgetData` + `renderWidget`, `writeFileSync(dashboard.json)`, perf sample, ticker push, flare arming | moved verbatim from the old `snapshot()` method |
| `runtime.ts` (slimmed) | `snapshot(ctx?)` is now a 1-line delegate (`return snapshotImpl(this, ctx)`); `lastSnapshotSig` is now public so `MegaRuntime` satisfies `RuntimeSnapshotContext` structurally | — |

**What moved:**
- The `computeMegaSnapshot`, `buildDashboardSnapshot`, `detectCrossRepoDrift`,
  `vectorStats`/`vectorRepoStats`/`vectorDataInvariant`, `recordPerfSample`,
  `recordSessionHeartbeat`, `appendTokenSample`, and `latestModelSnapshot`
  imports moved into `runtime-snapshot.ts` (none are used by `runtime.ts`
  anymore) — `runtime.ts` only imports `VectorStore` (type) now.
- `lastSnapshotSig` became public (one-token change; internal state, not an
  API contract) so `MegaRuntime` satisfies `RuntimeSnapshotContext`.

All call sites (the `before_agent_start`/`context`/`compact` handlers that
call `this.snapshot(ctx)`) are unchanged — the thin in-class delegate
preserves the existing API. Verified: `tsc --noEmit` passes; full suite
green (649 tests across 61 files).

## Completed — Phase 2d: Maximal split of `runtime.ts` (~522 → ~437 lines, zero method bodies)

The maximal split moves **every** remaining method body in `runtime.ts` into
its own single-responsibility module, leaving the class as field declarations,
the constructor, and 1-line delegates only. This completes the decomposition
charter: no logic lives in the orchestrator file anymore.

| New file | Content | Source of the code |
|---|---|---|
| `pressure-getters.ts` | `PressureContext` + `pressureImpl` / `effectiveThresholdImpl` / `pressureBandImpl` | moved verbatim from the `pressure` / `effectiveThreshold` / `pressureBand` getters |
| `reset-runtime.ts` | `ResetRuntimeContext` + `resetRuntimeImpl(self, sessionId)` | moved verbatim from `resetRuntime()` |
| `append-event.ts` | `AppendEventContext` + `appendEventImpl(self, event, fields)` | moved verbatim from `appendEvent()` |
| `get-state-dir.ts` | `GetStateDirContext` + `getStateDirImpl(self)` | moved verbatim from `getStateDir()` |
| `render-widget.ts` | `RenderWidgetContext` + `renderWidgetImpl(self, ctx)` | moved verbatim from `renderWidget()` |
| `status.ts` | `SetStatusContext` + `setStatusImpl(self, ctx, text)` | moved verbatim from `setStatus()` |
| `engine-view.ts` | `engineViewImpl(messages)` | moved verbatim from `engineView()` |
| `game-state.ts` (+append) | `DisposeRuntimeContext` + `disposeRuntimeImpl(self)` | moved verbatim from `dispose()` (game-state.ts already owns the watcher context, so this lands there alongside `ensureGameStateWatcherImpl`) |

**What moved / changed:**
- `runtime.ts` import block rewritten: dropped `appendFileSync`/`mkdirSync`,
  `STATUS_KEY`/`WIDGET_KEY`, `buildWidgetLines`, and
  `pressureRatio`/`pressureFromPct`/`pressureBand`/`effectiveThresholdTokens`
  (now consumed only in their respective modules); added imports of the 7 new
  `*Impl` functions + `disposeRuntimeImpl`. `toEngineMessages` is kept
  (`engineView`'s return type still references it); `normalizeSessionId` is kept
  (the `rt` field initializer still uses it).
- The big pressure doc comment moved to `pressure-getters.ts`; `runtime.ts`
  keeps a one-line pointer comment per delegate.
- `dispose()` delegates to `disposeRuntimeImpl` (in `game-state.ts`), which
  composes `GameStateContext` + `PerfContext` and calls the existing
  `disposePerf` — so `disposePerf` is no longer imported by `runtime.ts`.

**Why maximal:** the soft `~500 line` doc-length target (CLAUDE.md §6) applies to
source files too. `runtime.ts` at 522 lines was the only mega-runtime source
file over the target; the split brings it to **437 lines** (delegates + fields +
constructor only), with every new file ≤96 lines. The pattern (context-interface
+ free-function + thin-delegate) is the same one established in Phase 1
(`effects.ts`/`game-state.ts`/`capture-model.ts`/`bind-repo.ts`/`perf.ts`) and
extended in Phase 2b/2c (`runtime-helpers.ts`/`runtime-snapshot.ts`).

Verified: `tsc --noEmit` passes; `npm run lint` (tsc + guardrails-scan +
semantic-scan) green; `npm test` green (678 tests, 61 files, 0 failures);
`python3 scripts/regression_check.py --all` green; 8-point structural audit
green (line counts, no logic primitives left, 22 `Impl(this)` delegates, no
`this.` in new files, each `*Impl` defined exactly once, git scope limited to
the 2 modified + 7 new files, game-state.ts diff is purely additive, tsc clean).


### Deferred — effects wrappers

The `armMegaCacheFlare` / `armAchievementFlare` / `setEffect` / `pushTicker`
methods on `MegaRuntime` are already thin one-line delegates whose bodies live
in `effects.ts` (`*Impl` functions). They could optionally be collapsed into a
`runtime-effects.ts` barrel-of-delegates, but this yields little benefit (each
is already one line) and risks churn. **Deferred** unless `runtime.ts` grows.

## Sprint Backlog (prioritised)

1. ~~**Split `widget.ts`** — done (Phase 2a).~~
2. ~~**Split `runtime.ts`** — extract `materialSig`/`embedderName`/`driftStatus`/`getTurnLevel` into `runtime-helpers.ts` — done (Phase 2b).~~
3. ~~**Extract `snapshot()` body** into `runtime-snapshot.ts` — done (Phase 2c).~~
4. ~~**Verify `state.ts` re-export** — confirm `state.ts` → `runtime.ts` → final modules chain works (`state.test.ts` uses `createRequire` to load compiled JS) — green after Phase 2b.~~
5. ~~**Run full test suite** after each split (`npm test`) — green after 2a, 2b, and 2c (649 tests, 61 files, 0 failures).~~
6. **Final cleanup** — remove the `state.ts` placeholder once all consumers are updated to import `MegaRuntime` directly from `runtime.ts` (low priority; `state.ts` re-export is zero-cost).
7. **Commit Phase 2** — stage the Phase 2a/2b/2c changes (`runtime-helpers.ts`, `widget-ansi.ts`, `widget-types.ts`, `widget.ts`, `runtime-snapshot.ts`, `runtime.ts`, `DECOMPOSITION.md`) and commit.

---

## Notes

- `state.ts` is intentionally kept as a re-export to avoid a breaking change in `extensions/mega-runtime.ts:18` which imports `MegaRuntime` from `./mega-runtime/state.js`.
- `state.test.ts` and `widget.test.ts` exist alongside the source — they use `createRequire` to load compiled JS, not direct TS imports, so they exercise the built `dist/` output (build before testing).
- The `extensions/mega-runtime.ts` barrel does `export * from "./mega-runtime/widget.js"`; the widget split keeps that resolving because `widget.ts` re-exports the same public surface.
