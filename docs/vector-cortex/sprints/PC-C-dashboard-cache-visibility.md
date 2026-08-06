# PC-C — Dashboard prompt-cache per-turn visibility

**Status:** planned | **Depends on:** PC-B | **Phase:** PC
**Flag:** `MEGACOMPACT_PC_C`, defined in `src/config/vector-cortex-pcc.ts` (sibling extract), re-exported by `vector-cortex.ts` + root `src/config.ts`, default ON; `MEGACOMPACT_PC_C=0` disables and must be byte-identical to the PC-B predecessor (the prefix-stability endpoint returns 404/disabled and the CacheTab renders exactly as before — stripe distribution + hit-rate trend only). Registered in `VECTOR_CORTEX_SETTINGS` as a visible boolDirect toggle, never in `EXCLUDED_SETTINGS`.

## Goal and inputs/outputs

Surface the per-turn `prefix_stability` metric (logged by `tailResult.ts` at each turn) in the dashboard CacheTab. The existing CacheTab already has `StripeDistributionCard` and `CacheHitRateTrendCard` driven by `/api/cache-stripes` and `/api/perf`; this sprint adds the **per-turn prefix-stability breakdown** — a trend showing `stablePrefix` / `totalMessages` over recent turns, sourced from the `prefix_stability` log events. This completes the PLAN_V2 Phase 4 dashboard visibility plan.

Production ownership: `extensions/dashboard-server/routes-prefix-stability.ts (new — GET /api/prefix-stability endpoint); extensions/dashboard-server/routes-prefix-stability.test.ts (new); extensions/dashboard-server/api-contracts/prefix-stability.ts (new — response contract); extensions/dashboard-server/api-contracts/endpoints/registry.ts (additive — prefix-stability entry, EXPECTED_ENDPOINT_COUNT bump); extensions/dashboard-server/route-dispatch.ts (additive — if-chain entry); extensions/dashboard-server/routes.ts (additive — barrel re-export); extensions/dashboard-client/src/tabs/CacheTab.tsx (additive — new PrefixStabilityCard section); extensions/dashboard-client/src/components/PrefixStabilityCard.tsx (new — per-turn trend chart); extensions/dashboard-client/src/api/client.ts (additive — fetchPrefixStability); extensions/dashboard-client/src/types/ (additive — PrefixStabilityResponse type); src/config/vector-cortex-pcc.ts (new); src/config/vector-cortex.ts (additive re-export, stays ≤ 300); src/config.ts (additive re-export, stays ≤ 200); extensions/dashboard-server/routes-rag-settings-vector-cortex.ts (additive boolDirect toggle, stays ≤ 300); scripts/pc-prompt-cache/gen-fixtures-pcc.mjs (new generator); conformance/vector-cortex/v2/prompt-cache/PC-009.json..015.json (new); conformance/vector-cortex/v2/manifest.json (additive); src/vector-cortex/pcc-acceptance.test.ts (new); scripts/vector-cortex-docs-check.mjs (EXPECTED_SPRINTS 35→36); docs/vector-cortex/sprints/PC-C-dashboard-cache-visibility.md (this spec); docs/vector-cortex/evidence/PC-C.md (new)`.

