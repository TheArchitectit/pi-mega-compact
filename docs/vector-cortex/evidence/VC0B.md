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
- `src/vector-cortex/replay/replay.ts` — `runReplayV2` (ascending `(seq,eventId)` scan), `extractToolPairs`, `largestPairSafeSeq`, `compareOccurrences`. Emits `vector_cortex_replay_cut_retreat` and `vector_cortex_replay_highwater_frozen` via the replay emit seam. Mode A/B branch: A uses `computeEffectiveCutV2`; B uses the independent `computeEffectiveCutV2B`.
- `src/vector-cortex/replay/replayB.ts` — `computeEffectiveCutV2B`, the genuinely independent mode-B algorithm (streams bytes, own open-call tracker, sequential authority/floor clamps; no shared A subroutine, no min-of-three).
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

- A = optimized v2 effective-cut calculator (`computeEffectiveCutV2`: pair-list boundary + min-of-three + retreat).
- B = genuinely independent deterministic local algorithm (`computeEffectiveCutV2B` in replayB.ts: streams observed bytes, own open-call pair-completeness, independent authority/floor clamps; NO shared A subroutine, NO min-of-three). Byte-identical to A across a forced-retreat parameter corpus (replay.test.ts) — same effectiveSeq via its own code, validating the independent implementation against A.
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
- `node --test dist/extensions/dashboard-server/routes-rag-settings.test.js` → `tests 13, pass 13, fail 0` at sprint close (was 12; VC0B toggle round-trip added; suite has since grown to 18 as later sprints added their own toggles).

## Evaluation

10,000 replay turns (30,000 occurrences) with balanced call/result streams + legal anchor floors: zero reordered pairs, zero split pairs, zero orphan tool events (acceptance hard-invariant). CUT-001..020 and M3-001..010 conformance rows each returned their manifest bytes/results or exactly their listed failure code.

## Dashboard / API / config / SETTINGS evidence

- `MEGACOMPACT_VC0B` surfaced in the "Vector Cortex" SETTINGS group as a working `boolDirect` on/off toggle — NOT in `EXCLUDED_SETTINGS`.
- **Flag toggle round-trip (gate evidence):** `routes-rag-settings.test.ts` "VC0B flag round-trips through settings" verifies POST `/api/rag-settings` with `{"key":"MEGACOMPACT_VC0B","value":"false"}` writes `export MEGACOMPACT_VC0B="false"` to `.mega-compact.env`, driving `VC0B_ENABLED()` off; `value:"true"` writes the `"true"` line and drives it on.
- No dashboard-visible API change is necessary for this internal developer seam (per VC0B spec).

## Offline / network / asset / platform evidence

Zero runtime network egress verified under full `net/tls/http/https/dns.lookup/fetch` denial in all three triad modes (PREVENT-PI-004). replay/cut/migration are pure in-memory; persistence is local filesystem only.

## File sizes and baseline exceptions

All new files within limits: replay/types.ts 145, cut.ts 162 (now 169 — grew as later sprints extended replay), replay/replay.ts 291 (now 308), replay/replayB.ts 97, replay/emit.ts 76 (now 89), migrations/effective-cut-v2.ts 149, cut.test.ts 90 (now 115), replay.test.ts 239 (now 258), vc0b-acceptance.test.ts 373 (< 600 test hard limit; single cohesive aggregator). Pre-existing over-hard-limit `extensions/mega-events/context-handler.ts` (514 @ HEAD) is out of scope.

## Rollback / downgrade rehearsal

`MEGACOMPACT_VC0B=0` → legacy capped replay; acceptance suite passes with the flag off (0 failed) and the outbound/predecessor golden bytes match exactly (byte-identical). The M3 crash-injection rehearsal (`M3-002`) proves a stop after copy/validate but before switch retains the old cut pointer; `M3-003` proves resumption is idempotent. Evidence is retained on rollback.

## Issues found during implementation

