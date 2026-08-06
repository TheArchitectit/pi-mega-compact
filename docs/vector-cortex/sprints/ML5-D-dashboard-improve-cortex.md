# ML5-D — Dashboard "Improve Cortex" surface + promote workflow

**Status:** planned | **Depends on:** ML5-C | **Phase:** ML5
**Flag:** `MEGACOMPACT_ML5_D`, defined in `src/config/vector-cortex-ml5d.ts` (sibling extract), re-exported by `vector-cortex.ts` + root `src/config.ts`, default ON; `MEGACOMPACT_ML5_D=0` disables and must be byte-identical to the ML5-C survivor (no `ModelImprovementCard` — `VectorCortexTab` renders exactly as before — and the `/api/cortex/improve*` endpoints return 404/disabled). Registered in `VECTOR_CORTEX_SETTINGS` as a visible boolDirect toggle, never in `EXCLUDED_SETTINGS`.

## Goal and inputs/outputs

The user-facing close of the ML5 loop: the Vector Cortex tab already has a health card; this sprint adds a **"Model Improvement"** sub-panel with a single **"Improve"** button. One click runs the training pipeline locally (ML5-A) against the latest local corpus, re-qualifies the five heads, and surfaces the Promoted/Rejected verdict on the dashboard. It also **closes the audit's Table 1 stub 8** — the dashboard-snapshot placeholder at `extensions/mega-runtime/dashboard-snapshot.ts:163` — feeding `totalTokensSaved` from the real `ctx.repo.tokensSaved` counter already in place (not the rolled-up `(dedupCollapsed * 100)` math).

The panel **reads**: `encoderAssetDigest`, `encoderMode`, the current `QualificationV1` verdict, the bench history (the 5 most recent `ML5-BENCH-*` events from `events.log`), the "Improve Cortex" action endpoint, and the last promotion timestamp.

Two additive endpoints:

- `POST /api/cortex/improve` — **local-only**, requires a `window.confirm` modal (server-side confirmation required, not client-only). Runs the training pipeline (ML5-A) using the latest local corpus as a background job. Returns `{ status:"improving", jobId }`. The `onnxruntime-web` WASM footprint is budget-safe, so "Improve" never needs a native install — it works on any device with `pi` + WASM runtime; the `onnxruntime-node` path is attempted only when `MEGACOMPACT_ENCODER_NATIVE=1` (default OFF).
- `GET /api/cortex/improve/status/:jobId` — pollable. Returns `{ status, progress, verdict?, assetDigest? }` and terminates in `{ status:"qualified", verdict, assetDigest }` or `{ status:"demoted_to_B", reason }`.

**Outputs**: a new `ModelImprovementCard` in `VectorCortexTab` showing current mode, last bench run, latest qualification verdict, and the Promoted/Rejected badge.

Production ownership: `extensions/dashboard-server/routes-cortex-improve.ts (new — POST /api/cortex/improve + GET /api/cortex/improve/status/:jobId, server-side window.confirm-equivalent guard); extensions/dashboard-server/api-contracts/cortex-improve.ts (new — CortexImproveJob contract); extensions/dashboard-client/src/components/ModelImprovementCard.tsx (new — card with mode, last bench, verdict, badge); extensions/dashboard-client/src/tabs/VectorCortexTab.tsx (additive — ModelImprovementCard section below the health card); extensions/dashboard-server/route-dispatch.ts (additive if-chain entry); extensions/dashboard-server/api-contracts/endpoints/registry.ts (additive — cortex-improve entries, EXPECTED_ENDPOINT_COUNT bump); extensions/dashboard-client/src/api/client-http.ts / client-extra.ts (additive — the improve/status fetch helpers, keeping client.ts under the 400 soft limit, PC-C precedent); src/config/vector-cortex-ml5d.ts (new); conformance/vector-cortex/v2/cortex-improve/ (fixtures ML5-DASH-001..006); scripts/ml5/gen-fixtures-ml5d.mjs (new generator); scripts/vector-cortex-docs-check.mjs (EXPECTED_SPRINTS 39→40); docs/vector-cortex/evidence/ML5-D.md (new); extensions/mega-runtime/dashboard-snapshot.ts (stub-8 closure — totalTokensSaved already feeds from ctx.repo.tokensSaved; verify no rolled-up math remains in the snapshot path)`.

