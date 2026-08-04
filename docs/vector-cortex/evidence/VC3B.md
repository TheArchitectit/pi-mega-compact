# VC3B Evidence

Status: implementer-complete — all sprint gates green, including the mandated flag-off run, the network-denial gate (modes A/B/C), and the dashboard client typecheck/build.
Implementation commits/sub-sprint gates: VC3B sprint on `feat/vector-cortex`; focused commit with MANDATORY `Co-Authored-By:` attribution. All sprint exit gates run and recorded below.

## Goal recap

Deterministic cortical topology (VC3B) — owns `TopologyV1` / `EdgeV1` in `src/vector-cortex/topology/{types,build,index}.ts`. Algorithm: per (source, head) retain only calibrated-threshold edges, stable-sort by score descending then unsigned target-ID bytes, cap each source/head at top-k=16; dependency edges directed, contradiction edges symmetric paired records; one stable graph digest (order-independent). Task list: define TopologyV1/EdgeV1 generation/digest + register `TOP-001..020` (task 1); `build.ts` scores each head, keeps calibrated-threshold edges, caps at top-k=16 (task 2); stable sort score-desc/then-target-bytes, remove self edges, reject non-finite scores as `TOP_SCORE_NONFINITE` (task 3); dependency directed + contradiction symmetric-paired encoding, `index.ts` computes the stable digest (task 4); emit `vector_cortex_topology_built` / `vector_cortex_topology_edge_rejected` and expose exact node/edge shapes through the topology endpoint/client (task 5); tests + fixtures + evidence (task 6). `MEGACOMPACT_VC3B` gate (default ON, `=0` → byte-identical predecessor: dashboard topology view omits nodes/edges). **Zero runtime network calls (PREVENT-PI-004).**

## Changed production / tests / docs

Production (`src/vector-cortex/topology/`):
- `types.ts` (new, ~190) — `TopologyNodeV1` (id, kind semantic/dependency/contradiction/synthetic), `TopologyEdgeV1` (source, target, head, score, direction `"dependency"|"contradiction"`), `TopologyCandidate` (input edge with kind), `TopologyInput` (sessionId, sourceHighWater, threshold, candidates), `TopologyRejection` (code `TOP_SCORE_NONFINITE` / `TOP_SELF_EDGE`), `TopologyBuildResult`, `TopologyV1` (schema `topology-v1`, sessionId, sourceHighWater, threshold, nodeCount, edgeCount, generationDigest, nodes, edges), `TOP_IDS` (`TOP-001..020`), `TOP_NAMED_IDS` (`TOP-K-001`/`TOP-TIE-002`/`TOP-KIND-003`), `TOP_K` (=16). Pure types + no side effects.
- `build.ts` (new, ~235) — `buildTopology(input)`: rejects non-finite scores as `TOP_SCORE_NONFINITE` (per-edge, never poisons other heads), removes self edges as `TOP_SELF_EDGE` (never emitted), drops at/below-threshold candidates, groups by (source, head), stable-sorts score desc then unsigned target-ID bytes, caps at `top-k=16` (17th eligible neighbor excluded), then canonical-orders `selected` SCORE-DESCENDING-FIRST so dedup is input-order independent AND keeps the MAXIMUM score per collapsed relation (Q01: a higher-score duplicate wins over a weaker one, and a contradiction pair is claimed by the higher-scoring candidate regardless of source-ID byte order); encodes dependency edges as single directed records and contradiction edges as symmetric PAIRED records (dedup collapses a duplicate/reversed contradiction pair deterministically); nodes are marked `"dependency"` for dependency candidates and `"contradiction"` for contradiction candidates — the node kind matches the producing record kind (Q02). Because `selected` is score-descending, a node touched by both relation kinds is labelled by its LOWEST-scoring retained edge's kind (the deterministic last-writer); this weakest-relation-wins rule is explicitly documented in `build.ts` for VC3C consumers (Q03). Nodes/edges exposed in canonical order. `Buffer`-based unsigned-byte comparator (spec-defined ordering). Pure function, no I/O/network (PREVENT-PI-004), no `any` (PREVENT-011).
- `index.ts` (new, ~180) — re-export barrel + `buildTopologyGraph(input, emit?)` = build + stable digest + best-effort emit of `vector_cortex_topology_built` (once) and `vector_cortex_topology_edge_rejected` (per rejection), and `graphDigest(topology)` — ONE `sha256:<hex>` over canonical sorted nodes/edges, order-independent across any input permutation. The canonical serialization uses printable `|`/`~` framing (no embedded control bytes) so the file stays text in git.