Algorithm: the `prefix_stability` events are already logged by `tailResult.ts` at each turn with `stablePrefix` (number of leading messages matching the previous turn's prefix fingerprint) and `totalMessages` (total message count). The new endpoint reads recent `prefix_stability` events from the monitoring events log, aggregates them into a trend series, and returns the last N turns. The client renders a sparkline/bar chart showing the stable-prefix ratio per turn. A high ratio (>0.8) indicates good cache prefix stability; a low ratio (<0.5) indicates the prefix is being invalidated each turn.

## Numbered implementation tasks

1. Add the `MEGACOMPACT_PC_C` flag (default ON, `=0` byte-identical) in `src/config/vector-cortex-pcc.ts` + the `vector-cortex.ts`/`src/config.ts` re-exports, and the `VECTOR_CORTEX_SETTINGS` boolDirect toggle in `routes-rag-settings-vector-cortex.ts`. `vector-cortex.ts` stays ≤ 300 (one additive re-export line).
2. Create `extensions/dashboard-server/api-contracts/prefix-stability.ts`: `PrefixStabilityResponse { turns: Array<{ turnIndex: number; stablePrefix: number; totalMessages: number; ratio: number; timestamp: string }>; avgRatio: number; trend: "improving" | "stable" | "degrading" }`.
3. Create `extensions/dashboard-server/routes-prefix-stability.ts`: `GET /api/prefix-stability?limit=50` — reads recent `prefix_stability` events from the events log, returns the trend series. Flag-off → 404. Read-only, no payload bytes (EVAL-REDACT-002).
4. Register the endpoint in `route-dispatch.ts`, `routes.ts`, and `api-contracts/endpoints/registry.ts` (EXPECTED_ENDPOINT_COUNT bump).
5. Add `extensions/dashboard-server/routes-prefix-stability.test.ts` pinning the response shape with stub events.
6. Create `extensions/dashboard-client/src/components/PrefixStabilityCard.tsx` — per-turn ratio trend (bar or sparkline), current ratio, average ratio, trend label. Follows the `StripeDistributionCard` pattern.
7. Patch `extensions/dashboard-client/src/tabs/CacheTab.tsx` additively: add `PrefixStabilityCard` section below `CacheHitRateTrendCard`. Add `fetchPrefixStability` to `api/client.ts` + type import.
8. Add `scripts/pc-prompt-cache/gen-fixtures-pcc.mjs` emitting `PC-009..015`, register them + owner `PC-C` in the v2 manifest; bump `EXPECTED_SPRINTS` 35→36 in `scripts/vector-cortex-docs-check.mjs`.
9. Add the sprint acceptance aggregator `src/vector-cortex/pcc-acceptance.test.ts`, then evidence `PC-C.md`; run `cd extensions/dashboard-client && npm run typecheck && npm run build` (the client is touched — MANDATORY).

## Failure triad and independence

A flag-on trend: with `MEGACOMPACT_PC_C=1` (default), the endpoint returns a non-empty trend series from real `prefix_stability` events, and the client renders the card (fixture 009). B empty-state: with the flag on but no `prefix_stability` events logged yet (fresh session), the endpoint returns an empty `turns` array with `avgRatio: null` and the client renders a "no data" state (fixture 010). C flag-off: with `MEGACOMPACT_PC_C=0`, the endpoint returns 404 and the CacheTab omits the PrefixStabilityCard — byte-identical to PC-B-era behavior (fixture 011). Trend direction classification (improving/stable/degrading) is pinned by fixtures 012-014. The endpoint-registry integration (EXPECTED_ENDPOINT_COUNT + contract shape) is pinned by fixture 015. A is produced by the event-log read; B by the empty-state early return; C purely by the flag branch. All three use independent inputs. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/prompt-cache/`.

- `PC-009: flag-on returns non-empty trend series from prefix_stability events` — `{ kind:"prompt-cache", flag:"MEGACOMPACT_PC_C", flag_enabled:true, endpoint:"/api/prefix-stability", events_present:true, turns_returned:">0" }`.
- `PC-010: no events returns empty turns array with null avgRatio` — `{ kind:"prompt-cache", flag:"MEGACOMPACT_PC_C", flag_enabled:true, events_present:false, turns_returned:0, avgRatio:null }`.
- `PC-011: flag-off returns 404, CacheTab omits the card` — `{ kind:"prompt-cache", flag:"MEGACOMPACT_PC_C", flag_enabled:false, endpoint_status:404, card_present:false }`.
- `PC-012: trend "improving" when recent ratios > earlier ratios` — `{ kind:"prompt-cache", trend_classification:"improving" }`.
- `PC-013: trend "stable" when recent ≈ earlier ratios` — `{ kind:"prompt-cache", trend_classification:"stable" }`.
- `PC-014: trend "degrading" when recent ratios < earlier ratios` — `{ kind:"prompt-cache", trend_classification:"degrading" }`.
- `PC-015: endpoint registered in registry with correct contract` — `{ kind:"prompt-cache", registry_entry:"/api/prefix-stability", contract_shape:"PrefixStabilityResponse", endpoint_count_bumped:true }`.

Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/pcc-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/pcc-acceptance.test.js
```

Expected assertions: all `PC-009..015` rows registered with algorithm `prompt-cache` against the `prompt-cache-fixture` schema; 009 pins the non-empty trend; 010 pins the empty state; 011 pins flag-off 404; 012-014 pin trend classification; 015 pins registry integration. Exact flag-off comparison command: `MEGACOMPACT_PC_C=0 node --test dist/vector-cortex/pcc-acceptance.test.js`; the aggregator is flag-agnostic. Acceptance: no payload leakage (response contains ratios and counts only — EVAL-REDACT-002); no network (event log is local). Apply [EVALUATION](../EVALUATION.md) annotation/power rules; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure — no schema/state changes** (reads existing `prefix_stability` events from the monitoring log; no new tables). Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); response contains aggregate ratios and counts only, never message content (EVAL-REDACT-002). Dashboard: new endpoint + new card + SETTINGS toggle. Run `cd extensions/dashboard-client && npm run typecheck && npm run build` — MANDATORY (client files are touched).

Rollback sets `MEGACOMPACT_PC_C=0`; the endpoint returns 404 and the CacheTab omits the PrefixStabilityCard — byte-identical to the PC-B-era CacheTab — without deleting evidence.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/pcc-acceptance.test.js`, `MEGACOMPACT_PC_C=0 node --test dist/vector-cortex/pcc-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all --soft-as-hard --soft-as-hard-base <PREV_TAG> --pre-commit`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, `node scripts/vector-cortex-scope-check.mjs PC-C <COMMIT_SHA>`, `node scripts/vector-cortex-evidence-check.mjs PC-C`, `git diff --check`, `cd extensions/dashboard-client && npm run typecheck && npm run build`. No permissive globs or warning-only scans count.

Clients and the dashboard server are touched by this sprint, so `<COMMIT_SHA>` in the scope-check command is this sprint's commit.

This sprint adds a 36th sprint file, so `EXPECTED_SPRINTS` in `scripts/vector-cortex-docs-check.mjs` is bumped from 35 to 36.
