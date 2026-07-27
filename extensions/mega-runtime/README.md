# mega-runtime

Runtime state and widget rendering for the mega-compact dashboard.

## Module structure

| Module | Responsibility |
|---|---|
| `state.ts` | Barrel re-export (imports should use this path) |
| `runtime.ts` | `MegaRuntime` class — orchestrator |
| `snapshot.ts` | `computeMegaSnapshot()` pure function |
| `dashboard-snapshot.ts` | `computeDashboardSnapshot()` |
| `widget.ts` | Above-editor widget rendering (ANSI) |
| `effects.ts` | Effect/flare helpers |
| `game-state.ts` | Game state cache |
| `capture-model.ts` | Model capture |
| `bind-repo.ts` | Repo binding utilities |
| `perf.ts` | Perf sample recording |
| `helpers.ts` | Shared constants/types |
| `query.ts` | Query helpers |
