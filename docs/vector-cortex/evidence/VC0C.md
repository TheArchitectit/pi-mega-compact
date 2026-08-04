---
# VC0C Evidence

Status: implementer-complete
Implementation commits/sub-sprint gates: VC0C sprint on `feat/vector-cortex`; see git log for the focused commits. All sprint exit gates run and recorded below.
Contract review: not yet performed — pending independent reviewer.

## Goal recap

Live safety envelope (TriadResult / BreakerRecord / KillDecision). Production ownership of `src/vector-cortex/resilience/{types,breaker,spool}.ts` and `extensions/mega-runtime/vector-cortex-safety.ts`. Select mode A (optimized/learned), then independent mode B (deterministic local spool deriving directly from authority), then unchanged mode C (continuity, NOT semantic completeness) BEFORE provider invocation; a manual reset clears cooldown but never evidence. Normative 60s/20-attempt breaker, 30s exponential cooldown, N=3 probes, 5min healthy residence; authority outage freezes the derived high-water frontier. Flag `MEGACOMPACT_VC0C` default ON.

## Changed production / tests / docs

Production (`src/` + `extensions/`):
- `src/config/vector-cortex.ts` — `VC0C_ENABLED()` (default ON; `MEGACOMPACT_VC0C=0` → off). The shared `BREAKER_*` constants (window 60s, min attempts 20, cooldown 30s, probe count 3, exp retry base/cap/jitter, min healthy residence 5min, hysteresis budget) are consumed, NOT redefined — resolving the standing "dead BREAKER_* constants" issue (carried from prior sprints).
- `src/vector-cortex/resilience/types.ts` — `Mode="A"|"B"|"C"`, `BreakerState`, `BreakerRecord`, `TriadResult<T>` discriminated union, `KillDecision`, the `Breaker` circuit-breaker seam (`execute`/`recordProbe`/`manualHalt`), `SpoolDrainVerdict`, and `TRI_IDS` registering conformance rows `TRI-001..030` (mirroring `EVT_IDS`/`CUT_IDS`/`M3_IDS`).
- `src/vector-cortex/resilience/breaker-core.ts` (impl) + `breaker.ts` (thin factory shell, delegate-shell split) — TRIAD_RESILIENCE §breaker state machine: `CLOSED_A/OPEN_B/OPEN_C/PROBE_B/PROBE_A/MANUAL_HALT`. Rolling 60s window + 20-attempt min; performance trip at 5 failures or rate ≥ threshold, correctness trip on the FIRST correctness failure (zero-tolerance); 30s cooldown; exactly 3 successful probes to advance; expired cooldown may PROBE, never directly promote (probe output is never served); exponential `30s·2^attempt` backoff capped at 15min with deterministic ±10% jitter derived from the subsystem digest; promotion hysteresis (rate + p95 budget) and 5min healthy residence before promotion; manual halt requires a reason; admin `reset` clears cooldown NEVER evidence. Windows/cooldowns use MONOTONIC clock (`now()`, injectable/fake-clock); wall time only stamps `updatedAt` — backward/forward wall jumps never alter eligibility. Reconstruction on restart replays appended breaker events (`onEvent`).
- `src/vector-cortex/resilience/spool-core.ts` (impl) + `spool.ts` (shell) — append/fsync/ack records keyed by session+seq: length-prefixed binary frames sourced in `originalBytes`, SHA-256 + CRC32C, fsync-before-ack, ack frames advance a contiguous per-session high-water, crash-replay drains only unacknowledged frames, and a unique injection distinguishes a kill between fsync and ack while a corrupt header throws on reopen (schema guard). `freezeFrontier()`/`frozen()` freeze the authority frontier on outage; restart re-reads the durable file.
- `src/vector-cortex/resilience/emit.ts` — the resilience emit seam carrying exactly the three named events (see below), same injected `(event, fields)` shape + `safe()` non-fatal wrapper + per-call `VC0C_ENABLED()` gate; absent emitter / flag OFF → no-op (byte-identical predecessor).
- `extensions/mega-runtime/vector-cortex-safety.ts` — the pi-runtime-adjacent shell. `createVectorCortexSafety(ctx, emit?)` composes breaker + spool + reporter; `select(provider)` defers to the breaker's A→B→C selection BEFORE provider invocation; `health()` builds the reader aggregate; `reset`/`halt` own the admin/security surface. Non-fatal: any breaker/spool noise degrades to mode C and never breaks the agent loop.

