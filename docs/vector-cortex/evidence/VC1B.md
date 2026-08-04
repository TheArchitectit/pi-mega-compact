# VC1B Evidence

Status: implementer-complete
Implementation commits/sub-sprint gates: VC1B sprint on `feat/vector-cortex`; git log for the focused commit. All sprint exit gates run and recorded below.
Contract review: not yet performed — pending independent reviewer.

## Goal recap

Occurrence ledger + tool identity (VC1B). Persist every canonical byte event as an **occurrence** and give each tool call a stable identity. Uniqueness is `(event_id, digest)` ONLY — the same bytes at a distinct event id are two occurrences. `seq` is a monotonic per-session counter and may never regress. A tool RESULT references exactly one earlier call (an exactly-one back-edge); a RESULT with no matching earlier call is rejected `EVT_TOOL_CALL_MISSING`, a non-contiguous `seq` `EVT_SEQ_REGRESSION`. A v2 isolate database file hosts the occurrence ledger + `compat_journal_v1`, switched in via a copy → validate → switch (M2) atomic migration with a downgrade export (`MIG-DOWN-*`) that produces a new **legacy** projection copy and lists any unrepresentable (invalid-UTF-8) rows on prepare. Capability gating `store.asReader()/asWriter()/asAdmin()`; appended-only provenance (no `UPDATE` in the ledger schema). `MEGACOMPACT_VC1B` gate (default ON, `=0` → byte-identical predecessor) and the `vector_cortex_occurrence_appended` / `vector_cortex_compat_switch_committed` emit seam (single real consumer).

## Changed production / tests / docs

Production (`src/`):
- `src/config/vector-cortex.ts` — `VC1B_ENABLED()` (default ON; `MEGACOMPACT_VC1B=0` → off). Re-exported by root `src/config.ts`. Single real consumer gates the ledger emit seam.
- `src/vector-cortex/ledger/types.ts` (141) — `Occurrence` (schema `"occurrence-v2"`: session, seq bigint, eventId, kind `"user"|"assistant"|"tool_call"|"tool_result"|"system"`, digest `sha256:${string}`, sourceBytes, toolCallId optional), `SqliteAppendCode` (`OK | EVT_DUP_ID_DIGEST | EVT_SEQ_REGRESSION | EVT_TOOL_CALL_MISSING | ...`), `LedgerReader`/`LedgerWriter`/`LedgerAdmin` capabilities, `M2_IDS`/`MIG_DOWN_IDS` conformance-ID registries, plus `EVT_IDS` extended to register `EVT-016..030`.
- `src/vector-cortex/migrations/occurrence-v2.ts` (182) — **M2** copy → validate → switch: `m2Copy` (alias `stagedLegacy`), `m2Validate`, `m2Switch` over an `M2Host` with the journal as authority. Atomic + resumable/idempotent (a re-run re-stages and reprocesses with no duplicate rows). Failure codes `M2_COPY_MISSING`, `MIG_DOWN_NOT_ACTIVE`, `MIG_DOWN_PHASE_UNREACHED`, `MIG_DOWN_DIGEST_MISMATCH`, `M2_UNREPRESENTABLE_UNLISTED`. The single `migrateOccurrenceV2()` drives the full sequence to phase `switched`.
- `src/vector-cortex/ledger/sqlite.ts` (265) — `openOccurrenceStore` (v2 isolate DB: `occurrences` PK `(session, seq)`, `UNIQUE (session, event_id, digest)`; `compat_journal_v1`; no `UPDATE` anywhere — append-only), `appendOccurrence` (validates exactly-one tool RESULT back-edge + monotonic seq + `(event_id,digest)` idempotency), `appendBatch` (per-row accept/reject), `SQLite` reader helpers (`count`, `readSession`).
- `src/vector-cortex/ledger/compat-journal.ts` (215) — `initCompatJournal`, `createCompatJournal`: the `compat_journal_v1` state machine (`prepared → copied → validated → switched`) and the **downgrade export** `prepare()`/`buildLegacy()` which creates a new legacy projection copy and lists unrepresentable rows (invalid-UTF-8 → `legacyProjection IS NULL`).
- `src/vector-cortex/ledger/store.ts` (427) — `createLedgerStore(dbPath, emit?)`: byte-authority `sha256:` digesting over raw `sourceBytes`, capability-gated `reader()/writer()/admin()`, journal auto-record on append, admin `migrateOccurrenceV2()` + `compat` surface, and the emit seam. **S2 (review):** `writer().append()` and `advanceHighWater()` are gated on `VC1B_ENABLED()` — flag OFF returns a `syntheticAppend` no-op that accepts the call, writes NOTHING, and emits nothing (byte-identical predecessor). `legacyProjectionOf` returns `null` for non-UTF-8 bytes (`TextDecoder("utf-8",{fatal:true})` in try/catch) — makes `MIG-DOWN-003` reachable through the real writer.

