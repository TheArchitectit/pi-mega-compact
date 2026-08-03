# VC0B Evidence

Status: implementer-complete
Implementation commits/sub-sprint gates: VC0B sprint on `feat/vector-cortex`; see git log for the focused commit(s). All sprint exit gates run and recorded below.
Contract review: not yet performed — pending independent reviewer.

## Goal recap

Replay correctness. Owner of **ReplayCutV2 / ReplayReportV2** + **M3 effective-cut-v2**. Algorithm: effective cut is `min(boundarySafeSeq, committedSeq, capturedHighWater)` (capped by `requestedSeq`), retreated to the call boundary whenever the candidate intersects a tool call/result pair, then clamped to the recent-anchor floor; ties choose the lower source sequence.

## Changed production / tests / docs

Production (`src/`):
- `src/config/vector-cortex.ts` — `VC0B_ENABLED()` (default ON; `MEGACOMPACT_VC0B=0` → off). Re-exported by root `src/config.ts`.
- `src/vector-cortex/replay/types.ts` — `ReplayCutV2`, `ReplayReportV2`, `ReplayOccurrenceV2`, `ReplayToolPair`, `ReplayRetreatCode`, plus registered ID ranges `CUT_IDS` (CUT-001..020) and `M3_IDS` (M3-001..010).
- `src/vector-cortex/replay/cut.ts` — `computeEffectiveCutV2` (min-of-three + pair retreat + anchor floor + lower-source tie-break), `cutIsPairSafe`.
- `src/vector-cortex/replay/replay.ts` — `runReplayV2` (ascending `(seq,eventId)` scan), `extractToolPairs`, `largestPairSafeSeq`, `compareOccurrences`. Emits `vector_cortex_replay_cut_retreat` and `vector_cortex_replay_highwater_frozen` via the replay emit seam.
- `src/vector-cortex/replay/emit.ts` — replay emit seam (VC0B): the single structured-event surface for the replay/effective-cut path, mirroring the VC0A eval observer (`src/vector-cortex/eval/observer.ts`) with the same non-fatal, structured-JSON `ts`+`event` contract (`src/log.ts` LogEntry). `createReplayReporter(emit?)` builds a typed, best-effort reporter bound to the two replay event names; absent emitter degrades to a no-op (byte-identical predecessor). This is deliberately MINIMAL — not a second metrics pipeline; a future VC0C breaker/dashboard consumes the lines.
- `src/vector-cortex/migrations/effective-cut-v2.ts` — M3 copy/validate/switch (`m3Copy`/`m3Validate`/`m3Switch`/`migrateEffectiveCutV2`), failure codes `M3_HOST_MISSING`/`M3_MINIMA_VIOLATED`/`M3_PAIR_SPLIT`/`M3_ANCHOR_CROSSED`/`M3_COPY_MISMATCH`.

