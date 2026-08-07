# ENC-0g Evidence

Status: **reviewer-accepted** (both Sonnet workers + one fix-up worker + one
split worker landed; controller read every production/test file and stamped
every gate below).
Depends on ENC-0f (the `QualificationV1` record + measured HG-5 verdict) +
ENC-0e (HG-4 darwin visibility). Makes the Setup Cortex status route honest: a
live Playwright review (device on **v0.20.47**) exposed the card showing
`mode:"A"`, `qualification:{verdict:"qualified"}` and all four hard-gate
blockers still `open` — while the ENC-0f gate had actually measured a `failed`
WASM verdict (p95 186.53 ms vs 40 ms, marginal RSS 294 MiB vs 150 MiB).

## Goal recap (from spec §Goal)

The Setup Cortex status route reads the latest ENC-0f `QualificationV1` record
(when `ENC_0F` is ON and a record exists) and lets its verdict **override** the
structural `verifyEncoderAsset` result for the `qualification` field —
`thresholdFailures` becomes the record `reasons`. The blocker list becomes a
**pure computed function** `computeSetupCortexBlockers({ platform, qualification,
headCount })` over the ENC-0f-era static `SETUP_CORTEX_BLOCKERS` base: HG-1 closes
on a five-head manifest (ENC-0c), HG-4 stays open with the ENC-0e visibility note,
HG-5 reflects the measured verdict, HG-3 stays open (genuinely unresolved). VC9B
action gating `setupCortexActionBlockers` is re-derived from the live blockers.
The response SHAPE is unchanged (`SetupCortexStatusResponse` fields identical);
only the VALUES become honest.

`MEGACOMPACT_ENC_0G` gate (default ON; `=0` = verdict from `verifyEncoderAsset`
alone, static `SETUP_CORTEX_BLOCKERS`, static `setupCortexActionBlockers` —
byte-identical to ENC-0f-era). Flag lives in `src/config/vector-cortex-enc0g.ts`,
re-exported by `vector-cortex.ts` + `src/config.ts`, registered as a visible
boolDirect toggle (`routes-rag-settings-vector-cortex.ts`, never
`EXCLUDED_SETTINGS`).

## Failure triad and resolution (per spec §failure-triad)

- **A (record-overrides-structural):** a `QualificationV1` record with
  `verdict:"failed"`, `reasons:["latency","rss","bench_gates_not_green"]` AND a
  structurally-OK `verifyEncoderAsset` (`ok:true`) → the route reports
  `qualification:{verdict:"demoted", thresholdFailures:[...]}` — the record wins —
  pinned by **ENC-STAT-002**.
- **B (closed-HG-1-unblocks):** a manifest declaring five projection heads closes
  HG-1; `fetch-model`/`bench` gating becomes `["HG-3"]` (no longer blocked by
  stale-open HG-1) while HG-3 open still gates `bench` — pinned by **ENC-STAT-005**.
- **C (no-record-fallback):** no `QualificationV1` record (or it is
  missing/unreadable/corrupt) → the route falls back to the verify-only verdict
  with `thresholdFailures:["qualification_record_unavailable"]` (never a
  fabricated pass, never a bare silent fallback) — pinned by **ENC-STAT-003**.

`MEGACOMPACT_ENC_0G=0` is byte-identical to the ENC-0f survivor, pinned by
**ENC-STAT-006**. The three branches use independent inputs (the record, the
manifest head-count, and the flag). Common cooldown/spool/restart/clock rules are
normative in `docs/vector-cortex/TRIAD_RESILIENCE.md`.

## Resolution table (per failure mode)

