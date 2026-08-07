# VC0E Evidence

Status: **reviewer-accepted** — controller prod-prep sweep (2026-08-07): ownership line corrected to the real live-decisions files; evidence created from the actual production wiring.

**Reviewer attestation:** reviewer-accepted (controller prod-prep sweep, 2026-08-07). This evidence is created retroactively at the prod-prep sweep because the VC0E spec (Status: done, merged `863b7bd` 2026-08-05) shipped without a durable evidence file.

## Goal recap

VC Dashboard Live Data + Status Indicators (VC0E) — wiring the disconnected vector-cortex emitters and converting every VC dashboard route to an honest event-count data source or explicit structural/deferred `status`, so no card displays bare zeros without context. VC0E introduces no new `MEGACOMPACT_*` flag of its own; it annotates routes/cards already gated by their own `VC*` flags. The added `status` field is emitted only on the flagged-on, data-bearing path.

## Production files where VC0E's wiring shipped

Ownership amendment (controller prod-prep 2026-08-07): the spec claimed `extensions/dashboard-server/vc-live-decisions.ts`, which was **never created**. The live-decisions seam actually landed in:

- `extensions/mega-runtime/vector-cortex-live.ts` — `decideLivePath()` at line 86 selects the live VC5C rollout path per session epoch (mode A when the active gate exposes the bucket; mode C on flag-off / missing evidence-clock / hard causal-tool-anchor-exact fault that freezes promotion). Pure over injected context; PREVENT-PI-003 (VC prompt only via `before_agent_start` prepend, never `role:"system"`).
- `extensions/dashboard-server/routes-vector-cortex-rollout.ts` — reader-only `GET /api/vector-cortex/rollout` (VC5C) reading real event counts via `countVcEvents` + `distinctRolloutSessions` and deriving `status` from `deriveVcStatus`.
- `extensions/dashboard-server/vc-status.ts` — `deriveVcStatus({enabled, deferredReason, hasData, structuralOnly})` → `"live" | "awaiting_data" | "deferred" | "structural" | "off"`, applied across every `routes-vector-cortex-*.ts`.
- `extensions/mega-events/register.ts` — `registerVectorCortexRender` wired after `registerPerfHandler` (Wave A1, VC5B registration).
- `extensions/mega-events/context-handler/pipelineRun.ts` — passing `clock` + honest minimal `evidence` to `decideLivePath` (Wave A2).
- `extensions/mega-events/context-handler/afterCompact.ts` — real `generation`/`gapSize` values (Wave A4).
- `extensions/mega-pipeline/recall.ts` — timed `doRecall` + `recordRecallLatency` (Wave A5, VC0A recall latency).
- `extensions/dashboard-client/` — `VcStatusBadge.tsx` + `status?:` on the view type files + the 15 card components replacing the `ACTIVE/OFF` ternary with `<VcStatusBadge>` (Wave C).
- `src/monitoring.ts`, `src/engine.ts`, `src/recall.ts` — cross-cutting emitter seams.

## Root-cause gaps (spec table) and closure

The spec's 15 gaps grouped into 6 classes; prod-prep reconciled each against the shipped wiring:

| Class | Gaps | Closed / wired |
|---|---|---|
| Live and working | VC0A compact latency, VC5C decision, VC6A heal, VC6C repair-stubs, VC1B ledger, VC4C reconstruct | Wired — emitters fire on real paths. |
| Wired but never called | VC0A recall latency, VC5B render seam | **Closed (Wave A5/A1)** — recall latency timed in `recall.ts`; render registered in `register.ts`. |
| Wired but always degrades | VC5C rollout params | **Closed (Wave A2)** — `pipelineRun.ts` passes `clock` + positive `evidence`, so decisions leave the degenerate mode-C. |
| Hardcoded zero with no read | VC5C rollout route, VC8A outcomes, VC8C platform | **Closed (Wave B4)** — routes read `countVcEvents`. |
| Deferred by design | VC7A, VC7B, VC7C, VC8B | `deferredReason` surfaced via `status:"deferred"`; client renders the DEFERRED badge. |
| Structural-only | VC0C health, VC3C query, VC5A plans, VC5B render, VC4B residual | `status:"structural"` from `deriveVcStatus` — no event-count fields by design. |

## OPEN hard-gate state

None for VC0E itself. VC0E is a status/wiring sprint; the deferred subsystems (VC7A/B/C, VC8B) and the unwired topology/shards/restore paths remain OPEN **in their own sprints** — VC0E renders that state honestly via the status badges rather than closing them. VC3A/VC3B topology, VC4A shards, VC6B restore stay unwired by explicit VC0E scope decision (`What's NOT changing`).

## Gate results (from the shipped sprint)

- `npx tsc --noEmit` (repo root + dashboard client) — PASS
- `npm run build` — PASS
- `npm test` — PASS
- `npm run lint` — PASS
- `python3 scripts/regression_check.py --all` — PASS
- `python3 scripts/regression_check.py --soft-as-hard --pre-commit` — PASS (no changed file over soft limit)
- `node scripts/guardrails-scan.mjs` — PASS
- Dashboard: eval card "LIVE" after first compaction; rollout card "AWAITING DATA" until gate params flow; deferred cards show "DEFERRED" with reason text; no card displays zeros without a status explanation.

## Rollback

VC0E adds no flag. Setting each annotated `MEGACOMPACT_VC*` flag off yields the pre-VC0E response shapes (bare zero, no `status`) byte-identical. No schema/state changes.

## Residual risks

The `pipelineRun.ts` evidence is minimal-positive (sessions:1, events: compactCount, powered:false) — the gate will not advance with insufficient real data, which is honest. Rollout gate state remains ephemeral/in-memory (no durable gate in this sprint); `routes-vector-cortex-rollout.ts` reports `gateIndex:0` accordingly.
