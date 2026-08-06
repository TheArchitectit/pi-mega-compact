# PC-B — cacheStriping flag unification + default ON

**Status:** planned | **Depends on:** PC-A | **Phase:** PC
**Flag:** `MEGACOMPACT_CACHE_STRIPING`, config-driven via `config.cacheStriping` in `extensions/mega-config.ts` (envBool default flipped `false`→`true`); the in-function env read in `buildCacheOptimizedPrompt` is REMOVED so the single gate lives at the call site (`tailResult.ts:47-51`). `MEGACOMPACT_CACHE_STRIPING=0` disables and must be byte-identical to the pre-change OFF state (delegates to `buildSeparatedPrompt`, which itself is gated by `config.messageSeparation` at the call site). Registered as a visible boolDirect toggle in `routes-rag-settings-helpers.ts`, never in `EXCLUDED_SETTINGS`.

## Goal and inputs/outputs

Unify the `cacheStriping` flag from its double-gate (call-site config + in-function env read) to the standard positive-sprint-flag convention: default ON, `=0` byte-identical, single config-driven gate. The `buildCacheOptimizedPrompt` function becomes pure — it never reads `process.env` — and the call site in `tailResult.ts` is the sole gate via `config.cacheStriping`. When striping is off, the function delegates to `buildSeparatedPrompt` (which was unified in PC-A). When no stripe data exists (no `cache_stripes` rows for the epoch), the function returns the base separated prompt unchanged.

Production ownership: `extensions/mega-config.ts (envBool default flipped, comment added); extensions/mega-events/separated-prompt.ts (env gate removed from buildCacheOptimizedPrompt — the function is now pure); extensions/dashboard-server/routes-rag-settings-helpers.ts (boolDirect default flipped false→true); scripts/pc-prompt-cache/gen-fixtures-pcb.mjs (new generator); conformance/vector-cortex/v2/prompt-cache/PC-005.json..008.json (new); conformance/vector-cortex/v2/manifest.json (additive); src/vector-cortex/pcb-acceptance.test.ts (new); scripts/vector-cortex-docs-check.mjs (EXPECTED_SPRINTS 34→35); docs/vector-cortex/sprints/PC-B-cache-striping-default-on.md (this spec); docs/vector-cortex/evidence/PC-B.md (new)`.

Algorithm: `buildCacheOptimizedPrompt` builds a 5-layer prompt: Layer 0 (system, empty in pi) → Layer 1 (branch/compaction summaries) → Layer 2 (cache stripes — stable context ordered by stability score DESC from `cache_stripes` table) → Layer 3 (conversation thread) → Layer 4 (tool results at tail). It first calls `buildSeparatedPrompt` for the base 4-layer structure, then inserts the stripe layer between summaries and thread. When `cache_stripes` has no rows for the current epoch, the stripe layer is empty and the result equals the separated prompt. The call-site gate in `tailResult.ts` checks `config.cacheStriping` before invoking; `config.cacheStriping` takes precedence over `config.messageSeparation` (line 47: `if (config.cacheStriping) { buildCacheOptimizedPrompt } else if (config.messageSeparation) { buildSeparatedPrompt }`).

## Numbered implementation tasks

1. Flip the flag default in `extensions/mega-config.ts`: `envBool("MEGACOMPACT_CACHE_STRIPING", false)` → `envBool("MEGACOMPACT_CACHE_STRIPING", true)`. Add comment: positive sprint flag, `=0` byte-identical.
2. Remove the env gate from `buildCacheOptimizedPrompt` in `extensions/mega-events/separated-prompt.ts`: delete the `process.env.MEGACOMPACT_CACHE_STRIPING` read and early-return. The function is now pure. Update the JSDoc.
3. Update the boolDirect toggle default in `extensions/dashboard-server/routes-rag-settings-helpers.ts` from `false` to `true`.
4. Add `scripts/pc-prompt-cache/gen-fixtures-pcb.mjs` emitting `PC-005..008`, register them + owner `PC-B` in the v2 manifest; bump `EXPECTED_SPRINTS` 34→35 in `scripts/vector-cortex-docs-check.mjs`.
5. Add the sprint acceptance aggregator `src/vector-cortex/pcb-acceptance.test.ts`, then evidence `PC-B.md`.

## Failure triad and independence