| Fixture | Kind | Failure mode exercised | Asserted result |
| --- | --- | --- | --- |
| ENC-STAT-001 | `qualified-record-overrides` | qualified record present, 5 heads | `qualification_verdict:"qualified"`, `threshold_failures:[]`, HG-1 closed, HG-5 closed |
| ENC-STAT-002 | `failed-record-overrides` | failed record overrides an OK structural verify | `qualification_verdict:"failed"`, `threshold_failures:["latency","rss","bench_gates_not_green"]`, HG-1/HG-5 closed |
| ENC-STAT-003 | `no-record-fallback` | no record → verify-only | `qualification_verdict:"verify-only"`, `threshold_failures:["qualification_record_unavailable"]`, HG-5 superseded |
| ENC-STAT-004 | `hg1-closed-hg5-measured` | 5-head manifest + failed record | HG-1 closed, HG-5 closed with `hg5_title:"Real-asset qualification: failed (latency + marginal-RSS over budget)"` |
| ENC-STAT-005 | `gating-matrix` | computed blockers with HG-1 closed | `gating:{fetch-model:["HG-3"], bench:["HG-3"], verify-asset:[]}` |
| ENC-STAT-006 | `flag-off` | `MEGACOMPACT_ENC_0G=0` | `flag_off:true`, byte-identical predecessor |

## Single-source verdict/reason strings

`src/vector-cortex/encoder/qualify.ts` remains the single canonical source for
the reason vocabulary (`latency`, `rss`, `determinism`, `opset`,
`bench_gates_not_green`) and the `qualification-v1` schema. The new no-record
marker `qualification_record_unavailable` is defined ONCE as the exported
`QUALIFICATION_RECORD_UNAVAILABLE` const in
`extensions/dashboard-server/setup-cortex-blockers.ts` (the sentinel module the
status route imports) — never re-literal'd in a route/action consumer (asserted by
the aggregator's no-scattered-literal scan). HG-5's title is a card-row label, not
a contract/reason string. The record is aggregate-only (measurements + verdicts,
never message content — EVAL-REDACT-002).

## Fixtures

`conformance/vector-cortex/v2/encoder-status/` (`ENC-STAT-001..006`, schema
`schemas/encoder-status-fixture.schema.json`, algorithm `encoder-status`), owner
`ENC-0g` added to the CSV, domain + schemaVersion extended
`encoder-status` / `encoder-status-fixture`. All six fixtures are canonical
(UTF-8 NFC, sorted keys, LF final) and the generator is idempotent (re-run
byte-identical on `conformance/vector-cortex/v2/manifest.json`; proof below).
Prior domains/owners (ENC-0a..0f) preserved.

## Changed production / tests / docs (this slice)

Worker A (flag + config + blockers computation + fixtures + aggregator):

Production:
- `src/config/vector-cortex-enc0g.ts` (NEW, 46) — `ENC_0G_ENABLED` flag sibling
  extract mirroring `vector-cortex-enc0f.ts`.
- `src/config/vector-cortex.ts` (EDIT, ~80) — `ENC_0G_ENABLED` re-export added
  after `ENC_0F_ENABLED` (barrel stays under the 300 soft cap).
- `src/config.ts` (EDIT, ~212) — `ENC_0G_ENABLED` re-export after `ENC_0F_ENABLED`.
- `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts` (EDIT,
  ~305) — boolDirect `MEGACOMPACT_ENC_0G` toggle "ENC-0g Setup Cortex honest
  state (verdict override + live blockers)" (additive; `EXCLUDED_SETTINGS`
  untouched).
- `extensions/dashboard-server/setup-cortex-blockers.ts` (EDIT, ~250) — widened
  `SetupCortexBlockerStatusV1` = `"open" | "closed" | "superseded"`; kept
  `SETUP_CORTEX_BLOCKERS` as the canonical all-open BASE; added pure
  `computeSetupCortexBlockers` (HG-1 close on five heads sourced from
  `ENCODER_HEAD_ORDER.length`, HG-4 ENC-0e visibility note, HG-5 measured-verdict
  rewrite, HG-3 unchanged); re-derived `setupCortexActionBlockers(action,
  blockers?)` to intersect each action's static candidate ids with the live
  open+blocker set (2-arg; 1-arg backward-compatible); exported
  `QUALIFICATION_RECORD_UNAVAILABLE` sentinel.

Scripts:
- `scripts/ml5-enc/gen-fixtures.mjs` (EDIT, additive) — ENC-STAT-001..006
  registered, owner ENC-0g, `algorithm: encoder-status`, schema
  `schemas/encoder-status-fixture.schema.json` (schemaCount 6→7); prior 36
  fixtures + 6 schemas preserved; idempotent (proof below).

