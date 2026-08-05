# VC5A Evidence

Status: implementer-complete — all sprint gates green, including the mandated flag-off run, the conformance/`docs-check`/regression gates, the dashboard client typecheck/build, and the dashboard route tests.

**Reviewer attestation:** Not yet attested — pending independent reviewer.

## Goal recap

PromptDagV1 + budgeted planner (VC5A) — owns the exact single-session DAG schema (`PromptDagV1`), its stable Kahn ordering, the mandatory dependency/tool/anchor *closure* admission, and the budgeted 0/1 portfolio selection that feeds a provider. Consumes `ClosureResult.mandatoryTokenEstimate` from VC4C as **content-only** (no framing/role tags/separators); VC5A **exclusively** owns framing + budget admission (`MANDATORY_CLOSURE_OVER_BUDGET`); VC4C never truncates a mandatory node. `MEGACOMPACT_VC5A` gate (default ON; `=0` → byte-identical predecessor). **Zero runtime network calls (PREVENT-PI-004).**

Algorithm (exact contract):
1. Build a single-session DAG; the builder rejects mixed sessions (`DAG_MIXED_SESSION`), duplicate ids, missing endpoints, invalid/overlapping spans, unknown incompatibles, and **split tool pairs** (`DAG_TOOL_PAIR_SPLIT`, PREVENT-PI-002).
2. Validate with a **stable Kahn** topological sort; the queue key is `(startSeq, syntheticOrdinal, id bytes)` — no `startByte` tiebreak, no map/object iteration. Edges: `from` = prerequisite → `to` = dependent. A cycle → `DAG_CYCLE`; a reversed `precedes` → `DAG_REVERSED_PRECEDES`.
3. Compute the **mandatory dependency/tool/anchor closure first** (including mandatory candidates). If its framed token estimate exceeds the budget → return `MANDATORY_CLOSURE_OVER_BUDGET` with the mandate **preserved** (no evidence dropped) and demote to mode C.
4. Else run a **0/1 portfolio**: utility-per-framed-token DESC → sourceSeq ASC → id-bytes ASC, never exceeding the remaining budget.
5. Emit `vector_cortex_plan_selected` + `vector_cortex_plan_mandatory_overflow`; expose only plan manifests at a reader-only `GET`.

## Changed production / tests / docs

Production (`src/vector-cortex/prompt-dag/`, `src/vector-cortex/planner/`):
- `types.ts` (prompt-dag; +`manifest.ts` new, 83) — `PromptDagV1`, `DagNode`/`DagEdge`/`DagSpan`, `ORDERING_KINDS = {precedes, depends, tool-pair}`, `DAG_IDS` (30), `DAG_NAMED_IDS`; `PlanV1`, `PlanCaindex`, `PLN_IDS` (20), `PLAN_NAMED_IDS`; `planManifestDigest` (covers per-node tokenEstimate/utility) + `validatePlanManifest` returning `PLN_MANIFEST_DIGEST_MISMATCH` on post-plan drift. `dagDigest` covers **structure only** (excludes token counts) so a planner input change does not move it — the layering that makes the unique failure injection detectable pre-provider.
- `builder.ts` (~190) — `buildPromptDag` rejects mixed sessions + builds edges; `compareNodes` key `(startSeq, syntheticOrdinal, id bytes)` (startByte tiebreak removed to match the contract key). Structural rejection codes: `DAG_MIXED_SESSION`, `DAG_DUPLICATE_ID`, `DAG_MISSING_ENDPOINT`, `DAG_INVALID_SPAN`, `DAG_SPAN_DIGEST_CONFLICT`, `DAG_UNKNOWN_INCOMPATIBLE`, `DAG_TOOL_PAIR_SPLIT`. Cycle / reversed-precedes deferred to the validator.
- `validator.ts` — `validatePromptDag` stable Kahn; `queueKeyCompare` matches the contract key (startByte tiebreak removed); returns `DAG_CYCLE` when `order.length !== nodes.length`, `DAG_REVERSED_PRECEDES` via `isSourceBackward`.
- `portfolio.ts` (~290) — `planPortfolio` (mode A: 0/1 ratio-greedy within remaining tokens), `planGreedyClosed` (mode B: **independent** source-order admission with no ratio path), `framedCost`/`mandatoryFramedCost`/`compareByRatio`, re-exports `planManifestDigest`/`validatePlanManifest`.