A flag-on striping: with `cacheStriping=true` (default) and stripe data present, the prompt array has the stripe layer inserted between summaries and thread, ordered by stability score DESC (fixture 005). B no-stripes fallback: with the flag on but no `cache_stripes` rows for the epoch, `buildCacheOptimizedPrompt` returns the base separated prompt unchanged — byte-identical to PC-A behavior (fixture 006). C flag-off byte-parity: with `MEGACOMPACT_CACHE_STRIPING=0`, the call-site skips `buildCacheOptimizedPrompt` entirely; if `messageSeparation` is also on (the default), only separation runs — identical to PC-A-only behavior (fixture 007). The delegation chain correctness (`buildCacheOptimizedPrompt` → `buildSeparatedPrompt` → tail reordering) is pinned by fixture 008. A is produced by the stripe-insertion logic; B by the empty-stripes early return; C purely by the call-site gate. All three use independent inputs. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/prompt-cache/`.

- `PC-005: flag-on inserts stripe layer between summaries and thread` — `{ kind:"prompt-cache", flag:"MEGACOMPACT_CACHE_STRIPING", flag_enabled:true, stripes_present:true, expected_layer_order:["summary","stripe","thread","tool"], reordered:true }`. Stripe content appears in stability-DESC order.
- `PC-006: no-stripes fallback returns separated prompt unchanged` — `{ kind:"prompt-cache", flag:"MEGACOMPACT_CACHE_STRIPING", flag_enabled:true, stripes_present:false, falls_back_to_separation:true, reordered:true }`. Without stripe data, result equals PC-A output.
- `PC-007: flag-off delegates to messageSeparation only` — `{ kind:"prompt-cache", flag:"MEGACOMPACT_CACHE_STRIPING", flag_enabled:false, message_separation_also_on:true, result_matches:"PC-A-only", reordered:true }`. `=0` restores PC-A behavior exactly.
- `PC-008: delegation chain preserves tail reordering` — `{ kind:"prompt-cache", flag:"MEGACOMPACT_CACHE_STRIPING", flag_enabled:true, delegation_chain:["buildCacheOptimizedPrompt","buildSeparatedPrompt","tail_reorder"], chain_correct:true }`. Full chain: striping → separation → tail reordering produces the correct 5-layer output.

Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/pcb-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/pcb-acceptance.test.js
```

Expected assertions: all `PC-005..008` rows registered with algorithm `prompt-cache` against the `prompt-cache-fixture` schema; 005 pins stripe insertion; 006 pins no-stripes fallback; 007 pins flag-off delegation; 008 pins chain correctness. Exact flag-off comparison command: `MEGACOMPACT_CACHE_STRIPING=0 node --test dist/vector-cortex/pcb-acceptance.test.js`; the aggregator is flag-agnostic, green under both flag states. Acceptance: no payload leakage (fixtures contain layer names and structural metadata only — EVAL-REDACT-002); stripe data is read from the local SQLite store (PREVENT-PI-004, no network). Apply [EVALUATION](../EVALUATION.md) annotation/power rules; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure — no schema/state changes** (the `cache_stripes` table already exists; this sprint changes only the flag default and removes the env gate). Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); stripe metadata is structural (layer names, stability scores) — no payload bytes (EVAL-REDACT-002). Dashboard: the SETTINGS toggle default flips from OFF to ON; no endpoint registry change. No client-side changes.

Rollback sets `MEGACOMPACT_CACHE_STRIPING=0`; the call-site skips `buildCacheOptimizedPrompt`, and if `messageSeparation` is on, only separation runs — byte-identical to the PC-A-only state — without deleting evidence.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/pcb-acceptance.test.js`, `MEGACOMPACT_CACHE_STRIPING=0 node --test dist/vector-cortex/pcb-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all --soft-as-hard --soft-as-hard-base <PREV_TAG> --pre-commit`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, `node scripts/vector-cortex-scope-check.mjs PC-B <COMMIT_SHA>`, `node scripts/vector-cortex-evidence-check.mjs PC-B`, `git diff --check`. No permissive globs or warning-only scans count.

No client or dashboard server files are touched (the settings helper is server-side only), so dashboard-client typecheck/build is NOT required. The `<COMMIT_SHA>` in the scope-check command is this sprint's commit.

This sprint adds a 35th sprint file, so `EXPECTED_SPRINTS` in `scripts/vector-cortex-docs-check.mjs` is bumped from 34 to 35.