## Numbered implementation tasks

1. Add the `MEGACOMPACT_ML5_D` flag (default ON, `=0` byte-identical) in `src/config/vector-cortex-ml5d.ts` + the `vector-cortex.ts`/`src/config.ts` re-exports, and the `VECTOR_CORTEX_SETTINGS` boolDirect toggle in `routes-rag-settings-vector-cortex.ts` (additive, stays ≤ 300). `vector-cortex.ts` stays ≤ 300. `=0` = no Improve card + endpoints 404.
2. Create `extensions/mega-runtime/dashboard-snapshot.ts` stub-8 verification: confirm `totalTokensSaved` feeds from `ctx.repo.tokensSaved` (the real counter) and no `dedupCollapsed * 100`-style rolled-up math remains in the snapshot path. Any incursion is a comment-level fix only, not new math.
3. Create `extensions/dashboard-server/api-contracts/cortex-improve.ts`: `CortexImproveStart { status:"improving", jobId }; CortexImproveStatus { status:StringEnum<"improving"|"qualified"|"demoted_to_B">, progress:number, verdict?:QualificationV1, assetDigest?:string, reason?:string }`.
4. Create `extensions/dashboard-server/routes-cortex-improve.ts`: `POST /api/cortex/improve` (requires a server-side confirm guard the client mirrors with `window.confirm`; launches ML5-A training on the latest local corpus as a background job → `{ status:"improving", jobId }`) and `GET /api/cortex/improve/status/:jobId` (pollable progress; terminal `qualified`/`demoted_to_B`). Flag-off → 404. LOCAL ONLY (PREVENT-PI-004).
5. Register both endpoints in `route-dispatch.ts`, `routes.ts`, and `api-contracts/endpoints/registry.ts` (EXPECTED_ENDPOINT_COUNT bump: 2 new endpoints).
6. Create `extensions/dashboard-client/src/components/ModelImprovementCard.tsx`: mode, last bench run (5 most recent `ML5-BENCH-*` events), verdict, Promoted/Rejected badge, Improve button with `window.confirm`. Follows the health-card pattern in `VectorCortexTab`.
7. Patch `extensions/dashboard-client/src/tabs/VectorCortexTab.tsx` additively: add the `ModelImprovementCard` below the existing health card. Add the improve/status fetch helpers to `api/client.ts` via the `client-http.ts`/`client-extra.ts` delegate-split siblings (client.ts stays < 400 soft limit).
8. Add `scripts/ml5/gen-fixtures-ml5d.mjs` emitting `ML5-DASH-001..006`, register them + owner `ML5-D` in the v2 manifest against `schemas/ml5-fixture.schema.json`; bump `EXPECTED_SPRINTS` 39→40.
9. Add the sprint acceptance aggregator `src/vector-cortex/ml5d-acceptance.test.ts`, then evidence `ML5-D.md`; run `cd extensions/dashboard-client && npm run typecheck && npm run build` (the client is touched — MANDATORY).

## Failure triad and independence