Dashboard (`extensions/dashboard-server/`):
- `api-contracts/vector-cortex.ts` — `VectorCortexLedgerView` (enabled, session, highWater, count, occurrences[] of `{seq,eventId,kind,digest,toolCallId?}`, updatedAt), registered as `vectorCortexLedger` in `api-contracts/endpoints/registry-ext.ts` (endpoint count 48 → 49).
- `routes-vector-cortex.ts` — `handleVectorCortexLedger(req,res,ctx)` GET `/api/vector-cortex/ledger` (parses `?session=`, defaults `"default"`), opens `createLedgerStore({stateDir})`, reads identity rows via `LedgerReader` only (`highWater` + `readSession`, slice(-500)) — **never** exposes `sourceBytes`/payload text. Wired into server.ts dispatch + routes.ts barrel.
- `routes-rag-settings-helpers.ts` — `MEGACOMPACT_VC1B` added to the "Vector Cortex" SETTINGS group as a `boolDirect` on/off toggle (NOT in `EXCLUDED_SETTINGS`).

Dashboard client (`extensions/dashboard-client/`):
- `src/types/vector-cortex.ts` — `VectorCortexLedgerView`.
- `src/api/vector-cortex.ts` — `fetchVectorCortexLedger(session="default")`.
- `src/tabs/VectorCortexTab.tsx` — poll + "Occurrence Ledger (VC1B)" card rendering the identity rows.

Pi runtime adapter (`extensions/`):
- `extensions/mega-runtime/vector-cortex-ledger.ts` (NEW, 139) — **S1 (review) ingestion seam**: `openLedgerWriter(stateDir)` (returns `null` when flag OFF), `appendLedgerMessage`, and `appendMessagesToLedger(stateDir, sessionId, messages)` which opens the writer, appends one occurrence per canonical message (mapping `(role,text) → {seq, kind, eventId: sha256:…, digest}`), closes in `finally`, and returns accepted count (0 when disabled). Flag-OFF opens NO ledger DB (byte-identical predecessor). toolCallId is NOT set here — deferred to the VC1 producer-wiring sprint because the pi runtime discriminates messages by `role` only and the tool-call id lives in variant content unreachable by role (residual-risk note retained).
- `extensions/mega-events/context-handler.ts` (514 → 523) — call site: after the db-mirror block, `appendMessagesToLedger(runtime.currentStateDir, runtime.rt.sessionId, messages)` inside try/catch (`runtime.logger.warn("vc1b-ledger-append-fail")`), non-fatal. This file remains the documented pre-existing over-hard-limit baseline exception; only 7 lines added.

Tests:
- `extensions/mega-runtime/vector-cortex-ledger.test.ts` (NEW) — 4 tests: flag ON persists one occurrence per message (count + `reader().count`), flag OFF opens no DB (zero writes), flag OFF `openLedgerWriter` returns null, `messageToLedgerInput` maps role/seq and a stable `(event_id,digest)` (identical content → identical eventId).
- `src/vector-cortex/ledger/sqlite.test.ts` (225), `ledger/compat-journal.test.ts` (214).
- `src/vector-cortex/vc1b-acceptance.test.ts` (600) — 25-test acceptance aggregator: conformance registration (M2-001..015, MIG-DOWN-001, named behaviors, EVT-016..030), M2 lifecycle, MIG-DOWN/named fixtures, capability gating, append-only provenance (no `UPDATE` in schema), flag-gated emit seam, **flag-off write parity** (S2: flag OFF writes zero rows AND emits zero events — not merely zero emissions).
- `extensions/dashboard-server/routes-vector-cortex.test.ts` (was 8, now 10): "GET ledger (VC1B) returns identity rows (never source payloads)", "GET ledger (VC1B) reports disabled when flag is OFF".
- `extensions/dashboard-server/routes-rag-settings.test.ts` (14 → 16): "VC1B flag round-trips through settings".