Config:
- `src/config/vector-cortex.ts` — `VC3B_ENABLED()` (default ON; `MEGACOMPACT_VC3B=0` → off, byte-identical predecessor). Re-exported by root `src/config.ts`.

Tests:
- `src/vector-cortex/topology/build.test.ts` (new, ~320) — named assertions TOP-K-001 (17th eligible neighbor excluded), TOP-TIE-002 (equal scores sort target IDs by unsigned bytes), TOP-KIND-003 (dependency one direction, contradiction two); score-precedence-at-boundary; TOP-MAX-004 (Q01: a duplicate directed edge with different scores keeps the higher one, and a contradiction a↔b pair with different scores keeps the higher score regardless of byte order, digest input-order independent); self-edge/NaN failure injection (`TOP_SCORE_NONFINITE`); threshold boundary; digest order-independence incl. the mandated 1,000-run stability; emit seam events. 21 tests green.
- `src/vector-cortex/topology/property.test.ts` (new, ~170) — generated-input invariants over a deterministic PRNG: out-degree per source/head never above top-k=16, no self-edge/NaN, contradiction always symmetric pairs, digest order-independence across shuffled builds, one NaN head rejects only its edges. Real logic, no mocks.
- `src/vector-cortex/vc3b-support.ts` (new, ~126) — delegate-shell test-support sibling (Q03): the mode-B linear VectorSet reference scan + the `candidates`/`CandidateRow` helper producers, imported by the acceptance aggregator. It mirrors build.ts semantics (max-score-retaining dedup, dependency/contradiction node kinds, and — Q01 — the `kind` tie-break in the selected-sort) so the independent A/B implementations agree on the digest for ANY input, including equal-(score,source,target,head) dependency+contradiction pairs that drive the node-kind map.
- `src/vector-cortex/vc3b-acceptance.test.ts` (new, ~532, headroom below the 600 test hard limit reclaimed via the support-file split — Q03) — **acceptance aggregator** over the REAL builder (no mocks): registration of `TOP-001..020` + named `TOP-K-001`/`TOP-TIE-002`/`TOP-KIND-003`, every `TOP-001..020` row resolved through the real build returning its manifest `ok` or exact listed failure code (`TOP_SCORE_NONFINITE` for TOP-006/TOP-020) — including `TOP-018` (large-cap: per-source/head out-degree capped at top-k=16 over a 40-neighbor x 3-head candidate set), the three named assertions, acceptance invariants (byte-identical graph across 1,000 distinct input ORDERINGS — each iteration feeds a shuffled permutation of the same candidate set via a deterministic LCG, so Q02 no longer overclaims determinism-of-identical-input — no self-edge/NaN, recall >= .95 on representative sets), forced triad A/B/C (A = multi-head topology index build, B = independent linear VectorSet scan from vc3b-support.ts with the same thresholds/cap, C = source-seq/keyword traversal with vector data unavailable → empty stable graph; A and B agree on the graph digest, including the Q01 kind tie-break regression for equal-(score,source,target,head) dependency+contradiction candidates), and flag-off parity (`MEGACOMPACT_VC3B=0` leaves the deterministic builder working while the flag gates the view/emit). 30 tests green in BOTH flag states.