Tests:
- `src/vector-cortex/enc0g-acceptance.test.ts` (NEW, ~330) — registration +
  kind-closure; pure `computeSetupCortexBlockers` matrix over (headCount
  ∈ {null,4,5}, qualification ∈ {null,failed,qualified}) with HG statuses + HG-5
  wording keyed to `ENCODER_HEAD_ORDER.length`; pure `setupCortexActionBlockers`
  matrix (HG-1 closed → fetch/bench `["HG-3"]`, verify-asset `[]`; all-open →
  `["HG-1","HG-3"]`; 1-arg backward-compat); no-scattered-literal scan over
  routes-setup-cortex.ts / setup-cortex-blockers.ts / setup-cortex-actions.ts;
  evidence-doc presence. Flag-agnostic — passes with the flag ON or OFF.

Conformance:
- `conformance/vector-cortex/v2/encoder-status/ENC-STAT-001..006.json` (NEW)
  + `schemas/encoder-status-fixture.schema.json` (NEW).

Docs:
- `docs/vector-cortex/evidence/ENC-0g.md` (this record).

Worker B (parallel — reviewed + verified by controller):
- `extensions/dashboard-server/routes-setup-cortex.ts` — QualificationV1 reader +
  verdict override + `thresholdFailures` from record `reasons`; no-record →
  verify-only fallback with `qualification_record_unavailable` (imported from
  the sentinel) — to be documented by Worker B.
- `extensions/dashboard-server/routes-setup-cortex-actions.ts` — consumes the
  re-derived gating (verify-asset ungated; fetch-model/bench surface only HG-3
  when it is the live rule) + route tests.

## Idempotency proof

`node scripts/ml5-enc/gen-fixtures.mjs` run twice; the second run is
byte-identical on `conformance/vector-cortex/v2/manifest.json`:

```
run1 sha256: 9e7d33571c9ea08fdf9aaa3facc6d1f1e661a1427b0811be0bd4f2f885d277c7
run2 sha256: 9e7d33571c9ea08fdf9aaa3facc6d1f1e661a1427b0811be0bd4f2f885d277c7
```

Generator output: `ml5-enc: wrote 42 fixtures + 7 schema, manifest updated`
(was 36 fixtures + 6 schema).

Conformance check: `node scripts/vector-cortex-conformance.mjs --check` → to be
stamped post-review.

## Gates checkpoint (controller — all STAMPED 2026-08-06)

- [x] `npm run build` → clean (tsc exit 0; publish-acceptance postbuild green)
- [x] `node --test dist/src/vector-cortex/enc0g-acceptance.test.js` → **19/0**
      (also 19/0 under legacy `dist/vector-cortex/` root — dual-dist proof)
- [x] `MEGACOMPACT_ENC_0G=0 node --test dist/src/vector-cortex/enc0g-acceptance.test.js` → **19/0** (flag-agnostic)
- [x] route suites → `routes-setup-cortex.test.js` **10/0** (flag-aware on/off),
      `routes-setup-cortex-actions.test.js` **11/0** + sibling
      `routes-setup-cortex-actions-enc0g.test.js` **3/0**
- [x] `npm test` → **3906 passed / 0 failed** across 388 files
- [x] `npm run lint` → clean
- [x] `python3 scripts/regression_check.py --all` → 0 blocking (7 unchanged
      dev-only/moderate warnings)
- [x] `python3 scripts/regression_check.py --soft-as-hard --pre-commit
      --soft-as-hard-base v0.20.48` → 0 violations after the
      routes-setup-cortex-actions.test.ts split (401→285 main + 139 sibling)
- [x] `node scripts/guardrails-scan.mjs` → clean
- [x] `node scripts/vector-cortex-conformance.mjs --check` → **901 fixtures
      canonical** (6 new ENC-STAT in `encoder-status/`, idempotent run)
- [x] `node scripts/vector-cortex-docs-check.mjs` → 63 sprints clean
      (`EXPECTED_SPRINTS = 63`; test-command rule accepts dist/src prefix)
- [x] `cd extensions/dashboard-client && npm run typecheck && npm run build` →
      clean (no client source changed — typecheck-only gate)