- **VC0B-I06 [type: minor, state: fixed-in-this-sprint, commit 2e7e7c8]**: initial replay emission used an ad-hoc inline `emit` callback rather than a named seam. Per the VC0A review'd sequencing finding (emit via the established observer/emit helpers OR a minimal `replay/emit.ts` — never a second pipeline), formalized as `src/vector-cortex/replay/emit.ts` (`createReplayReporter`) mirroring the VC0A eval observer's non-fatal `ts`+`event` contract; `runReplayV2` now routes through it. M3 was briefly considered as an emitter but reverted — M3 is a pointer migration, not a replay scan, so emitting replay events there would be duplicate/forced emission.
- **VC0B-I07 [type: minor, state: fixed-in-this-sprint, commit 2e7e7c8]**: `emit.ts` initial `Record<string,unknown>` cast needed a `via unknown` hop for TS2352; resolved with a localized double-cast (no `any`, no index-signature widening). No production `any` remains; the lone `as any` is confined to the acceptance test's fixture helper.
- **VC0B-I08 [type: important, state: OPEN, owner: VC0C/VC1 producer-wiring sprint]**: live producer unwired — neither `runReplayV2` nor `migrateEffectiveCutV2` is called by `extensions/mega-compact.ts` / `src/engine.ts` this sprint. The `MEGACOMPACT_VC0B` flag has one real consumer (the replay emit seam gates observability emission) but the actual caller hook-up in the live compaction/replay loop is deferred to VC1. Inherits the VC0A-I01 family (dashboard OBSERVER badge derives from the flag, not real observability, until a live producer exists). The replay emit seam and the eval observer are both unwired dead-ends until that wiring — which this sprint leaves clean (single seam, no second pipeline).
- **VC0B-I09 [type: moderate, state: fixed-in-this-sprint]**: triad mode B was not algorithmically independent — `runReplayV2` had no separate A/B branch; both modes executed the same `largestPairSafeSeq` + `computeEffectiveCutV2`, so the mode-B equality test compared code to itself. Fixed per controller decision (FIX F3): added `src/vector-cortex/replay/replayB.ts` — `computeEffectiveCutV2B` is a genuinely independent deterministic local algorithm (streams the observed bytes, derives pair-completeness from its own open-call tracker, applies authority caps and anchor floor via independent sequential clamps; NO shared A subroutine, NO min-of-three shortcut). `runReplayV2` mode B now branches to it; the mode-B tests assert byte-identical output to mode A across a forced-retreat parameter corpus, same `effectiveSeq` via B's own algorithm under forced fixtures, and B's `boundarySafeSeq` parity with the sequential scan. Shared `emit.ts` seam and the common replay-scan scaffolding remain shared (observer seam, not algorithm).
- **VC0B-I10 [type: moderate, state: fixed-in-this-sprint, commit ccc939c]**: flag-off acceptance test was tautological — `VC0B_ENABLED()===false` asserted a hardcoded string equal to itself, never exercising the flag against a real consumer (serializeNoop anti-pattern). Fixed per spec review (FIX F1): wired `VC0B_ENABLED()` into `createReplayReporter` as its single real consumer (flag OFF → zero replay observability writes, mirroring VC0A mode C), and rewrote the acceptance test to assert the real gating invariant (flag ON emits `cut_retreat` + `highwater_frozen`; flag OFF emits zero events while the `ReplayReportV2` still carries mode C + frozen high-water).
- **VC0B-I11 [type: important, state: fixed-in-this-sprint]**: code-quality review found A and B diverged on a stream ending in an unclosed (dangling) tool call. Mode B's open-call tracker retreats below a dangling call, but mode A reasoned only over *completed* pairs — `extractToolPairs` created a pair only when a result existed, so A kept a call whose result was dropped while reporting `orphanToolEvents: 0` (`finalizeReplay` only counted unpaired *results*). Reproduced empirically (A=4/17 bytes vs B=3/12). Fixed in `extractToolPairs`: matched calls are now deleted as results close them, and each remaining unclosed call surfaces as a synthetic pair whose `resultSeq` is one past the last observed seq — so A retreats to the call boundary exactly like B (converged: both effectiveSeq=3, byte-identical). Added the regression test "modes A and B agree on a stream ending in an unclosed tool call".
- **VC0B-I12 [type: important, state: fixed-in-this-sprint]**: `retreatAgainstPairs` infinite-looped when the anchor floor sat inside a tool pair (clamp to floor → floor still splits the same pair → re-find forever). A synchronous hang inside the agent loop with no escape. Reproduced as a hard hang (timeout, exit 124). Fixed with a no-progress guard: once the cut clamps at the floor the loop terminates (`if (!hit || floorClamped) return`), emitting `CUT_ANCHOR_FLOOR`. Added two `cut.test.ts` regression cases (floor-inside-pair clamps at floor; two-pair case terminates without hanging).

## Residual risks

- **Non-blocking review notes (VC0B-I13..I17, deferred):** the code-quality review also recorded minor items — `scanned` counts one element past the cut (semantics/clarity), `minOfCapped` tie accounting omits `requestedSeq` from the recorded tie, mode C fabricates `boundarySafeSeq: requestedSeq`, acceptance-test `?? 3` fallback + `as any` fixture casts, and a pure `ReplayRetreatCode` re-export in cut.ts. None affect cut correctness, byte-identity, or the zero-tolerance invariants; deferred to a later polish pass.

- **Deferred producer wiring (VC0B-I08):** see issues section above — the live loop caller hook-up is deferred to VC1; the emit seam + eval observer remain unwired until then. Flag-off remains byte-identical regardless (reporter emits nothing).
- `runReplayV2` mode C emits `vector_cortex_replay_highwater_frozen`; the frozen-high-water semantics are validated at the unit/acceptance seam, with full authority-outage integration owned by the triad/spool sprint (VC0C).
- **Triad mode B independence (VC0B-I09, now FIXED):** resolved by the independent `computeEffectiveCutV2B` (replayB.ts). Mode A remains the optimized path (pair-list + min-of-three); mode B is the slow, deterministic local path that derives directly from observed bytes. Mode selection (which path the breaker uses) is a downstream VC0C concern, not the flag wiring.
- `log_failure.py --list` reports 2 pre-existing active runtime failures unrelated to VC0B.

## Reviewer attestation

2026-08-03 — controller spec-compliance + code-quality review: ✅ both stages passed and the sprint shipped. Implementer (Sonnet) work was read in full, file limits verified, flag-off parity confirmed, conformance fixtures canonical. Evidence claims re-verified against the shipped tree by `vector-cortex-evidence-check.mjs`; the line-count drift noted above is benign growth from later sprints extending shared files (the rag-settings suite and replay sources), not a regression.