Scripts:
- `scripts/vector-cortex-gen-fixtures.mjs` — added the `replay/` domain (CUT-001..020 + M3-001..010) + `schemas/replay-fixture.schema.json`; regenerates the multi-domain manifest.
- `scripts/vector-cortex-publish-acceptance.mjs` — additive extension mirroring the new `replay/` + `migrations/` compiled subtrees to `dist/vector-cortex/` (VC0B's acceptance aggregator imports them).

Dashboard (`extensions/dashboard-server/`):
- `routes-rag-settings-helpers.ts` — `MEGACOMPACT_VC0B` added to the "Vector Cortex" SETTINGS group as a `boolDirect` on/off toggle (NOT in `EXCLUDED_SETTINGS`).

Tests:
- `src/vector-cortex/replay/cut.test.ts`, `replay/replay.test.ts`, `vc0b-acceptance.test.ts` (acceptance aggregator).
- `extensions/dashboard-server/routes-rag-settings.test.ts` — VC0B flag toggle round-trip (was 12, now 13).

Docs: `docs/vector-cortex/evidence/VC0B.md` (this record).

## Fixtures and corpus digests

`conformance/vector-cortex/v2/replay/` — 30 replay fixtures (CUT-001..020, M3-001..010) + `schemas/replay-fixture.schema.json`.
`node scripts/vector-cortex-conformance.mjs --check` → `✓ CONFORMANCE: v2 manifest + 44 fixtures canonical (44 files).`

Asserts (repo root `replay/`):
- `CUT-001` = CUT-PAIR-001 — requested cut between call c7 and result r7 retreats before c7 (effective = 6).
- `CUT-002` = CUT-ANCHOR-002 — pair retreat lands on/above the legal anchor floor; never crosses it.
- `CUT-003` = CUT-HIGHWATER-003 — captured high-water below committed seq wins (effective = 4).

Manifest now describes `domain:"evaluation,replay"`, `owner:"VC0A,VC0B"`, `schemaVersion:"metric-event-v1;replay-cut-v2"`. All fixtures canonical (UTF-8/NFC/sorted keys/shortest numbers/final LF); SHA-256 pinned in the manifest.

## Migration

**M3 effective-cut-v2 (copy/validate/switch).** `src/vector-cortex/migrations/effective-cut-v2.ts` freezes `min(boundarySafeSeq, committedSeq, capturedHighWater)` with pair retreat + anchor floor. Phases exposed separately for crash-safety:
- copy: computes candidate and stages it (writeStaged) without activating.
- validate: verifies the STAGED pointer obeys minima (never exceeds a source), never splits a pair, never falls below the anchor floor, and copy-matches the freshly computed effective.
- switch: atomic activation (switchPointer), the final step.

Unique failure injection (`M3-002`): crash after copy+validate but before switch retains the OLD pointer; restart resumes idempotently (`M3-003`). Failure codes reachable from corruption: `M3_MINIMA_VIOLATED` (`M3-004`), `M3_PAIR_SPLIT` (`M3-005`), `M3_ANCHOR_CROSSED` (`M3-006`), `M3_COPY_MISMATCH` (`M3-007`), `M3_HOST_MISSING` (`M3-008`). Operates against the EXISTING host state via an injected `M3Host` interface; the future v2 compat-journal is owned by VC1B and not introduced here. Rollback: `MEGACOMPACT_VC0B=0` selects the legacy capped replay byte-identically.

## A/B/C and independence evidence

- A = v2 effective-cut calculator (`computeEffectiveCutV2`).
- B = sequential boundary scan with no aggregate index (`largestPairSafeSeq`); matches A's effective cut on balanced streams (replay.test.ts "mode B matches mode A").
- C = unchanged host transcript, derived high-water frozen (`runReplayV2` mode C returns zero bytes and emits `vector_cortex_replay_highwater_frozen` via the real C path — no stub).
- `node scripts/vector-cortex-network-denial.mjs --modes=A,B,C` → all clean, zero network egress.

## Commands and verbatim summaries

- `npm run build` → tsc clean (no `error TS`).
- Mandated command, verbatim:
  ```bash
  node --test dist/vector-cortex/vc0b-acceptance.test.js
  # → ℹ tests 13, ℹ pass 13, ℹ fail 0   (flag ON)
  MEGACOMPACT_VC0B=0 node --test dist/vector-cortex/vc0b-acceptance.test.js
  # → ℹ tests 13, ℹ pass 13, ℹ fail 0   (flag-off rehearsal; predecessor bytes match)
  ```
- `npm test` → `TOTAL: 1304 passed, 0 failed across 179 files` (observed run; pass total drifts run-to-run per `scripts/run-tests.mjs` adjudication, but `0 failed` + constant file count is the stable invariant).
- `npm run lint` → `tsc --noEmit` + `guardrails-scan` + `semantic-scan` all clean.
- `python3 scripts/regression_check.py --all` → `✓ No potential regressions detected`; sole hard-limit error `extensions/mega-events/context-handler.ts` (514) is pre-existing at HEAD, untouched by this sprint.
- `node scripts/vector-cortex-conformance.mjs --check` → `✓` (44 fixtures canonical).
- `node scripts/vector-cortex-docs-check.mjs` → `✓ DOCS-CHECK: 27 sprints / 9 phases, links+flags+commands+migrations clean.`
- `python3 scripts/log_failure.py --list` → 2 pre-existing active runtime entries (FAIL-38192431, FAIL-55d81817); no VC0B-introduced failure.
- `node scripts/guardrails-scan.mjs` → `GUARDRAILS: pi pattern scan clean.` + semantic scan clean.
- `git diff --check` → clean (exit 0).
- `node --test dist/extensions/dashboard-server/routes-rag-settings.test.js` → `tests 13, pass 13, fail 0` (was 12; VC0B toggle round-trip added).

## Evaluation

10,000 replay turns (30,000 occurrences) with balanced call/result streams + legal anchor floors: zero reordered pairs, zero split pairs, zero orphan tool events (acceptance hard-invariant). CUT-001..020 and M3-001..010 conformance rows each returned their manifest bytes/results or exactly their listed failure code.

## Dashboard / API / config / SETTINGS evidence

- `MEGACOMPACT_VC0B` surfaced in the "Vector Cortex" SETTINGS group as a working `boolDirect` on/off toggle — NOT in `EXCLUDED_SETTINGS`.
- **Flag toggle round-trip (gate evidence):** `routes-rag-settings.test.ts` "VC0B flag round-trips through settings" verifies POST `/api/rag-settings` with `{"key":"MEGACOMPACT_VC0B","value":"false"}` writes `export MEGACOMPACT_VC0B="false"` to `.mega-compact.env`, driving `VC0B_ENABLED()` off; `value:"true"` writes the `"true"` line and drives it on.
- No dashboard-visible API change is necessary for this internal developer seam (per VC0B spec).

## Offline / network / asset / platform evidence

Zero runtime network egress verified under full `net/tls/http/https/dns.lookup/fetch` denial in all three triad modes (PREVENT-PI-004). replay/cut/migration are pure in-memory; persistence is local filesystem only.

## File sizes and baseline exceptions

All new files within limits: replay/types.ts 145, cut.ts 162, replay/replay.ts 244, replay/emit.ts 76, migrations/effective-cut-v2.ts 149, cut.test.ts 90, replay.test.ts 198, vc0b-acceptance.test.ts 331 (< 600 test hard limit; single cohesive aggregator). Pre-existing over-hard-limit `extensions/mega-events/context-handler.ts` (514 @ HEAD) is out of scope.

## Rollback / downgrade rehearsal

`MEGACOMPACT_VC0B=0` → legacy capped replay; acceptance suite passes with the flag off (0 failed) and the outbound/predecessor golden bytes match exactly (byte-identical). The M3 crash-injection rehearsal (`M3-002`) proves a stop after copy/validate but before switch retains the old cut pointer; `M3-003` proves resumption is idempotent. Evidence is retained on rollback.

## Issues found during implementation

- **VC0B-I01 [type: minor, state: fixed-in-this-sprint]**: initial replay emission used an ad-hoc inline `emit` callback rather than a named seam. Per the VC0A review'd sequencing finding (emit via the established observer/emit helpers OR a minimal `replay/emit.ts` — never a second pipeline), formalized as `src/vector-cortex/replay/emit.ts` (`createReplayReporter`) mirroring the VC0A eval observer's non-fatal `ts`+`event` contract; `runReplayV2` now routes through it. M3 was briefly considered as an emitter but reverted — M3 is a pointer migration, not a replay scan, so emitting replay events there would be duplicate/forced emission.
- **VC0B-I02 [type: minor, state: fixed-in-this-sprint]**: `emit.ts` initial `Record<string,unknown>` cast needed a `via unknown` hop for TS2352; resolved with a localized double-cast (no `any`, no index-signature widening). No production `any` remains; the lone `as any` is confined to the acceptance test's fixture helper.

## Residual risks

- **Deferred producer wiring:** the live pi loop is not yet connected — `extensions/mega-compact.ts` / `src/engine.ts` do NOT call `runReplayV2` / `migrateEffectiveCutV2` this sprint. The `MEGACOMPACT_VC0B` flag currently gates the v2 module availability + SETTINGS toggle only; the actual caller hook-up in the live compaction/replay loop is deferred to the VC1 integration sprint (mirrors the VC0A deferred-observer precedent). The replay emit seam and the eval observer are both unwired dead-ends until a live producer exists — that is the VC0C/VC1 wiring action, which this sprint leaves clean (single emit seam, no second pipeline). Flag-off remains byte-identical regardless.
- `runReplayV2` mode C emits `vector_cortex_replay_highwater_frozen`; the frozen-high-water semantics are validated at the unit/acceptance seam, with full authority-outage integration owned by the triad/spool sprint (VC0C).
- `log_failure.py --list` reports 2 pre-existing active runtime failures unrelated to VC0B.

## Reviewer attestation

Not yet attested — pending independent reviewer.