A card render: with `MEGACOMPACT_ML5_D=1`, a qualified (mode A) asset makes `ModelImprovementCard` render the "Promoted" state with mode, last bench, verdict, and a terminal-qualified badge (fixture 601; ids below use the `ML5-DASH-` prefix, abbreviated as `601`). B mode-B/demoted render: with the asset unqualified, the card renders the "Rejected / demoted_to_B" state with the demotion reason (fixture 602). C flag-off: with `MEGACOMPACT_ML5_D=0`, both endpoints return 404 and `VectorCortexTab` omits the card entirely — byte-identical to the ML5-C-era tab (fixture 603). The modal confirm + state machinery is pinned by fixtures 604–606: the Improve trigger requires the `window.confirm` confirmation server-side and returns a `jobId` (604); the status endpoint walks progressing→qualified/demoted_to_B (605); the Promoted/Rejected mode-badge transition is pinned end-to-end (606). A is produced by the qualified-asset read path; B by the demotion path; C purely by the flag branch. All three use independent inputs. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/cortex-improve/`. Schema: `schemas/ml5-fixture.schema.json` (shared ML5 schema).

- `ML5-DASH-001: card render mode A (qualified / promoted)` — `{ kind:"cortex-improve", flag:"MEGACOMPACT_ML5_D", mode:"A", render:"promoted", badge:"Promoted", endpoint:"/api/cortex/improve" }`.
- `ML5-DASH-002: card render mode B (demoted/rejected)` — `{ kind:"cortex-improve", flag:"MEGACOMPACT_ML5_D", mode:"B", render:"rejected", badge:"Rejected", reason_field:true }`.
- `ML5-DASH-003: flag-off returns 404, VectorCortexTab omits the card` — `{ kind:"cortex-improve", flag:"MEGACOMPACT_ML5_D", flag_enabled:false, endpoints_status:404, card_present:false }`.
- `ML5-DASH-004: improve trigger requires confirm, returns jobId` — `{ kind:"cortex-improve", flag:"MEGACOMPACT_ML5_D", confirm_required:true, action:"POST /api/cortex/improve", returns:"{status:improving, jobId}" }`.
- `ML5-DASH-005: status endpoint progress states to terminal` — `{ kind:"cortex-improve", flag:"MEGACOMPACT_ML5_D", progress_states:["improving","qualified"|"demoted_to_B"], terminal_qualified:{status:"qualified",verdict:true}, terminal_demoted:{status:"demoted_to_B",reason:true} }`.
- `ML5-DASH-006: mode-badge state-transition pin (Improve → verify → promoted/rejected)` — `{ kind:"cortex-improve", flag:"MEGACOMPACT_ML5_D", transition:"mode->improving->qualified|demoted_to_B", badge_transition_pinned:true }`.

Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/ml5d-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/ml5d-acceptance.test.js
```

Expected assertions: all `ML5-DASH-001..006` rows registered with algorithm `cortex-improve` against the `ml5-fixture` schema; 601 pins the promoted render; 602 pins the rejected render; 603 pins flag-off 404 + card omission; 604 pins the confirm-required improve trigger returning `jobId`; 605 pins the status-endpoint progress→terminal states; 606 pins the mode-badge transition. Exact flag-off comparison command: `MEGACOMPACT_ML5_D=0 node --test dist/vector-cortex/ml5d-acceptance.test.js`; the aggregator is flag-agnostic. Acceptance: no payload leakage — the endpoints and card surface mode/verdict/digest/progress only, never message content or training corpus rows (EVAL-REDACT-002); **zero network calls at runtime** — training, qualification, and status all run local (PREVENT-PI-004 green). Apply [EVALUATION](../EVALUATION.md) annotation/power rules; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure — no schema/state changes** (training reads the existing local corpus; qualification pushes the verdict onto the existing manifest; no new tables; the dashboard-snapshot stub-8 closure only verifies the existing real `totalTokensSaved` counter). Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); the panel surfaces mode/verdict/digest/bench aggregates and never message or corpus content (EVAL-REDACT-002). Dashboard: new sub-panel + 2 additive endpoints + SETTINGS toggle. Run `cd extensions/dashboard-client && npm run typecheck && npm run build` — MANDATORY (client files are touched).

Rollback sets `MEGACOMPACT_ML5_D=0`; both improve endpoints return 404 and `VectorCortexTab` omits the `ModelImprovementCard` — byte-identical to the ML5-C-era tab — without deleting evidence.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/ml5d-acceptance.test.js`, `MEGACOMPACT_ML5_D=0 node --test dist/vector-cortex/ml5d-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all --soft-as-hard --soft-as-hard-base <PREV_TAG> --pre-commit`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, `node scripts/vector-cortex-scope-check.mjs ML5-D <COMMIT_SHA>`, `node scripts/vector-cortex-evidence-check.mjs ML5-D`, `git diff --check`, `cd extensions/dashboard-client && npm run typecheck && npm run build`. No permissive globs or warning-only scans count.

Clients and the dashboard server are touched by this sprint, so `<COMMIT_SHA>` in the scope-check command is this sprint's commit.

This sprint adds a 40th sprint file, so `EXPECTED_SPRINTS` in `scripts/vector-cortex-docs-check.mjs` is bumped from 39 to 40.
