# ML5-D Evidence

Status: **REVIEWED + COMMITTED + PUBLISHED as v0.20.40** — all sprint gates
green before the commit, independently replicated by the controller against
the committed tree, and the deploy landed on master via
`./scripts/deploy.sh 0.20.40`.

**Controller attestation.** The implementer's tree matched the report exactly
(14 modified + 10 new files, all under caps). The controller applied no
corrective edits and re-ran every gate: build clean (43 acceptance artifacts
mirrored incl. `ml5d-acceptance.test.js` + `improve.js`); `node --test
dist/vector-cortex/ml5d-acceptance.test.js` → 13/13 pass under both
flag-on and flag-off; full `npm test` → 3592 pass / 0 fail across 364 files;
`npm run lint` clean; `conformance` → 843 fixtures canonical; `docs-check`
→ 44/11 (ratified stale, see deviation #2); `log_failure` clean;
`regression_check --all --soft-as-hard --soft-as-hard-base v0.20.39
--pre-commit` → rc=0 (only pre-existing soft-limit warnings); `git diff
--check` clean; dashboard-client `vite build` clean. All 6 declared
deviations ratified (including #3 — discriminated-union narrowing is the
correct call over injecting `deriveVcStatus`).

The implementer's original attestation and deviation list are preserved below
verbatim for the audit trail.

---

**Implementer attestation (this working tree).** The implementer ran every gate
that does not require a root build or a root `npm test` and verified:

**Implementer attestation (this working tree).** The implementer ran every gate
that does not require a root build or a root `npm test` and verified:
- Root `tsc --noEmit` → clean (0 errors), covering `src/**` and
  `extensions/dashboard-server/**` (includes the new `routes-cortex-improve.ts`,
  `routes-rag-settings-vector-cortex.ts`, the improved discriminated-union
  status narrowing).
- Dashboard-client `tsc --noEmit` (the spec's `npm run typecheck`, run inside
  `extensions/dashboard-client`) → clean (0 errors), covering the new
  `types/cortex-improve.ts`, `api/client-extra.ts` improve/status fetch helpers,
  `components/ModelImprovementCard.tsx`, and the `VectorCortexTab.tsx` edit.
- `npm run lint` component scans (excluding the root build step) →
  `guardrails-scan` clean + `semantic-scan` clean (both run directly).
- `node scripts/vector-cortex-conformance.mjs --check` →
  `✓ v2 manifest + 843 fixtures canonical (843 files)` (ML5-C's 837 + this
  sprint's 6).
- `node scripts/vector-cortex-docs-check.mjs` → `✓ 44 sprints / 11 phases`
  (at the **ratified stale** 44 — see deviation #2).
- Fixture generator idempotency: re-running `scripts/ml5/gen-fixtures-ml5d.mjs`
  deterministically rewrites the same 6 fixtures + manifest; the schema `kind`
  enum extends additively to `[ml5-train, bench-heads, runtime-choice,
  cortex-improve]`.
- `git status` shows only the intended working-tree additions (new
  `cortex-improve/` fixture dir + modified manifest/schema); no leftover
  foreign state created by me.

**Gates pending controller attestation** (implementer constrained not to run):
`npm run build`, `node --test dist/vector-cortex/ml5d-acceptance.test.js` and
`MEGACOMPACT_ML5_D=0 ...` parity, `npm test` (full suite), `python3
scripts/regression_check.py --all --soft-as-hard --soft-as-hard-base <PREV_TAG>
--pre-commit`, `git diff --check`, and the client `vite build` (the spec's
`npm run build` in `extensions/dashboard-client`). The controller runs these at
attestation and promotes this record to `REVIEWED + COMMITTED`.

**Attested deviations** (each deliberately taken; recorded for the controller's
review):
1. **`scripts/vector-cortex-docs-check.mjs` NOT bumped (44, not 40).** The spec
   says bump `EXPECTED_SPRINTS 39→40`, but the on-disk value already reads 44
   (the same stale-doc situation ratified in ML5-A, ML5-B and ML5-C). Left at 44
   per controller direction; `docs-check` passes. No action taken.
2. **Acceptance test-count reported from source, not from an executed run.** The
   aggregator `src/vector-cortex/ml5d-acceptance.test.ts` contains **13** `test()`
   calls (1 conformance-registration + 6 envelope invariants + 5 pure
   improve-harness decision + 1 audit stub-8 closure). The executed counts
   (`node --test dist/vector-cortex/ml5d-acceptance.test.js`) cannot be produced
   by the implementer because producing `dist/` requires `npm run build`, which
   the implementer is forbidden to run. The controller's attestation figures
   supersede the source count.
3. **`deriveVcStatus` not injected into improve route responses.** The project
   convention and spec ask for `deriveVcStatus` in responses, but the improve
   job API uses a strict job-lifecycle discriminated union
   (`"improving" | "qualified" | "demoted_to_B"`) where the `status` field is a
   job-state literal, not a VC derived-status enum. Injecting `deriveVcStatus`
   would corrupt the contract. The status endpoint narrows the job state per
   variant to satisfy the discriminated union cleanly. Recorded as a forced
   deviation.
4. **`StringEnum` type does not exist; used literal unions.** The spec's task 3
   references `StringEnum<"improving"|"qualified"|"demoted_to_B">`. No such
   generic exists in the codebase; the same discrimination is expressed with
   explicit literal-union types (`CortexImproveJobStatus` + the `CortexImprove*`
   discriminated union), which is stricter and PREVENT-011-clean.
5. **Client fetch helpers added only to `client-extra.ts`, not `client.ts`.**
   Per controller direction, `extensions/dashboard-client/src/api/client.ts` was
   NOT touched; the `improveCortex` / `fetchCortexImproveStatus` helpers live in
   the `client-extra.ts` delegate-sibling (PC-C precedent). `client-http.ts` was
   not needed (postJson/getJson already bundled in `client-extra.ts`).
6. **`routes-cortex-improve.ts` responds 404 not 405 to disabled-GET.** For
   `GET /api/cortex/improve/status/:jobId`, a flag-off returns the same `404`
   `disabled` body as the POST surface (`sendDisabled`), matching the spec's
   "flag-off → 404" for both endpoints. A wrong method on the status route
   returns 405 before the flag check.

## Goal recap

Add the dashboard "Model Improvement" sub-panel + promote workflow: a single
**Improve** button under the Vector Cortex health card. One click runs the ML5-A
training pipeline locally against the latest local corpus as a background job,
re-qualifies the five heads, and surfaces the Promoted/Rejected verdict. The
sprint also **closes the audit's Table-1 stub 8** — the dashboard-snapshot
placeholder — by verifying `totalTokensSaved` feeds from the real
`ctx.repo.tokensSaved` counter and that no rolled-up `(dedupCollapsed * 100)`
math remains in the snapshot path.

Two additive endpoints:
- `POST /api/cortex/improve` — local-only, **server-side confirm required**
  (`confirm:true` in the body; the client mirrors with a `window.confirm`
  modal). Spawns `python3` ML5-A training on the latest local corpus as a
  background job → `{ status:"improving", jobId }`. Flag-off → 404.
- `GET /api/cortex/improve/status/:jobId` — pollable; returns
  `{ status, progress, verdict?, assetDigest? }` and terminates in
  `{ status:"qualified", verdict, assetDigest }` or
  `{ status:"demoted_to_B", reason }`. Flag-off / unknown job → 404.

Output: a `ModelImprovementCard` in `VectorCortexTab` showing current mode, last
bench run, latest qualification verdict, and the Promoted/Rejected badge —
surfacing mode/verdict/digest/progress aggregates only, never message content or
corpus rows (EVAL-REDACT-002). Zero network at runtime (PREVENT-PI-004): the
improve job is spawned locally (`python3 training/vector-cortex/train.py`) and
its status is polled from an in-process `JOBS` map.

`MEGACOMPACT_ML5_D` gate in `src/config/vector-cortex-ml5d.ts` (default ON;
`=0` → both improve endpoints return 404/disabled and `VectorCortexTab` omits the
card — byte-identical to the ML5-C tab).

## Changed production / tests / docs

TypeScript (src):
- `src/config/vector-cortex-ml5d.ts` (30) — `MEGACOMPACT_ML5_D` flag via
  `sprintFlag`, default ON, `=0` disables the improve surface + card.
- `src/config/vector-cortex.ts` (300) — additive `ML5D_ENABLED` re-export in the
  existing sibling block; held at the 300 soft limit (one comment compressed to
  stay exactly at 300).
- `src/config.ts` (203) — additive `ML5D_ENABLED` re-export.
- `src/vector-cortex/improve.ts` (28) — **pure** `qualifyDecision(exitCode,
  assetDigest)` → `"qualified" | "demoted_to_B"` (qualified only when
  `exitCode === 0 && assetDigest !== null`). Lives under `src/` so both the
  dashboard route and the mirrored `dist/../ml5d-acceptance.test.js` import it —
  the pure rule is tested with no real training run.
- `src/vector-cortex/ml5d-acceptance.test.ts` (166) — flag-agnostic acceptance
  aggregator, **13 tests** in 4 suites (conformance registration; envelope
  invariants 001–006; pure improve-harness decision-rule with `if
  (!ML5D_ENABLED()) return;` gates; audit stub-8 closure). Tests read local
  files only, zero network.

Dashboard server:
- `extensions/dashboard-server/api-contracts/cortex-improve.ts` (82) —
  `QualificationV1`, `CortexImproveStart`, `CortexImproveJobStatus`, the
  `CortexImproveStatus` discriminated union (`CortexImproveProgress` /
  `CortexImproveQualified` / `CortexImproveDemoted`), `CortexImproveDisabled`,
  `CortexImproveStartRequest`.
- `extensions/dashboard-server/api-contracts/endpoints/registry-ext.ts` (157) —
  import + `improveCortex` / `improveCortexStatus` `EndpointDef`s; spread into
  `registry.ts` (496) via the existing registry-ext seam (registry.ts itself not
  modified directly).
- `extensions/dashboard-server/api-contracts/index.ts` (337) — exported the new
  cortex-improve types.
- `extensions/dashboard-server/api-contracts.test/endpoints-registry.test.ts`
  (199) — `EXPECTED_ENDPOINT_COUNT` 53→55; 2 new `/api/cortex/improve*` paths in
  `SERVER_TS_PATHS`.
- `extensions/dashboard-server/routes-cortex-improve.ts` (256) —
  `handleImproveCortex` (POST, confirm:true required, flag-off 404, spawns
  background `python3 training/vector-cortex/train.py` job) +
  `handleImproveCortexStatus` (GET status, flag-off/unknown 404, per-state
  discriminated-union narrowing). In-process `JOBS` map (restart-scoped).
- `extensions/dashboard-server/route-dispatch.ts` (162) — imports + 2 if-chain
  entries.
- `extensions/dashboard-server/routes.ts` (68) — re-exports the two handlers.
- `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts` (244) —
  additive `MEGACOMPACT_ML5_D` boolDirect toggle ("ML5-D Improve Cortex"),
  never in `EXCLUDED_SETTINGS`.
- `extensions/mega-runtime/dashboard-snapshot.ts` — **stub-8 closure** (no new
  math): stale inline comment corrected to reference the real field
  `ctx.repo.tokensSaved` (line ~162); the snapshot already reads that real
  counter (line ~164). No rolled-up `dedupCollapsed * 100` remains.

Dashboard client:
- `extensions/dashboard-client/src/types/cortex-improve.ts` (42) — client mirror
  of the improve API types.
- `extensions/dashboard-client/src/api/client-extra.ts` (71) — `improveCortex`
  (POST) + `fetchCortexImproveStatus` (GET) fetch helpers via postJson/getJson.
  `client.ts` NOT touched (controller direction).
- `extensions/dashboard-client/src/components/ModelImprovementCard.tsx` (141) —
  card with mode / last bench / verdict and a Promoted/Rejected badge
  (success/danger/outline variants), an Improve button gated by `window.confirm`,
  and polled job-status to a terminal badge. Flag-off → card omitted by the tab.
- `extensions/dashboard-client/src/tabs/VectorCortexTab.tsx` (220) — additive:
  `<ModelImprovementCard />` rendered below the existing health card, gated on
  `ML5D_ENABLED`.

Scripts:
- `scripts/ml5/gen-fixtures-ml5d.mjs` (176) — emits `ML5-DASH-001..006` into
  `conformance/vector-cortex/v2/cortex-improve/`; extends the shared schema `kind`
  enum additively to `[ml5-train, bench-heads, runtime-choice, cortex-improve]`;
  registers owner `ML5-D` in the v2 manifest; idempotent.
- `scripts/vector-cortex-publish-acceptance.mjs` (343) — `nSupport` increased by
  1 so the new `src/vector-cortex/improve.js` is mirrored into
  `dist/vector-cortex/` via the existing loose-file copy pass (the acceptance
  aggregator imports `./improve.js`).

Conformance:
- `conformance/vector-cortex/v2/cortex-improve/ML5-DASH-001..006.json` (new, 6
  files, canonical + idempotent) — 001 promoted render, 002 rejected render,
  003 flag-off 404 + card omission, 004 confirm-required + jobId, 005 status
  terminal states, 006 mode-badge transition pin.
- `conformance/vector-cortex/v2/schemas/ml5-fixture.schema.json` — `kind` enum
  extended additively with `cortex-improve`.
- `conformance/vector-cortex/v2/manifest.json` — 6 new `cortex-improve` fixture
  rows; owner CSV includes `ML5-D`.

Docs: `docs/vector-cortex/evidence/ML5-D.md` (this record).

## File sizes and baseline exceptions

- `src/config/vector-cortex-ml5d.ts` (30) — new, under 300 soft limit.
- `src/config/vector-cortex.ts` (300) — held at 300 soft limit.
- `src/config.ts` (203) — additive re-export, under 300 soft limit.
- `src/vector-cortex/improve.ts` (28) — new, under 300 soft limit.
- `src/vector-cortex/ml5d-acceptance.test.ts` (166) — new, under 600 hard limit.
- `extensions/dashboard-server/api-contracts/cortex-improve.ts` (82) — new.
- `extensions/dashboard-server/api-contracts/endpoints/registry-ext.ts` (157) —
  additive, under 400 soft limit.
- `extensions/dashboard-server/api-contracts/index.ts` (337) — additive export,
  under 400 soft limit.
- `extensions/dashboard-server/api-contracts.test/endpoints-registry.test.ts`
  (199) — additive bump, under 600 hard limit.
- `extensions/dashboard-server/routes-cortex-improve.ts` (256) — new, under 400
  soft limit.
- `extensions/dashboard-server/route-dispatch.ts` (162) — additive.
- `extensions/dashboard-server/routes.ts` (68) — additive re-export.
- `extensions/dashboard-server/routes-rag-settings-vector-cortex.ts` (244) —
  additive toggle, under 400 soft limit.
- `extensions/dashboard-client/src/types/cortex-improve.ts` (42) — new.
- `extensions/dashboard-client/src/api/client-extra.ts` (71) — additive, under
  400 client soft limit.
- `extensions/dashboard-client/src/components/ModelImprovementCard.tsx` (141) —
  new, under 400 soft limit.
- `extensions/dashboard-client/src/tabs/VectorCortexTab.tsx` (220) — additive.
- `scripts/ml5/gen-fixtures-ml5d.mjs` (176) — new, under 400 soft limit.
- `scripts/vector-cortex-publish-acceptance.mjs` (343) — additive counter bump,
  under 400 soft limit.

## Fixtures and corpus digests

`conformance/vector-cortex/v2/cortex-improve/` (`ML5-DASH-001..006`, schema
`ml5-fixture.schema.json` extended additively to allow `kind:"cortex-improve"`);
6 new fixture files + the shared schema re-registered, owner `ML5-D` added to
the CSV.

- **ML5-DASH-001** — card render mode A (qualified / promoted): mode A, render
  "promoted", badge "Promoted", endpoint `/api/cortex/improve`.
- **ML5-DASH-002** — card render mode B (demoted/rejected): mode B, render
  "rejected", badge "Rejected", `reason_field:true`.
- **ML5-DASH-003** — flag-off returns 404 and `VectorCortexTab` omits the card
  (`flag_enabled:false`, `endpoints_status:404`, `card_present:false`).
- **ML5-DASH-004** — improve trigger requires confirm and returns a jobId
  (`confirm_required:true`, action `POST /api/cortex/improve`, returns
  `{status:improving, jobId}`).
- **ML5-DASH-005** — status endpoint progress states → terminal
  (`progress_states:["improving","qualified","demoted_to_B"]`; terminal-qualified
  has `verdict:true`; terminal-demoted has `reason:true`).
- **ML5-DASH-006** — mode-badge state-transition pin (mode → improving →
  qualified | demoted_to_B; `badge_transition_pinned:true`).

Corpus after registration: **843 fixtures canonical (843 files)** (the v2 count
across all sprints; ML5-D added 6 fixtures on top of the pre-ML5-D total of 837).
Fixtures carry only aggregate gate envelopes (mode, render, badge, endpoint,
flag/envelope fields) — never raw text or payload content.

## Gate results

| Gate | Command | Result |
| --- | --- | --- |
| Root typecheck | `npx tsc --noEmit -p tsconfig.json` | pass (0 errors) — implementer run |
| Client typecheck | `cd extensions/dashboard-client && npx tsc --noEmit` | pass (0 errors) — implementer run |
| Guardrails | `node scripts/guardrails-scan.mjs` | pi pattern scan clean — implementer run |
| Semantic | `node scripts/semantic-scan.mjs` | SEMANTIC-001 clean — implementer run |
| Conformance | `node scripts/vector-cortex-conformance.mjs --check` | `✓ v2 manifest + 843 fixtures canonical (843 files)` — implementer run |
| Docs-check | `node scripts/vector-cortex-docs-check.mjs` | `✓ 44 sprints / 11 phases` — implementer run |
| Build | `npm run build` | **pending controller attestation** (implementer constrained: no build) |
| ML5-D acceptance | `node --test dist/vector-cortex/ml5d-acceptance.test.js` | **pending controller attestation** (source has 13 tests) |
| ML5-D flag-off | `MEGACOMPACT_ML5_D=0 node --test dist/vector-cortex/ml5d-acceptance.test.js` | **pending controller attestation** (flag-agnostic parity) |
| Full suite | `npm test` | **pending controller attestation** |
| Regression | `python3 scripts/regression_check.py --all --soft-as-hard --soft-as-hard-base <PREV_TAG> --pre-commit` | **pending controller attestation** |
| Diff hygiene | `git diff --check` | **pending controller attestation** |
| Client build | `cd extensions/dashboard-client && npm run build` (vite) | **pending controller attestation** |

The implementer did not run `npm run build`, `npm test`, `python3
regression_check.py`, `git diff --check`, or the client vite build because the
controller's constraints forbid those (root build nukes `dist/`; full-suite and
regression are the controller's attestation act). Both typechecks and both
scans are real implementer-run results. The exact line counts in the "File
sizes" section and the 843-fixture conformance count are real, verified values.

## Unit and acceptance tests

Acceptance aggregator (fixtures-driven, flag-agnostic, **13 tests in source**):

Suite layout in `src/vector-cortex/ml5d-acceptance.test.ts`:
1. Conformance registration (1 test): manifest registers `ML5-DASH-001..006`
   with `algorithm:"cortex-improve"`, `schema:"schemas/ml5-fixture.schema.json"`,
   `expected:"ok"`, path `cortex-improve/<id>.json`; owner CSV includes `ML5-D`.
2. Envelope invariants (6 tests): one per fixture — 001 promoted render, 002
   rejected render, 003 flag-off 404 + card omission, 004 confirm-required +
   jobId, 005 status terminal states, 006 mode-badge transition.
3. Pure improve-harness decision rule (5 tests): `ML5D_ENABLED()` is a live
   boolean; `qualifyDecision(0, digest)` → qualified; `qualifyDecision(0, null)`
   → demoted (empty corpus never fabricates a promotion); non-zero exit → demoted
   regardless of digest. The 4 decision tests gate on `if (!ML5D_ENABLED())
   return;` so the suite is green under both flag states (flag-agnostic).
4. Audit Table-1 stub-8 closure (1 test): `dashboard-snapshot.ts` reads
   `totalTokensSaved: ctx.repo.tokensSaved` and contains no
   `dedupCollapsed * 100` rolled-up math — the audit stub is genuinely closed.

Executed counts (`node --test dist/vector-cortex/ml5d-acceptance.test.js` under
both flag states) require `npm run build` to produce `dist/` and are therefore
**pending controller attestation**. The source-count of 13 is recorded here; the
controller's executed figures supersede it.

## Evaluation

- **No payload leakage (EVAL-REDACT-002):** the endpoints and card surface only
  mode, verdict, asset digest prefix, reason code and progress — never message
  content or corpus rows. The fixtures carry only aggregate gate envelopes.
  Job responses are constructed to surface exactly the contract fields, never
  `JOBS` internals beyond progress.
- **No runtime network (PREVENT-PI-004):** the improve job is spawned locally
  (`python3 training/vector-cortex/train.py` — an in-process child process), and
  status is polled from an in-process `JOBS` map. No `fetch`/HTTP at runtime; the
  dashboard server is the already-audited local-surface exception.
- **Honest degradation:** the pure `qualifyDecision` consents to promotion only
  when the training process exited 0 AND a readable produced-asset digest
  exists. An empty corpus (`assetDigest:null`) or a failed train
  (`exitCode!==0`) is always `demoted_to_B` — the improve job never fabricates a
  promotion.
- **Flag-off byte-identical:** `MEGACOMPACT_ML5_D=0` → `ML5D_ENABLED()` false →
  both improve endpoints return 404/disabled and `VectorCortexTab` omits the
  `ModelImprovementCard` → the tab renders exactly as the ML5-C-era tab. The
  acceptance aggregator is flag-agnostic (decision tests self-gate).

## Failure triad and independence

| Arm | Algorithm | Inputs | Independence argument |
| --- | --- | --- | --- |
| **A — flag on, qualified** | Qualified asset path renders the promoted card; improve job qualifies (`exitCode 0` + digest). | `MEGACOMPACT_ML5_D=1`, mode-A qualified asset (`ML5-DASH-001`). | Only active when the flag is on and the asset qualifies; badge "Promoted". |
| **B — mode B / demoted** | Unqualified asset renders the rejected card; a failed/empty train demotes to B. | `MEGACOMPACT_ML5_D=1`, unqualified asset (`ML5-DASH-002`). | Driven by the demotion path (`reason` surfaced), independent of Arm A's promotion input. |
| **C — flag off** | Both endpoints 404; tab omits the card. | `MEGACOMPACT_ML5_D=0` (`ML5-DASH-003`). | `ML5D_ENABLED()` false; no card, no routes — byte-identical to ML5-C tab. |

The confirm trigger (004), status terminal walk (005), and badge transition
(006) are pinned independently; all three arms use independent inputs. Common
cooldown/spool/restart/clock rules follow the normative
[TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Offline / network / asset / platform evidence

Fully local. The improve job spawns `python3 training/vector-cortex/train.py`
locally and polls an in-process `JOBS` map. The decision rule is a pure function
(`improve.ts`) over `{ exitCode, assetDigest }`. No `fetch`, no HTTP listener
beyond the audited dashboard server. `src/` stays pi-agnostic.

**Host state:** no training corpus is exercised by the acceptance suite — the
decision rule is validated synthetically (`exitCode`/`assetDigest` pairs) with no
real ML5-A training run. The dashboard server route and client card are covered
by the root + client `tsc --noEmit` typechecks; their runtime behavior is the
controller's attestation act.

## Rollback / downgrade rehearsal

`MEGACOMPACT_ML5_D=0` — flag-off. Both improve endpoints return 404/disabled and
`VectorCortexTab` omits the `ModelImprovementCard` — byte-identical to the
ML5-C-era tab, without deleting evidence. The conformance fixtures are additive
(6 new files in a new directory). The schema `kind` enum extension is additive.
The manifest re-registration is idempotent. No schema/state change; no SQLite
migration. The improve job is restart-scoped (in-memory `JOBS`) and non-fatal.

## Known findings / deferred

1. **Executed gate runs deferred to the controller.** `npm run build`, `npm
   test`, `python3 regression_check.py ...`, `git diff --check`, and the client
   `vite build` are the controller's attestation act (implementer constrained not
   to run them). The implementer's negative results (root + client typecheck,
   both scans, conformance 843, docs-check 44/11) are real and recorded above.
2. **`scripts/vector-cortex-docs-check.mjs` not bumped.** See deviation #1 —
   on-disk value is 44 (ratified stale), not the spec's 40; left untouched.
3. **`deriveVcStatus` not injected into improve route responses.** See deviation
   #3 — the strict job-lifecycle discriminated union conflicts with the VC
   derived-status convention.
4. **Reviewer attestation pending.** Status is `implementation-complete`;
   attestation is the controller's act.

## Review checklist (for the reviewer / controller)

- Working tree reviewed as-is; **no commit made** by the implementer (per
  controller direction). Only the intended additions are present: new
  `cortex-improve/` fixture dir, modified schema + manifest, and the 19 source /
  server / client / script files with line counts above.
- All 9 numbered sprint tasks delivered: flag + re-exports + SETTINGS toggle
  (t1); dashboard-snapshot stub-8 verification (t2); api-contracts
  `cortex-improve.ts` + registry entries (t3/t5); `routes-cortex-improve.ts` +
  dispatch + routes wiring (t4/t5); `ModelImprovementCard` + `VectorCortexTab`
  + `client-extra.ts` helpers (t6/t7); generator + fixtures + manifest (t8);
  acceptance aggregator + evidence (t9).
- Implementer gates green: root `tsc --noEmit` 0 errors; client `tsc --noEmit` 0
  errors; guardrails-scan clean; semantic-scan clean; conformance 843 canonical;
  docs-check 44/11; fixture generator idempotent (re-run deterministic).
- Pending controller: `npm run build`; 13-test acceptance (both flag states);
  full suite; regression `--soft-as-hard --pre-commit`; `git diff --check`;
  client `vite build`.
- PREVENT-STUB / PREVENT-001/002/011/024: no `any`; no unguarded `JSON.parse`
  (the fixtures test uses `JSON.parse(...) as Manifest`);
  SQL/network unchanged. Improve surface is local-only.
- `EXPECTED_ENDPOINT_COUNT` bumped 53→55 — the registry test now expects both
  cortex-improve endpoints.
