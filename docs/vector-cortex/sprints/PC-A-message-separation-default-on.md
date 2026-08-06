# PC-A — messageSeparation flag unification + default ON

**Status:** implementer-complete | **Depends on:** VC9D | **Phase:** PC
**Flag:** `MEGACOMPACT_MESSAGE_SEPARATION`, config-driven via `config.messageSeparation` in `extensions/mega-config.ts` (envBool default flipped `false`→`true`); the in-function env read in `buildSeparatedPrompt` is REMOVED so the single gate lives at the call site (`tailResult.ts:43-51`). `MEGACOMPACT_MESSAGE_SEPARATION=0` disables and must be byte-identical to the pre-change OFF state (no reordering — the prompt array passes through unchanged). Registered as a visible boolDirect toggle in `routes-rag-settings-helpers.ts`, never in `EXCLUDED_SETTINGS`.

## Goal and inputs/outputs

Unify the `messageSeparation` flag from its double-gate (call-site config + in-function env read) to the standard positive-sprint-flag convention: default ON, `=0` byte-identical, single config-driven gate. The `buildSeparatedPrompt` function becomes pure — it never reads `process.env` — and the call site in `tailResult.ts` is the sole gate via `config.messageSeparation`. Includes the `mega-config.ts` delegate-shell split: the file is 432 lines (over the 400 extension soft limit) and trips the soft-as-hard headroom gate on any edit, so the `MegaConfig` interface moves to a sibling `mega-config-types.ts` (pure type move, zero behavioral change).

Production ownership: `extensions/mega-config.ts (delegate-shell split — MegaConfig interface extracted to sibling, envBool default flipped, comment added, net -166 lines to 266); extensions/mega-config-types.ts (new — MegaConfig interface + CompactTier type, moved verbatim from mega-config.ts); extensions/mega-events/separated-prompt.ts (env gate removed from buildSeparatedPrompt — the function is now pure); extensions/mega-events/separated-prompt.test/phase2-separation.test.ts (updated — tests assert pure-function behavior, no env manipulation); extensions/dashboard-server/routes-rag-settings-helpers.ts (boolDirect default flipped false→true); scripts/pc-prompt-cache/gen-fixtures-pca.mjs (new generator); conformance/vector-cortex/v2/schemas/prompt-cache-fixture.schema.json (new); conformance/vector-cortex/v2/prompt-cache/PC-001.json..004.json (new); conformance/vector-cortex/v2/manifest.json (additive); src/vector-cortex/pca-acceptance.test.ts (new); scripts/vector-cortex-docs-check.mjs (EXPECTED_SPRINTS 33→34, EXPECTED_PHASES 9→10); docs/vector-cortex/phases/PC-prompt-cache-rollout.md (new); docs/vector-cortex/sprints/PC-A-message-separation-default-on.md (this spec); docs/vector-cortex/evidence/PC-A.md (new)`. The conformance manifest is updated to add the owner token `PC-A` and the 4 new rows; the reserved range `PC-001..019` is documented in the spec and the generator (PC-A 001-004, PC-B 005-008, PC-C 009-015, PC-D 016-019).

Algorithm: `buildSeparatedPrompt` reorders `toolResult`/`bashExecution` roles to the tail of the prompt array, keeping the stable prefix (user/assistant/summaries/custom) contiguous. When `tail.length === 0` (no tool results), returns the array unchanged — byte-identical. The call-site gate in `tailResult.ts` checks `config.messageSeparation` (from `envBool("MEGACOMPACT_MESSAGE_SEPARATION", true)`) before invoking. Flag OFF → the function is never called, prompt arrays pass through unchanged.

## Numbered implementation tasks

1. Split `extensions/mega-config.ts`: move the `MegaConfig` interface (and `CompactTier` type if co-located) into `extensions/mega-config-types.ts` (pure type move, no logic). `mega-config.ts` imports and re-exports the type. Result: `mega-config.ts` ≤ 270 lines, `mega-config-types.ts` ≤ 200 lines. Both under their 400 extension soft limits.
2. Flip the flag default in `extensions/mega-config.ts`: `envBool("MEGACOMPACT_MESSAGE_SEPARATION", false)` → `envBool("MEGACOMPACT_MESSAGE_SEPARATION", true)`. Add comment: positive sprint flag, `=0` byte-identical.
3. Remove the env gate from `buildSeparatedPrompt` in `extensions/mega-events/separated-prompt.ts`: delete the `process.env.MEGACOMPACT_MESSAGE_SEPARATION` read and early-return. The function is now pure. Update the JSDoc.
4. Update the boolDirect toggle default in `extensions/dashboard-server/routes-rag-settings-helpers.ts` from `false` to `true`.
5. Update `extensions/mega-events/separated-prompt.test/phase2-separation.test.ts`: remove env manipulation, assert pure-function behavior (reordering when tool results present, byte-identical when absent).
6. Add `scripts/pc-prompt-cache/gen-fixtures-pca.mjs` emitting the `prompt-cache-fixture` schema + `PC-001..004`, register them + owner `PC-A` in the v2 manifest; bump `EXPECTED_SPRINTS` 33→34 and `EXPECTED_PHASES` 9→10 in `scripts/vector-cortex-docs-check.mjs`.
7. Add the sprint acceptance aggregator `src/vector-cortex/pca-acceptance.test.ts`, then evidence `PC-A.md`.