Scripts:
- `scripts/gen-fixtures/ledger.mjs` (NEW) — generates M2-001..015, MIG-DOWN-001 + named `M2-DUP-001`, `M2-TOOL-002`, `MIG-DOWN-003` (schema `schemas/ledger-fixture.schema.json`, algorithm `"occurrence-v2"` / `"migrate-down"`).
- `scripts/gen-fixtures/write.mjs` — `ledger` domain + `ledgerCount`/`ledgerNamedCount`; manifest `domain:"evaluation,replay,events,resilience,ledger"`, `owner:"VC0A,VC0B,VC1A,VC0C,VC1B"`, `schemaVersion:"metric-event-v1;replay-cut-v2;event-v2;ledger-fixture"`.
- `scripts/vector-cortex-gen-fixtures.mjs` — reports ledger counts.

Docs: `docs/vector-cortex/evidence/VC1B.md` (this record).

## Fixtures and corpus digests

`conformance/vector-cortex/v2/ledger/` — 19 fixtures: M2-001..015, M2-DUP-001, M2-TOOL-002, MIG-DOWN-001, MIG-DOWN-003 + `schemas/ledger-fixture.schema.json`.
`node scripts/vector-cortex-conformance.mjs --check` → `✓ CONFORMANCE: v2 manifest + 129 fixtures canonical (129 files).`

M2 lifecycle fixtures (M2-001..015): full balanced user/tool migration; duplicate-content preservation; never-active refusal; halt-before-switch; interrupted-switch resume idempotency; copy-missing; phase-unreached; digest-mismatch; unrepresented-unrepresentable; dangling-RESULT; seq-regression; idempotent re-append; mixed batch; reader parity; full-migration idempotency.
Named behavior fixtures: `M2-DUP-001` (identity is `(event_id,digest)` only — equal bytes at two seq are two occurrences), `M2-TOOL-002` (result names exactly one earlier call c9), `MIG-DOWN-001` (unrepresentable rows listed on prepare), `MIG-DOWN-003` (invalid-UTF-8 row unrepresentable via the real writer).

All fixtures canonical (UTF-8/NFC/sorted keys/shortest numbers/final LF); SHA-256 pinned in the manifest. Every ledger + migrations file under `conformance/vector-cortex/v2/` is manifest-registered (checked by `vector-cortex-conformance.mjs`).

## Migration

M2 (`occurrence-v2.ts`) copy → validate → switch, atomic + resumable: copy re-stages the legacy projection (phase → copied), validate checks representability/digest/active state, switch flips authority (phase → switched). Idempotent under resume (re-run produces no duplicate rows, M2-005/M2-015). Downgrade (`MIG-DOWN-*`) exports a NEW legacy copy and lists unrepresentable rows; `MIG_DOWN_NOT_ACTIVE` refuses a downtime path on an untouched ledger. No byte-`UPDATE` in the ledger schema (append-only provenance).

## A/B/C and independence evidence

Prior sprints establish the byte-authority event model (VC1A) and replay cut (VC0A); VC1B layers persistence + tool identity on top. Mode A = the real store (`sqlite.ts`/`store.ts`); Mode B = the raw `M2Host` harness in the acceptance test driving phase-by-phase M2 (reachable failure codes the single `migrateOccurrenceV2()` cannot hit) shares no store subroutine; Mode C = `MEGACOMPACT_VC1B=0` — the ledger/seam emits zero observability events while the store remains functional (flag-off acceptance passes, byte-identical predecessor behavior). Dashboard `GET` is reader-capability-only.

## Commands and verbatim summaries

- `npm run build` → tsc clean (no `error TS`); postbuild `vector-cortex-publish-acceptance` → `published 5 acceptance + 6 eval + 5 replay + 2 migrations + 9 ledger + 6 resilience files`.
- Acceptance, mandated command, both flag states:
  ```bash
  node --test dist/vector-cortex/vc1b-acceptance.test.js
  # → ℹ tests 25, ℹ pass 25, ℹ fail 0   (flag ON)
  MEGACOMPACT_VC1B=0 node --test dist/vector-cortex/vc1b-acceptance.test.js
  # → ℹ tests 25, ℹ pass 25, ℹ fail 0   (flag-off rehearsal; S2 asserts ZERO writes not just zero emissions)
  # S1/S2 ingestion-seam test (extension adapter) also green: node --test dist/extensions/mega-runtime/vector-cortex-ledger.test.js → 4 pass / 0 fail
  ```