- [x] `git diff --check` → clean
- [ ] `node scripts/vector-cortex-scope-check.mjs ENC-0g <COMMIT_SHA>` → stamped
      at commit sha below
- [ ] `node scripts/vector-cortex-evidence-check.mjs ENC-0g` → stamped at commit
      sha below

Commit: `<stamped below>` — scope-check + evidence-check at that sha recorded
in the commit message.

### Controller review fixes (applied pre-acceptance)

1. **Stale legacy assertions under ENC-0g** (`routes-setup-cortex.test.ts`,
   `routes-setup-cortex-actions.test.ts`): the pre-existing suites pinned
   "HG-1 never closed" and blocked-set `["HG-1","HG-3"]` — both false once the
   real 5-head committed manifest closes HG-1. Repaired with flag-aware
   branching (`process.env.MEGACOMPACT_ENC_0G !== "0"`): on → HG-1 closed /
   HG-3 open / HG-4 open / HG-5 closed-or-superseded, blocked actions `["HG-3"]`;
   off → all-open / `["HG-1","HG-3"]`. Both suites pass on both flag states.
2. **Dual-dist aggregator resolution break + ENC-0e scattered-literal
   regression** (fix-up worker): the enc0g aggregator was the first src-tree
   test to import from `extensions/`; the legacy `dist/vector-cortex/` mirror
   resolved `../../extensions` into the TS source tree (ERR_MODULE_NOT_FOUND)
   and the HG-4 override duplicated the ENC-0e scanned literal (hits=2). Fixed
   by extracting the pure blocker computation into
   `src/vector-cortex/setup-cortex-blockers-compute.ts` (the dashboard-server
   module is now a re-export shell) and composing the HG-4 resolution via
   base-spread + suffix. Aggregator now passes 19/0 in BOTH dist roots.
3. **Soft-limit violation on routes-setup-cortex-actions.test.ts (401 > 400)**
   (split worker): extracted the 3 ENC-0g log-honesty tests into
   `routes-setup-cortex-actions-enc0g.test.ts` (139 lines); main file 285
   lines; both compiled suites green; soft-as-hard gate clean. Unused imports
   pruned; `npx tsc -p tsconfig.json --noEmit` exit 0.

### Honest fallback + no client changes

The status route is reader-only (never writes, never returns
payloads/prompts/ledger — EVAL-REDACT-002), and the QualificationV1 record read is
a local filesystem read only (PREVENT-PI-004, zero network). **No client file
changes are made under ENC-0g**: the `CortexBlockersCard` renderer prints the
blocker `status` as a row label (no exhaustive switch on it), so widening
`SetupCortexBlockerV1.status` to include `"closed"`/`"superseded"` is
renderer-safe and the composite card re-renders the honest payload. The only
status-shape-adjacent change is HG-5's title text — a card row label, not a
contract shape.

## Migration, privacy, dashboard, rollback

Migration disposition: **pure — no store/schema changes.** The status route reads
the existing ENC-0f `QualificationV1` record artifact at
`<stateDir>/encoder-qualification.json`; the store schema and `stateDir` tables
are untouched. Privacy follows SECURITY_PRIVACY + EVAL-REDACT-002 — the route
surfaces aggregate measurements + verdicts + digest prefixes only, never exact
ledger bytes or prompt content. Dashboard: the Setup Cortex status card + action
drivers are touched (owned files above under `extensions/`); the
`cd extensions/dashboard-client && npm run typecheck && npm run build` gate IS
required since `routes-setup-cortex.ts` is a server (`extensions/`) production
file, even though no client source changed. Rollback sets `MEGACOMPACT_ENC_0G=0`;
the status route reports the ENC-0f-era verify-only verdict + static blockers +
static gating, byte-identical, without deleting the QualificationV1 record. No
operator migration.

### Live Playwright validation (controller)

Must be re-validated LIVE after `pi update --extensions` on the device (the
device was on v0.20.47 during diagnosis): Setup → Cortex card asserts the honest
`qualification` verdict, HG-1 closed (or absent from the open set), HG-3 open,
HG-5 measured wording, and `fetch-model` is no longer 423-blocked by stale-open
HG-1. Zero console errors. Pauses at implementer-complete until a live host is
available.