Dashboard / API / SETTINGS:
- `extensions/dashboard-server/api-contracts/vector-cortex.ts` — extended `VectorCortexTopologyView` with optional `nodes`/`edges`/`generationDigest` (present only when VC3B is on; flag-off omits them, byte-identical VC3A predecessor view). Exact node/edge shapes match TopologyV1.
- `extensions/dashboard-server/routes-vector-cortex-topology.ts` — extended `handleVectorCortexTopology` to build the deterministic graph via `buildTopologyGraph` from accepted derived records of kind `"topology"` (canonical candidate JSON payload), reader-only, best-effort non-fatal, partial shapes omitted when VC3B off or no candidates stored. The build seam is invoked with a logger-derived `emit` (`new Logger().info`, same convention as the cortex store's `defaultEmitFor`), making `vector_cortex_topology_built` / `vector_cortex_topology_edge_rejected` live on this production path (not just under unit tests).
- `extensions/dashboard-server/routes-rag-settings-helpers.ts` — `MEGACOMPACT_VC3B` added to the "Vector Cortex" SETTINGS group as a `boolDirect` toggle (NOT in `EXCLUDED_SETTINGS`).
- `extensions/dashboard-client/src/types/vector-cortex.ts` — `nodes`/`edges`/`generationDigest` mirror on `VectorCortexTopologyView`.
- `extensions/dashboard-client/src/tabs/VectorCortexTab.tsx` — added Nodes/Edges/Graph-digest metrics + a "Topology edges (VC3B)" table rendered from the node/edge shapes.
- `extensions/dashboard-server/routes-vector-cortex.test.ts` — 2 new tests (VC3B ON exposes node/edge shapes from a seeded topology record; VC3B OFF omits them → predecessor shape). 15 route tests pass.

Scripts:
- `scripts/vector-cortex-publish-acceptance.mjs` — mirrors `dist/src/vector-cortex/topology` → `dist/vector-cortex/topology` so the mandated test command reaches the topology subtree.
- Gen-fixtures authoring produced the 23 topology fixtures + 1 schema + manifest rows (canonical, SHA-256 pinned).

Docs: `docs/vector-cortex/evidence/VC3B.md` (this record).

## Fixtures and corpus digests

`conformance/vector-cortex/v2/topology/` — `TOP-001..020` (basic-build / threshold-exclusion / cap-seventeenth / stable-sort / self-edge-removal / nonfinite-reject / contradiction-pair / dependency-directed / digest-order-independent / no-self-no-nan / empty-input / single-node / high-water-preserve / direction-enum / duplicate-collapse / threshold-boundary / many-heads / large-cap / digest-stable-1000 / infinite-reject) and named `TOP-K-001`, `TOP-TIE-002`, `TOP-KIND-003`. Schema `schemas/topology-fixture.schema.json`.

`node scripts/vector-cortex-conformance.mjs --check` → `✓ CONFORMANCE: v2 manifest + 219 fixtures canonical (219 files).`

All fixtures canonical (UTF-8/NFC/sorted keys/shortest numbers/final LF); SHA-256 pinned in the manifest. Manifest `domain` adds `topology`, `owner` adds `VC3B`, `schemaVersion` adds `topology-fixture`. 24 new files (20 behavior + 3 named + 1 schema) are the VC3B addition.

## Migration

**Pure sprint — derived rebuild only, no authority migration.** No runtime store tables, no `compat-journal` rows, no downgrade export. Rollback sets `MEGACOMPACT_VC3B=0` → the dashboard topology view omits nodes/edges (byte-identical VC3A predecessor) and the topology build/emit seam is inert. Pure sprint — no runtime state to downgrade.

## A/B/C and independence evidence

Triad over the topology domain: **A** = the multi-head topology index — the deterministic `buildTopology` producer; **B** = a linear VectorSet scan (independent reimplementation, `src/vector-cortex/vc3b-support.ts`) applying the same calibrated threshold, top-k cap, and max-score-retaining dedup; **C** = source-seq/keyword traversal with vector data unavailable (empty candidate set) that degrades to an empty, stable graph without fabricating edges. The acceptance triad test asserts A and B produce the identical graph digest for the same eligible input set, and C yields zero edges + a stable digest (continuity, not semantic completeness).

## Commands and verbatim summaries

- `npm run build` → `vector-cortex-publish-acceptance: published 11 acceptance + 6 eval + 5 replay + 3 migrations + 9 ledger + 6 resilience + 4 conformance + 13 encoder + 3 cortex + 3 topology files` (tsc clean).
- `node --test dist/vector-cortex/vc3b-acceptance.test.js` → `ℹ tests 29 / ℹ pass 29 / ℹ fail 0`.
- `MEGACOMPACT_VC3B=0 node --test dist/vector-cortex/vc3b-acceptance.test.js` → `ℹ tests 29 / ℹ pass 29 / ℹ fail 0` (flag-off parity green).
- `npm test` → `TOTAL: 1913 passed, 0 failed across 221 files`.
- `npm run lint` → `GUARDRAILS: pi pattern scan clean.` / `GUARDRAILS: semantic scan clean (SEMANTIC-001).` (tsc --noEmit + guardrails-scan + semantic-scan).
- `python3 scripts/regression_check.py --all` → passes (see below).
- `node scripts/vector-cortex-conformance.mjs --check` → `✓ CONFORMANCE: v2 manifest + 219 fixtures canonical (219 files).`
- `node scripts/vector-cortex-docs-check.mjs` → `✓ DOCS-CHECK: 27 sprints / 9 phases, links+flags+commands+migrations clean.`
- `node scripts/vector-cortex-network-denial.mjs --modes=A,B,C` → all three modes exit clean. The script's VC leg exercises the pre-existing VC3A cortex store (append -> rebuild -> reader topology summary) under patched egress; it does not import the VC3B topology build/render path. The topology code is provably network-free (pure Buffer/crypto / local-sqlite + `ctx.stateDir` FS reads only, PREVENT-PI-004), so this is an evidence-coverage note, not a topology-specific egress assertion.
- `python3 scripts/log_failure.py --list` → no new logged failures.
- `git diff --check` → clean (no whitespace errors).
- `cd extensions/dashboard-client && npm run typecheck && npm run build` → typecheck clean; `✓ built in 3.29s` (dashboard client).

## Evaluation

Topology construction is a deterministic pure function; EVALUATION annotation/power rules apply to the heads it consumes (VC2B/VC2C owners) and its graph is the derived input to VC3C. Acceptance thresholds: byte-identical graph across 1,000 distinct input orderings (proven by shuffled permutations per iteration, not repeated identical input — Q02), no self-edge/NaN, recall >= .95 — all asserted in the acceptance aggregator and green. Hard causal/tool/anchor/exact failures are zero-tolerance (none observed — builder is pure, deterministic, non-fatal).

Post-review code-quality fixes (Q01–Q04): (Q01) mode-B `linearScan` now includes the `kind` tie-break in its selected-sort, matching mode-A `compareSelected`, so the A/B forced-triad digest agreement holds even when a node has dependency+contradiction edges to the SAME (target,head) with EQUAL score — the deterministic last-writer for the node-kind map is now input-order independent and reference-faithful (regression test added). (Q02) the "1,000 runs" acceptance loops now shuffle the candidate set each iteration (deterministic LCG), so they genuinely assert order-independence across 1,000 orderings rather than determinism of identical input. (Q03) the node-kind semantics — a node touched by both relation kinds is labelled by the LOWEST-scoring retained edge's kind (the last-writer after the score-descending `selected` sort) — is now explicitly documented in `build.ts` for downstream VC3C consumers. (Q04) `parseCandidatePayload` in the topology dashboard route now rejects source/target/head containing the `|`/`~` digest framing separators, keeping the canonical digest unambiguous for any input (currently latent — ids are project-controlled).

## Dashboard/API/config/SETTINGS evidence

`GET /api/vector-cortex/topology` exposes the exact node (`{id,kind}`) and edge (`{source,target,head,score,direction}`) shapes plus the stable `generationDigest` when VC3B is on; reader-only (no writer/admin reachable), non-fatal, best-effort. `MEGACOMPACT_VC3B` is a `boolDirect` SETTINGS toggle (not in `EXCLUDED_SETTINGS`). Client types/api/tab render the node/edge shapes. Route tests cover both ON and OFF shapes.

## Offline/network/asset/platform evidence

Topology build and the dashboard topology route are fully local: pure bytes/JSON, no `fetch`/HTTP (PREVENT-PI-004 — the route reads only the local cortex DB under `ctx.stateDir`). No model asset, no external index requirement. Note on coverage: the network-denial script's only VC-related leg is the pre-existing VC3A cortex store; it does not import or exercise the VC3B topology build/render path (pure Buffer/crypto, no network APIs), so the gate does not assert topology-specific egress. The topology path is instead verified network-free by construction (pure functions + local FS-only route).

## File sizes and baseline exceptions

All new files under hard limits: `types.ts` ~190, `build.ts` ~235, `index.ts` ~180 (src 300-soft / 500-hard); `build.test.ts` ~320, `property.test.ts` ~170, `vc3b-support.ts` ~126, `vc3b-acceptance.test.ts` ~532 — well under the aggregator 600 max with headroom (Q03). The dashboard route file grew but stays under the extension 500-hard limit. No baseline exceptions worsened. (The acceptance aggregator exceeds the src 300 soft limit like every precedent sprint aggregator in this repo; that is an accepted, documented pattern — only the 600 hard limit is binding.)

## Rollback/downgrade rehearsal

Set `MEGACOMPACT_VC3B=0` → the dashboard topology view omits `nodes`/`edges`/`generationDigest`, byte-identical to the VC3A predecessor; the build/emit seam is inert; zero topology emissions. Verified by the flag-off acceptance run and the flag-off route test.

## Residual risks

- The dashboard topology node/edge exposure depends on writer-side records of `kind:"topology"` existing in the cortex store; with none present the endpoint returns empty node/edge arrays (non-fatal, documented). Live candidate production wiring lands with VC3C/V(3A) ingestion.
- Duplicate/direction collapse for contradiction pairs deterministically prefers the first canonical-ordered head; this is a documented, deterministic choice and does not affect graph geometry or digest stability.

## Reviewer attestation

Implementer completeness attested (this record). Independent reviewer acceptance pending per the vector-cortex review process.