Dashboard (`extensions/dashboard-server/` + `dashboard-client/`):
- `routes-rag-settings-helpers.ts` — `MEGACOMPACT_VC0C` added to the "Vector Cortex" SETTINGS group as a `boolDirect` on/off toggle (NOT in `EXCLUDED_SETTINGS`).
- `api-contracts/vector-cortex.ts` — `VectorCortexHealthCard` (enabled/mode/state/subSystem/sinceMs/windowMs/probeCount/backoffDelayMs/frontierFrozen/authorityOutage/spoolLag/attempts/failures/p95Ms/failureRate/updatedAt) + `VectorCortexResetResult`.
- `routes-vector-cortex.ts` — reader-only GET `/api/vector-cortex/health` (constructs `createVectorCortexSafety({stateDir})` per request) + admin POST `/api/vector-cortex/breakers/reset` (409 when disabled); registered in `routes.ts` + `server.ts` before `handleStatic`.
- `dashboard-client/src/types/vector-cortex.ts`, `api/vector-cortex.ts`, `tabs/VectorCortexTab.tsx` — health state, reset handler, "Live Safety Envelope (VC0C)" card.
- `routes-vector-cortex.test.ts` — 8 route tests (health reader-only shape, reset clears cooldown retains evidence, missing subsystem, 409-when-disabled). `routes-rag-settings.test.ts` — was 14, now 15 (VC0C toggle round-trip).

Scripts:
- `scripts/vector-cortex-gen-fixtures.mjs` — added `resilience/` domain (30 fixtures TRI-001..030 + `schemas/tri-fixture.schema.json`) + `resilienceNamed` (TRI-WINDOW-001, TRI-PROBE-002, TRI-FREEZE-003); regenerated multi-domain manifest (`domain:"evaluation,replay,events,resilience"`, `owner:"VC0A,VC0B,VC1A,VC0C"`).
- `scripts/vector-cortex-network-denial.mjs` — mode A exercises the common breaker, mode B the spool, mode C unchanged (zero event/spool writes, transcript codec unchanged).

Tests:
- `src/vector-cortex/resilience/breaker.test.ts`, `spool.test.ts` — unit (window, cooldown, probes, backoff, hysteresis, residence, spool frame/drain/gap/digest-conflict/ack-crash/frozen-frontier).
- `src/vector-cortex/vc0c-acceptance.test.ts` — acceptance aggregator (16 tests, both flag states): manifest byte-authority over all 30 TRI rows, real breaker vs TRI-001..015 expected states, real spool verdict vs TRI-016..030, promotion invariant (never precedes cooldown, 3 probes, 5min residence), unique failure injection (kill-between-fsync-and-ack reopen, backward wall skew 90s, monotonic restart), forced triad (A healthy, B demoted by A exception, C when both unavailable), and flag-off byte identity (zero events + unchanged golden bytes).

Docs: `docs/vector-cortex/evidence/VC0C.md` (this record).

## Fixtures and corpus digests

`conformance/vector-cortex/v2/resilience/` — 30 fixtures (TRI-001..015 breaker, TRI-016..030 spool) + `schemas/tri-fixture.schema.json`.
`node scripts/vector-cortex-conformance.mjs --check` → `✓ CONFORMANCE: v2 manifest + 94 fixtures canonical (94 files).`

Required named fixtures:
- `TRI-WINDOW-001` — twentieth failed attempt inside 60s opens the breaker.
- `TRI-PROBE-002` — three successful probes enter healthy residence.
- `TRI-FREEZE-003` — authority outage preserves the prior frontier.

Manifest now describes `domain:"evaluation,replay,events,resilience"`, `owner:"VC0A,VC0B,VC1A,VC0C"`, `schemaVersion:"metric-event-v1;replay-cut-v2;event-v2;tri-fixture-v1"`. All fixtures canonical (UTF-8/NFC/sorted keys/shortest numbers/final LF); SHA-256 pinned in the manifest.

## A/B/C and independence evidence

- A = common breaker path (`breaker.ts` state machine: rolling window, trips, cooldown, backoff, hysteresis). Healthy A serves the optimized/learned result.
- B = deterministic/local spool (`spool.ts`: length-prefixed frames, SHA-256+CRC32C, fsync-before-ack, contiguous per-session high-water, crash-replay of only unacknowledged frames, authority-outage frontier freeze). Driven by an A exception → B serves independently.
- C = unchanged transcript (continuity, NOT semantic completeness); used when both A and B are unavailable, and its output states that the old semantic context is lost.
- Each mode uses independent algorithms/assets/indexes. Network-denial mode C is a genuine no-op (zero event/spool writes, transcript codec byte-identical to predecessor).