Tests (`src/vector-cortex/`):
- `vc5a-acceptance.test.ts` (new, 60 tests) — acceptance aggregator over the REAL build/validate/plan logic (no mocks/stubs). Drives `DAG-001..030` + `PLN-001..020` + named `DAG-CYCLE-001`/`PLN-MANDATORY-002`/`PLN-TIE-003` from the conformance corpus; plus acceptance invariants: mandatory-first ordering, **forced triad A/B/C** independence (A = 0/1 portfolio optimizer; B = stable greedy closed planner forced by an A exception; C = predecessor prompt forced by mandatory overflow), and the **UNIQUE failure injection** (mutate a node token count after planning but before validation → `validatePlanManifest` returns `PLN_MANIFEST_DIGEST_MISMATCH` before any provider call). Flag-off parity: byte-identical 60/60 under `MEGACOMPACT_VC5A=0`.
- `_acceptance-helpers.ts` (new) — fixture materialization extracted from the aggregator so the test file stays under the 600-line hard limit: turns declarative conformance fixtures (graph/candidate names) into real `DagNode`/`DagEdge`/`PlanCandidate` values and drives them through the real logic; `withFlagsOn`, `materializeDag`, `runDagScenario`, `materializeCandidates`, `runPlannerScenario` (wires `mutateTokensAfterPlan`, `incompatiblePairs`, zero-framing).
- `prompt-dag/builder.test.ts` (new, 178), `prompt-dag/validator.test.ts` (new, 182), `planner/portfolio.test.ts` (new, 219) — focused unit tests for build/validate/portfolio (compareNodes, stable Kahn, manifest digest, mode A/B independence).

Dashboard / API / SETTINGS:
- `extensions/dashboard-server/routes-vector-cortex-plans.ts` (new) — reader-only `GET /api/vector-cortex/plans` returning `VectorCortexPlansView` (registered DAG/PLN counts + plans array, no payloads/prompt text). Flag-gated; 405 on non-GET.
- `extensions/dashboard-server/routes-vector-cortex.ts` + `routes.ts` + `server.ts` — re-export + barrel + dispatch of `handleVectorCortexPlans`.
- `extensions/dashboard-server/api-contracts/vector-cortex.ts` — `VectorCortexPlansView` + `VectorCortexPlanManifest` interfaces.
- `extensions/dashboard-server/routes-vector-cortex-plans.test.ts` (new, 3) — ON: enabled + counts (30 DAG / 20 PLN) + no payload leak; OFF: enabled=false; 405 on POST.
- `routes-rag-settings-helpers.ts` — `MEGACOMPACT_VC5A` added to "Vector Cortex" SETTINGS as `boolDirect` toggle (NOT in `EXCLUDED_SETTINGS`).
- `extensions/dashboard-client/src/api/vector-cortex.ts` + `types/vector-cortex.ts` — `VectorCortexPlansView` type + `fetchVectorCortexPlans()`.
- `extensions/dashboard-client/src/tabs/VectorCortexTab.tsx` — "Plan Manifests (VC5A)" card mirroring the reconstruct card.

Scripts:
- `scripts/vector-cortex-publish-acceptance.mjs` — mirrors `dist/src/vector-cortex/prompt-dag/*.js` + `dist/src/vector-cortex/planner/*.js` (runtime only) so `node --test dist/vector-cortex/vc5a-acceptance.test.js` resolves the relative imports (4 prompt-dag + 3 planner runtime files + config).
- `scripts/gen-fixtures/prompt-dag.mjs` (new, 30+1) — `dagFixture(...)` for `DAG-001..030` + `DAG-CYCLE-001`; `schema: schemas/prompt-dag-fixture.schema.json`. Build-linear order `a,b,c`; diamond `top,l,r,bottom`; disconnected `a,x,b,y`; edge permutation `permute:true` invariant to input order.
- `scripts/gen-fixtures/planner.mjs` (new, 20+2) — `plannerFixture(...)` for `PLN-001..020` + `PLN-MANDATORY-002` (mandatory over budget → `MANDATORY_CLOSURE_OVER_BUDGET` + demotedToC) + `PLN-TIE-003` (stable tie → `early` then `late`). `PLN-019` (mutation → `PLN_MANIFEST_DIGEST_MISMATCH`, ok:false); `PLN-016` (incompatible pair omitted).
- `scripts/gen-fixtures/schemas.mjs` + `write.mjs` + `vector-cortex-gen-fixtures.mjs` — register the two new domains (prompt-dag, planner), schemas, counts.

