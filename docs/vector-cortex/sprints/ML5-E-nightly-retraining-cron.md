# ML5-E — Nightly retraining cron + feedback loop

**Status:** planned | **Depends on:** ML5-D | **Phase:** ML5
**Flag:** `MEGACOMPACT_ML5_E`, defined in `src/config/vector-cortex-ml5e.ts` (sibling extract), re-exported by `vector-cortex.ts` + root `src/config.ts`, default ON; `MEGACOMPACT_ML5_E=0` disables and must be byte-identical to the ML5-D survivor (no cron behavior — the scripts exist but are never invoked by the runtime; the promotion gate is inert and the dashboard's Improve Cortex flow is untouched). Registered in `VECTOR_CORTEX_SETTINGS` as a visible boolDirect toggle, never in `EXCLUDED_SETTINGS`.

## Goal and inputs/outputs

Turns one-shot training (ML5-D's Improve button) into a **living loop**: the user's own post-redaction conversation turns become fresh training signal, the five heads are re-fit nightly, calibration is re-validated, and mode-A promotion is re-checked without human intervention. The cron is the closure of the ML5 phase's item 6 ("feed the loop with new conversation turns").

- **Trigger**: cron `0 2 * * *` (daily 2am, the operator's local time). This is **system-configured** via `crontab -e` on the operator device — **never in the extension**, and never a runtime timer in `src/`.
- **Corpus refresh**: re-exports the corpus snapshot (new redacted-tagged sessions since the last run). A `corpus-digest` check compares against the last-run ledger; **if no new rows, no-op exit 0** (no re-training, no event noise).
- **Training**: `scripts/ml5/retrain-nightly.mjs` — an orchestrator that calls the ML5-A train step, the ML5-B bench, and the ML5-C package step in sequence.
- **Promotion**: the new asset is promoted **only if all five heads** pass their per-head calibration thresholds **and** the new asset beats the currently-committed asset on **held-out evaluation** (a fixed dev set, never training data). Otherwise it stays in mode B and records a `demoted_new_asset` event.
- **Rollback**: if a newly-promoted asset later regresses (a week-N+1 calibration run scores worse), the prior week's asset is restored via atomic manifest digest swap — no partial state.
- **Guardrails**: every new asset is a NEW `manifest.json` entry, never an overwrite — the manifest is **append-only**, so a prior asset is restorable by SHA-256 in O(1). The cron **never commits or pushes** — it writes candidate assets to `~/.pi/mega-compact-encoder/candidates/`; the human operator reviews the dashboard and promotes via the ML5-D "Improve Cortex" flow. This is a **local, computer-bound** workload — **zero network** (PREVENT-PI-004 green).

Production ownership: `scripts/ml5/retrain-nightly.mjs (new — orchestrator: corpus refresh → train → bench → package, no-op exit 0 on empty delta); scripts/ml5/promotion-gate.mjs (new — five-head thresholds + held-out eval beat + atomic manifest digest-swap rollback); scripts/ml5/crontab.example (new — the documented `0 2 * * *` and env wiring; reference only, never installed by the extension); src/vector-cortex/encoder/promotion.ts (new — PromotionV1 ledger row type + append-only manifest helper, sha256-restore); conformance/vector-cortex/v2/nightly-retrain/ (fixtures ML5-LOOP-001..004); scripts/ml5/gen-fixtures-ml5e.mjs (new generator); scripts/vector-cortex-docs-check.mjs (EXPECTED_SPRINTS 40→41); docs/vector-cortex/evidence/ML5-E.md (new); scripts/ml5/ (additive — no runtime `src/` timer, per the system-cron disposition)`.

## Numbered implementation tasks

1. Add the `MEGACOMPACT_ML5_E` flag (default ON, `=0` byte-identical) in `src/config/vector-cortex-ml5e.ts` + the `vector-cortex.ts`/`src/config.ts` re-exports, and the `VECTOR_CORTEX_SETTINGS` boolDirect toggle in `routes-rag-settings-vector-cortex.ts` (additive, stays ≤ 300). `vector-cortex.ts` stays ≤ 300. The flag gates **invocation** only — scripts exist regardless; `=0` means the runtime never invokes them.
2. Create `scripts/ml5/retrain-nightly.mjs`: the cron orchestrator. Re-exports the corpus snapshot, computes the `corpus-digest` relative to the last-run ledger entry, and **no-ops with exit 0** when there are no new rows. Otherwise calls the ML5-A train step, the ML5-B bench, and the ML5-C package step in sequence. Declared to be run by the system cron, never auto-spawned.
3. Create `scripts/ml5/promotion-gate.mjs`: evaluates the five heads against per-head calibration thresholds AND the new asset against the committed asset on a **fixed held-out dev set** (never training data). On pass → mark candidate eligible; on fail → write the candidate and emit `demoted_new_asset`.
4. Create `src/vector-cortex/encoder/promotion.ts`: `PromotionV1` ledger row type; the **append-only** manifest helper (every new asset is a new entry, never an overwrite; restore a prior asset by SHA-256 in O(1)); the **atomic digest-swap** rollback that restores the prior week's asset with no partial state.
5. Add `scripts/ml5/crontab.example`: the documented `0 2 * * *` schedule line, the env wiring (`MEGACOMPACT_ML5_E=1`, state-dir, candidates dir), and the note that this is a reference for the operator's `crontab -e` — the extension never installs or writes a crontab (documentation only; no runtime code path).
6. Add `scripts/ml5/gen-fixtures-ml5e.mjs` emitting `ML5-LOOP-001..004`, register them + owner `ML5-E` in the v2 manifest against `schemas/ml5-fixture.schema.json`; bump `EXPECTED_SPRINTS` 40→41.
7. Add the sprint acceptance aggregator `src/vector-cortex/ml5e-acceptance.test.ts`, then evidence `ML5-E.md` recording the weekly end-to-end loop (cron → train → bench → promote-or-demote → rollback) verified on the operator's device.

## Failure triad and independence

A corpus no-op: with no new redacted-tagged rows since the last run, `retrain-nightly.mjs` computes the unchanged `corpus-digest` and exits 0 without retraining or emitting training noise (fixture 701; ids below use the `ML5-LOOP-` prefix, abbreviated as `701`). B training-run recording: with new rows, the orchestrator records a full training run (training event, bench events, packaged asset) into the append-only manifest (fixture 702). C promotion gate: the gate promotes only when all five heads pass their per-head thresholds AND the new asset beats the committed asset on the held-out dev set — and otherwise writes the candidate and records `demoted_new_asset` (fixture 703). The rollback digest-swap is pinned by fixture 704 — a regressed newly-promoted asset is atomically swapped back to the prior SHA-256 entry with no partial state. A is produced by the corpus-digest early return; B by the orchestrator's run recording; C purely by the promotion-gate criteria. All three use independent inputs. `MEGACOMPACT_ML5_E=0` never invokes the scripts — byte-identical mode-B serving. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/nightly-retrain/`. Schema: `schemas/ml5-fixture.schema.json` (shared ML5 schema).

- `ML5-LOOP-001: corpus-digest no-op exits 0 without retraining` — `{ kind:"nightly-retrain", flag:"MEGACOMPACT_ML5_E", new_rows:false, corpus_digest_unchanged:true, exit_code:0, no_training_events:true }`.
- `ML5-LOOP-002: training-run records full pipeline on new rows` — `{ kind:"nightly-retrain", flag:"MEGACOMPACT_ML5_E", new_rows:true, trains:true, bench_records:true, packaged_asset:true, manifest_append:true }`.
- `ML5-LOOP-003: promotion gate requires all threshold pass + held-out beat` — `{ kind:"nightly-retrain", flag:"MEGACOMPACT_ML5_E", five_heads_ok:true, heldout_beat:true, promote:true, five_heads_ok:false, heldout_beat:false, promote:false, demoted_event:"demoted_new_asset" }`.
- `ML5-LOOP-004: rollback via atomic manifest digest-swap` — `{ kind:"nightly-retrain", flag:"MEGACOMPACT_ML5_E", regression:true, restored_sha256:"<prior-asset-sha256>", atomic_swap:true, no_partial_state:true }`.

Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/ml5e-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/ml5e-acceptance.test.js
```

Expected assertions: all `ML5-LOOP-001..004` rows registered with algorithm `nightly-retrain` against the `ml5-fixture` schema; 701 pins the no-op exit 0; 702 pins the full-pipeline run recording into the append-only manifest; 703 pins the promotion-gate criterion (all-five + held-out beat) and the `demoted_new_asset` path; 704 pins the atomic rollback digest-swap. Exact flag-off comparison command: `MEGACOMPACT_ML5_E=0 node --test dist/vector-cortex/ml5e-acceptance.test.js`; the aggregator is flag-agnostic. Acceptance: no payload leakage — the manifest rows carry digests and verdicts only, never message content or training corpus rows (EVAL-REDACT-002); **zero network calls** — retraining, benching, packaging, and promotion are all local computation (PREVENT-PI-004 green). Apply [EVALUATION](../EVALUATION.md) annotation/power rules; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure — no schema/state changes** (the append-only manifest extends the existing encoder manifest; the candidate dir is new OS-level storage `~/.pi/mega-compact-encoder/candidates/`, not a state-table change; no new tables; the cron is a system/host concern, not an in-process migration). Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); the corpus is the extension's own redacted-tagged rows, the manifest stores digests and verdicts only, and candidates live under the user's home dir — never message content outside the user's machine (EVAL-REDACT-002). Dashboard: **no changes** — promotion happens via the existing ML5-D "Improve Cortex" flow; `cd extensions/dashboard-client && npm run typecheck && npm run build` is NOT required and NOT run. The cron is system-configured on the operator device and never invokes the extension at runtime.

Rollback sets `MEGACOMPACT_ML5_E=0`; the scripts remain on disk but are never invoked by the runtime, and the dashboard's Improve Cortex flow is byte-identical to the ML5-D survivor — without deleting evidence.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/ml5e-acceptance.test.js`, `MEGACOMPACT_ML5_E=0 node --test dist/vector-cortex/ml5e-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all --soft-as-hard --soft-as-hard-base <PREV_TAG> --pre-commit`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, `node scripts/vector-cortex-scope-check.mjs ML5-E <COMMIT_SHA>`, `node scripts/vector-cortex-evidence-check.mjs ML5-E`, `git diff --check`. No permissive globs or warning-only scans count.

The ML5-E evidence doc additionally records the **workbook field addition**: the `crontab -e` documentation (via `scripts/ml5/crontab.example`) and the **promoted-by-dashboard workflow verified end-to-end** on the operator's device — a nightly candidate promoted through the ML5-D Improve Cortex flow, plus one rollback round-trip.

`<COMMIT_SHA>` in the scope-check command is this sprint's commit. No client or dashboard server files are touched.

This sprint adds a 41st sprint file, so `EXPECTED_SPRINTS` in `scripts/vector-cortex-docs-check.mjs` is bumped from 40 to 41.