## Command-verified acceptance numbers

Acceptance, mandated command, both flag states (ON and flag-off rehearsal):
```bash
node --test dist/vector-cortex/vc0c-acceptance.test.js
# → ℹ tests 16, ℹ pass 16, ℹ fail 0   (flag ON)
MEGACOMPACT_VC0C=0 node --test dist/vector-cortex/vc0c-acceptance.test.js
# → ℹ tests 16, ℹ pass 16, ℹ fail 0   (predecessor golden bytes match)
```

## Commands and verbatim summaries

- `npm run build` → tsc clean (no `error TS`; postbuild publishes resilience files to dist).
- `npm test` → `0 failed` across a constant file count (pass total drifts run-to-run per `scripts/run-tests.mjs` adjudication; `0 failed` + constant file count is the stable invariant).
- `npm run lint` → `tsc --noEmit` + `guardrails-scan` + `semantic-scan` all clean.
- `python3 scripts/regression_check.py --all` → `✓ No potential regressions detected`; the sole hard-limit error is the pre-existing `extensions/mega-events/context-handler.ts` (514) at HEAD, untouched by this sprint. (`vc0c-acceptance.test.ts` was trimmed to 580 lines — under the 600 hard limit, see VC0C-I04.)
- `node scripts/vector-cortex-conformance.mjs --check` → `✓` (94 fixtures canonical).
- `node scripts/vector-cortex-docs-check.mjs` → `✓ DOCS-CHECK: 27 sprints / 9 phases, links+flags+commands+migrations clean.`
- `python3 scripts/log_failure.py --list` → 2 pre-existing active runtime entries (FAIL-38192431, FAIL-55d81817); no VC0C-introduced failure.
- `node scripts/guardrails-scan.mjs` → `GUARDRAILS: pi pattern scan clean` (+ semantic scan clean via lint).
- `node scripts/vector-cortex-network-denial.mjs --modes=A,B,C` → `NETWORK-DENIAL: modes A,B,C clean — no network egress.`
- `git diff --check` → clean (exit 0).
- `node --test dist/extensions/dashboard-server/routes-rag-settings.test.js` → `tests 15, pass 15, fail 0` (was 14; VC0C toggle round-trip added).
- Dashboard: `cd extensions/dashboard-client && npm run build` → `✓ built` (production Vite bundle; the dashboard dist was rebuilt and committed). `npm run typecheck` reports 92 PRE-EXISTING `node:sqlite`/`process` node-type errors from `../../src/store`, `../../src/wiki`, `../../src/config/vector-cortex.ts` pulled via `@contracts` (tsconfig `types:[]` disables `@types/node`); none are introduced by VC0C and my VC0C dashboard files produce ZERO errors. The Vite production build is the documented passing gate (see VC0C-I03).

## Evaluation

All 30 TRI-001..030 conformance rows re-executed against the REAL breaker/spool (not mock) return their manifest bytes or exact listed failure code; the real final breaker state for every TRI-001..015 scenario and the real spool verdict for every TRI-016..030 scenario equal the fixture's `expected` value. Invariant: promotion never precedes cooldown (a single post-trip success enters PROBE_A, never CLOSED_A), requires exactly 3 successful probes, and a cleared 5min healthy residence. Unique failure injection (task-6 wording): kill between spool fsync and ack → reopen drains only the unacknowledged frame; skew the wall clock backward 90s → eligibility (monotonic) unaffected, cooldown not cleared; restart from monotonic elapsed time reconstructs state. Forced triad: A=common breaker healthy serves mode A; B=spool replay forced by an A exception drops to B; C=both A and B unavailable serves unchanged mode C — correctness demotion before provider invocation in 100% of the chaos cases exercised.

## Dashboard / API / config / SETTINGS evidence

- `MEGACOMPACT_VC0C` surfaced in the "Vector Cortex" SETTINGS group as a working `boolDirect` on/off toggle — NOT in `EXCLUDED_SETTINGS`.
- **Flag toggle round-trip (gate evidence):** `routes-rag-settings.test.ts` "VC0C flag round-trips through settings" verifies POST `/api/rag-settings` with `{"key":"MEGACOMPACT_VC0C","value":"false"}` writes `export MEGACOMPACT_VC0C="false"` to `.mega-compact.env`, driving `VC0C_ENABLED()` off; `value:"true"` writes the `"true"` line and drives it on.
- **Health card (reader-only GET /api/vector-cortex/health):** `routes-vector-cortex.test.ts` verifies GET returns the default `CLOSED_A` health card and that non-GET is rejected (reader-only path has no mutation).
- **Admin reset (POST /api/vector-cortex/breakers/reset):** route tests verify reset clears cooldown while retaining evidence, rejects a missing subsystem, and returns 409 when `MEGACOMPACT_VC0C` is disabled.

