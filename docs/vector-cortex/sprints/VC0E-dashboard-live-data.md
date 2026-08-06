# VC Dashboard Live Data + Status Indicators

Status: **done** | Branch: `feat/vc-dashboard-live-data` (merged at `863b7bd`) | Date: 2026-08-05

Flag: VC0E wires existing emitters + adds status badges to routes/cards that already sit behind their own `MEGACOMPACT_VC*` flags (VC0A recall latency, VC5B render seam, VC5C live decision, VC8 outcomes/platform); it introduces **no new `MEGACOMPACT_*` flag** of its own. Setting any of those flags off yields the pre-VC0E response shapes (bare zero, no `status`) byte-identical; the added `status` field is only emitted on the flagged-on, data-bearing paths it annotates.

Production ownership: `extensions/dashboard-server/routes-vector-cortex*.ts`, `extensions/dashboard-server/vc-status.ts`, `extensions/dashboard-server/vc-live-decisions.ts`, `extensions/mega-runtime/*.ts` (emitter wiring), `src/monitoring.ts`, `src/engine.ts`, `src/recall.ts`, plus the dashboard-client `VectorCortex*` badges/cards wiring and the cross-cutting seams the scope-check already covers.

Follow-up to VC0D production wiring. The v0.20.23 wiring shipped emitters, but the live dashboard still showed all zeros. Root-cause exploration identified 15 gaps across 3 classes.

## Problem Statement

The Vector Cortex dashboard shows bare zeros on every card with no indication of *why* (never-called emitters vs. wired-but-broken vs. deferred-by-design). User directive: cards must communicate state instead of showing zeros.

### Root-Cause Classification (from codebase exploration)

| Class | Subsystems | Diagnosis |
|---|---|---|
| Live and working | VC0A (compact latency), VC5C (decision emission), VC6A (heal), VC6C (repair-stubs), VC1B (ledger), VC4C (reconstruct, shared with VC6A) | Emitters fire on real paths; some write correct values |
| Wired but never called | VC0A recall latency, VC5B (render seam) | Function exists at known location; **no import reference** from the production entry point or recall caller |
| Wired but always degrades | VC5C (rollout params) | `decideLivePath` requires `clock` + `evidence`; call site omits both → permanent mode-C |
| Hardcoded zero with no read | VC5C rollout route, VC8A outcomes, VC8C platform | Response body uses `events: 0, sessions: 0` — never consults `countVcEvents` |
| Deferred by design | VC7A, VC7B, VC7C, VC8B | `deferredReason` set, but client renders the card the same as zero-active |
| Structural-only | VC0C (health), VC3C (query), VC5A (plans), VC5B (render), VC4B (residual) | Flag/constant response has no event-count fields |

## Goals

1. Wire all disconnected emitters.
2. Pass the required rollout gate parameters so decisions become non-degenerate.
3. Convert every VC dashboard route to an honest event-count data source or explicit structural/deferred status.
4. Add a client-side status badge so no card displays zeros without context.

## Plan

### Wave A: Emit wiring (production)

- **A1. VC5B registration** — `extensions/mega-events/register.ts`: call `registerVectorCortexRender(pi, runtime.ctx, emit)` after `registerPerfHandler`. Function is internally flag-gated.
- **A2. VC5C rollout params** — `extensions/mega-events/context-handler/pipelineRun.ts`: pass `clock` (from `defaultClock()` in rollout/gate module) and minimal honest `evidence` (sessions: 1, events: compactCount, powered: false) to `decideLivePath`. Gate will not advance with insufficient data, but decisions now carry structured evidence instead of degenerate mode-C.
- **A4. VC6C real values** — `extensions/mega-events/context-handler/afterCompact.ts`: set `generation: runtime.rt.compactCount` and `gapSize: ran.result.compactedFrom` (stubs were `gapSize: 0, generation: 1`).
- **A5. VC0A recall latency** — `extensions/mega-pipeline/recall.ts`: time `doRecall` and call `recordRecallLatency(runtime, elapsed, sid, 0)`.

### Wave B: Route status + data sources (dashboard-server)

- **B1. Status helper** — new `extensions/dashboard-server/vc-status.ts` with `deriveVcStatus({enabled, deferredReason, hasData, structuralOnly})` → `"live"|"awaiting_data"|"deferred"|"structural"|"off"`.
- **B2. API contracts** — add `readonly status?:` to every View interface in `extensions/dashboard-server/api-contracts/vector-cortex*.ts`.
- **B3. All routes add status** — every `routes-vector-cortex-*.ts` response includes `status` from `deriveVcStatus`. Route-specific `hasData` expressions (e.g., eval → samples > 0, ledger → count > 0).
- **B4. Rollout/outcomes/platform routes read events.log** — replace hardcoded zeros with `countVcEvents`; rollout route also counts distinct sessionIds from rollout events.

### Wave C: Client status UI (dashboard-client)

- **C1. Client types** — add `status?:` to view interfaces in the three client type files.
- **C2. VcStatusBadge component** — new shared badge mapping status → variant (`live` → "LIVE" success, `awaiting_data` → "AWAITING DATA" warning, `deferred` → "DEFERRED" outline, `structural` → "STRUCTURAL" accent, `off` → "OFF" danger).
- **C3. All 15 card components** — replace the `{view?.enabled ? ACTIVE : OFF}` ternary with `<VcStatusBadge status={view?.status} />` and add status-line text for awaiting_data and deferred states.

## What's NOT changing

- VC7A/VC7B/VC7C/VC8B remain deferred — no new subsystem work.
- VC3A/VC3B (topology), VC4A (shards), VC6B (restore) stay unwired — they require their own sprints; status now renders this explicitly.
- VC4B residual stays structural (explicit empty-metrics comment).

## Execution

Sonnet agents perform implementation; controller performs review and fixes. Wave A and B run in parallel (disjoint file sets: A touches `extensions/mega-events/` + `extensions/mega-pipeline/`, B touches `extensions/dashboard-server/`). Wave C blocks on both (touches `extensions/dashboard-client/`).

## Acceptance / Gate

- `npx tsc --noEmit` clean (repo root + dashboard client)
- `npm run build` clean
- `npm test` — all tests pass
- `npm run lint` clean
- `python3 scripts/regression_check.py --all` clean
- `python3 scripts/regression_check.py --soft-as-hard --pre-commit` — no changed file over soft limit
- `node scripts/guardrails-scan.mjs` clean
- Dashboard shows: eval card "LIVE" after first compaction; rollout card "AWAITING DATA" until gate params flow; deferred cards show "DEFERRED" with reason text; no card displays zeros without a status explanation

## Deploy

`./scripts/deploy.sh <version>` — single sprint patch bump.