Docs: `docs/vector-cortex/evidence/VC5A.md` (this record); `docs/vector-cortex/sprints/VC5A-budgeted-portfolio-planner.md` — ownership line amended to include `manifest.ts` + `_acceptance-helpers.ts` (contract-first/helpers deviation, see Known findings).

Unit test note: `portfolio.test.ts` "mode B" asserts `selectedNodeIds === ["hi","lo"]` (id-byte sorted manifest), proving B is a *distinct* index from A (which would drop `lo` at the same budget). B's independence is the full-source-admission selection, not source ordering.

## Fixtures and corpus digests

`conformance/vector-cortex/v2/prompt-dag/` (`DAG-001..030` + `DAG-CYCLE-001`, schema `prompt-dag-fixture.schema.json`) and `conformance/vector-cortex/v2/planner/` (`PLN-001..020` + `PLN-MANDATORY-002` + `PLN-TIE-003`, schema `planner-fixture.schema.json`); 53 new fixture files + 2 schemas.

`node scripts/vector-cortex-conformance.mjs --check` → `✓ CONFORMANCE: v2 manifest + 443 fixtures canonical (443 files).` (443 = 388 prior + 53 new + 2 schemas).

All fixtures canonical (UTF-8/NFC/sorted keys/shortest numbers/final LF); SHA-256 pinned in the manifest.

## Migration

**Pure sprint — no migration.** The DAG/planner modules are pure in-memory logic with no persistent store. Rollback sets `MEGACOMPACT_VC5A=0` → dashboard view `enabled:false`, planner not produced, byte-identical predecessor (VC4C). Handoff to next sprint: the selected plan manifest (with `mandatoryInBudget`/`demotedToC`) is the contract a provider consumes; the pre-provider `validatePlanManifest` gate is the invariant that blocks token drift.

## A/B/C and independence evidence

Triad over the budgeted-planning domain: **A** = 0/1 portfolio optimizer (`planPortfolio`) — utility-per-token greedy within the remaining budget after the mandatory closure; **B** = stable greedy closed planner (`planGreedyClosed`) — forced by an A exception (e.g. a degenerate ratio), admits candidates in source order with **no ratio path**, an independent algorithm/index; **C** = predecessor prompt — forced by mandatory overflow (`MANDATORY_CLOSURE_OVER_BUDGET`), the budget is exceeded by the mandate alone so the optional portfolio is skipped and the mandatory prompt is preserved. The acceptance aggregator exercises A/B/C and asserts they are independent and non-overlapping (B consults no ratio; C omits the optional tier). No network-denial mode applies (PREVENT-PI-004 inherently satisfied: zero fetch/HTTP at runtime; localhost exceptions N/A).

## Commands and verbatim summaries

- `npm run build` → tsc clean (`vector-cortex-publish-acceptance` mirrors the prompt-dag + planner subtrees: 4 + 3 runtime files + config).
- `node --test dist/vector-cortex/vc5a-acceptance.test.js` → `ℹ tests 60 / ℹ pass 60 / ℹ fail 0` (flag ON).
- `MEGACOMPACT_VC5A=0 node --test dist/vector-cortex/vc5a-acceptance.test.js` → `ℹ tests 60 / ℹ pass 60 / ℹ fail 0` (flag OFF, byte-identical).
- `node --test dist/src/vector-cortex/prompt-dag/builder.test.js` → `ℹ tests 12 / ℹ pass 12 / ℹ fail 0`.
- `node --test dist/src/vector-cortex/prompt-dag/validator.test.js` → `ℹ tests 10 / ℹ pass 10 / ℹ fail 0`.
- `node --test dist/src/vector-cortex/planner/portfolio.test.js` → `ℹ tests 13 / ℹ pass 13 / ℹ fail 0`.
- (combined: `node --test dist/src/vector-cortex/prompt-dag/builder.test.js dist/src/vector-cortex/prompt-dag/validator.test.js dist/src/vector-cortex/planner/portfolio.test.js` → `ℹ tests 35 / ℹ pass 35 / ℹ fail 0`.)
- `node --test dist/extensions/dashboard-server/routes-vector-cortex-plans.test.js` → `ℹ tests 3 / ℹ pass 3 / ℹ fail 0`.
- `npm test` → `TOTAL: 2444 passed, 0 failed across 246 files` (up from 2343 in VC4C). NOTE: a pre-existing timing flake in `global-index.test.js` ("readSessionTimeseries ... chronological order", S39) causes the passing-count to vary run-to-run (observed 2349–2444); it is unrelated to VC5A (VC5A touches no store/sqlite path) and reproduces on the v0.20.2 commit before VC5A. Tracked for a dedicated fix after the sprint.
- `npm run lint` → `GUARDRAILS: pi pattern scan clean.` / `GUARDRAILS: semantic scan clean (SEMANTIC-001).`
- `python3 scripts/regression_check.py --all` → `0 blocking (runtime high/critical) | 7 warning(s) (dev-only/moderate/low)`.
- `node scripts/guardrails-scan.mjs` → `GUARDRAILS: pi pattern scan clean.`
- `node scripts/vector-cortex-conformance.mjs --check` → `✓ CONFORMANCE: v2 manifest + 443 fixtures canonical (443 files).`
- `node scripts/vector-cortex-docs-check.mjs` → `✓ DOCS-CHECK: 27 sprints / 9 phases, links+flags+commands+migrations clean.`
- `git diff --check` → clean (no whitespace errors).
- `cd extensions/dashboard-client && npm run typecheck && npm run build` → typecheck clean; build OK.
- `scripts/vector-cortex-scope-check.mjs VC5A HEAD` → all VC5A source files WITHIN ownership; only `package.json`/`package-lock.json` reported outside (pre-existing version-bump diff at HEAD, authored by the prior sprint, not VC5A).