## Offline / network / asset / platform evidence

Zero runtime network egress verified under full `net/tls/http/https/dns.lookup/fetch` denial in all three modes A (breaker), B (spool), and C (unchanged) — PREVENT-PI-004 (resilience/spool/breaker are pure in-memory + local FS only). Migration disposition: **pure — no migration** written.

## File sizes and baseline exceptions

Production within limits: resilience/types.ts 158, breaker-core.ts 420 (<500), breaker.ts 22, spool-core.ts 359, spool.ts 22, emit.ts 99; vector-cortex-safety.ts 156 (<400). Tests: breaker.test.ts 216, spool.test.ts 213; vc0c-acceptance.test.ts 580 (under the tests/ 600 HARD limit after the I04 trim; over the 300 SOFT limit as a deliberate single-file aggressive aggregator, consistent with vc1a-acceptance 477 / vc0b-acceptance 373). Pre-existing over-hard-limit `extensions/mega-events/context-handler.ts` (514 @ HEAD) is out of scope.

## Rollback / downgrade rehearsal

`MEGACOMPACT_VC0C=0` → the safety envelope selects mode C (unchanged transcript), the reporter emits ZERO events even on a breaker trip, and the served bytes are byte-identical to the predecessor (golden bytes match exactly). Rollback restores the prior derived pointer without deleting evidence (per the sprint rollback disposition).

## Issues found during implementation

- **VC0C-I01 [type: minor, state: fixed-in-this-sprint]**: the initial `vc0c-acceptance.test.ts` was 654 lines — OVER the tests/ 600 HARD limit, which `regression_check.py --all` flags as a commit-blocker. Refactored the repeated 20-attempt trip loops and single-mode executes into compact `tripA`/`bThrow`/`okExec`/`tripACorrectness` helpers (pre-refactor file backed up to /tmp), bringing the file to 580 lines. All 16 acceptance tests still pass in BOTH flag states; the acceptance logic (scenario drivers, assertions, test names) is unchanged — only driver boilerplate was deduplicated.
- **VC0C-I02 [type: minor, state: OPEN, owner: VC0C polish]**: TRI-027 (corrupt spool header) throws on reopen while the spool interpreter keeps `SPOOL_COMMITTED`; the acceptance file asserts the schema-guard behavior separately from the fixture code. Cosmetic division between the fixture verdict surface and the throw-on-reopen guard.
- **VC0C-I03 [type: minor, state: OPEN (pre-existing, documented)**: the dashboard-client `npm run typecheck` fails on 92 PRE-EXISTING `node:sqlite`/`process` node-type errors in `../../src/store`, `../../src/wiki`, and `../../src/config/vector-cortex.ts` pulled via `@contracts` imports (tsconfig sets `types:[]`, disabling `@types/node`). VC0C's dashboard files produce ZERO typecheck errors, and the production Vite `npm run build` (the documented sprint gate) passes and was rebuilt+committed. Pre-existing condition at HEAD; a full `typecheck` clean would require either adding `@types/node` to the client tsconfig `types` or splitting the `@contracts` types that leak node-builtin imports.

## Residual risks / carried-forward OPEN issues

- **Carried forward OPEN (VC0B-I08, owner VC0C/VC1 producer-wiring):** the resilience breaker/spool/safety envelope is live-owned and the dashboard health/reset API is wired, but the LIVE producer hook-up into `extensions/mega-compact.ts` / `src/engine.ts` (calling `createVectorCortexSafety().select(...)` around the actual compaction loop) remains deferred to a later producer-wiring sprint. The seams are single and clean until then.
- **Carried forward OPEN (VC0A family):** dashboard OBSERVER badge derives from the flag (VC0A-I01 family) until a live producer exists.
- Non-blocking honestly-of-claim notes carried from VC1A (I06/I07/I08) and the `serializeNoop`/canonicalizer-divergence notes carried from VC0A remain open; none gate this sprint.
- `vc0c-acceptance.test.ts` (580 lines) exceeds the tests/ 300 SOFT limit but is under the 600 HARD limit — consistent single-file acceptance aggregator (as with vc1a/vc0b).

## Reviewer attestation

Not yet attested — pending independent reviewer.
