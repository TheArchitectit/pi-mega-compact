# VC4A — Dual-tier shard contract

**Status:** planned | **Depends on:** VC3C | **Phase:** VC4
**Flag:** `MEGACOMPACT_VC4A`, defined in `src/config/vector-cortex.ts`, re-exported by root `src/config.ts`, default ON; `MEGACOMPACT_VC4A=0` disables and must be byte-identical to the predecessor. Add to dashboard `SETTINGS`, or record the immutable/security exclusion below.

## Goal and inputs/outputs

Consume only reviewer-accepted predecessor contracts and [common contracts](../CONTRACTS.md). Own **SemanticShardV1 / ExactShardV1 / ShardManifestV1**. Production ownership: `src/vector-cortex/shards/types.ts`; `src/vector-cortex/shards/semantic.ts`; `src/vector-cortex/shards/exact.ts`; `src/vector-cortex/shards/manifest.ts`. Algorithm: Partition only at EventV2 boundaries; exact shards cover tools/anchors/invalid UTF-8; ranges disjoint and manifest coverage sorted by seq/byte.

## Numbered implementation tasks

1. Define `SemanticShardV1`, `ExactShardV1`, and `ShardManifestV1` ranges/digests/kinds; register `SHD-001..020`.
2. Implement `semantic.ts` to partition only between complete EventV2 records and preserve source seq/byte range metadata.
3. Implement `exact.ts` to include every tool call/result pair, anchor, and invalid UTF-8 event as original bytes.
4. Implement `manifest.ts` to require disjoint ranges sorted by `(seqStart,byteStart)` and complete protected-span coverage; return `SHD_RANGE_OVERLAP` or `SHD_PROTECTED_GAP`.
5. Emit `vector_cortex_shard_manifest_built` and `vector_cortex_protected_span_rejected`; expose aggregate counts/bytes only at the stated shards GET.
6. After shard production and dashboard gates pass, add semantic/exact/manifest tests and fixtures, then evidence `VC4A.md`.

## Failure triad and independence

A semantic+exact; B extractive+exact; C exact anchors/current transcript. Each uses independent algorithms/assets/indexes as applicable. C states its loss of old semantic context; authority outage freezes derived high-water. Common cooldown/spool/restart/clock rules are normative in [TRIAD_RESILIENCE](../TRIAD_RESILIENCE.md).

## Tests, fixtures, and assertions

Fixture root: `conformance/vector-cortex/v2/shards/`.

- `SHD-PAIR-001: call/result spanning target size stays in one exact shard`.
- `SHD-UTF8-002: invalid bytes are exact-only and unchanged`.
- `SHD-RANGE-003: overlapping semantic/exact coverage is rejected`.

Exact test sources: `src/vector-cortex/shards/semantic.test.ts`; `src/vector-cortex/shards/exact.test.ts`; `src/vector-cortex/shards/manifest.test.ts`. Sprint acceptance aggregator (must exist after implementation): `src/vector-cortex/vc4a-acceptance.test.ts`; exact compiled command:

```bash
npm run build
node --test dist/vector-cortex/vc4a-acceptance.test.js
```

Expected assertions: all `SHD-001..020` conformance rows return their manifest bytes or exact listed failure code; generate EventV2 streams with tool pairs, anchors, and arbitrary bytes; invariant: ranges are disjoint and every protected byte is covered exactly once. Unique failure injection: remove the final exact shard while retaining manifest digest; load fails `SHD_PROTECTED_GAP` before any reconstruction. Forced triad: A=semantic plus exact shards; B=extractive plus exact shards with semantic encoder disabled; C=exact anchors/current transcript only. Breaker recovery must follow the sprint triad contract. Exact flag-off comparison command: `MEGACOMPACT_VC4A=0 node --test dist/vector-cortex/vc4a-acceptance.test.js`; its outbound/predecessor golden bytes must match exactly. Acceptance: 100% protected-span coverage and zero pair splits. Apply [EVALUATION](../EVALUATION.md) annotation/power rules to affected heads; hard causal/tool/anchor/exact failures are zero-tolerance.

## Migration, privacy, dashboard, and rollback

Migration disposition: **pure—additive derived shards**. Every migration follows compatibility journal/copy-validate-switch and old-binary protocol; pure sprints write no migration. Privacy follows [SECURITY_PRIVACY](../SECURITY_PRIVACY.md); exact ledger is not training data. Dashboard: GET /api/vector-cortex/shards aggregate only. Dashboard work must own `extensions/dashboard-server/api-contracts/vector-cortex.ts`, registration in `routes.ts`, handler `routes-vector-cortex.ts`, client `api/vector-cortex.ts`, `types/vector-cortex.ts`, `tabs/VectorCortexTab.tsx`, route/client/component tests, reader-only GET capability, and run `cd extensions/dashboard-client && npm run typecheck && npm run build`.

Rollback sets `MEGACOMPACT_VC4A=0`, selects C, restores the prior derived pointer without deleting evidence, and verifies predecessor golden bytes. Next handoff: VC4B receives protected stream and shard manifest.

## Exit evidence

Run exact project gates: `npm run build`, `node --test dist/vector-cortex/vc4a-acceptance.test.js`, `npm test`, `npm run lint`, `python3 scripts/regression_check.py --all`, `node scripts/guardrails-scan.mjs`, `python3 scripts/log_failure.py --list`, `node scripts/vector-cortex-conformance.mjs --check`, `node scripts/vector-cortex-docs-check.mjs`, and `git diff --check`. Sprints that add or alter any runtime path also run `node scripts/vector-cortex-network-denial.mjs --modes=A,B,C`; asset/Rust/dashboard gates additionally apply when named by this sprint. No permissive globs or warning-only scans count.