- `npm test` → full gate (see Evaluation: 0 failed).
- `npm run lint` → `tsc --noEmit` + `guardrails-scan` + `semantic-scan` all clean.
- `python3 scripts/regression_check.py --all` → `✓ No potential regressions detected` + `✓ All MEGACOMPACT_* env vars have dashboard settings entries` (0 blocking vulns; 11 dev-only warnings are toolchain).
- `node scripts/vector-cortex-conformance.mjs --check` → `✓ (129 fixtures canonical)`.
- `node scripts/vector-cortex-docs-check.mjs` → `✓ DOCS-CHECK: 27 sprints / 9 phases, links+flags+commands+migrations clean.`
- `node scripts/guardrails-scan.mjs` → `GUARDRAILS: pi pattern scan clean` (also via lint).
- `node scripts/vector-cortex-publish-acceptance.mjs` → mirrors ledger/ (excluding `*.test.js`) + migrations to `dist/vector-cortex/`.
- Dashboard server target tests: `routes-vector-cortex.test.js` → `tests 10, pass 10, fail 0`; `routes-rag-settings.test.js` → `tests 16, pass 16, fail 0`; `endpoints-registry.test.js` → `tests 4, pass 4, fail 0`.
- Dashboard client: `npm run build` (vite) → `✓ built in 3.65s`. (`npm run typecheck` reports pre-existing environmental noise — the client tsconfig pulls in `../../src` without node types, yielding `Cannot find name 'process'/'Buffer'` and `Cannot find module 'node:sqlite'` across unrelated files including `src/store/*` and `src/wiki/*`; the only vector-cortex hit is the same `process` intrinsic in `src/config/vector-cortex.ts`, identical to the VC1A file. Vite build — the real gate — succeeds.)
- `git diff --check` → clean (exit 0).

## Evaluation

All 25 acceptance tests pass in both flag states. M2 lifecycle verified phase-by-phase through the raw harness: halt-before-switch leaves authority untouched (phase `validated`), interrupted-switch resume re-stages idempotently, and copy-missing / phase-unreached / digest-mismatch / unrepresented-unlisted failure codes fire at the intended phases. Tool identity: a RESULT names exactly one earlier call (`EVT_TOOL_CALL_MISSING` rejects a dangling RESULT; `M2-TOOL-002` confirms the single back-edge); seq never regresses (`EVT_SEQ_REGRESSION`); `(event_id,digest)`-only uniqueness (same bytes at distinct event_id → two occurrences). Downgrade export lists invalid-UTF-8 rows as unrepresentable and holds bytes losslessly. Full `npm test` gate: 1481 passed, 0 failed across 192 files (4 new S1/S2 wiring tests included).

## Dashboard / API / config / SETTINGS evidence

- `MEGACOMPACT_VC1B` surfaced in the "Vector Cortex" SETTINGS group as a working `boolDirect` on/off toggle — NOT in `EXCLUDED_SETTINGS` (regression_check `--all` confirms every `MEGACOMPACT_*` var has a settings entry).
- Flag toggle round-trip verified in `routes-rag-settings.test.ts` ("VC1B flag round-trips through settings").
- New endpoint `GET /api/vector-cortex/ledger` (`VectorCortexLedgerView`), registered in the endpoint registry (48 → 49). Reader-built from `LedgerReader` capability only; returns identity rows, never `sourceBytes`/payload text (verified by the "never source payloads" assertion on port 9420). Flag-OFF reports `enabled:false` (port 9421). Client `VectorCortexTab` renders the ledger card.
- Writer capability fed by the future live writer → ingestion wiring (this sprint ships the seam; live producer hook-up is the later VC1 producer-wiring sprint).

## Offline / network / asset / platform evidence

Zero runtime network egress (PREVENT-PI-004): the ledger is `node:sqlite` `DatabaseSync` (in-process), local filesystem only. No `fetch`/HTTP in the store path; the optional dashboard server is loopback. BYO embedder/Ollama unchanged. No new third-party asset.

## File sizes and baseline exceptions

All new files within limits: ledger/types.ts 141, sqlite.ts 265, compat-journal.ts 215, store.ts 427 (over 300 soft, under 500 hard; S2 added the flag-gated no-op append), migrations/occurrence-v2.ts 182, sqlite.test.ts 225, compat-journal.test.ts 214, vc1b-acceptance.test.ts 600 (at the 600 test hard limit; S2 expanded the flag test to also assert zero writes), config/vector-cortex.ts 87, `extensions/mega-runtime/vector-cortex-ledger.ts` 139 (< 400 extension hard). Pre-existing over-hard-limit `extensions/mega-events/context-handler.ts` remains a documented baseline exception — S1 adds only 7 lines (514 → 523) to wire the ingestion call site.

## Rollback / downgrade rehearsal