## Failure triad and independence

A flag-on reordering: with `messageSeparation=true` (default), a prompt array containing tool results has them moved to the tail, with the stable prefix contiguous (fixture 001). B pure-function purity: with the flag on but an array containing NO tool results, `buildSeparatedPrompt` returns the identical array reference — byte-identical, zero copies (fixture 002). C flag-off byte-parity: with `MEGACOMPACT_MESSAGE_SEPARATION=0`, prompt arrays pass through `tailResult.ts` unchanged — identical to the pre-change OFF state (fixture 003). The mega-config split's type-move correctness (all existing imports still resolve, `loadConfig()` returns the same shape) is pinned by fixture 004. A is produced by the reordering logic; B by the `tail.length === 0` early return; C purely by the call-site gate. All three use independent inputs (message arrays with/without tool results / the flag env var / the config object). Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/prompt-cache/`. Reserved range `PC-001..019` — PC-A 001-004, PC-B 005-008, PC-C 009-015, PC-D 016-019.

- `PC-001: flag-on reorders tool results to the tail` — `{ kind:"prompt-cache", flag:"MEGACOMPACT_MESSAGE_SEPARATION", flag_enabled:true, input_roles:["user","assistant","toolResult","user","toolResult"], expected_tail_roles:["toolResult","toolResult"], expected_prefix_roles:["user","assistant","user"], reordered:true }`. Tool results move to tail; stable prefix contiguous.
- `PC-002: no-tool-results input returns identical array (pure no-op)` — `{ kind:"prompt-cache", flag:"MEGACOMPACT_MESSAGE_SEPARATION", flag_enabled:true, input_roles:["user","assistant","user"], reordered:false, identical_reference:true }`. No tool results → same array returned, byte-identical.
- `PC-003: flag-off passes prompt arrays through unchanged` — `{ kind:"prompt-cache", flag:"MEGACOMPACT_MESSAGE_SEPARATION", flag_enabled:false, input_roles:["user","assistant","toolResult"], reordered:false }`. `=0` restores pre-change behavior exactly.
- `PC-004: mega-config split preserves loadConfig shape` — `{ kind:"prompt-cache", flag:"MEGACOMPACT_MESSAGE_SEPARATION", type_move:"MegaConfig→mega-config-types.ts", config_shape_preserved:true }`. The type extraction is behavior-neutral.

Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/pca-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/pca-acceptance.test.js
```

Expected assertions: all `PC-001..004` rows registered with algorithm `prompt-cache` against the `prompt-cache-fixture` schema; each fixture envelope satisfies the schema invariants; 001 pins the reordering; 002 pins the no-op identity; 003 pins flag-off parity; 004 pins the type-move shape preservation. Exact flag-off comparison command: `MEGACOMPACT_MESSAGE_SEPARATION=0 node --test dist/vector-cortex/pca-acceptance.test.js`; the aggregator is flag-agnostic (it never asserts a fixed runtime flag value; the flag-off byte-parity is pinned by fixture 003), so the SAME suite is green under both flag states. Acceptance: no payload leakage (fixtures contain role names and structural metadata only, never message content — EVAL-REDACT-002); no network (pure in-memory array reordering). Apply [EVALUATION](../EVALUATION.md) annotation/power rules; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure — no schema/state changes** (prompt reordering is in-memory only, per-turn; no persisted data format changes). Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); no payload bytes are logged or exported — cache metrics are aggregate counts and ratios only (EVAL-REDACT-002). Dashboard: the SETTINGS toggle default flips from OFF to ON in `routes-rag-settings-helpers.ts`; no endpoint registry change. No client-side changes — `cd extensions/dashboard-client && npm run typecheck && npm run build` not required for this sprint.

Rollback sets `MEGACOMPACT_MESSAGE_SEPARATION=0`; prompt arrays pass through `tailResult.ts` unchanged — byte-identical to the pre-change OFF state — without deleting evidence; the predecessor golden bytes are unchanged.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/pca-acceptance.test.js`, `MEGACOMPACT_MESSAGE_SEPARATION=0 node --test dist/vector-cortex/pca-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all --soft-as-hard --soft-as-hard-base v0.20.30 --pre-commit`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, `node scripts/vector-cortex-scope-check.mjs PC-A <COMMIT_SHA>`, `node scripts/vector-cortex-evidence-check.mjs PC-A`, `git diff --check`. No permissive globs or warning-only scans count.

No client or dashboard server files are touched (the settings helper is server-side only), so dashboard-client typecheck/build is NOT required for this sprint. The `<COMMIT_SHA>` in the scope-check command is this sprint's commit (run AFTER commit; if it flags files, extend the spec's Production ownership with a forced-deviation note and make a second commit so scope-check covers the union).

This sprint adds a 34th sprint file and a 10th phase file, so `EXPECTED_SPRINTS` in `scripts/vector-cortex-docs-check.mjs` is bumped from 33 to 34 and `EXPECTED_PHASES` from 9 to 10; that script is included in Production ownership (a genuine docs-check reconciliation, not scope drift).