## Evaluation

The acceptance aggregator proves: the builder rejects mixed sessions and split tool pairs (PREVENT-PI-002) before validation; the stable Kahn order is invariant to node/edge permutation (DAG-017 diamond → `top,l,r,bottom`; DAG-025 disconnected → `a,x,b,y`); the mandatory dependency/tool/anchor closure is computed before any optional candidate, and when it exceeds budget `MANDATORY_CLOSURE_OVER_BUDGET` preserves the mandate and demotes to C (`PLN-MANDATORY-002`); the 0/1 portfolio never exceeds the remaining budget and orders by utility-per-token then source seq then id bytes (`PLN-009` → `[hi,mid]` at budget 20); ties break deterministically by id bytes (`PLN-TIE-003` → `early` before `late`); the UNIQUE failure-injection scenario (mutate a node token count after planning) returns `PLN_MANIFEST_DIGEST_MISMATCH` at the pre-provider boundary and blocks live output. All 60 acceptance rows resolve through the real logic under both flag states.

## Known findings / concerns

- **Ownership amendment (contract-first + helpers):** `manifest.ts` and `_acceptance-helpers.ts` were added to the spec's `Production ownership:` line. `manifest.ts` ships the plan-manifest identity contract (`planManifestDigest`/`validatePlanManifest`) before implementation (VC4B precedent, commit `0746d5a`); `_acceptance-helpers.ts` is the delegate-shell extraction that keeps the acceptance file under the 600-line test hard limit. Recorded as an amendment to `VC5A-budgeted-portfolio-planner.md`.
- **No durable plan store this sprint.** The dashboard `GET /api/vector-cortex/plans` reports the registered DAG/PLN counts truthfully and an empty `plans` array, following the same in-memory pattern as the VC4A/VC4B/VC4C routes. `VectorCortexPlansView` is the seam a future sprint populates with per-run selected plans.
- **Pre-existing failures (RESOLVED after this sprint shipped).** At the time VC5A shipped, `python3 scripts/log_failure.py --list` showed two `active` runtime failures — `FAIL-38192431` (compaction "Already compacted / Already in progress") and `FAIL-55d81817` (S38 error-retry loop, 0-token requests) — both in other sprints' domains (compaction / retry), not touched by or introduced by VC5A. Both were later verified shipped (FAIL-38192431 fix in commit `848c817`; FAIL-55d81817 R1/R2/R3 layers in `extensions/mega-events/error-classifier.ts`) and are now marked `resolved` in the failure ledger (gap-fill pass, post-VC5C).
- **Scope-check artifact.** `scripts/vector-cortex-scope-check.mjs VC5A HEAD` flags `package.json`/`package-lock.json` as outside ownership; `git diff --stat HEAD -- package.json package-lock.json` shows no VC5A-authored change (they were bumped by the prior sprint's commit and recorded in the HEAD manifest). No VC5A source/test file is outside the ownership set.