`MEGACOMPACT_VC1B=0` → the writer is a no-op: `writer().append()` accepts calls but writes ZERO rows, `openLedgerWriter`/`appendMessagesToLedger` open NO ledger DB, the emit seam emits nothing, and the store remains functional; acceptance passes with flag off (0 failed, S2 asserts zero writes not just zero emissions). Downgrade path (M2/MIG-DOWN) verified: prepare lists unrepresentable rows before building the legacy copy; the new legacy copy is produced on switch with unrepresentable rows listed; an untouched ledger refuses the downtime path (`MIG_DOWN_NOT_ACTIVE`). Evidence retained on rollback.

## Issues found during implementation

- **VC1B-I01 [type: minor, state: fixed-in-this-sprint]**: the acceptance test (`vc1b-acceptance.test.ts`) exceeded the 600-line HARD limit for `.test.ts` under `src/` (674 lines at first draft). Refactored to `withStore`/`withRawStore` helpers that own temp-dir create/close/cleanup, compacting the per-test boilerplate and header docstring — now 596 lines, under both the 600 hard and comfortably reporting total. All 25 tests still pass after the refactor.
- **VC1B-I02 [type: minor, state: fixed-in-this-sprint]**: M2-003/M2-007 fixtures initially asserted impossible states (ok:true on a fully-untouched ledger; re-validate after switch). Corrected to the implementation's honest behavior — `MIG_DOWN_NOT_ACTIVE` for an empty ledger (downgrade refused), `MIG_DOWN_PHASE_UNREACHED` for a validate-before-copy on an active journal — so the corpus exercises real reachable paths.
- Query-parameter hardening on the new ledger endpoint: `?session=` defaults to `"default"` for any/missing value (no injection surface — the value is bound as a parameterized placeholder into the `SessionRead` path).
- **VC1B-I03 [type: minor, state: fixed-in-this-sprint]**: the new EVT-026 event fixture declared `expected.order` as `[U+10000, U+E000]` — the JS code-unit order, REVERSED from the bytewise (unsigned UTF-8) order the validator produces (`U+E000` = `EE`, `U+10000` = `F0`, so `EE < F0` puts `U+E000` first, per EVT-003's documented divergence). The VC1A "validate rows" acceptance iterates every `event-v2-validate` fixture in the manifest, so this regressed `vc1a-acceptance.test.js` (12/1) once EVT-016..030 landed. Fixed the generator's expected order (events.mjs) and regenerated the corpus; both VC1A (13/13) and VC1B (25/25) acceptance pass after the fix.
- **VC1B-I04 [type: spec-compliance, state: fixed-in-this-sprint]**: independent review flagged S1 (spec said "wire only writer capability to ingestion" but nothing called `store.writer()`) and S2 (the flag gated only the emit seam, so `writer().append()` wrote regardless). Fixed: S1 wires the writer into the pi runtime ingestion path via the new `extensions/mega-runtime/vector-cortex-ledger.ts` adapter, called from `context-handler.ts`; S2 gates the entire write path — flag OFF returns a `syntheticAppend` no-op (`store.ts`) and opens no DB, and the flag-off acceptance test now asserts ZERO writes (count unchanged) plus zero emissions. New adapter test (`vector-cortex-ledger.test.ts`, 4 tests) covers both.

## Residual risks / carried-forward OPEN issues

- **Carried forward OPEN (VC1 family):** the writer is now wired into the runtime ingestion path (S1: `context-handler.ts` → `appendMessagesToLedger`), but the toolCallId back-edge (the exactly-one tool-call→result identity) is NOT yet produced on the live path — the pi runtime discriminates `AgentMessage` by `role` only, and the tool-call id lives in variant content unreachable by role, so `messageToLedgerInput` omits toolCallId (documented deferral). `MEGACOMPACT_VC1B` gates the whole write path. The full producer hook-up (appending per-turn occurrences with the exactly-one tool identity, including engine-level wiring beyond the context-handler seam) is deferred to the VC1 producer-wiring sprint.
- **Carried forward OPEN (VC0A family):** dashboard OBSERVER badge derives from the flag rather than real observability until a live producer exists.
- Reader endpoint returns identity rows only (`seq/eventId/kind/digest/toolCallId`) and omits `sourceBytes` by design (reader-only policy); the writer/ingestion path is what will attach full payloads later.
- `vc1b-acceptance.test.ts` (600) exceeds the `tests/` 300-line SOFT limit — consistent single-file acceptance aggregator, at the 600 HARD limit.

## Reviewer attestation

Not yet attested — pending independent reviewer.
